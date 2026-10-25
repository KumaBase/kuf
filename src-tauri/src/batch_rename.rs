use crate::fs::local::{is_case_only_alias, rename_no_replace, validate_local_rename_name};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RenamePlanItem {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Default, Serialize)]
pub struct BatchRenameResult {
    pub completed: Vec<RenamePlanItem>,
    pub pending: Vec<RenamePlanItem>,
    pub unchanged: Vec<RenamePlanItem>,
    pub error: Option<String>,
    pub cancelled: bool,
}

struct ValidatedPlan {
    directory: PathBuf,
    changed: Vec<RenamePlanItem>,
    unchanged: Vec<RenamePlanItem>,
}

fn name_key(name: &str) -> String {
    // Conservative across Windows and commonly case-insensitive macOS volumes.
    // Distinct names differing only by case are not a supported batch plan.
    name.to_lowercase()
}

fn validate_plan(directory: &Path, plan: Vec<RenamePlanItem>) -> Result<ValidatedPlan, String> {
    if plan.is_empty() || plan.len() > 10_000 {
        return Err("一括リネームの対象は1〜10,000件にしてください。".into());
    }
    let directory = std::fs::canonicalize(directory).map_err(|e| format!("Cannot read directory: {e}"))?;
    if !directory.is_dir() { return Err("Not a directory".into()); }
    let mut sources = HashSet::new();
    let mut targets = HashSet::new();
    let mut changed = Vec::new();
    let mut unchanged = Vec::new();
    for item in plan {
        validate_local_rename_name(&item.from)?;
        validate_local_rename_name(&item.to)?;
        if !sources.insert(name_key(&item.from)) { return Err(format!("Duplicate source: {}", item.from)); }
        if !targets.insert(name_key(&item.to)) { return Err(format!("Duplicate destination: {}", item.to)); }
        let source = directory.join(&item.from);
        std::fs::symlink_metadata(&source).map_err(|e| format!("Cannot read '{}': {e}", item.from))?;
        if item.from == item.to { unchanged.push(item); continue; }
        let destination = directory.join(&item.to);
        match std::fs::symlink_metadata(&destination) {
            Ok(_) if !is_case_only_alias(&source, &destination) => {
                return Err(format!("Already exists: {}（入れ替え・循環リネームには対応していません）", item.to));
            },
            Ok(_) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(format!("Cannot verify destination '{}': {error}", item.to)),
        }
        changed.push(item);
    }
    Ok(ValidatedPlan { directory, changed, unchanged })
}

fn execute_plan(
    plan: ValidatedPlan,
    mut check: impl FnMut() -> Result<(), String>,
    mut rename: impl FnMut(&Path, &Path) -> Result<(), String>,
    mut progress: impl FnMut(usize, usize),
) -> BatchRenameResult {
    let mut result = BatchRenameResult { unchanged: plan.unchanged, ..Default::default() };
    progress(0, plan.changed.len());
    for (index, item) in plan.changed.iter().enumerate() {
        if let Err(error) = check() {
            result.pending.extend_from_slice(&plan.changed[index..]);
            result.error = Some(error);
            result.cancelled = true;
            return result;
        }
        if let Err(error) = rename(&plan.directory.join(&item.from), &plan.directory.join(&item.to)) {
            result.pending.extend_from_slice(&plan.changed[index..]);
            result.error = Some(format!("{} → {}: {error}", item.from, item.to));
            return result;
        }
        result.completed.push(item.clone());
        progress(index + 1, plan.changed.len());
    }
    result
}

