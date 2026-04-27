use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// --- Settings types ---

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct DisplaySettings {
    pub font_size: u32,
    pub row_height: u32,
    pub show_hidden: bool,
    pub theme: String,
    pub columns: Vec<String>,
    pub rename_without_extension: bool,
}

impl DisplaySettings {
    pub fn defaults() -> Self {
        Self {
            font_size: 13,
            row_height: 22,
            show_hidden: true,
            theme: "tokyo-night".to_string(),
            columns: vec![
                "extension".to_string(),
                "size".to_string(),
                "date".to_string(),
                "permissions".to_string(),
            ],
            rename_without_extension: false,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NavigationSettings {
    pub left_dir: String,
    pub right_dir: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SortSettings {
    pub dirs_first: bool,
    pub case_sensitive: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct WindowSettings {
    pub mode: String,
    pub width: f64,
    pub height: f64,
}

impl WindowSettings {
    pub fn defaults() -> Self {
        Self {
            mode: "remember".to_string(),
            width: 1200.0,
            height: 800.0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    pub display: DisplaySettings,
    pub navigation: NavigationSettings,
    pub sort: SortSettings,
    pub editor: String,
    pub window: WindowSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            display: DisplaySettings::defaults(),
            navigation: NavigationSettings {
                left_dir: String::new(),
                right_dir: String::new(),
            },
            sort: SortSettings {
                dirs_first: true,
                case_sensitive: false,
            },
            editor: "vim".to_string(),
            window: WindowSettings::defaults(),
        }
    }
}

// --- Config directory ---

pub fn config_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|mut p| {
            p.push(".config");
            p.push("kuf");
            p
        })
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("settings.toml"))
}

fn keybinds_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("keybind.toml"))
}

pub(crate) fn ensure_config_dir() -> Result<(), String> {
    let dir = config_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Cannot create config dir: {}", e))?;
    }
    Ok(())
}

// --- Default keybinds as TOML string ---

fn default_keybinds_toml() -> String {
    r#"[keybind]
"ArrowUp" = "cursor_up"
"ArrowDown" = "cursor_down"
"Home" = "cursor_top"
"End" = "cursor_bottom"
"Enter" = "enter"
"Shift+Enter" = "preview"
"Backspace" = "parent_dir"
"Tab" = "switch_pane"
" " = "toggle_select"
"Insert" = "toggle_select"
"Delete" = "delete"
"F2" = "rename"
"F5" = "copy"
"F6" = "move"
"F7" = "new_folder"
"F8" = "delete"
"c" = "copy"
"m" = "move"
"d" = "delete"
"r" = "rename"
"k" = "new_folder"
"f" = "bookmark_list"
"Ctrl+a" = "select_all"
"Ctrl+r" = "refresh"
"Ctrl+d" = "bookmark_add"
"Alt+ArrowLeft" = "history_back"
"Alt+ArrowRight" = "history_forward"
"Alt+1" = "left_pane"
"Alt+2" = "right_pane"
"o" = "sync_to_other"
"Shift+O" = "sync_from_other"
"\\" = "copy_to_other"
"Ctrl+\\" = "move_to_other"
"Ctrl+t" = "tab_new"
"Ctrl+w" = "tab_close"
"Ctrl+Tab" = "tab_next"
"Ctrl+Shift+Tab" = "tab_prev"
"e" = "open_in_editor"
"F3" = "preview"
"x" = "open_file"
"Escape" = "clear_selection"
"#.to_string()
}

// --- Load / Save settings ---

#[tauri::command]
pub fn settings_load() -> Result<AppSettings, String> {
    ensure_config_dir()?;
    let path = settings_path()?;
    if !path.exists() {
        let default = AppSettings::default();
        let toml_str =
            toml::to_string_pretty(&default).map_err(|e| format!("Serialize error: {}", e))?;
        fs::write(&path, toml_str).map_err(|e| format!("Write error: {}", e))?;
        return Ok(default);
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    toml::from_str(&content).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub fn settings_save(settings: AppSettings) -> Result<(), String> {
    ensure_config_dir()?;
    let path = settings_path()?;
    let toml_str =
        toml::to_string_pretty(&settings).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&path, toml_str).map_err(|e| format!("Write error: {}", e))
}

#[tauri::command]
pub fn settings_reset() -> Result<AppSettings, String> {
    ensure_config_dir()?;
    let default = AppSettings::default();
    let path = settings_path()?;
    let toml_str =
        toml::to_string_pretty(&default).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&path, toml_str).map_err(|e| format!("Write error: {}", e))?;
    Ok(default)
}

// --- Load / Save keybinds ---

#[tauri::command]
pub fn keybinds_load() -> Result<serde_json::Value, String> {
    ensure_config_dir()?;
    let path = keybinds_path()?;
    if !path.exists() {
        fs::write(&path, default_keybinds_toml()).map_err(|e| format!("Write error: {}", e))?;
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    let map: serde_json::Value =
        toml::from_str(&content).map_err(|e| format!("Parse error: {}", e))?;
    Ok(map)
}

#[tauri::command]
pub fn keybinds_save(keybinds: serde_json::Value) -> Result<(), String> {
    ensure_config_dir()?;
    let path = keybinds_path()?;
    let toml_str =
        toml::to_string(&keybinds).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&path, toml_str).map_err(|e| format!("Write error: {}", e))
}

#[tauri::command]
pub fn keybinds_reset() -> Result<serde_json::Value, String> {
    ensure_config_dir()?;
    let path = keybinds_path()?;
    let default_str = default_keybinds_toml();
    fs::write(&path, &default_str).map_err(|e| format!("Write error: {}", e))?;
    let map: serde_json::Value =
        toml::from_str(&default_str).map_err(|e| format!("Parse error: {}", e))?;
    Ok(map)
}

#[tauri::command]
pub fn config_dir_path() -> Result<String, String> {
    let dir = config_dir()?;
    Ok(dir.to_string_lossy().to_string())
}
