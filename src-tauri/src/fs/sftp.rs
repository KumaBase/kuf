use crate::ssh::connection::SshHandle;
use crate::FileInfo;
use russh_sftp::client::SftpSession;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

pub struct SftpFs;

impl SftpFs {
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

    fn format_permissions(perm: &russh_sftp::protocol::FilePermissions) -> String {
        let mut s = String::with_capacity(9);
        s.push(if perm.owner_read { 'r' } else { '-' });
        s.push(if perm.owner_write { 'w' } else { '-' });
        s.push(if perm.owner_exec { 'x' } else { '-' });
        s.push(if perm.group_read { 'r' } else { '-' });
        s.push(if perm.group_write { 'w' } else { '-' });
        s.push(if perm.group_exec { 'x' } else { '-' });
        s.push(if perm.other_read { 'r' } else { '-' });
        s.push(if perm.other_write { 'w' } else { '-' });
        s.push(if perm.other_exec { 'x' } else { '-' });
        s
    }

    pub async fn read_dir(
        handle: &SshHandle,
        path: &Path,
    ) -> Result<Vec<FileInfo>, String> {
        let sftp = Self::create_sftp(handle).await?;
        let read_dir = sftp
            .read_dir(path.to_string_lossy().to_string())
            .await
            .map_err(|e| format!("SFTP read_dir {}: {}", path.display(), e))?;

        let mut files: Vec<FileInfo> = Vec::new();

        for entry in read_dir {
            let name = entry.file_name();
            if name.is_empty() || name == "." {
                continue;
            }

            let metadata = entry.metadata();
            let is_dir = metadata.is_dir();
            let is_symlink = metadata.is_symlink();
            let size = if is_dir { 0 } else { metadata.len() };
            let is_hidden = name.starts_with('.');

            let extension = if is_dir {
                String::new()
            } else {
                Path::new(&name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default()
            };

            let modified = metadata.modified().ok().map(|t| {
                let duration = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                let dt = chrono::DateTime::from_timestamp(duration.as_secs() as i64, 0)
                    .unwrap_or_else(|| chrono::DateTime::UNIX_EPOCH);
                let local_dt: chrono::DateTime<chrono::Local> = dt.into();
                local_dt.format("%Y-%m-%d %H:%M").to_string()
            });

            let permissions = Self::format_permissions(&metadata.permissions());

            files.push(FileInfo {
                name,
                is_dir,
                size,
                modified,
                extension,
                is_hidden,
                is_symlink,
                permissions,
            });
        }

        files.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        files.insert(
            0,
            FileInfo {
                name: "..".to_string(),
                is_dir: true,
                size: 0,
                modified: None,
                extension: String::new(),
                is_hidden: false,
                is_symlink: false,
                permissions: String::new(),
            },
        );

        Ok(files)
    }

    pub async fn delete_items(
        handle: &SshHandle,
        paths: &[PathBuf],
    ) -> Result<(), String> {
        let sftp = Self::create_sftp(handle).await?;
        for path in paths {
            let path_str = path.to_string_lossy().to_string();
            let metadata = sftp
                .metadata(&path_str)
                .await
                .map_err(|e| format!("Stat {}: {}", path.display(), e))?;
            if metadata.is_dir() {
                remove_dir_recursive(&sftp, &path_str).await?;
            } else {
                sftp.remove_file(&path_str)
                    .await
                    .map_err(|e| format!("Delete {}: {}", path.display(), e))?;
            }
        }
        Ok(())
    }

    pub async fn rename_item(
        handle: &SshHandle,
        path: &Path,
        new_name: &str,
    ) -> Result<(), String> {
        let sftp = Self::create_sftp(handle).await?;
        let parent = path
            .parent()
            .ok_or_else(|| format!("Cannot get parent of: {}", path.display()))?;
        let new_path = parent.join(new_name);
        sftp.rename(path.to_string_lossy().to_string(), new_path.to_string_lossy().to_string())
            .await
            .map_err(|e| format!("Rename failed: {}", e))
    }

    pub async fn create_dir(
        handle: &SshHandle,
        path: &Path,
        name: &str,
    ) -> Result<(), String> {
        let sftp = Self::create_sftp(handle).await?;
        let dir_path = path.join(name);
        sftp.create_dir(dir_path.to_string_lossy().to_string())
            .await
            .map_err(|e| format!("Create dir failed: {}", e))
    }

    pub async fn path_exists(
        handle: &SshHandle,
        path: &Path,
    ) -> Result<bool, String> {
        let sftp = Self::create_sftp(handle).await?;
        sftp.try_exists(path.to_string_lossy().to_string())
            .await
            .map_err(|e| format!("Exists check: {}", e))
    }

    pub async fn read_file_text(
        handle: &SshHandle,
        path: &Path,
    ) -> Result<String, String> {
        let sftp = Self::create_sftp(handle).await?;
        let path_str = path.to_string_lossy().to_string();

        let metadata = sftp
            .metadata(&path_str)
            .await
            .map_err(|e| format!("Stat error: {}", e))?;
        let size = metadata.len();
        if size > 2 * 1024 * 1024 {
            return Err(format!("File too large ({} bytes, max 2 MB)", size));
        }

        let content = sftp
            .read(&path_str)
            .await
            .map_err(|e| format!("Read {}: {}", path.display(), e))?;
        String::from_utf8(content)
            .map_err(|e| format!("UTF-8 decode: {}", e))
    }
}

fn remove_dir_recursive<'a>(
    sftp: &'a SftpSession,
    path: &'a str,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
    let read_dir = sftp
        .read_dir(path.to_string())
        .await
        .map_err(|e| format!("Readdir {}: {}", path, e))?;

    for entry in read_dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }

        let child_path = if path.ends_with('/') {
            format!("{}{}", path, name)
        } else {
            format!("{}/{}", path, name)
        };

        if entry.metadata().is_dir() {
            remove_dir_recursive(sftp, &child_path).await?;
        } else {
            sftp.remove_file(&child_path)
                .await
                .map_err(|e| format!("Delete {}: {}", child_path, e))?;
        }
    }

    sftp.remove_dir(path)
        .await
        .map_err(|e| format!("Rmdir {}: {}", path, e))?;
    Ok(())
    })
}