#[tauri::command]
pub async fn batch_rename_items(
    directory: String,
    plan: Vec<RenamePlanItem>,
    operation_id: Option<String>,
    operations: tauri::State<'_, crate::operation::Operations>,
    app: tauri::AppHandle,
) -> Result<BatchRenameResult, String> {
    let operation = operations.get(operation_id.as_deref())?;
    crate::background::run(move || {
        let plan = validate_plan(Path::new(&directory), plan)?;
        let mut last_progress = std::time::Instant::now();
        Ok(execute_plan(plan,
            || operation.as_ref().map_or(Ok(()), |op| op.check()),
            rename_no_replace,
            |done, total| {
                if done == 0 || done == total || last_progress.elapsed().as_millis() >= 100 {
                    if let Some(op) = &operation { op.progress(&app, done, total); }
                    last_progress = std::time::Instant::now();
                }
            },
        ))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("kuf-batch-{}-{stamp}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn item(from: &str, to: &str) -> RenamePlanItem { RenamePlanItem { from: from.into(), to: to.into() } }

    #[test]
    fn all_items_are_checked_before_the_first_rename() {
        let root = Fixture::new();
        std::fs::write(root.0.join("first"), b"first").unwrap();
        std::fs::write(root.0.join("second"), b"second").unwrap();
        std::fs::write(root.0.join("occupied"), b"keep").unwrap();
        for plan in [vec![item("first", "renamed"), item("second", "occupied")], vec![item("first", "same"), item("second", "SAME")], vec![item("first", "second"), item("second", "first")], vec![item("first", "../escape")]] {
            assert!(validate_plan(&root.0, plan).is_err());
            assert_eq!(std::fs::read(root.0.join("first")).unwrap(), b"first");
            assert_eq!(std::fs::read(root.0.join("occupied")).unwrap(), b"keep");
        }
    }

    #[test]
    fn successful_batch_renames_files_and_folders_and_reports_unchanged() {
        let root = Fixture::new();
        std::fs::write(root.0.join("file.TXT"), b"contents").unwrap();
        std::fs::create_dir(root.0.join("folder")).unwrap();
        std::fs::write(root.0.join("same"), b"same").unwrap();
        let plan = validate_plan(&root.0, vec![item("file.TXT", "001.TXT"), item("folder", "002"), item("same", "same")]).unwrap();
        let result = execute_plan(plan, || Ok(()), rename_no_replace, |_, _| {});
        assert!(result.error.is_none());
        assert_eq!(result.completed.len(), 2);
        assert_eq!(result.unchanged, vec![item("same", "same")]);
        assert!(result.pending.is_empty());
        assert_eq!(std::fs::read(root.0.join("001.TXT")).unwrap(), b"contents");
        assert!(root.0.join("002").is_dir());
    }

    #[test]
    fn racing_destination_is_never_replaced_and_partial_results_are_exact() {
        let root = Fixture::new();
        std::fs::write(root.0.join("a"), b"a").unwrap();
        std::fs::write(root.0.join("b"), b"b").unwrap();
        let plan = validate_plan(&root.0, vec![item("a", "new-a"), item("b", "new-b")]).unwrap();
        std::fs::write(root.0.join("new-b"), b"racing content").unwrap();
        let result = execute_plan(plan, || Ok(()), rename_no_replace, |_, _| {});
        assert_eq!(result.completed, vec![item("a", "new-a")]);
        assert_eq!(result.pending, vec![item("b", "new-b")]);
        assert!(result.error.is_some());
        assert_eq!(std::fs::read(root.0.join("b")).unwrap(), b"b");
        assert_eq!(std::fs::read(root.0.join("new-b")).unwrap(), b"racing content");
    }

    #[test]
    fn cancellation_stops_between_items_and_lists_the_remaining_plan() {
        let root = Fixture::new();
        for name in ["a", "b"] { std::fs::write(root.0.join(name), name.as_bytes()).unwrap(); }
        let plan = validate_plan(&root.0, vec![item("a", "new-a"), item("b", "new-b")]).unwrap();
        let mut checks = 0;
        let result = execute_plan(plan, || { checks += 1; if checks > 1 { Err("cancelled".into()) } else { Ok(()) } }, rename_no_replace, |_, _| {});
        assert!(result.cancelled);
        assert_eq!(result.completed, vec![item("a", "new-a")]);
        assert_eq!(result.pending, vec![item("b", "new-b")]);
        assert!(root.0.join("b").exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_batch_case_only_rename_succeeds_on_case_insensitive_volume() {
        use crate::fs::local::rename_test_volume::MacVolume;
        let volume = MacVolume::new(false);
        let source = volume.path().join("Report.txt");
        std::fs::write(&source, b"batch report").unwrap();
        assert!(std::fs::symlink_metadata(volume.path().join("report.txt")).is_ok());
        let plan = validate_plan(volume.path(), vec![item("Report.txt", "report.txt")]).unwrap();
        let result = execute_plan(plan, || Ok(()), rename_no_replace, |_, _| {});
        assert!(result.error.is_none(), "{:?}", result.error);
        assert_eq!(result.completed, vec![item("Report.txt", "report.txt")]);
        assert!(result.pending.is_empty());
        assert_eq!(std::fs::read(volume.path().join("report.txt")).unwrap(), b"batch report");
        let names: Vec<_> = std::fs::read_dir(volume.path()).unwrap().map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_str().is_some_and(|name| name.eq_ignore_ascii_case("report.txt"))).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("report.txt")]);
    }
}
