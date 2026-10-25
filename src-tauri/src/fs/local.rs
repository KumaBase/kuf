use crate::format_local_permissions;
use crate::fs::FileSystem;
use crate::FileInfo;
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

            // Detect links without following them so junctions/symlinks can be
            // handled safely on both Unix and Windows.
            let link_metadata = match fs::symlink_metadata(entry.path()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_symlink = link_metadata.is_symlink() || link_metadata.file_type().is_symlink();

            let resolved = if is_symlink {
                fs::metadata(entry.path()).ok()
            } else {
                None
            };
            let effective = resolved.as_ref().unwrap_or(&link_metadata);

            let is_dir = effective.is_dir();
            let size = if is_dir { 0 } else { effective.len() };
            let is_hidden = is_hidden_entry(&name, &link_metadata);
            let permissions = format_local_permissions(&link_metadata);

            let extension = if is_dir {
                String::new()
            } else {
                Path::new(&name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default()
            };

            let (modified, modified_timestamp) = effective
                .modified()
                .ok()
                .map(|t| {
                    let dt: DateTime<Local> = t.into();
                    (
                        dt.format("%Y-%m-%d %H:%M").to_string(),
                        dt.timestamp_millis(),
                    )
                })
                .unzip();

            files.push(FileInfo {
                name,
                is_dir,
                size,
                modified,
                modified_timestamp,
                extension,
                is_hidden,
                is_symlink,
                permissions,
            });
        }

        files.insert(
            0,
            FileInfo {
                name: "..".to_string(),
                is_dir: true,
                size: 0,
                modified: None,
                modified_timestamp: None,
                extension: String::new(),
                is_hidden: false,
                is_symlink: false,
                permissions: String::new(),
            },
        );

        Ok(files)
    }

    fn copy_items(
        &self,
        sources: &[PathBuf],
        dest: &Path,
        overwrite: bool,
        dest_names: Option<&[String]>,
    ) -> Result<(), String> {
        for (i, src) in sources.iter().enumerate() {
            let file_name = dest_name_for(src, i, dest_names)?;
            let dest_item = dest.join(&file_name);
            if would_copy_into_self(src, &dest_item)? {
                return Err(format!("Cannot copy '{}' into itself", src.display()));
            }
            if dest_item.exists() && !overwrite {
                continue;
            }
            if dest_item.exists() {
                let src_dir = src.is_dir();
                let dest_dir = dest_item.is_dir();
                if src_dir != dest_dir {
                    remove_entry(&dest_item)?;
                }
            }
            copy_entry(src, &dest_item)?;
        }
        Ok(())
    }

    fn move_items(
        &self,
        sources: &[PathBuf],
        dest: &Path,
        overwrite: bool,
        dest_names: Option<&[String]>,
    ) -> Result<(), String> {
        for (i, src) in sources.iter().enumerate() {
            let file_name = dest_name_for(src, i, dest_names)?;
            let dest_item = dest.join(&file_name);
            if would_copy_into_self(src, &dest_item)? {
                return Err(format!("Cannot move '{}' into itself", src.display()));
            }
            if dest_item.exists() && !overwrite {
                continue;
            }
            if dest_item.exists() {
                remove_entry(&dest_item)?;
            }
            if fs::rename(src, &dest_item).is_err() {
                copy_entry(src, &dest_item)?;
                remove_entry(src)?;
            }
        }
        Ok(())
    }

    fn delete_items(&self, paths: &[PathBuf]) -> Result<(), String> {
        for path in paths {
            remove_entry(path)?;
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
        validate_item_name(name)?;
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

pub fn validate_item_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err("Invalid name".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err("Name cannot contain path separators".to_string());
    }
    Ok(())
}

fn dest_name_for(
    src: &Path,
    index: usize,
    dest_names: Option<&[String]>,
) -> Result<String, String> {
    if let Some(names) = dest_names {
        if let Some(name) = names.get(index) {
            validate_item_name(name)?;
            return Ok(name.clone());
        }
    }
    src.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("Invalid path: {}", src.display()))
}

