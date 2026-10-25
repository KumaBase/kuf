use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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
            font_size: 16,
            row_height: 29,
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
    #[serde(default = "restore_session_default")]
    pub restore_session: bool,
}

fn restore_session_default() -> bool {
    true
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
                restore_session: true,
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
    // Isolate native smoke tests from the user's real settings and keymap.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("KUF_DEV_CONFIG_DIR") {
        return Ok(PathBuf::from(path));
    }
    dirs::config_dir()
        .map(|mut p| {
            p.push("kuf");
            p
        })
        .ok_or_else(|| "Cannot determine config directory".to_string())
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
    r#"preset = "afxw-2"

[keybind]
"ArrowUp" = "cursor_up"
"ArrowDown" = "cursor_down"
"Home" = "cursor_top"
"End" = "cursor_bottom"
"PageUp" = "cursor_page_up"
"PageDown" = "cursor_page_down"
"Enter" = "enter"
"Shift+Enter" = "preview"
"Backspace" = "parent_dir"
"Tab" = "switch_pane"
" " = "toggle_select"
"Insert" = "toggle_select"
"Delete" = "delete"
"F2" = "rename"
"F3" = "preview"
"F5" = "copy_to_other"
"F6" = "move_to_other"
"Shift+F5" = "copy_as"
"Shift+F6" = "move_as"
"F7" = "new_folder"
"Shift+F7" = "new_file"
"F8" = "delete"
"a" = "select_all"
"c" = "copy_to_other"
"m" = "move_to_other"
"d" = "delete"
"r" = "rename"
"k" = "new_folder"
"e" = "open_in_editor"
"v" = "preview"
"x" = "open_file"
"j" = "bookmark_list"
"Shift+j" = "goto_path"
"l" = "drive_list"
";" = "bookmark_list"
"o" = "sync_to_other"
"Shift+o" = "sync_from_other"
"\\" = "go_root"
"Ctrl+a" = "select_all"
"Ctrl+c" = "copy"
"Ctrl+x" = "move"
"Ctrl+r" = "refresh"
"Ctrl+d" = "bookmark_add"
"Ctrl+g" = "goto_path"
"Ctrl+l" = "goto_path"
"Ctrl+i" = "invert_selection"
"Ctrl+u" = "swap_panes"
"Ctrl+e" = "select_same_ext"
"Ctrl+Shift+c" = "copy_path"
"Ctrl+Shift+n" = "copy_name"
"Ctrl+Shift+Enter" = "open_terminal"
"Ctrl+Shift+s" = "sort"
"Ctrl+Shift+r" = "sort_reverse"
"Alt+Home" = "go_home"
"Alt+ArrowLeft" = "history_back"
"Alt+ArrowRight" = "history_forward"
"ArrowLeft" = "left_pane"
"ArrowRight" = "right_pane"
"Alt+1" = "left_pane"
"Alt+2" = "right_pane"
"Alt+d" = "drive_list"
"Ctrl+t" = "tab_new"
"Ctrl+w" = "tab_close"
"Ctrl+Tab" = "tab_next"
"Ctrl+Shift+Tab" = "tab_prev"
"Escape" = "clear_selection"
"Ctrl+s" = "ssh_connect"
"/" = "filter"
"Ctrl+f" = "filter"
"f" = "filter"
"Shift+ " = "toggle_select_up"
"Ctrl+Shift+p" = "command_palette"
"Ctrl+," = "settings"
"Ctrl+q" = "quit"
"Ctrl+v" = "paste"
"Ctrl+Shift+t" = "tab_duplicate"
"h" = "history_list"
"w" = "compare_panes"
"Shift+f" = "search_files"
"p" = "zip_create"
"u" = "zip_extract"
"@" = "select_pattern"
"Shift+@" = "select_pattern"
"Shift+ArrowUp" = "select_range_up"
"Shift+ArrowDown" = "select_range_down"
"Shift+Home" = "select_range_top"
"Shift+End" = "select_range_bottom"
"Shift+PageUp" = "select_range_page_up"
"Shift+PageDown" = "select_range_page_down"
"Shift+r" = "bulk_rename"
"Shift+x" = "external_commands"
"#
    .to_string()
}

// --- Load / Save settings ---

#[tauri::command]
pub fn settings_defaults() -> AppSettings {
    AppSettings::default()
}

#[tauri::command]
pub fn keybinds_defaults() -> Result<serde_json::Value, String> {
    toml::from_str(&default_keybinds_toml()).map_err(|e| format!("Parse error: {e}"))
}

#[tauri::command]
pub fn settings_load() -> Result<AppSettings, String> {
    ensure_config_dir()?;
    settings_load_from(&settings_path()?)
}

fn settings_load_from(path: &Path) -> Result<AppSettings, String> {
    if !path.exists() {
        let default = AppSettings::default();
        let toml_str =
            toml::to_string_pretty(&default).map_err(|e| format!("Serialize error: {}", e))?;
        fs::write(&path, toml_str).map_err(|e| format!("Write error: {}", e))?;
        return Ok(default);
    }
    let content = fs::read_to_string(path).map_err(|e| format!("Read error: {}", e))?;
    // Existing user preferences are read-only, including files from older versions.
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
    keybinds_load_from(&keybinds_path()?)
}

