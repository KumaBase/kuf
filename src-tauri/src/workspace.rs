use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const VERSION: u32 = 1;
const MAX_TABS: usize = 64;
const MAX_NAME_CHARS: usize = 80;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
static STORAGE_LOCK: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceTab {
    pub left_path: String,
    pub right_path: String,
    pub active_side: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub tabs: Vec<WorkspaceTab>,
    pub active_index: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NamedWorkspace {
    pub name: String,
    pub snapshot: WorkspaceSnapshot,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceData {
    pub version: u32,
    pub last_session: Option<WorkspaceSnapshot>,
    pub workspaces: Vec<NamedWorkspace>,
}

impl Default for WorkspaceData {
    fn default() -> Self {
        Self {
            version: VERSION,
            last_session: None,
            workspaces: Vec::new(),
        }
    }
}

fn workspace_path() -> Result<PathBuf, String> {
    Ok(crate::config::config_dir()?.join("workspaces.json"))
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "Workspace name must contain 1 to {MAX_NAME_CHARS} characters"
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("Workspace name cannot contain control characters".to_string());
    }
    Ok(())
}

fn validate_snapshot(snapshot: &WorkspaceSnapshot) -> Result<(), String> {
    if snapshot.tabs.is_empty() || snapshot.tabs.len() > MAX_TABS {
        return Err(format!("Workspace must contain 1 to {MAX_TABS} tabs"));
    }
    if snapshot.active_index >= snapshot.tabs.len() {
        return Err("Workspace active tab is out of range".to_string());
    }
    for tab in &snapshot.tabs {
        if tab.active_side != "left" && tab.active_side != "right" {
            return Err("Workspace active side must be left or right".to_string());
        }
        for path in [&tab.left_path, &tab.right_path] {
            if path.is_empty() || path.contains('\0') {
                return Err(
                    "Workspace paths must be nonempty and contain no null characters".to_string(),
                );
            }
        }
    }
    // Availability is deliberately checked during restoration, not storage:
    // removable drives and disconnected SFTP paths are valid saved locations.
    Ok(())
}

fn validate_data(data: &WorkspaceData) -> Result<(), String> {
    if data.version != VERSION {
        return Err(format!(
            "Unsupported workspace file version: {}",
            data.version
        ));
    }
    if let Some(snapshot) = &data.last_session {
        validate_snapshot(snapshot)?;
    }
    let mut names = HashSet::new();
    for workspace in &data.workspaces {
        validate_name(&workspace.name)?;
        if !names.insert(workspace.name.trim()) {
            return Err(format!("Duplicate workspace name: {}", workspace.name));
        }
        validate_snapshot(&workspace.snapshot)?;
    }
    Ok(())
}

fn load_from_path(path: &Path) -> Result<WorkspaceData, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceData::default());
        }
        Err(error) => return Err(format!("Cannot read workspace file: {error}")),
    };
    let mut content = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|error| format!("Cannot read workspace file: {error}"))?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("Workspace file is too large; existing file was preserved".to_string());
    }
    let data: WorkspaceData = serde_json::from_slice(&content)
        .map_err(|error| format!("Invalid workspace file; existing file was preserved: {error}"))?;
    validate_data(&data)
        .map_err(|error| format!("Invalid workspace file; existing file was preserved: {error}"))?;
    Ok(data)
}

// Standard rename replaces existing files on Windows as well as Unix. Keep
// both paths in the same directory; never delete the destination beforehand.
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn save_to_path(path: &Path, data: &WorkspaceData) -> Result<(), String> {
    validate_data(data)?;
    let content = serde_json::to_vec_pretty(data)
        .map_err(|error| format!("Cannot serialize workspace data: {error}"))?;
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("Workspace data is too large; existing file was preserved".to_string());
    }
    let directory = path
        .parent()
        .ok_or("Workspace file has no parent directory")?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Cannot create workspace directory: {error}"))?;
    // create_new prevents stale temp files or another app instance from being
    // overwritten, even if this process ID has been reused.
    let (temp_path, mut file) = (0..100)
        .find_map(|_| {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let temp_path =
                directory.join(format!(".workspaces-{}-{sequence}.tmp", std::process::id()));
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp_path)
            {
                Ok(file) => Some(Ok((temp_path, file))),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(format!(
                    "Cannot create workspace temporary file: {error}"
                ))),
            }
        })
        .unwrap_or_else(|| Err("Cannot allocate workspace temporary file".to_string()))?;
    let result = file
        .write_all(&content)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("Cannot write workspace temporary file: {error}"));
    drop(file);
    let result = result.and_then(|_| {
        atomic_replace(&temp_path, path).map_err(|error| {
            format!("Cannot replace workspace file; existing file was preserved: {error}")
        })
    });
    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    result
}