fn is_hidden_entry(name: &str, meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        name.starts_with('.') || (meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        name.starts_with('.')
    }
}

fn is_symlink_meta(meta: &fs::Metadata) -> bool {
    meta.is_symlink() || meta.file_type().is_symlink()
}

fn would_copy_into_self(src: &Path, dest_item: &Path) -> Result<bool, String> {
    let src_c = fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    let dest_c = if dest_item.exists() {
        fs::canonicalize(dest_item).unwrap_or_else(|_| dest_item.to_path_buf())
    } else if let Some(parent) = dest_item.parent() {
        let parent_c = fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        parent_c.join(dest_item.file_name().unwrap_or_default())
    } else {
        dest_item.to_path_buf()
    };
    if dest_c == src_c {
        return Ok(true);
    }
    if src_c.is_dir() && dest_c.starts_with(&src_c) {
        return Ok(true);
    }
    if dest_item.exists() {
        return same_file(src, dest_item).map_err(|e| {
            format!(
                "Cannot verify copy/move target '{}': {}",
                dest_item.display(),
                e
            )
        });
    }
    Ok(false)
}

#[cfg(unix)]
fn same_file(src: &Path, dest: &Path) -> std::io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let source = fs::metadata(src)?;
    let target = fs::metadata(dest)?;
    Ok(source.dev() == target.dev() && source.ino() == target.ino())
}

#[cfg(windows)]
fn same_file(src: &Path, dest: &Path) -> std::io::Result<bool> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
    };

    fn identity(path: &Path) -> std::io::Result<(u32, u32, u32)> {
        // Query identity without read/write access or excluding other processes.
        let file = fs::OpenOptions::new()
            .access_mode(0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // The owned File keeps the handle valid throughout the synchronous call.
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
            .map_err(std::io::Error::other)?;
        Ok((
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
        ))
    }

    Ok(identity(src)? == identity(dest)?)
}

#[cfg(not(any(unix, windows)))]
fn same_file(_src: &Path, _dest: &Path) -> std::io::Result<bool> {
    Ok(false)
}

fn copy_entry(src: &Path, dest: &Path) -> Result<(), String> {
    let link_meta =
        fs::symlink_metadata(src).map_err(|e| format!("Stat failed: {}: {}", src.display(), e))?;
    if is_symlink_meta(&link_meta) || link_meta.is_dir() {
        copy_dir_recursive(src, dest)
    } else {
        // Directory merging can also encounter a hard link back to a source file.
        if would_copy_into_self(src, dest)? {
            return Err(format!("Cannot copy '{}' into itself", src.display()));
        }
        fs::copy(src, dest).map(|_| ()).map_err(|e| {
            format!(
                "Copy failed: {} -> {}: {}",
                src.display(),
                dest.display(),
                e
            )
        })
    }
}

fn remove_entry(path: &Path) -> Result<(), String> {
    let is_link = fs::symlink_metadata(path)
        .map(|m| is_symlink_meta(&m))
        .unwrap_or(false);
    if is_link {
        if path.is_dir() {
            fs::remove_dir(path)
                .map_err(|e| format!("Delete link failed: {}: {}", path.display(), e))
        } else {
            fs::remove_file(path)
                .map_err(|e| format!("Delete link failed: {}: {}", path.display(), e))
        }
    } else if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("Delete failed: {}: {}", path.display(), e))
    } else {
        fs::remove_file(path).map_err(|e| format!("Delete failed: {}: {}", path.display(), e))
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
            .map(|m| is_symlink_meta(&m))
            .unwrap_or(false);

        if is_link || src_item.is_dir() {
            copy_dir_recursive(&src_item, &dest_item)?;
        } else {
            copy_entry(&src_item, &dest_item)?;
        }
    }
    Ok(())
}
