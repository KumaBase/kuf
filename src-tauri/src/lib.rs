mod background;
mod config;
mod fs;
mod operation;
mod ssh;
#[cfg(windows)]
mod terminal;
mod workspace;
mod watcher;
mod trash;
mod search;
mod archive;
mod batch_rename;
mod external_commands;
mod preview;
mod opener;

use fs::local::LocalFs;
use fs::FileSystem;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;
use tauri::Manager;

// --- Bookmark state (in-memory, persisted to file) ---

struct Bookmarks(Mutex<Vec<String>>);

struct RemoteSubMenu(Submenu<tauri::Wry>);

#[tauri::command]
fn bookmark_list(state: tauri::State<Bookmarks>) -> Vec<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn bookmark_add(path: String, state: tauri::State<Bookmarks>) -> Result<(), String> {
    let path = normalize_bookmark_path(&path);
    if path.is_empty() {
        return Err("Empty path".to_string());
    }
    let mut bookmarks = state.0.lock().unwrap();
    if !bookmarks.contains(&path) {
        bookmarks.push(path);
    }
    save_bookmarks_to_file(&bookmarks)?;
    Ok(())
}

#[tauri::command]
fn bookmark_remove(path: String, state: tauri::State<Bookmarks>) -> Result<(), String> {
    let mut bookmarks = state.0.lock().unwrap();
    bookmarks.retain(|p| p != &path);
    save_bookmarks_to_file(&bookmarks)?;
    Ok(())
}

// --- Bookmark persistence ---

#[derive(Serialize, Deserialize)]
struct BookmarksFile {
    paths: Vec<String>,
}

fn bookmarks_file_path() -> Result<PathBuf, String> {
    Ok(config::config_dir()?.join("bookmarks.json"))
}

fn bookmarks_toml_path() -> Result<PathBuf, String> {
    Ok(config::config_dir()?.join("bookmarks.toml"))
}

fn normalize_bookmark_path(path: &str) -> String {
    let p = path.trim();
    if p.is_empty() {
        return String::new();
    }
    if is_windows_drive_root(p) {
        return if p.ends_with(['/', '\\']) {
            p.to_string()
        } else {
            format!("{p}\\")
        };
    }
    p.trim_end_matches(['/', '\\']).to_string()
}

fn is_windows_drive_root(path: &str) -> bool {
    let p = path.trim_end_matches(['/', '\\']);
    let b = p.as_bytes();
    b.len() == 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
}

fn load_bookmarks_from_file() -> Vec<String> {
    if let Ok(path) = bookmarks_file_path() {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(paths) = serde_json::from_str::<Vec<String>>(&content) {
                    return paths
                        .into_iter()
                        .map(|p| normalize_bookmark_path(&p))
                        .filter(|p| !p.is_empty())
                        .collect();
                }
            }
        }
    }
    // Older TOML format used Windows paths that can break on `\U` escapes.
    if let Ok(path) = bookmarks_toml_path() {
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(file) = toml::from_str::<BookmarksFile>(&content) {
                    let paths: Vec<String> = file
                        .paths
                        .into_iter()
                        .map(|p| normalize_bookmark_path(&p))
                        .filter(|p| !p.is_empty())
                        .collect();
                    let _ = save_bookmarks_to_file(&paths);
                    return paths;
                }
            }
        }
    }
    Vec::new()
}

