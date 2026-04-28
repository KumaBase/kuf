use crate::fs::FileSystem;
use crate::FileInfo;
use crate::format_local_permissions;
use chrono::{DateTime, Local};
use std::fs;
use std::path::{Path, PathBuf};

pub struct LocalFs;

impl FileSystem for LocalFs {
    fn read_dir(&self, path: &Path) -> Result<Vec<FileInfo>, String> {
        if !path.is_dir() {
            return Err(format!("Not a directory: {}", path.display()));
        }

        let mut files: Vec<FileInfo> = Vec::new();
        let entries = fs::read_dir(path).map_err(|e| e.to_string())?;

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            let name = entry.file_name().to_string_lossy().to_string();
            let is_hidden = name.starts_with('.');

            // Detect links without following them so junctions/symlinks can be
            // handled safely on both Unix and Windows.
            let link_metadata = match fs::symlink_metadata(entry.path()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_symlink = link_metadata.is_symlink()
                || link_metadata.file_type().is_symlink();

            let resolved = if is_symlink {
                fs::metadata(entry.path()).ok()
            } else {
                None
            };
            let effective = resolved.as_ref().unwrap_or(&link_metadata);

            let is_dir = effective.is_dir();
            let size = if is_dir { 0 } else { effective.len() };
            let permissions = format_local_permissions(&link_metadata);

            let extension = if is_dir {
                String::new()
            } else {
                Path::new(&name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default()
            };

            let modified = effective.modified().ok().map(|t| {
                let dt: DateTime<Local> = t.into();
                dt.format("%Y-%m-%d %H:%M").to_string()
            });

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

    fn copy_items(&self, sources: &[PathBuf], dest: &Path) -> Result<(), String> {
        for src in sources {
            let file_name = src
                .file_name()
                .ok_or_else(|| format!("Invalid path: {}", src.display()))?;
            let dest_item = dest.join(file_name);

            if src.is_dir() {
                copy_dir_recursive(src, &dest_item)?;
            } else {
                fs::copy(src, &dest_item)
                    .map_err(|e| format!("Copy failed: {} -> {}: {}", src.display(), dest.display(), e))?;
            }
        }
        Ok(())
    }

    fn move_items(&self, sources: &[PathBuf], dest: &Path) -> Result<(), String> {
        for src in sources {
            let file_name = src
                .file_name()
                .ok_or_else(|| format!("Invalid path: {}", src.display()))?;
            let dest_item = dest.join(file_name);

            if fs::rename(src, &dest_item).is_err() {
                if src.is_dir() {
                    copy_dir_recursive(src, &dest_item)?;
                } else {
                    fs::copy(src, &dest_item)
                        .map_err(|e| format!("Move copy failed: {}", e))?;
                }
                if src.is_dir() {
                    fs::remove_dir_all(src).map_err(|e| e.to_string())?;
                } else {
                    fs::remove_file(src).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    fn delete_items(&self, paths: &[PathBuf]) -> Result<(), String> {
        for path in paths {
            let is_link = fs::symlink_metadata(path)
                .map(|m| m.is_symlink() || m.file_type().is_symlink())
                .unwrap_or(false);

            if is_link {
                if path.is_dir() {
                    fs::remove_dir(path)
                        .map_err(|e| format!("Delete link failed: {}: {}", path.display(), e))?;
                } else {
                    fs::remove_file(path)
                        .map_err(|e| format!("Delete link failed: {}: {}", path.display(), e))?;
                }
            } else if path.is_dir() {
                fs::remove_dir_all(path)
                    .map_err(|e| format!("Delete failed: {}: {}", path.display(), e))?;
            } else {
                fs::remove_file(path)
                    .map_err(|e| format!("Delete failed: {}: {}", path.display(), e))?;
            }
        }
        Ok(())
    }

    fn rename_item(&self, path: &Path, new_name: &str) -> Result<(), String> {
        let parent = path
            .parent()
            .ok_or_else(|| format!("Cannot get parent of: {}", path.display()))?;
        let new_path = parent.join(new_name);
        fs::rename(path, &new_path).map_err(|e| format!("Rename failed: {}", e))
    }

    fn create_dir(&self, path: &Path, name: &str) -> Result<(), String> {
        let dir_path = path.join(name);
        fs::create_dir(&dir_path).map_err(|e| format!("Create dir failed: {}", e))
    }

    fn path_exists(&self, path: &Path) -> Result<bool, String> {
        Ok(path.exists())
    }

    fn read_file_text(&self, path: &Path) -> Result<String, String> {
        if !path.exists() {
            return Err("File not found".into());
        }
        if path.is_dir() {
            return Err("Is a directory".into());
        }
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        if metadata.len() > 2 * 1024 * 1024 {
            return Err(format!(
                "File too large ({} bytes, max 2 MB)",
                metadata.len()
            ));
        }
        fs::read_to_string(path).map_err(|e| format!("Failed to read: {}", e))
    }
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    if let Ok(link_meta) = fs::symlink_metadata(src) {
        if link_meta.is_symlink() || link_meta.file_type().is_symlink() {
            let target = fs::read_link(src)
                .map_err(|e| format!("Read link failed: {}: {}", src.display(), e))?;
            #[cfg(target_os = "windows")]
            {
                if target.is_dir() || src.is_dir() {
                    std::os::windows::fs::symlink_dir(&target, dest)
                        .map_err(|e| format!("Create junction/symlink failed: {}", e))?;
                } else {
                    std::os::windows::fs::symlink_file(&target, dest)
                        .map_err(|e| format!("Create symlink failed: {}", e))?;
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                std::os::unix::fs::symlink(&target, dest)
                    .map_err(|e| format!("Create symlink failed: {}", e))?;
            }
            return Ok(());
        }
    }

    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_item = entry.path();
        let dest_item = dest.join(entry.file_name());
        let is_link = fs::symlink_metadata(&src_item)
            .map(|m| m.is_symlink() || m.file_type().is_symlink())
            .unwrap_or(false);

        if is_link || src_item.is_dir() {
            copy_dir_recursive(&src_item, &dest_item)?;
        } else {
            fs::copy(&src_item, &dest_item)
                .map_err(|e| format!("Copy failed: {}: {}", src_item.display(), e))?;
        }
    }
    Ok(())
}