fn keybinds_load_from(path: &Path) -> Result<serde_json::Value, String> {
    if !path.exists() {
        fs::write(&path, default_keybinds_toml()).map_err(|e| format!("Write error: {}", e))?;
    }
    let content = fs::read_to_string(path).map_err(|e| format!("Read error: {}", e))?;
    // Preset markers identify defaults; they must never reset custom bindings on load.
    toml::from_str(&content).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub fn keybinds_save(keybinds: serde_json::Value) -> Result<(), String> {
    ensure_config_dir()?;
    let path = keybinds_path()?;
    let toml_str = toml::to_string(&keybinds).map_err(|e| format!("Serialize error: {}", e))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

    struct ConfigFixture(PathBuf);

    impl ConfigFixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "kuf-config-test-{}-{}-{}",
                std::process::id(),
                nonce,
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for ConfigFixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn loading_legacy_settings_preserves_preferences_and_original_bytes() {
        let fixture = ConfigFixture::new();
        let path = fixture.path("settings.toml");
        let legacy = concat!(
            "# Keep my compact layout and comments.\r\n",
            "editor = 'custom-editor'\r\n",
            "[display]\r\nfont_size = 11\r\nrow_height = 18\r\n",
            "show_hidden = false\r\ntheme = 'nord'\r\n",
            "[navigation]\r\nleft_dir = '/my/left'\r\nright_dir = '/my/right'\r\n",
            "[sort]\r\ndirs_first = false\r\ncase_sensitive = true\r\n",
            "[window]\r\nmode = 'remember'\r\nwidth = 900.0\r\nheight = 600.0\r\n"
        );
        for (original, restore_session) in [
            (legacy.to_string(), true),
            (
                legacy.replace(
                    "[navigation]\r\n",
                    "[navigation]\r\nrestore_session = false\r\n",
                ),
                false,
            ),
        ] {
            fs::write(&path, original.as_bytes()).unwrap();
            for _ in 0..2 {
                let settings = settings_load_from(&path).unwrap();
                assert_eq!(settings.display.font_size, 11);
                assert_eq!(settings.display.row_height, 18);
                assert_eq!(settings.navigation.restore_session, restore_session);
                assert_eq!(settings.navigation.left_dir, "/my/left");
                assert_eq!(settings.editor, "custom-editor");
                assert_eq!(fs::read(&path).unwrap(), original.as_bytes());
            }
        }
    }

    #[test]
    fn loading_legacy_and_custom_keymaps_never_replaces_bindings_or_bytes() {
        let fixture = ConfigFixture::new();
        let path = fixture.path("keybind.toml");
        for preset in [
            None,
            Some("afxw-1"),
            Some("afxw-2"),
            Some("my-custom-preset"),
        ] {
            let marker = preset
                .map(|value| format!("preset = '{value}'\r\n"))
                .unwrap_or_default();
            let original = format!(
                "# My shortcuts must survive upgrades.\r\n{marker}[keybind]\r\n'F5' = 'preview'\r\n'Ctrl+q' = 'copy_path'\r\n'Ctrl+Shift+s' = 'preview'\r\n'Ctrl+Shift+r' = 'copy_path'\r\n"
            );
            fs::write(&path, original.as_bytes()).unwrap();
            for _ in 0..2 {
                let map = keybinds_load_from(&path).unwrap();
                assert_eq!(map["keybind"]["F5"], "preview");
                assert_eq!(map["keybind"]["Ctrl+q"], "copy_path");
                assert_eq!(map["keybind"]["Ctrl+Shift+s"], "preview");
                assert_eq!(map["keybind"]["Ctrl+Shift+r"], "copy_path");
                assert_eq!(map.get("preset").and_then(|value| value.as_str()), preset);
                assert_eq!(fs::read(&path).unwrap(), original.as_bytes());
            }
        }
    }

    #[test]
    fn invalid_existing_configuration_is_preserved_on_load_failure() {
        let fixture = ConfigFixture::new();
        for original in [
            b"[broken".as_slice(),
            b"[display]\nfont_size = 'invalid'\n".as_slice(),
        ] {
            let path = fixture.path("settings.toml");
            fs::write(&path, original).unwrap();
            assert!(settings_load_from(&path).is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
        }
        let path = fixture.path("keybind.toml");
        let original = b"# Do not replace this damaged file.\r\n[keybind\r\n";
        fs::write(&path, original).unwrap();
        assert!(keybinds_load_from(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn absent_configuration_still_creates_current_defaults() {
        let fixture = ConfigFixture::new();
        let settings_path = fixture.path("settings.toml");
        let settings = settings_load_from(&settings_path).unwrap();
        assert_eq!(settings.display.font_size, 16);
        assert_eq!(settings.display.row_height, 29);
        assert!(settings.navigation.restore_session);
        let stored: AppSettings =
            toml::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert_eq!(stored.display.font_size, 16);
        assert_eq!(stored.display.row_height, 29);

        let keybinds_path = fixture.path("keybind.toml");
        let keybinds = keybinds_load_from(&keybinds_path).unwrap();
        assert_eq!(keybinds["preset"], "afxw-2");
        assert_eq!(keybinds["keybind"]["F5"], "copy_to_other");
        assert_eq!(keybinds["keybind"]["Ctrl+Shift+s"], "sort");
        assert_eq!(keybinds["keybind"]["Ctrl+Shift+r"], "sort_reverse");
        assert_eq!(
            fs::read_to_string(keybinds_path).unwrap(),
            default_keybinds_toml()
        );
    }
}
