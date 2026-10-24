use crate::ssh::connection::SshHandle;
use russh_sftp::client::{error::Error as SftpError, SftpSession};
use russh_sftp::protocol::StatusCode;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const COPY_BUF_SIZE: usize = 64 * 1024;

async fn create_sftp(handle: &SshHandle) -> Result<SftpSession, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("Open channel: {}", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("Request SFTP subsystem: {}", e))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP init: {}", e))
}

async fn remote_kind(sftp: &SftpSession, path: &str) -> Result<Option<bool>, String> {
    match sftp.metadata(path.to_string()).await {
        Ok(metadata) => Ok(Some(metadata.is_dir())),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(error) => Err(format!("Stat {}: {}", path, error)),
    }
}

fn check_upload_kind(
    path: &str,
    source_is_dir: bool,
    dest_is_dir: Option<bool>,
) -> Result<(), String> {
    if dest_is_dir.is_some_and(|is_dir| is_dir != source_is_dir) {
        return Err(format!(
            "ファイルとフォルダーの相互置換はできません: {}。転送先の名前を変更するか、別の場所へ移動してから再実行してください。",
            path
        ));
    }
    Ok(())
}

fn skip_existing(
    path: &str,
    exists: bool,
    overwrite: bool,
    fail_on_skip: bool,
) -> Result<bool, String> {
    if exists && !overwrite {
        if fail_on_skip {
            return Err(format!(
                "移動を中止しました。転送先が既に存在します: {}。コピー元は削除していません。",
                path
            ));
        }
        return Ok(true);
    }
    Ok(false)
}

async fn local_exists(path: &Path) -> Result<bool, String> {
    tokio::fs::try_exists(path)
        .await
        .map_err(|error| format!("Stat {}: {}", path.display(), error))
}

async fn preflight_download_targets(
    remote_paths: &[PathBuf],
    local_dest: &Path,
    dest_names: Option<&[String]>,
) -> Result<(), String> {
    for (index, remote_path) in remote_paths.iter().enumerate() {
        let local_path = local_dest.join(item_name(remote_path, index, dest_names)?);
        skip_existing(
            &local_path.to_string_lossy(),
            local_exists(&local_path).await?,
            false,
            true,
        )?;
    }
    Ok(())
}

// A type conflict anywhere in an overwrite batch must be rejected before the
// first remote write. Do not recursively delete an existing destination merely
// because the user confirmed an ordinary file overwrite.
async fn preflight_upload<F, Fut>(
    local_paths: &[PathBuf],
    remote_dest: &str,
    overwrite: bool,
    fail_on_skip: bool,
    dest_names: Option<&[String]>,
    op: Option<&crate::operation::Operation>,
    mut destination_kind: F,
) -> Result<(), String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<Option<bool>, String>>,
{
    let mut pending = Vec::new();
    for (index, path) in local_paths.iter().enumerate() {
        let name = item_name(path, index, dest_names)?;
        pending.push((
            path.clone(),
            format!("{}/{}", remote_dest.trim_end_matches('/'), name),
            true,
        ));
    }
    while let Some((local_path, remote_path, top_level)) = pending.pop() {
        if let Some(op) = op {
            op.check()?;
        }
        let is_dir = tokio::fs::metadata(&local_path)
            .await
            .map_err(|error| format!("Stat {}: {}", local_path.display(), error))?
            .is_dir();
        let destination = destination_kind(remote_path.clone()).await?;
        if (top_level || !is_dir || fail_on_skip)
            && skip_existing(&remote_path, destination.is_some(), overwrite, fail_on_skip)?
        {
            continue;
        }
        check_upload_kind(&remote_path, is_dir, destination)?;
        if is_dir {
            let mut entries = tokio::fs::read_dir(&local_path)
                .await
                .map_err(|error| format!("Readdir {}: {}", local_path.display(), error))?;
            while let Some(entry) = entries
                .next_entry()
                .await
                .map_err(|error| error.to_string())?
            {
                pending.push((
                    entry.path(),
                    format!("{}/{}", remote_path, entry.file_name().to_string_lossy()),
                    false,
                ));
            }
        }
    }
    Ok(())
}

fn item_name(path: &Path, index: usize, dest_names: Option<&[String]>) -> Result<String, String> {
    if let Some(names) = dest_names {
        if let Some(name) = names.get(index) {
            crate::fs::local::validate_item_name(name)?;
            return Ok(name.clone());
        }
    }
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("Invalid path: {}", path.display()))
}

