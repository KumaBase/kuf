use ssh2::Session;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Copy files from local filesystem to remote (SFTP)
pub fn copy_local_to_remote(
    local_paths: &[PathBuf],
    remote_dest: &Path,
    session: &Session,
) -> Result<(), String> {
    let sftp_channel = session
        .sftp()
        .map_err(|e| format!("SFTP channel: {}", e))?;

    for local_path in local_paths {
        let file_name = local_path
            .file_name()
            .ok_or_else(|| format!("Invalid path: {}", local_path.display()))?;
        let remote_item = remote_dest.join(file_name);

        if local_path.is_dir() {
            copy_local_dir_to_remote(&local_path, &remote_item, &sftp_channel)?;
        } else {
            copy_local_file_to_remote(&local_path, &remote_item, &sftp_channel)?;
        }
    }
    Ok(())
}

/// Copy files from remote (SFTP) to local filesystem
pub fn copy_remote_to_local(
    remote_paths: &[PathBuf],
    local_dest: &Path,
    session: &Session,
) -> Result<(), String> {
    let sftp_channel = session
        .sftp()
        .map_err(|e| format!("SFTP channel: {}", e))?;

    for remote_path in remote_paths {
        let file_name = remote_path
            .file_name()
            .ok_or_else(|| format!("Invalid path: {}", remote_path.display()))?;
        let local_item = local_dest.join(file_name);

        let stat = sftp_channel
            .stat(remote_path)
            .map_err(|e| format!("Stat {}: {}", remote_path.display(), e))?;

        if stat.is_dir() {
            copy_remote_dir_to_local(&remote_path, &local_item, &sftp_channel)?;
        } else {
            copy_remote_file_to_local(&remote_path, &local_item, &sftp_channel)?;
        }
    }
    Ok(())
}

fn copy_local_file_to_remote(
    local_path: &Path,
    remote_path: &Path,
    sftp: &ssh2::Sftp,
) -> Result<(), String> {
    let content = std::fs::read(local_path)
        .map_err(|e| format!("Read {}: {}", local_path.display(), e))?;

    let mut remote_file = sftp
        .create(remote_path)
        .map_err(|e| format!("Create {}: {}", remote_path.display(), e))?;
    remote_file
        .write_all(&content)
        .map_err(|e| format!("Write {}: {}", remote_path.display(), e))?;
    Ok(())
}

fn copy_local_dir_to_remote(
    local_path: &Path,
    remote_path: &Path,
    sftp: &ssh2::Sftp,
) -> Result<(), String> {
    sftp.mkdir(remote_path, 0o755)
        .map_err(|e| format!("Mkdir {}: {}", remote_path.display(), e))?;

    let entries = std::fs::read_dir(local_path)
        .map_err(|e| format!("Readdir {}: {}", local_path.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let local_item = entry.path();
        let remote_item = remote_path.join(&name);

        if local_item.is_dir() {
            copy_local_dir_to_remote(&local_item, &remote_item, sftp)?;
        } else {
            copy_local_file_to_remote(&local_item, &remote_item, sftp)?;
        }
    }
    Ok(())
}

fn copy_remote_file_to_local(
    remote_path: &Path,
    local_path: &Path,
    sftp: &ssh2::Sftp,
) -> Result<(), String> {
    let mut remote_file = sftp
        .open(remote_path)
        .map_err(|e| format!("Open {}: {}", remote_path.display(), e))?;
    let mut content = Vec::new();
    remote_file
        .read_to_end(&mut content)
        .map_err(|e| format!("Read {}: {}", remote_path.display(), e))?;

    std::fs::write(local_path, content)
        .map_err(|e| format!("Write {}: {}", local_path.display(), e))?;
    Ok(())
}

fn copy_remote_dir_to_local(
    remote_path: &Path,
    local_path: &Path,
    sftp: &ssh2::Sftp,
) -> Result<(), String> {
    std::fs::create_dir_all(local_path)
        .map_err(|e| format!("Mkdir {}: {}", local_path.display(), e))?;

    let entries = sftp
        .readdir(remote_path)
        .map_err(|e| format!("Readdir {}: {}", remote_path.display(), e))?;

    for (entry_path, stat) in &entries {
        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }

        let local_item = local_path.join(&name);

        if stat.is_dir() {
            copy_remote_dir_to_local(entry_path, &local_item, sftp)?;
        } else {
            copy_remote_file_to_local(entry_path, &local_item, sftp)?;
        }
    }
    Ok(())
}