fn update_at_path(
    path: &Path,
    update: impl FnOnce(&mut WorkspaceData) -> Result<(), String>,
) -> Result<WorkspaceData, String> {
    // Always load and validate first. Never overwrite corrupt or newer data.
    let mut data = load_from_path(path)?;
    update(&mut data)?;
    save_to_path(path, &data)?;
    Ok(data)
}

#[tauri::command]
pub async fn workspace_load() -> Result<WorkspaceData, String> {
    crate::background::run(|| {
        let _guard = STORAGE_LOCK
            .lock()
            .map_err(|_| "Workspace storage lock failed")?;
        load_from_path(&workspace_path()?)
    })
    .await
}

#[tauri::command]
pub async fn workspace_save_session(snapshot: WorkspaceSnapshot) -> Result<WorkspaceData, String> {
    crate::background::run(move || {
        let _guard = STORAGE_LOCK
            .lock()
            .map_err(|_| "Workspace storage lock failed")?;
        validate_snapshot(&snapshot)?;
        update_at_path(&workspace_path()?, |data| {
            data.last_session = Some(snapshot);
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn workspace_save_named(
    name: String,
    snapshot: WorkspaceSnapshot,
) -> Result<WorkspaceData, String> {
    crate::background::run(move || {
        let _guard = STORAGE_LOCK
            .lock()
            .map_err(|_| "Workspace storage lock failed")?;
        let name = name.trim().to_string();
        validate_name(&name)?;
        validate_snapshot(&snapshot)?;
        update_at_path(&workspace_path()?, |data| {
            if let Some(existing) = data
                .workspaces
                .iter_mut()
                .find(|saved| saved.name.trim() == name)
            {
                *existing = NamedWorkspace { name, snapshot };
            } else {
                data.workspaces.push(NamedWorkspace { name, snapshot });
            }
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn workspace_remove(name: String) -> Result<WorkspaceData, String> {
    crate::background::run(move || {
        let _guard = STORAGE_LOCK
            .lock()
            .map_err(|_| "Workspace storage lock failed")?;
        let name = name.trim().to_string();
        validate_name(&name)?;
        update_at_path(&workspace_path()?, |data| {
            data.workspaces
                .retain(|workspace| workspace.name.trim() != name);
            Ok(())
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let directory = std::env::temp_dir().join(format!(
                "kuf-workspace-test-{}-{}-{sequence}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&directory).unwrap();
            Self(directory)
        }
        fn path(&self) -> PathBuf {
            self.0.join("workspaces.json")
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn snapshot() -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            tabs: vec![WorkspaceTab {
                left_path: "C:\\作業\\資料".to_string(),
                right_path: "sftp://user@example.test:22/unavailable".to_string(),
                active_side: "right".to_string(),
            }],
            active_index: 0,
        }
    }

    #[test]
    fn absent_file_returns_defaults_without_creating_files() {
        let directory = TestDirectory::new();
        assert_eq!(
            load_from_path(&directory.path()).unwrap(),
            WorkspaceData::default()
        );
        assert!(!directory.path().exists());
    }

    #[test]
    fn round_trip_preserves_remote_and_unavailable_locations_and_replaces_existing_file() {
        let directory = TestDirectory::new();
        let mut data = WorkspaceData::default();
        data.last_session = Some(snapshot());
        data.workspaces.push(NamedWorkspace {
            name: "開発環境".to_string(),
            snapshot: snapshot(),
        });
        save_to_path(&directory.path(), &data).unwrap();
        assert_eq!(load_from_path(&directory.path()).unwrap(), data);
        data.last_session = None;
        save_to_path(&directory.path(), &data).unwrap();
        assert_eq!(load_from_path(&directory.path()).unwrap(), data);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn corrupt_json_is_preserved_and_updates_are_refused() {
        let directory = TestDirectory::new();
        let original = b"{ broken json";
        fs::write(directory.path(), original).unwrap();
        let result = update_at_path(&directory.path(), |data| {
            data.last_session = Some(snapshot());
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(fs::read(directory.path()).unwrap(), original);
    }

    #[cfg(windows)]
    #[test]
    fn failed_replacement_preserves_original_and_cleans_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = TestDirectory::new();
        let original = WorkspaceData::default();
        save_to_path(&directory.path(), &original).unwrap();
        // An editor can hold a settings file without allowing delete/rename.
        let held_file = OpenOptions::new()
            .read(true)
            .share_mode(0x1)
            .open(directory.path())
            .unwrap();
        let changed = WorkspaceData {
            last_session: Some(snapshot()),
            ..WorkspaceData::default()
        };
        assert!(save_to_path(&directory.path(), &changed).is_err());
        assert_eq!(load_from_path(&directory.path()).unwrap(), original);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        drop(held_file);
    }

    #[test]
    fn session_updates_preserve_named_workspaces_and_named_removal_preserves_session() {
        let directory = TestDirectory::new();
        let mut initial = WorkspaceData::default();
        initial.workspaces.push(NamedWorkspace {
            name: "開発".to_string(),
            snapshot: snapshot(),
        });
        save_to_path(&directory.path(), &initial).unwrap();
        let session = snapshot();
        let data = update_at_path(&directory.path(), |data| {
            data.last_session = Some(session.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(data.workspaces, initial.workspaces);
        let data = update_at_path(&directory.path(), |data| {
            data.workspaces.retain(|saved| saved.name != "開発");
            Ok(())
        })
        .unwrap();
        assert!(data.workspaces.is_empty());
        assert_eq!(data.last_session, Some(session));
    }

    #[test]
    fn unsupported_version_and_wrong_field_types_are_rejected() {
        let directory = TestDirectory::new();
        for content in [
            r#"{"version":2,"last_session":null,"workspaces":[]}"#,
            r#"{"version":1,"last_session":false,"workspaces":[]}"#,
            r#"{"version":1,"workspaces":[],"last_session":null,"unexpected":true}"#,
        ] {
            fs::write(directory.path(), content).unwrap();
            assert!(load_from_path(&directory.path()).is_err());
        }
    }

    #[test]
    fn invalid_snapshots_and_names_are_rejected_before_writing() {
        let directory = TestDirectory::new();
        let mut invalid = snapshot();
        invalid.active_index = 1;
        assert!(validate_snapshot(&invalid).is_err());
        invalid = snapshot();
        invalid.tabs[0].active_side = "bottom".to_string();
        assert!(validate_snapshot(&invalid).is_err());
        invalid = snapshot();
        invalid.tabs[0].left_path.clear();
        assert!(validate_snapshot(&invalid).is_err());
        invalid = snapshot();
        invalid.tabs = vec![invalid.tabs[0].clone(); MAX_TABS + 1];
        assert!(validate_snapshot(&invalid).is_err());
        invalid.tabs.clear();
        assert!(validate_snapshot(&invalid).is_err());
        assert!(validate_name(" ").is_err());
        assert!(validate_name(&"あ".repeat(MAX_NAME_CHARS + 1)).is_err());
        assert!(validate_name(&"あ".repeat(MAX_NAME_CHARS)).is_ok());
        let data = WorkspaceData {
            last_session: Some(invalid),
            ..WorkspaceData::default()
        };
        assert!(save_to_path(&directory.path(), &data).is_err());
        assert!(!directory.path().exists());
    }

    #[test]
    fn duplicate_names_are_rejected() {
        let mut data = WorkspaceData::default();
        for name in ["開発", " 開発 "] {
            data.workspaces.push(NamedWorkspace {
                name: name.to_string(),
                snapshot: snapshot(),
            });
        }
        assert!(validate_data(&data).is_err());
    }
}