/// Copy files from local filesystem to remote (SFTP).
/// Moves require `fail_on_skip`: returning success after a skipped file would
/// allow the caller to delete an uncopied source.
pub async fn copy_local_to_remote(
    local_paths: &[PathBuf],
    remote_dest: &Path,
    handle: &SshHandle,
    overwrite: bool,
    fail_on_skip: bool,
    dest_names: Option<&[String]>,
    op: Option<&crate::operation::Operation>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let sftp = create_sftp(handle).await?;
    let remote_dest_str = remote_dest.to_string_lossy().to_string();

    if let Some(op) = op {
        op.progress(app, 0, local_paths.len());
    }
    if overwrite || fail_on_skip {
        preflight_upload(
            local_paths,
            &remote_dest_str,
            overwrite,
            fail_on_skip,
            dest_names,
            op,
            |path| {
                let sftp = &sftp;
                async move { remote_kind(sftp, &path).await }
            },
        )
        .await?;
    }
    for (i, local_path) in local_paths.iter().enumerate() {
        if let Some(op) = op {
            op.check()?;
        }
        let file_name = item_name(local_path, i, dest_names)?;
        let remote_item = format!("{}/{}", remote_dest_str.trim_end_matches('/'), file_name);
        if skip_existing(
            &remote_item,
            remote_kind(&sftp, &remote_item).await?.is_some(),
            overwrite,
            fail_on_skip,
        )? {
            continue;
        }
        if tokio::fs::metadata(local_path)
            .await
            .map_err(|e| e.to_string())?
            .is_dir()
        {
            copy_local_dir_to_remote(local_path, &remote_item, &sftp, overwrite, fail_on_skip)
                .await?;
        } else {
            copy_local_file_to_remote(local_path, &remote_item, &sftp).await?;
        }
        if let Some(op) = op {
            op.progress(app, i + 1, local_paths.len());
        }
    }
    Ok(())
}

/// Copy files from remote (SFTP) to local filesystem.
/// Moves require `fail_on_skip` so cleanup only follows a complete transfer.
pub async fn copy_remote_to_local(
    remote_paths: &[PathBuf],
    local_dest: &Path,
    handle: &SshHandle,
    overwrite: bool,
    fail_on_skip: bool,
    dest_names: Option<&[String]>,
    op: Option<&crate::operation::Operation>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let sftp = create_sftp(handle).await?;

    if let Some(op) = op {
        op.progress(app, 0, remote_paths.len());
    }
    if fail_on_skip && !overwrite {
        preflight_download_targets(remote_paths, local_dest, dest_names).await?;
    }
    for (i, remote_path) in remote_paths.iter().enumerate() {
        if let Some(op) = op {
            op.check()?;
        }
        let file_name = item_name(remote_path, i, dest_names)?;
        let local_item = local_dest.join(&file_name);
        let remote_str = remote_path.to_string_lossy().to_string();
        if skip_existing(
            &local_item.to_string_lossy(),
            local_exists(&local_item).await?,
            overwrite,
            fail_on_skip,
        )? {
            continue;
        }

        let stat = sftp
            .metadata(&remote_str)
            .await
            .map_err(|e| format!("Stat {}: {}", remote_path.display(), e))?;

        if stat.is_dir() {
            copy_remote_dir_to_local(&remote_str, &local_item, &sftp, overwrite, fail_on_skip)
                .await?;
        } else {
            copy_remote_file_to_local(&remote_str, &local_item, &sftp).await?;
        }
        if let Some(op) = op {
            op.progress(app, i + 1, remote_paths.len());
        }
    }
    Ok(())
}

async fn copy_local_file_to_remote(
    local_path: &Path,
    remote_path: &str,
    sftp: &SftpSession,
) -> Result<(), String> {
    let mut src = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("Read {}: {}", local_path.display(), e))?;
    check_upload_kind(remote_path, false, remote_kind(sftp, remote_path).await?)?;
    let mut dst = sftp
        .create(remote_path)
        .await
        .map_err(|e| format!("Create {}: {}", remote_path, e))?;
    let mut buf = vec![0u8; COPY_BUF_SIZE];
    loop {
        let n = src
            .read(&mut buf)
            .await
            .map_err(|e| format!("Read {}: {}", local_path.display(), e))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| format!("Write {}: {}", remote_path, e))?;
    }
    dst.flush()
        .await
        .map_err(|e| format!("Flush {}: {}", remote_path, e))?;
    Ok(())
}

