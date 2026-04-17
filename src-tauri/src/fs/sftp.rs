use crate::fs::FileSystem;
use crate::FileInfo;
use ssh2::Session;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub struct SftpFs {
    session: Session,
}

impl SftpFs {
    pub fn new(session: Session) -> Self {
        Self { session }
    }

    fn sftp(&self) -> Result<ssh2::Sftp, String> {
        self.session
            .sftp()
            .map_err(|e| format!("SFTP channel error: {}", e))
    }
}

impl FileSystem for SftpFs {
    fn read_dir(&self, path: &Path) -> Result<Vec<FileInfo>, String> {
        let sftp = self.sftp()?;
        let dir = sftp
            .readdir(path)
            .map_err(|e| format!("SFTP readdir {}: {}", path.display(), e))?;

        let mut files: Vec<FileInfo> = Vec::new();

        for (entry_path, stat) in &dir {
            let name = entry_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.is_empty() || name == "." {
                continue;
            }

            let is_dir = stat.is_dir();
            let is_symlink = stat.file_type() == ssh2::FileType::Symlink;
            let size = if is_dir { 0 } else { stat.size.unwrap_or(0) };
            let is_hidden = name.starts_with('.');

            let extension = if is_dir {
                String::new()
            } else {
                Path::new(&name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default()
            };

            let modified = stat.mtime.map(|t| {
                let dt = chrono::DateTime::from_timestamp(t as i64, 0)
                    .unwrap_or_else(|| chrono::DateTime::UNIX_EPOCH);
                let local_dt: chrono::DateTime<chrono::Local> = dt.into();
                local_dt.format("%Y-%m-%d %H:%M").to_string()
            });

            files.push(FileInfo {
                name,
                is_dir,
                size,
                modified,
                extension,
                is_hidden,
                is_symlink,
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
            },
        );

        Ok(files)
    }

    fn copy_items(&self, sources: &[PathBuf], dest: &Path) -> Result<(), String> {
        let sftp = self.sftp()?;
        for src in sources {
            let file_name = src
                .file_name()
                .ok_or_else(|| format!("Invalid path: {}", src.display()))?;
            let dest_item = dest.join(file_name);

            let stat = sftp
                .stat(src)
                .map_err(|e| format!("Stat {}: {}", src.display(), e))?;

            if stat.is_dir() {
                self.copy_dir_recursive_sftp(&sftp, src, &dest_item)?;
            } else {
                self.copy_file_sftp(&sftp, src, &dest_item)?;
            }
        }
        Ok(())
    }

    fn move_items(&self, sources: &[PathBuf], dest: &Path) -> Result<(), String> {
        let sftp = self.sftp()?;
        for src in sources {
            let file_name = src
                .file_name()
                .ok_or_else(|| format!("Invalid path: {}", src.display()))?;
            let dest_item = dest.join(file_name);

            // Try rename first
            if sftp.rename(src, &dest_item, Some(ssh2::RenameFlags::OVERWRITE)).is_err() {
                // Fall back to copy + delete
                let stat = sftp
                    .stat(src)
                    .map_err(|e| format!("Stat {}: {}", src.display(), e))?;
                if stat.is_dir() {
                    self.copy_dir_recursive_sftp(&sftp, src, &dest_item)?;
                } else {
                    self.copy_file_sftp(&sftp, src, &dest_item)?;
                }
                self.delete_items(&[src.clone()])?;
            }
        }
        Ok(())
    }

    fn delete_items(&self, paths: &[PathBuf]) -> Result<(), String> {
        let sftp = self.sftp()?;
        for path in paths {
            let stat = sftp
                .stat(path)
                .map_err(|e| format!("Stat {}: {}", path.display(), e))?;
            if stat.is_dir() {
                self.remove_dir_recursive_sftp(&sftp, path)?;
            } else {
                sftp.unlink(path)
                    .map_err(|e| format!("Delete {}: {}", path.display(), e))?;
            }
        }
        Ok(())
    }

    fn rename_item(&self, path: &Path, new_name: &str) -> Result<(), String> {
        let sftp = self.sftp()?;
        let parent = path
            .parent()
            .ok_or_else(|| format!("Cannot get parent of: {}", path.display()))?;
        let new_path = parent.join(new_name);
        sftp.rename(path, &new_path, Some(ssh2::RenameFlags::OVERWRITE))
            .map_err(|e| format!("Rename failed: {}", e))
    }

    fn create_dir(&self, path: &Path, name: &str) -> Result<(), String> {
        let sftp = self.sftp()?;
        let dir_path = path.join(name);
        sftp.mkdir(&dir_path, 0o755)
            .map_err(|e| format!("Create dir failed: {}", e))
    }

    fn path_exists(&self, path: &Path) -> Result<bool, String> {
        let sftp = self.sftp()?;
        Ok(sftp.stat(path).is_ok())
    }

    fn read_file_text(&self, path: &Path) -> Result<String, String> {
        let sftp = self.sftp()?;

        let stat = sftp
            .stat(path)
            .map_err(|e| format!("Stat error: {}", e))?;
        let size = stat.size.unwrap_or(0);
        if size > 2 * 1024 * 1024 {
            return Err(format!("File too large ({} bytes, max 2 MB)", size));
        }

        let mut remote_file = sftp
            .open(path)
            .map_err(|e| format!("Open {}: {}", path.display(), e))?;
        let mut content = String::new();
        remote_file
            .read_to_string(&mut content)
            .map_err(|e| format!("Read {}: {}", path.display(), e))?;
        Ok(content)
    }
}

impl SftpFs {
    fn copy_file_sftp(&self, sftp: &ssh2::Sftp, src: &Path, dest: &Path) -> Result<(), String> {
        let mut remote_file = sftp
            .open(src)
            .map_err(|e| format!("Open {}: {}", src.display(), e))?;
        let mut content = Vec::new();
        remote_file
            .read_to_end(&mut content)
            .map_err(|e| format!("Read {}: {}", src.display(), e))?;

        let mut dest_file = sftp
            .create(dest)
            .map_err(|e| format!("Create {}: {}", dest.display(), e))?;
        dest_file
            .write_all(&content)
            .map_err(|e| format!("Write {}: {}", dest.display(), e))?;
        Ok(())
    }

    fn copy_dir_recursive_sftp(
        &self,
        sftp: &ssh2::Sftp,
        src: &Path,
        dest: &Path,
    ) -> Result<(), String> {
        sftp.mkdir(dest, 0o755)
            .map_err(|e| format!("Mkdir {}: {}", dest.display(), e))?;

        let entries = sftp
            .readdir(src)
            .map_err(|e| format!("Readdir {}: {}", src.display(), e))?;

        for (entry_path, stat) in &entries {
            let name = entry_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }

            let dest_item = dest.join(&name);
            if stat.is_dir() {
                self.copy_dir_recursive_sftp(sftp, entry_path, &dest_item)?;
            } else {
                self.copy_file_sftp(sftp, entry_path, &dest_item)?;
            }
        }
        Ok(())
    }

    fn remove_dir_recursive_sftp(&self, sftp: &ssh2::Sftp, path: &Path) -> Result<(), String> {
        let entries = sftp
            .readdir(path)
            .map_err(|e| format!("Readdir {}: {}", path.display(), e))?;

        for (entry_path, stat) in &entries {
            let name = entry_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name == "." || name == ".." {
                continue;
            }

            if stat.is_dir() {
                self.remove_dir_recursive_sftp(sftp, entry_path)?;
            } else {
                sftp.unlink(entry_path)
                    .map_err(|e| format!("Delete {}: {}", entry_path.display(), e))?;
            }
        }

        sftp.rmdir(path)
            .map_err(|e| format!("Rmdir {}: {}", path.display(), e))?;
        Ok(())
    }
}