fn save_bookmarks_to_file(bookmarks: &[String]) -> Result<(), String> {
    config::ensure_config_dir()?;
    let path = bookmarks_file_path()?;
    let content =
        serde_json::to_string_pretty(bookmarks).map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Write error: {}", e))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileInfo {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    #[serde(default)]
    pub modified_timestamp: Option<i64>,
    pub extension: String,
    pub is_hidden: bool,
    pub is_symlink: bool,
    pub permissions: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DriveInfo {
    pub name: String,
    pub path: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub drive_type: String,
}

// --- Local filesystem commands (delegated to LocalFs) ---

pub fn format_unix_permissions(mode: u32) -> String {
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    let mut s = String::with_capacity(9);
    for (bit, ch) in &bits {
        if mode & *bit != 0 {
            s.push(*ch);
        } else {
            s.push('-');
        }
    }
    s
}

#[cfg(windows)]
pub fn format_local_permissions(meta: &std::fs::Metadata) -> String {
    if meta.permissions().readonly() {
        "r--r--r--".to_string()
    } else {
        "rw-rw-rw-".to_string()
    }
}

#[cfg(unix)]
pub fn format_local_permissions(meta: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    format_unix_permissions(meta.permissions().mode())
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

#[tauri::command]
async fn read_dir(path: String) -> Result<Vec<FileInfo>, String> {
    background::run(move || {
        let local = LocalFs;
        local.read_dir(Path::new(&path))
    })
    .await
}

#[tauri::command]
async fn copy_items(
    sources: Vec<String>,
    dest: String,
    overwrite: bool,
    dest_names: Option<Vec<String>>,
    operation_id: Option<String>,
    operations: tauri::State<'_, operation::Operations>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let op = operations.get(operation_id.as_deref())?;
    background::run(move || {
        let local = LocalFs;
        let src_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
        operation::process_items(&src_paths, op.as_ref(), &app, |src, i| {
            let names = dest_names
                .as_ref()
                .and_then(|names| names.get(i))
                .map(std::slice::from_ref);
            local.copy_items(
                std::slice::from_ref(src),
                Path::new(&dest),
                overwrite,
                names,
            )
        })
    })
    .await
}

#[tauri::command]
async fn move_items(
    sources: Vec<String>,
    dest: String,
    overwrite: bool,
    dest_names: Option<Vec<String>>,
    operation_id: Option<String>,
    operations: tauri::State<'_, operation::Operations>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let op = operations.get(operation_id.as_deref())?;
    background::run(move || {
        let local = LocalFs;
        let src_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
        operation::process_items(&src_paths, op.as_ref(), &app, |src, i| {
            let names = dest_names
                .as_ref()
                .and_then(|names| names.get(i))
                .map(std::slice::from_ref);
            local.move_items(
                std::slice::from_ref(src),
                Path::new(&dest),
                overwrite,
                names,
            )
        })
    })
    .await
}

#[tauri::command]
async fn check_conflicts(
    sources: Vec<String>,
    dest: String,
    dest_names: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    background::run(move || {
        let dest_path = Path::new(&dest);
        let mut conflicts = Vec::new();
        for (i, src) in sources.iter().enumerate() {
            let p = Path::new(src);
            let name = dest_names
                .as_ref()
                .and_then(|n| n.get(i))
                .cloned()
                .or_else(|| p.file_name().map(|n| n.to_string_lossy().to_string()));
            let Some(name) = name else { continue };
            let dest_item = dest_path.join(&name);
            if dest_item.exists() {
                conflicts.push(name);
            }
        }
        Ok(conflicts)
    })
    .await
}

#[tauri::command]
async fn delete_items(
    paths: Vec<String>,
    operation_id: Option<String>,
    operations: tauri::State<'_, operation::Operations>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let op = operations.get(operation_id.as_deref())?;
    background::run(move || {
        let local = LocalFs;
        let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        operation::process_items(&path_bufs, op.as_ref(), &app, |path, _| {
            local.delete_items(std::slice::from_ref(path))
        })
    })
    .await
}

#[tauri::command]
async fn rename_item(path: String, new_name: String) -> Result<(), String> {
    background::run(move || {
        let local = LocalFs;
        local.rename_item(Path::new(&path), &new_name)
    })
    .await
}

#[tauri::command]
async fn create_dir(path: String, name: String) -> Result<(), String> {
    background::run(move || {
        let local = LocalFs;
        local.create_dir(Path::new(&path), &name)
    })
    .await
}

#[tauri::command]
async fn create_file(path: String, name: String) -> Result<(), String> {
    background::run(move || {
        fs::local::validate_item_name(&name)?;
        let file_path = Path::new(&path).join(&name);
        if file_path.exists() {
            return Err(format!("Already exists: {}", name));
        }
        std::fs::write(&file_path, b"").map_err(|e| format!("Create file failed: {}", e))
    })
    .await
}

#[tauri::command]
async fn open_terminal(path: String) -> Result<(), String> {
    background::run(move || {
        #[cfg(windows)]
        {
            terminal::open(Path::new(&path))
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .args(["-a", "Terminal", &path])
                .spawn()
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
            return Ok(());
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let result = std::process::Command::new("x-terminal-emulator")
                .args(["--working-directory", &path])
                .spawn()
                .or_else(|_| {
                    std::process::Command::new("gnome-terminal")
                        .args(["--working-directory", &path])
                        .spawn()
                })
                .or_else(|_| {
                    std::process::Command::new("konsole")
                        .args(["--workdir", &path])
                        .spawn()
                })
                .or_else(|_| {
                    std::process::Command::new("xfce4-terminal")
                        .args(["--working-directory", &path])
                        .spawn()
                })
                .or_else(|_| {
                    std::process::Command::new("xterm")
                        .current_dir(&path)
                        .spawn()
                });
            result.map_err(|e| format!("Failed to open terminal: {}", e))?;
            return Ok(());
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = path;
            Err("Open terminal is not supported on this platform".to_string())
        }
    })
    .await
}

#[tauri::command]
async fn path_exists(path: String) -> Result<bool, String> {
    background::run(move || {
        let local = LocalFs;
        local.path_exists(Path::new(&path))
    })
    .await
}

#[tauri::command]
async fn open_file(path: String) -> Result<(), String> {
    background::run(move || opener::open(&path)).await
}

#[tauri::command]
async fn open_in_editor(path: String, editor: String) -> Result<(), String> {
    background::run(move || {
        let editor = editor.trim().trim_matches('"');
        std::process::Command::new(editor)
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open editor: {}", e))?;
        Ok(())
    })
    .await
}

#[derive(Deserialize)]
struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

#[tauri::command]
fn pick_file(title: Option<String>, filters: Option<Vec<FileFilter>>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = title.as_deref() {
        dialog = dialog.set_title(title);
    }
    if let Some(filters) = filters {
        for filter in filters {
            let exts: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter(&filter.name, &exts);
        }
    }
    dialog.pick_file().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn pick_folder(title: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(title) = title.as_deref() {
        dialog = dialog.set_title(title);
    }
    dialog
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn read_file_text(path: String) -> Result<String, String> {
    background::run(move || {
        let local = LocalFs;
        local.read_file_text(Path::new(&path))
    })
    .await
}

// --- Drive listing ---

#[tauri::command]
async fn list_drives() -> Result<Vec<DriveInfo>, String> {
    background::run(move || {
        #[cfg(windows)]
        {
            return list_drives_windows();
        }
        #[cfg(target_os = "macos")]
        {
            return list_drives_macos();
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            return list_drives_linux();
        }
        #[cfg(not(any(windows, unix)))]
        {
            Ok(Vec::new())
        }
    })
    .await
}

#[cfg(windows)]
fn list_drives_windows() -> Result<Vec<DriveInfo>, String> {
    let mut drives = Vec::new();
    for letter in b'A'..=b'Z' {
        let path = format!("{}:\\", letter as char);
        let p = Path::new(&path);
        if !p.exists() {
            continue;
        }
        let name = format!("{}:", letter as char);
        drives.push(drive_info_for(&path, &name).unwrap_or(DriveInfo {
            name,
            path,
            total_bytes: 0,
            available_bytes: 0,
            drive_type: "Local".to_string(),
        }));
    }
    Ok(drives)
}

#[cfg(target_os = "macos")]
fn list_drives_macos() -> Result<Vec<DriveInfo>, String> {
    let mut drives = Vec::new();
    if let Some(info) = drive_info_for("/", "Macintosh HD") {
        drives.push(info);
    }
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            if let Some(info) = drive_info_for(path.to_string_lossy().as_ref(), &name) {
                drives.push(info);
            }
        }
    }
    Ok(drives)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn list_drives_linux() -> Result<Vec<DriveInfo>, String> {
    let mut drives = Vec::new();
    if let Some(info) = drive_info_for("/", "/") {
        drives.push(info);
    }
    for mount_root in ["/mnt", "/media", "/run/media"] {
        collect_mount_dirs(mount_root, &mut drives, 2);
    }
    Ok(drives)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn collect_mount_dirs(root: &str, drives: &mut Vec<DriveInfo>, depth: usize) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.starts_with('.') {
            continue;
        }
        let path_str = path.to_string_lossy().to_string();
        if let Some(info) = drive_info_for(&path_str, &name) {
            if !drives.iter().any(|d| d.path == info.path) {
                drives.push(info);
            }
        }
        if depth > 1 {
            collect_mount_dirs(&path_str, drives, depth - 1);
        }
    }
}

fn drive_info_for(path: &str, name: &str) -> Option<DriveInfo> {
    let p = Path::new(path);
    let total = fs4::total_space(p).unwrap_or(0);
    let available = fs4::free_space(p).unwrap_or(0);
    Some(DriveInfo {
        name: name.to_string(),
        path: path.to_string(),
        total_bytes: total,
        available_bytes: available,
        drive_type: "Local".to_string(),
    })
}

// --- SSH / SFTP commands ---

#[tauri::command]
async fn ssh_list_hosts() -> Result<Vec<ssh::config::SshHost>, String> {
    ssh::config::load_ssh_config()
}

#[tauri::command]
async fn ssh_connect(
    host: String,
    port: Option<u16>,
    user: Option<String>,
    auth: Option<ssh::connection::AuthMethod>,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let hosts = ssh::config::load_ssh_config()?;
    let host_config =
        hosts
            .iter()
            .find(|h| h.alias == host)
            .cloned()
            .unwrap_or(ssh::config::SshHost {
                alias: host.clone(),
                host_name: Some(host.clone()),
                user: user.clone(),
                port: port.unwrap_or(22),
                identity_file: None,
            });

    let auth_method = auth.unwrap_or(ssh::connection::AuthMethod::Default);
    let handle = state.connect(&host_config, &auth_method).await?;

    // Verify SFTP works
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("SFTP channel test: {}", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTP subsystem: {}", e))?;
    let _sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTP init: {}", e))?;

    rebuild_remote_menu(&app)?;

    Ok(())
}

#[tauri::command]
async fn ssh_disconnect(
    host: String,
    port: Option<u16>,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.disconnect(&host, port.unwrap_or(22))?;
    rebuild_remote_menu(&app)?;
    Ok(())
}

#[tauri::command]
fn ssh_list_connections(
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Vec<ssh::connection::ConnectedServer> {
    state.list_connections()
}

#[tauri::command]
async fn ssh_read_dir(
    host: String,
    port: Option<u16>,
    path: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<Vec<FileInfo>, String> {
    let handle = state
        .get(&host, port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", host))?;
    fs::sftp::SftpFs::read_dir(&handle, Path::new(&path)).await
}

#[tauri::command]
async fn ssh_delete_items(
    host: String,
    port: Option<u16>,
    paths: Vec<String>,
    operation_id: Option<String>,
    operations: tauri::State<'_, operation::Operations>,
    app: tauri::AppHandle,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let op = operations.get(operation_id.as_deref())?;
    let handle = state
        .get(&host, port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", host))?;
    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    fs::sftp::SftpFs::delete_items(&handle, &path_bufs, op.as_ref(), &app).await
}

#[tauri::command]
async fn ssh_rename_item(
    host: String,
    port: Option<u16>,
    path: String,
    new_name: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let handle = state
        .get(&host, port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", host))?;
    fs::sftp::SftpFs::rename_item(&handle, Path::new(&path), &new_name).await
}

#[tauri::command]
async fn ssh_create_dir(
    host: String,
    port: Option<u16>,
    path: String,
    name: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let handle = state
        .get(&host, port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", host))?;
    fs::sftp::SftpFs::create_dir(&handle, Path::new(&path), &name).await
}

#[tauri::command]
async fn ssh_create_file(
    host: String,
    port: Option<u16>,
    path: String,
    name: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let handle = state
        .get(&host, port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", host))?;
    fs::sftp::SftpFs::create_file(&handle, Path::new(&path), &name).await
}

#[tauri::command]
async fn ssh_path_exists(
    host: String,
    port: Option<u16>,
    path: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<bool, String> {
    let handle = state
        .get(&host, port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", host))?;
    fs::sftp::SftpFs::path_exists(&handle, Path::new(&path)).await
}

#[tauri::command]
async fn ssh_read_file_text(
    host: String,
    port: Option<u16>,
    path: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<String, String> {
    let handle = state
        .get(&host, port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", host))?;
    fs::sftp::SftpFs::read_file_text(&handle, Path::new(&path)).await
}

#[tauri::command]
async fn ssh_accept_host(
    challenge_id: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    state.accept_host(&challenge_id)
}

// --- Cross-filesystem transfer commands ---

#[tauri::command]
async fn ssh_copy_to_remote(
    local_paths: Vec<String>,
    remote_host: String,
    remote_port: Option<u16>,
    remote_path: String,
    overwrite: bool,
    dest_names: Option<Vec<String>>,
    operation_id: Option<String>,
    operations: tauri::State<'_, operation::Operations>,
    app: tauri::AppHandle,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let op = operations.get(operation_id.as_deref())?;
    let handle = state
        .get(&remote_host, remote_port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", remote_host))?;
    let local_path_bufs: Vec<PathBuf> = local_paths.iter().map(PathBuf::from).collect();
    fs::transfer::copy_local_to_remote(
        &local_path_bufs,
        Path::new(&remote_path),
        &handle,
        overwrite,
        false,
        dest_names.as_deref(),
        op.as_ref(),
        &app,
    )
    .await
}

#[tauri::command]
async fn ssh_copy_from_remote(
    remote_host: String,
    remote_port: Option<u16>,
    remote_paths: Vec<String>,
    local_path: String,
    overwrite: bool,
    dest_names: Option<Vec<String>>,
    operation_id: Option<String>,
    operations: tauri::State<'_, operation::Operations>,
    app: tauri::AppHandle,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let op = operations.get(operation_id.as_deref())?;
    let handle = state
        .get(&remote_host, remote_port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", remote_host))?;
    let remote_path_bufs: Vec<PathBuf> = remote_paths.iter().map(PathBuf::from).collect();
    fs::transfer::copy_remote_to_local(
        &remote_path_bufs,
        Path::new(&local_path),
        &handle,
        overwrite,
        false,
        dest_names.as_deref(),
        op.as_ref(),
        &app,
    )
    .await
}

#[tauri::command]
async fn ssh_move_to_remote(
    local_paths: Vec<String>,
    remote_host: String,
    remote_port: Option<u16>,
    remote_path: String,
    overwrite: bool,
    dest_names: Option<Vec<String>>,
    operation_id: Option<String>,
    operations: tauri::State<'_, operation::Operations>,
    app: tauri::AppHandle,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let op = operations.get(operation_id.as_deref())?;
    let handle = state
        .get(&remote_host, remote_port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", remote_host))?;
    let local_path_bufs: Vec<PathBuf> = local_paths.iter().map(PathBuf::from).collect();
    fs::transfer::copy_local_to_remote(
        &local_path_bufs,
        Path::new(&remote_path),
        &handle,
        overwrite,
        true,
        dest_names.as_deref(),
        op.as_ref(),
        &app,
    )
    .await?;
    if let Some(op) = &op {
        op.check()?;
    }
    background::run(move || LocalFs.delete_items(&local_path_bufs)).await?;
    Ok(())
}

#[tauri::command]
async fn ssh_move_from_remote(
    remote_host: String,
    remote_port: Option<u16>,
    remote_paths: Vec<String>,
    local_path: String,
    overwrite: bool,
    dest_names: Option<Vec<String>>,
    operation_id: Option<String>,
    operations: tauri::State<'_, operation::Operations>,
    app: tauri::AppHandle,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let op = operations.get(operation_id.as_deref())?;
    let handle = state
        .get(&remote_host, remote_port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", remote_host))?;
    let remote_path_bufs: Vec<PathBuf> = remote_paths.iter().map(PathBuf::from).collect();
    fs::transfer::copy_remote_to_local(
        &remote_path_bufs,
        Path::new(&local_path),
        &handle,
        overwrite,
        true,
        dest_names.as_deref(),
        op.as_ref(),
        &app,
    )
    .await?;
    if let Some(op) = &op {
        op.check()?;
    }
    fs::sftp::SftpFs::delete_items(&handle, &remote_path_bufs, None, &app).await?;
    Ok(())
}

fn rebuild_remote_menu(app: &tauri::AppHandle) -> Result<(), String> {
    let conn_mgr = app.state::<ssh::connection::ConnectionManager>();
    let connections = conn_mgr.list_connections();

    let remote_menu = app.state::<RemoteSubMenu>();

    // Remove all dynamic items (after the 2 base items: Connect, Disconnect)
    loop {
        let items = remote_menu.0.items().map_err(|e| e.to_string())?;
        if items.len() <= 2 {
            break;
        }
        if let Some(last) = items.last() {
            remote_menu.0.remove(last).map_err(|e| e.to_string())?;
        }
    }

    // Add dynamic items if there are connections
    if !connections.is_empty() {
        let sep = PredefinedMenuItem::separator(app).map_err(|e| format!("Separator: {}", e))?;
        remote_menu.0.append(&sep).map_err(|e| e.to_string())?;

        for server in &connections {
            let id = format!("ssh_server:{}:{}", server.alias, server.port);
            let label = format!("{} ({})", server.alias, server.user);
            let item = MenuItem::with_id(app, &id, label, true, None::<&str>)
                .map_err(|e| format!("Menu item: {}", e))?;
            remote_menu.0.append(&item).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Apply window size from settings
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(settings) = config::settings_load() {
                    let _ = window.set_size(tauri::LogicalSize::new(
                        settings.window.width,
                        settings.window.height,
                    ));
                }
            }

            let remote_submenu = Submenu::with_items(
                app,
                "Remote",
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        "ssh_connect",
                        "Connect to Server...",
                        true,
                        None::<&str>,
                    )?,
                    &MenuItem::with_id(app, "ssh_disconnect", "Disconnect", true, None::<&str>)?,
                ],
            )?;
            app.manage(RemoteSubMenu(remote_submenu));
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-event", event.id().as_ref());
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<watcher::DirectoryWatchState>().stop();
            }
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Ok(size) = window.inner_size() {
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let logical = size.to_logical(scale);
                    if let Ok(mut settings) = config::settings_load() {
                        settings.window.width = logical.width;
                        settings.window.height = logical.height;
                        let _ = config::settings_save(settings);
                    }
                }
            }
        })
        .manage(Bookmarks(Mutex::new(load_bookmarks_from_file())))
        .manage(ssh::connection::ConnectionManager::new())
        .manage(operation::Operations::default())
        .manage(watcher::DirectoryWatchState::default())
        .manage(search::SearchState::default())
        .invoke_handler(tauri::generate_handler![
            search::search_begin,
            search::search_cancel,
            search::search_files,
            archive::zip_create,
            archive::zip_extract,
            batch_rename::batch_rename_items,
            external_commands::external_commands_load,
            external_commands::external_commands_save,
            external_commands::external_command_run,
            preview::read_preview,
            preview::ssh_read_preview,
            watcher::watch_directories,
            trash::trash_items,
            workspace::workspace_load,
            workspace::workspace_save_session,
            workspace::workspace_save_named,
            workspace::workspace_remove,
            operation::operation_begin,
            operation::operation_cancel,
            operation::operation_end,
            home_dir,
            read_dir,
            copy_items,
            check_conflicts,
            move_items,
            delete_items,
            rename_item,
            create_dir,
            create_file,
            path_exists,
            open_file,
            open_in_editor,
            pick_file,
            pick_folder,
            open_terminal,
            read_file_text,
            list_drives,
            bookmark_list,
            bookmark_add,
            bookmark_remove,
            config::settings_load,
            config::settings_defaults,
            config::keybinds_defaults,
            config::settings_save,
            config::settings_reset,
            config::keybinds_load,
            config::keybinds_save,
            config::keybinds_reset,
            config::config_dir_path,
            ssh_list_hosts,
            ssh_connect,
            ssh_disconnect,
            ssh_list_connections,
            ssh_read_dir,
            ssh_delete_items,
            ssh_rename_item,
            ssh_create_dir,
            ssh_create_file,
            ssh_path_exists,
            ssh_read_file_text,
            ssh_accept_host,
            ssh_copy_to_remote,
            ssh_copy_from_remote,
            ssh_move_to_remote,
            ssh_move_from_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