fn copy_local_dir_to_remote<'a>(
    local_path: &'a Path,
    remote_path: &'a str,
    sftp: &'a SftpSession,
    overwrite: bool,
    fail_on_skip: bool,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        check_upload_kind(remote_path, true, remote_kind(sftp, remote_path).await?)?;
        if let Err(e) = sftp.create_dir(remote_path).await {
            if remote_kind(sftp, remote_path).await? != Some(true) {
                return Err(format!("Mkdir {}: {}", remote_path, e));
            }
        }

        let mut entries = tokio::fs::read_dir(local_path)
            .await
            .map_err(|e| format!("Readdir {}: {}", local_path.display(), e))?;

        while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
            let name = entry.file_name().to_string_lossy().to_string();
            let local_item = entry.path();
            let remote_item = format!("{}/{}", remote_path, name);
            let is_dir = tokio::fs::metadata(&local_item)
                .await
                .map_err(|e| e.to_string())?
                .is_dir();
            if (!is_dir || fail_on_skip)
                && skip_existing(
                    &remote_item,
                    remote_kind(sftp, &remote_item).await?.is_some(),
                    overwrite,
                    fail_on_skip,
                )?
            {
                continue;
            }
            if is_dir {
                copy_local_dir_to_remote(&local_item, &remote_item, sftp, overwrite, fail_on_skip)
                    .await?;
            } else {
                copy_local_file_to_remote(&local_item, &remote_item, sftp).await?;
            }
        }
        Ok(())
    })
}

async fn copy_remote_file_to_local(
    remote_path: &str,
    local_path: &Path,
    sftp: &SftpSession,
) -> Result<(), String> {
    let mut src = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("Open {}: {}", remote_path, e))?;
    let mut dst = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| format!("Write {}: {}", local_path.display(), e))?;
    let mut buf = vec![0u8; COPY_BUF_SIZE];
    loop {
        let n = src
            .read(&mut buf)
            .await
            .map_err(|e| format!("Read {}: {}", remote_path, e))?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])
            .await
            .map_err(|e| format!("Write {}: {}", local_path.display(), e))?;
    }
    dst.flush()
        .await
        .map_err(|e| format!("Flush {}: {}", local_path.display(), e))
}

