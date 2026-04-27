use crate::ssh::connection::SshHandle;
use russh_sftp::client::SftpSession;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

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

/// Copy files from local filesystem to remote (SFTP)
pub async fn copy_local_to_remote(
    local_paths: &[PathBuf],
    remote_dest: &Path,
    handle: &SshHandle,
) -> Result<(), String> {
    let sftp = create_sftp(handle).await?;
    let remote_dest_str = remote_dest.to_string_lossy().to_string();

    for local_path in local_paths {
        let file_name = local_path
            .file_name()
            .ok_or_else(|| format!("Invalid path: {}", local_path.display()))?
            .to_string_lossy()
            .to_string();
        let remote_item = format!("{}/{}", remote_dest_str, file_name);

        if local_path.is_dir() {
            copy_local_dir_to_remote(&local_path, &remote_item, &sftp).await?;
        } else {
            copy_local_file_to_remote(&local_path, &remote_item, &sftp).await?;
        }
    }
    Ok(())
}

/// Copy files from remote (SFTP) to local filesystem
pub async fn copy_remote_to_local(
    remote_paths: &[PathBuf],
    local_dest: &Path,
    handle: &SshHandle,
) -> Result<(), String> {
    let sftp = create_sftp(handle).await?;

    for remote_path in remote_paths {
        let file_name = remote_path
            .file_name()
            .ok_or_else(|| format!("Invalid path: {}", remote_path.display()))?
            .to_string_lossy()
            .to_string();
        let local_item = local_dest.join(&file_name);
        let remote_str = remote_path.to_string_lossy().to_string();

        let stat = sftp
            .metadata(&remote_str)
            .await
            .map_err(|e| format!("Stat {}: {}", remote_path.display(), e))?;

        if stat.is_dir() {
            copy_remote_dir_to_local(&remote_str, &local_item, &sftp).await?;
        } else {
            copy_remote_file_to_local(&remote_str, &local_item, &sftp).await?;
        }
    }
    Ok(())
}

async fn copy_local_file_to_remote(
    local_path: &Path,
    remote_path: &str,
    sftp: &SftpSession,
) -> Result<(), String> {
    let content = std::fs::read(local_path)
        .map_err(|e| format!("Read {}: {}", local_path.display(), e))?;
    sftp.write(remote_path, &content)
        .await
        .map_err(|e| format!("Write {}: {}", remote_path, e))?;
    Ok(())
}

fn copy_local_dir_to_remote<'a>(
    local_path: &'a Path,
    remote_path: &'a str,
    sftp: &'a SftpSession,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
    sftp.create_dir(remote_path)
        .await
        .map_err(|e| format!("Mkdir {}: {}", remote_path, e))?;

    let entries = std::fs::read_dir(local_path)
        .map_err(|e| format!("Readdir {}: {}", local_path.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let local_item = entry.path();
        let remote_item = format!("{}/{}", remote_path, name);

        if local_item.is_dir() {
            copy_local_dir_to_remote(&local_item, &remote_item, sftp).await?;
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
    let content = sftp
        .read(remote_path)
        .await
        .map_err(|e| format!("Read {}: {}", remote_path, e))?;
    std::fs::write(local_path, content)
        .map_err(|e| format!("Write {}: {}", local_path.display(), e))?;
    Ok(())
}

fn copy_remote_dir_to_local<'a>(
    remote_path: &'a str,
    local_path: &'a Path,
    sftp: &'a SftpSession,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
    Box::pin(async move {
    std::fs::create_dir_all(local_path)
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
            copy_remote_dir_to_local(&remote_item, &local_item, sftp).await?;
        } else {
            copy_remote_file_to_local(&remote_item, &local_item, sftp).await?;
        }
    }
    Ok(())
    })
}
