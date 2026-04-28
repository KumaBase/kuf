mod config;
mod fs;
mod ssh;

use fs::local::LocalFs;
use fs::FileSystem;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::Emitter;
use tauri::Manager;

// --- Bookmark state (in-memory, persisted to file) ---

struct Bookmarks(Mutex<Vec<String>>);

#[tauri::command]
fn bookmark_list(state: tauri::State<Bookmarks>) -> Vec<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn bookmark_add(path: String, state: tauri::State<Bookmarks>) -> Result<(), String> {
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
    Ok(config::config_dir()?.join("bookmarks.toml"))
}

fn load_bookmarks_from_file() -> Vec<String> {
    let path = match bookmarks_file_path() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    if !path.exists() {
        return Vec::new();
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    toml::from_str::<BookmarksFile>(&content)
        .map(|f| f.paths)
        .unwrap_or_default()
}

fn save_bookmarks_to_file(bookmarks: &[String]) -> Result<(), String> {
    config::ensure_config_dir()?;
    let path = bookmarks_file_path()?;
    let content = toml::to_string_pretty(&BookmarksFile {
        paths: bookmarks.to_vec(),
    })
    .map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, content).map_err(|e| format!("Write error: {}", e))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileInfo {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<String>,
    pub extension: String,
    pub is_hidden: bool,
    pub is_symlink: bool,
    pub permissions: String,
}

// --- Local filesystem commands (delegated to LocalFs) ---

pub fn format_unix_permissions(mode: u32) -> String {
    let bits = [
        (0o400, 'r'), (0o200, 'w'), (0o100, 'x'),
        (0o040, 'r'), (0o020, 'w'), (0o010, 'x'),
        (0o004, 'r'), (0o002, 'w'), (0o001, 'x'),
    ];
    let mut s = String::with_capacity(9);
    for (bit, ch) in &bits {
        if mode & *bit != 0 { s.push(*ch); } else { s.push('-'); }
    }
    s
}

#[cfg(windows)]
pub fn format_local_permissions(meta: &std::fs::Metadata) -> String {
    if meta.permissions().readonly() { "r--r--r--".to_string() } else { "rw-rw-rw-".to_string() }
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
fn read_dir(path: String) -> Result<Vec<FileInfo>, String> {
    let local = LocalFs;
    local.read_dir(Path::new(&path))
}

#[tauri::command]
fn copy_items(sources: Vec<String>, dest: String) -> Result<(), String> {
    let local = LocalFs;
    let src_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    local.copy_items(&src_paths, Path::new(&dest))
}

#[tauri::command]
fn move_items(sources: Vec<String>, dest: String) -> Result<(), String> {
    let local = LocalFs;
    let src_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    local.move_items(&src_paths, Path::new(&dest))
}

#[tauri::command]
fn delete_items(paths: Vec<String>) -> Result<(), String> {
    let local = LocalFs;
    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    local.delete_items(&path_bufs)
}

#[tauri::command]
fn rename_item(path: String, new_name: String) -> Result<(), String> {
    let local = LocalFs;
    local.rename_item(Path::new(&path), &new_name)
}

#[tauri::command]
fn create_dir(path: String, name: String) -> Result<(), String> {
    let local = LocalFs;
    local.create_dir(Path::new(&path), &name)
}

#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    let local = LocalFs;
    local.path_exists(Path::new(&path))
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let result = {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(&path).spawn()
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &path])
                .spawn()
        }
        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open").arg(&path).spawn()
        }
    };
    result.map_err(|e| format!("Failed to open: {}", e))?;
    Ok(())
}

#[tauri::command]
fn open_in_editor(path: String, editor: String) -> Result<(), String> {
    std::process::Command::new(&editor)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Failed to open editor: {}", e))?;
    Ok(())
}

#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    let local = LocalFs;
    local.read_file_text(Path::new(&path))
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
) -> Result<(), String> {
    let hosts = ssh::config::load_ssh_config()?;
    let host_config = hosts
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

    Ok(())
}