fn copy_remote_dir_to_local<'a>(
    remote_path: &'a str,
    local_path: &'a Path,
    sftp: &'a SftpSession,
    overwrite: bool,
    fail_on_skip: bool,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        tokio::fs::create_dir_all(local_path)
            .await
            .map_err(|e| format!("Mkdir {}: {}", local_path.display(), e))?;

        let read_dir = sftp
            .read_dir(remote_path.to_string())
            .await
            .map_err(|e| format!("Readdir {}: {}", remote_path, e))?;

        for entry in read_dir {
            let name = entry.file_name();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }

            let local_item = local_path.join(&name);
            let remote_item = format!("{}/{}", remote_path, name);
            let is_dir = entry.metadata().is_dir();

            if (!is_dir || fail_on_skip)
                && skip_existing(
                    &local_item.to_string_lossy(),
                    local_exists(&local_item).await?,
                    overwrite,
                    fail_on_skip,
                )?
            {
                continue;
            }

            if is_dir {
                copy_remote_dir_to_local(&remote_item, &local_item, sftp, overwrite, fail_on_skip)
                    .await?;
            } else {
                copy_remote_file_to_local(&remote_item, &local_item, sftp).await?;
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "kuf-upload-preflight-{}-{}-{sequence}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn upload_kind_allows_missing_and_matching_destinations_only() {
        for is_dir in [false, true] {
            assert!(check_upload_kind("/target/item", is_dir, None).is_ok());
            assert!(check_upload_kind("/target/item", is_dir, Some(is_dir)).is_ok());
            let error = check_upload_kind("/target/item", is_dir, Some(!is_dir)).unwrap_err();
            assert!(error.contains("/target/item"));
            assert!(error.contains("ファイルとフォルダーの相互置換"));
        }
    }

    #[tokio::test]
    async fn upload_preflight_rejects_both_top_level_type_conflicts_with_renamed_destinations() {
        let fixture = Fixture::new();
        let file = fixture.0.join("original.txt");
        let directory = fixture.0.join("original-dir");
        std::fs::write(&file, "source survives").unwrap();
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("child.txt"), "child survives").unwrap();

        for (source, destination_is_dir) in [(&file, true), (&directory, false)] {
            let names = ["renamed".to_string()];
            let error = preflight_upload(
                &[source.clone()],
                "/target/",
                true,
                false,
                Some(&names),
                None,
                |path| async move {
                    assert_eq!(path, "/target/renamed");
                    Ok(Some(destination_is_dir))
                },
            )
            .await
            .unwrap_err();
            assert!(error.contains("/target/renamed"));
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "source survives");
        assert_eq!(
            std::fs::read_to_string(directory.join("child.txt")).unwrap(),
            "child survives"
        );
    }

    #[tokio::test]
    async fn upload_preflight_rejects_nested_conflict_before_any_transfer() {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("nested/conflict"), "source content").unwrap();
        let mut visited = Vec::new();
        let error = preflight_upload(&[source], "/target", true, false, None, None, |path| {
            visited.push(path.clone());
            let kind = match path.as_str() {
                "/target/source" | "/target/source/nested" | "/target/source/nested/conflict" => {
                    Some(true)
                }
                _ => None,
            };
            std::future::ready(Ok(kind))
        })
        .await
        .unwrap_err();
        assert!(error.contains("/target/source/nested/conflict"));
        assert_eq!(visited.len(), 3);
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("source/nested/conflict")).unwrap(),
            "source content"
        );
    }

    #[tokio::test]
    async fn upload_preflight_allows_directory_merge_and_file_overwrite_but_propagates_stat_errors()
    {
        let fixture = Fixture::new();
        let source = fixture.0.join("source");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("nested/existing.txt"), "overwrite").unwrap();
        std::fs::write(source.join("new.txt"), "new").unwrap();
        let destinations = HashMap::from([
            ("/target/source".to_string(), true),
            ("/target/source/nested".to_string(), true),
            ("/target/source/nested/existing.txt".to_string(), false),
        ]);
        preflight_upload(
            &[source.clone()],
            "/target",
            true,
            false,
            None,
            None,
            |path| std::future::ready(Ok(destinations.get(&path).copied())),
        )
        .await
        .unwrap();

        let error = preflight_upload(&[source], "/target", true, false, None, None, |_| {
            std::future::ready(Err("Permission denied".to_string()))
        })
        .await
        .unwrap_err();
        assert_eq!(error, "Permission denied");
    }

    #[test]
    fn copies_may_skip_existing_items_but_moves_must_abort_instead() {
        // This policy is shared by upload/download, including nested entries.
        for path in [
            "/target/file.txt",
            "/target/nested/file.txt",
            "/target/nested",
        ] {
            assert!(skip_existing(path, true, false, false).unwrap());
            let error = skip_existing(path, true, false, true).unwrap_err();
            assert!(error.contains(path));
            assert!(error.contains("コピー元は削除していません"));
            for fail_on_skip in [false, true] {
                assert!(!skip_existing(path, true, true, fail_on_skip).unwrap());
                assert!(!skip_existing(path, false, false, fail_on_skip).unwrap());
            }
        }
    }

    #[tokio::test]
    async fn strict_upload_refuses_existing_files_and_directories_while_copy_can_skip() {
        let fixture = Fixture::new();
        let file = fixture.0.join("file.txt");
        let directory = fixture.0.join("directory");
        std::fs::write(&file, "source survives").unwrap();
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("child.txt"), "child survives").unwrap();

        for (source, is_dir) in [(&file, false), (&directory, true)] {
            let paths = [source.clone()];
            for strict_move in [false, true] {
                let result =
                    preflight_upload(&paths, "/target", false, strict_move, None, None, |_| {
                        std::future::ready(Ok(Some(is_dir)))
                    })
                    .await;
                assert_eq!(result.is_err(), strict_move);
            }
        }
        assert_eq!(std::fs::read_to_string(file).unwrap(), "source survives");
        assert_eq!(
            std::fs::read_to_string(directory.join("child.txt")).unwrap(),
            "child survives"
        );
    }

    #[tokio::test]
    async fn strict_upload_refuses_nested_conflict_even_if_parent_appears_after_preflight() {
        let fixture = Fixture::new();
        let source = fixture.0.join("directory");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("nested/file.txt"), "source survives").unwrap();
        for (conflict, is_dir) in [
            ("/target/directory/nested", true),
            ("/target/directory/nested/file.txt", false),
        ] {
            let result = preflight_upload(
                &[source.clone()],
                "/target",
                false,
                true,
                None,
                None,
                |path| std::future::ready(Ok((path == conflict).then_some(is_dir))),
            )
            .await;
            assert!(result.unwrap_err().contains(conflict));
        }
        assert_eq!(
            std::fs::read_to_string(source.join("nested/file.txt")).unwrap(),
            "source survives"
        );
    }

    #[tokio::test]
    async fn strict_download_preflights_existing_files_and_directories_without_modifying_them() {
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("existing.txt"), "destination survives").unwrap();
        std::fs::create_dir(fixture.0.join("existing-dir")).unwrap();
        std::fs::write(fixture.0.join("existing-dir/child.txt"), "child survives").unwrap();
        for name in ["existing.txt", "existing-dir"] {
            let remote_paths = [PathBuf::from("/source/original")];
            let names = [name.to_string()];
            let result = preflight_download_targets(&remote_paths, &fixture.0, Some(&names)).await;
            assert!(result.unwrap_err().contains(name));
        }
        preflight_download_targets(&[PathBuf::from("/source/new")], &fixture.0, None)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("existing.txt")).unwrap(),
            "destination survives"
        );
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("existing-dir/child.txt")).unwrap(),
            "child survives"
        );
        assert!(!fixture.0.join("new").exists());
    }
}
