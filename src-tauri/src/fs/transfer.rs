use crate::ssh::connection::SshHandle;
use russh_sftp::client::SftpSession;
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

async fn remote_exists(sftp: &SftpSession, path: &str) -> bool {
    sftp.try_exists(path.to_string()).await.unwrap_or(false)
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

/// Copy files from local filesystem to remote (SFTP)
pub async fn copy_local_to_remote(
    local_paths: &[PathBuf],
    remote_dest: &Path,
    handle: &SshHandle,
    overwrite: bool,
    dest_names: Option<&[String]>,
    op: Option<&crate::operation::Operation>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let sftp = create_sftp(handle).await?;
    let remote_dest_str = remote_dest.to_string_lossy().to_string();

    if let Some(op) = op {
        op.progress(app, 0, local_paths.len());
    }
    for (i, local_path) in local_paths.iter().enumerate() {
        if let Some(op) = op {
            op.check()?;
        }
        let file_name = item_name(local_path, i, dest_names)?;
        let remote_item = format!("{}/{}", remote_dest_str.trim_end_matches('/'), file_name);
        if !overwrite && remote_exists(&sftp, &remote_item).await {
            continue;
        }
        if tokio::fs::metadata(local_path)
            .await
            .map_err(|e| e.to_string())?
            .is_dir()
        {
            copy_local_dir_to_remote(local_path, &remote_item, &sftp, overwrite).await?;
        } else {
            copy_local_file_to_remote(local_path, &remote_item, &sftp).await?;
        }
        if let Some(op) = op {
            op.progress(app, i + 1, local_paths.len());
        }
    }
    Ok(())
}

/// Copy files from remote (SFTP) to local filesystem
pub async fn copy_remote_to_local(
    remote_paths: &[PathBuf],
    local_dest: &Path,
    handle: &SshHandle,
    overwrite: bool,
    dest_names: Option<&[String]>,
    op: Option<&crate::operation::Operation>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let sftp = create_sftp(handle).await?;

    if let Some(op) = op {
        op.progress(app, 0, remote_paths.len());
    }
    for (i, remote_path) in remote_paths.iter().enumerate() {
        if let Some(op) = op {
            op.check()?;
        }
        let file_name = item_name(remote_path, i, dest_names)?;
        let local_item = local_dest.join(&file_name);
        let remote_str = remote_path.to_string_lossy().to_string();
        if !overwrite && tokio::fs::try_exists(&local_item).await.unwrap_or(false) {
            continue;
        }

        let stat = sftp
            .metadata(&remote_str)
            .await
            .map_err(|e| format!("Stat {}: {}", remote_path.display(), e))?;

        if stat.is_dir() {
            copy_remote_dir_to_local(&remote_str, &local_item, &sftp, overwrite).await?;
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
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
        if let Err(e) = sftp.create_dir(remote_path).await {
            if !remote_exists(sftp, remote_path).await {
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
            if !overwrite && remote_exists(sftp, &remote_item).await && !is_dir {
                continue;
            }
            if is_dir {
                copy_local_dir_to_remote(&local_item, &remote_item, sftp, overwrite).await?;
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

            if entry.metadata().is_dir() {
                copy_remote_dir_to_local(&remote_item, &local_item, sftp, overwrite).await?;
            } else {
                if !overwrite && tokio::fs::try_exists(&local_item).await.unwrap_or(false) {
                    continue;
                }
                copy_remote_file_to_local(&remote_item, &local_item, sftp).await?;
            }
        }
        Ok(())
    })
}