#[tauri::command]
async fn ssh_disconnect(
    host: String,
    port: Option<u16>,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    state.disconnect(&host, port.unwrap_or(22))
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
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let handle = state
        .get(&host, port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", host))?;
    let path_bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    fs::sftp::SftpFs::delete_items(&handle, &path_bufs).await
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
    host: String,
    port: Option<u16>,
    user: Option<String>,
    _state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let hosts = ssh::config::load_ssh_config()?;
    let _host_config = hosts
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
    // With russh, host key is accepted during connect (TOFU handled by known_hosts)
    Ok(())
}

// --- Cross-filesystem transfer commands ---

#[tauri::command]
async fn ssh_copy_to_remote(
    local_paths: Vec<String>,
    remote_host: String,
    remote_port: Option<u16>,
    remote_path: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let handle = state
        .get(&remote_host, remote_port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", remote_host))?;
    let local_path_bufs: Vec<PathBuf> = local_paths.iter().map(PathBuf::from).collect();
    fs::transfer::copy_local_to_remote(&local_path_bufs, Path::new(&remote_path), &handle).await
}

#[tauri::command]
async fn ssh_copy_from_remote(
    remote_host: String,
    remote_port: Option<u16>,
    remote_paths: Vec<String>,
    local_path: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let handle = state
        .get(&remote_host, remote_port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", remote_host))?;
    let remote_path_bufs: Vec<PathBuf> = remote_paths.iter().map(PathBuf::from).collect();
    fs::transfer::copy_remote_to_local(&remote_path_bufs, Path::new(&local_path), &handle).await
}

#[tauri::command]
async fn ssh_move_to_remote(
    local_paths: Vec<String>,
    remote_host: String,
    remote_port: Option<u16>,
    remote_path: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let handle = state
        .get(&remote_host, remote_port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", remote_host))?;
    let local_path_bufs: Vec<PathBuf> = local_paths.iter().map(PathBuf::from).collect();
    fs::transfer::copy_local_to_remote(&local_path_bufs, Path::new(&remote_path), &handle).await?;
    let local = LocalFs;
    local.delete_items(&local_path_bufs)?;
    Ok(())
}

#[tauri::command]
async fn ssh_move_from_remote(
    remote_host: String,
    remote_port: Option<u16>,
    remote_paths: Vec<String>,
    local_path: String,
    state: tauri::State<'_, ssh::connection::ConnectionManager>,
) -> Result<(), String> {
    let handle = state
        .get(&remote_host, remote_port.unwrap_or(22))
        .ok_or_else(|| format!("Not connected to {}", remote_host))?;
    let remote_path_bufs: Vec<PathBuf> = remote_paths.iter().map(PathBuf::from).collect();
    fs::transfer::copy_remote_to_local(&remote_path_bufs, Path::new(&local_path), &handle).await?;
    fs::sftp::SftpFs::delete_items(&handle, &remote_path_bufs).await?;
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

            let menu = Menu::with_items(app, &[
                &Submenu::with_items(app, "kuf", true, &[
                    &MenuItem::with_id(app, "about", "About kuf", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrCtrl+,"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?,
                ])?,
                &Submenu::with_items(app, "File", true, &[
                    &MenuItem::with_id(app, "tab_new", "New Tab", true, Some("CmdOrCtrl+T"))?,
                    &MenuItem::with_id(app, "tab_close", "Close Tab", true, Some("CmdOrCtrl+W"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "open_file", "Open", true, None::<&str>)?,
                    &MenuItem::with_id(app, "open_editor", "Open in Editor", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "new_folder", "New Folder", true, Some("F7"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "copy", "Copy", true, Some("F5"))?,
                    &MenuItem::with_id(app, "move", "Move", true, Some("F6"))?,
                    &MenuItem::with_id(app, "rename", "Rename", true, Some("F2"))?,
                    &MenuItem::with_id(app, "delete", "Delete", true, Some("Delete"))?,
                ])?,
                &Submenu::with_items(app, "View", true, &[
                    &MenuItem::with_id(app, "refresh", "Refresh", true, Some("CmdOrCtrl+R"))?,
                    &MenuItem::with_id(app, "toggle_hidden", "Toggle Hidden Files", true, None::<&str>)?,
                ])?,
                &Submenu::with_items(app, "Go", true, &[
                    &MenuItem::with_id(app, "back", "Back", true, Some("Alt+ArrowLeft"))?,
                    &MenuItem::with_id(app, "forward", "Forward", true, Some("Alt+ArrowRight"))?,
                    &MenuItem::with_id(app, "parent_dir", "Parent Dir", true, Some("Backspace"))?,
                    &MenuItem::with_id(app, "switch_pane", "Switch Pane", true, Some("Tab"))?,
                ])?,
                &Submenu::with_items(app, "Bookmarks", true, &[
                    &MenuItem::with_id(app, "bookmark_add", "Add Bookmark", true, Some("CmdOrCtrl+D"))?,
                    &MenuItem::with_id(app, "bookmark_list", "Show Bookmarks", true, Some("CmdOrCtrl+B"))?,
                ])?,
                &Submenu::with_items(app, "Remote", true, &[
                    &MenuItem::with_id(app, "ssh_connect", "Connect to Server...", true, None::<&str>)?,
                    &MenuItem::with_id(app, "ssh_disconnect", "Disconnect", true, None::<&str>)?,
                ])?,
            ])?;

            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu-event", event.id().as_ref());
        })
        .on_window_event(|window, event| {
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
        .invoke_handler(tauri::generate_handler![
            home_dir,
            read_dir,
            copy_items,
            move_items,
            delete_items,
            rename_item,
            create_dir,
            path_exists,
            open_file,
            open_in_editor,
            read_file_text,
            bookmark_list,
            bookmark_add,
            bookmark_remove,
            config::settings_load,
            config::settings_save,
            config::settings_reset,
            config::keybinds_load,
            config::keybinds_save,
            config::keybinds_reset,
            config::config_dir_path,
            ssh_list_hosts,
            ssh_connect,
            ssh_disconnect,
            ssh_read_dir,
            ssh_delete_items,
            ssh_rename_item,
            ssh_create_dir,
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
