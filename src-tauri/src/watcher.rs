//! Watch only the visible local directories. Events invalidate listings rather
//! than attempting to reproduce every platform's create/rename/write semantics.
use notify::event::{AccessKind, AccessMode, ModifyKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::Emitter;

const QUIET_PERIOD: Duration = Duration::from_millis(250);
const MAX_DELAY: Duration = Duration::from_secs(1);
const RECOVERY_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
pub struct WatchStatus {
    pub path: String,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct DirectoryChanged {
    generation: u64,
    paths: Vec<String>,
}

type Emit = Arc<dyn Fn(DirectoryChanged) + Send + Sync>;

#[derive(Default)]
pub struct DirectoryWatchState {
    inner: Arc<Mutex<WatchState>>,
}

#[derive(Default)]
struct WatchState {
    generation: Option<u64>,
    session: Option<WatchSession>,
    stopped: bool,
}

impl DirectoryWatchState {
    /// Also call this on window destruction: the event emitter owns an
    /// AppHandle, so explicitly releasing the session breaks its ownership cycle.
    pub fn stop(&self) {
        let session = self.inner.lock().ok().and_then(|mut state| {
            state.stopped = true;
            state.generation = None;
            state.session.take()
        });
        drop(session);
    }
}

impl Drop for DirectoryWatchState {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tauri::command]
pub async fn watch_directories(
    generation: u64,
    paths: Vec<String>,
    state: tauri::State<'_, DirectoryWatchState>,
    app: tauri::AppHandle,
) -> Result<Vec<WatchStatus>, String> {
    let state = Arc::clone(&state.inner);
    crate::background::run(move || {
        replace_session(
            &state,
            generation,
            paths,
            Arc::new(move |event| {
                let _ = app.emit("directory-changed", event);
            }),
        )
    })
    .await
}

fn replace_session(
    state: &Mutex<WatchState>,
    generation: u64,
    paths: Vec<String>,
    emit: Emit,
) -> Result<Vec<WatchStatus>, String> {
    let targets = normalize_targets(paths)?;
    let old = {
        let mut state = state.lock().map_err(|e| e.to_string())?;
        if state.stopped || state.generation.is_some_and(|current| current > generation) {
            return Ok(Vec::new());
        }
        state.generation = Some(generation);
        state.session.take()
    };
    // Dropping/joining an old native watcher never runs on the window thread.
    drop(old);
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let (session, statuses) = WatchSession::start(generation, targets, emit)?;
    let mut state = state.lock().map_err(|e| e.to_string())?;
    if !state.stopped && state.generation == Some(generation) {
        state.session = Some(session);
    }
    Ok(statuses)
}

#[derive(Clone)]
struct Target {
    display: String,
    path: PathBuf,
}

fn path_key(path: &Path) -> String {
    #[cfg(windows)]
    let key = path.to_string_lossy().replace('\\', "/");
    #[cfg(not(windows))]
    let key = path.to_string_lossy();
    let key = key.trim_end_matches('/');
    #[cfg(windows)]
    let key = key.to_lowercase();
    key.to_string()
}

fn same_path(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}

fn at_or_below(path: &Path, ancestor: &Path) -> bool {
    let path = path_key(path);
    let ancestor = path_key(ancestor);
    path == ancestor
        || path
            .strip_prefix(&ancestor)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn normalize_targets(paths: Vec<String>) -> Result<Vec<Target>, String> {
    if paths.len() > 2 {
        return Err("Only the two visible directories can be watched".to_string());
    }
    let mut seen = HashSet::new();
    let mut targets = Vec::new();
    for display in paths {
        let lower = display.to_lowercase();
        if display.trim().is_empty() || lower.starts_with("ssh://") || lower.starts_with("sftp://")
        {
            return Err("Only local directories can be watched".to_string());
        }
        // absolute() is lexical: resolving symlinks would lose notifications
        // when the link itself is replaced in its original parent directory.
        let path = std::path::absolute(&display).map_err(|e| e.to_string())?;
        if seen.insert(path_key(&path)) {
            targets.push(Target { display, path });
        }
    }
    Ok(targets)
}

enum Message {
    Event(notify::Result<Event>),
    Wake,
}

struct WatchSession {
    stop: Arc<AtomicBool>,
    sender: SyncSender<Message>,
    worker: Option<JoinHandle<()>>,
}

struct WatchedDirectory {
    path: PathBuf,
    // FSEvents emits canonical paths (e.g. /private/var for /var), and
    // directory symlinks can point outside the displayed path on every OS.
    // Keep the lexical path too so replacing the link is still observable.
    canonical_path: Option<PathBuf>,
    canonical_entry_path: Option<PathBuf>,
    exists: bool,
    active: bool,
    initial_error: Option<String>,
}

impl WatchSession {
    fn start(
        generation: u64,
        targets: Vec<Target>,
        emit: Emit,
    ) -> Result<(Self, Vec<WatchStatus>), String> {
        // Bound the queue during large copies. Overflow invalidates all visible
        // listings, so dropping individual events cannot lose their changes.
        let (sender, receiver) = mpsc::sync_channel(64);
        let overflow = Arc::new(AtomicBool::new(false));
        let callback_sender = sender.clone();
        let callback_overflow = Arc::clone(&overflow);
        let mut watcher = notify::recommended_watcher(move |event| {
            if let Err(mpsc::TrySendError::Full(_)) =
                callback_sender.try_send(Message::Event(event))
            {
                callback_overflow.store(true, Ordering::Relaxed);
            }
        })
        .map_err(|e| format!("Cannot start directory watcher: {e}"))?;

        let mut directories: Vec<WatchedDirectory> = Vec::new();
        for target in &targets {
            for path in std::iter::once(target.path.as_path()).chain(target.path.parent()) {
                if directories.iter().any(|entry| same_path(&entry.path, path)) {
                    continue;
                }
                let exists = path.is_dir();
                let result = watcher.watch(path, RecursiveMode::NonRecursive);
                directories.push(WatchedDirectory {
                    path: path.to_path_buf(),
                    canonical_path: path.canonicalize().ok(),
                    canonical_entry_path: canonical_entry_path(path),
                    exists,
                    active: result.is_ok(),
                    initial_error: result.err().map(|error| error.to_string()),
                });
            }
        }
        let statuses = targets
            .iter()
            .map(|target| {
                let error = directories
                    .iter()
                    .find(|entry| same_path(&entry.path, &target.path))
                    .and_then(|entry| entry.initial_error.clone());
                WatchStatus {
                    path: target.display.clone(),
                    error,
                }
            })
            .collect();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("kuf-directory-watch".to_string())
            .spawn(move || {
                run_worker(
                    generation,
                    targets,
                    directories,
                    watcher,
                    receiver,
                    overflow,
                    worker_stop,
                    emit,
                )
            })
            .map_err(|e| format!("Cannot start directory watcher worker: {e}"))?;
        Ok((
            Self {
                stop,
                sender,
                worker: Some(worker),
            },
            statuses,
        ))
    }
}

impl Drop for WatchSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.sender.try_send(Message::Wake);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Default)]
struct Pending {
    paths: HashSet<String>,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl Pending {
    fn mark(&mut self, path: &str, now: Instant) {
        self.paths.insert(path.to_string());
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    fn deadline(&self) -> Option<Instant> {
        Some((self.first? + MAX_DELAY).min(self.last? + QUIET_PERIOD))
    }

    fn take_due(&mut self, now: Instant, targets: &[Target]) -> Option<Vec<String>> {
        if self.deadline().is_none_or(|deadline| now < deadline) {
            return None;
        }
        let paths = targets
            .iter()
            .filter(|target| self.paths.contains(&target.display))
            .map(|target| target.display.clone())
            .collect();
        *self = Self::default();
        Some(paths)
    }
}

fn meaningful(event: &Event) -> bool {
    event.need_rescan()
        || match event.kind {
            EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
            EventKind::Access(_) => false,
            _ => true,
        }
}

fn affects(target: &Path, changed: &Path) -> bool {
    at_or_below(target, changed)
        || changed
            .parent()
            .is_some_and(|parent| same_path(parent, target))
}

fn affects_target(target: &Target, directories: &[WatchedDirectory], changed: &Path) -> bool {
    affects(&target.path, changed)
        || directories
            .iter()
            .find(|directory| same_path(&directory.path, &target.path))
            .is_some_and(|directory| {
                directory
                    .canonical_path
                    .iter()
                    .chain(&directory.canonical_entry_path)
                    .any(|canonical| affects(canonical, changed))
            })
}

fn canonical_entry_path(path: &Path) -> Option<PathBuf> {
    // Resolve the parent, retaining the final symlink's own name. Its parent
    // watch reports replacement events here rather than at the old target.
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => parent.canonicalize().ok().map(|parent| parent.join(name)),
        _ => path.canonicalize().ok(),
    }
}

fn rearm(watcher: &mut RecommendedWatcher, directory: &mut WatchedDirectory) {
    // Unwatch the previous alias before resolving the current one. Otherwise
    // FSEvents would resolve a replaced symlink to its new target and leave
    // the old target registered indefinitely.
    if let Some(canonical) = &directory.canonical_path {
        let _ = watcher.unwatch(canonical);
    }
    let _ = watcher.unwatch(&directory.path);
    directory.canonical_path = directory.path.canonicalize().ok();
    directory.canonical_entry_path = canonical_entry_path(&directory.path);
    directory.exists = directory.path.is_dir();
    directory.active = directory.exists
        && watcher
            .watch(&directory.path, RecursiveMode::NonRecursive)
            .is_ok();
}

#[allow(clippy::too_many_arguments)]
fn run_worker(
    generation: u64,
    targets: Vec<Target>,
    mut directories: Vec<WatchedDirectory>,
    mut watcher: RecommendedWatcher,
    receiver: Receiver<Message>,
    overflow: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    emit: Emit,
) {
    let mut pending = Pending::default();
    let mut next_recovery = Instant::now() + RECOVERY_INTERVAL;
    while !stop.load(Ordering::Relaxed) {
        let deadline = pending
            .deadline()
            .map_or(next_recovery, |value| value.min(next_recovery));
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Message::Event(Ok(event))) if meaningful(&event) => {
                let now = Instant::now();
                for target in &targets {
                    if event.need_rescan()
                        || event.paths.is_empty()
                        || event
                            .paths
                            .iter()
                            .any(|path| affects_target(target, &directories, path))
                    {
                        pending.mark(&target.display, now);
                    }
                }
                // A watcher attached to a removed inode/Windows directory handle
                // cannot observe its replacement. Keep the parent and reattach.
                if matches!(
                    event.kind,
                    EventKind::Create(_)
                        | EventKind::Remove(_)
                        | EventKind::Modify(ModifyKind::Name(_))
                ) {
                    for directory in &mut directories {
                        if event.paths.iter().any(|path| {
                            at_or_below(&directory.path, path)
                                || directory
                                    .canonical_path
                                    .iter()
                                    .chain(&directory.canonical_entry_path)
                                    .any(|canonical| at_or_below(canonical, path))
                        }) {
                            rearm(&mut watcher, directory);
                        }
                    }
                }
            }
            Ok(Message::Event(Err(_))) => {
                for target in &targets {
                    pending.mark(&target.display, Instant::now());
                }
                // Some backends stop a watch after an OS error. Retry it on
                // the recovery timer even if the directory still exists.
                for directory in &mut directories {
                    directory.active = false;
                }
            }
            Ok(_) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let now = Instant::now();
        if overflow.swap(false, Ordering::Relaxed) {
            for target in &targets {
                pending.mark(&target.display, now);
            }
        }
        if now >= next_recovery {
            // Constant work: at most two directories and two parents, never an
            // entry scan. This recovers even when both a directory and its
            // parent disappeared and no surviving native watch can notify us.
            for directory in &mut directories {
                let exists = directory.path.is_dir();
                if exists != directory.exists || (exists && !directory.active) {
                    let changed = exists != directory.exists;
                    rearm(&mut watcher, directory);
                    if changed || directory.active {
                        for target in &targets {
                            if affects(&target.path, &directory.path) {
                                pending.mark(&target.display, now);
                            }
                        }
                    }
                }
            }
            next_recovery = Instant::now() + RECOVERY_INTERVAL;
        }
        if let Some(paths) = pending.take_due(Instant::now(), &targets) {
            if !paths.is_empty() {
                emit(DirectoryChanged { generation, paths });
            }
        }
    }
    // The native watcher is dropped before this thread finishes.
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("kuf-watch-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_two_local_paths_are_accepted_and_duplicates_are_shared() {
        let root = Fixture::new();
        let path = root.0.to_string_lossy().to_string();
        assert_eq!(
            normalize_targets(vec![path.clone(), path.clone()])
                .unwrap()
                .len(),
            1
        );
        assert!(normalize_targets(vec![path.clone(), path.clone(), path]).is_err());
        assert!(normalize_targets(vec!["ssh://host/tmp".into()]).is_err());
        assert!(normalize_targets(vec!["sftp://host/tmp".into()]).is_err());
        assert!(normalize_targets(vec![String::new()]).is_err());
    }

    #[test]
    fn access_events_do_not_cause_refresh_but_writes_and_rescans_do() {
        assert!(!meaningful(&Event::new(EventKind::Access(
            AccessKind::Open(AccessMode::Read)
        ))));
        assert!(!meaningful(&Event::new(EventKind::Access(
            AccessKind::Read
        ))));
        assert!(meaningful(&Event::new(EventKind::Access(
            AccessKind::Close(AccessMode::Write)
        ))));
        assert!(meaningful(&Event::new(EventKind::Modify(
            ModifyKind::Data(DataChange::Any)
        ))));
        assert!(meaningful(&Event::new(EventKind::Create(CreateKind::File))));
    }

    #[test]
    fn debounce_waits_for_quiet_but_flushes_during_continuous_changes() {
        let targets =
            normalize_targets(vec![std::env::temp_dir().to_string_lossy().to_string()]).unwrap();
        let path = &targets[0].display;
        let start = Instant::now();
        let mut pending = Pending::default();
        pending.mark(path, start);
        pending.mark(path, start + Duration::from_millis(200));
        assert!(pending
            .take_due(start + Duration::from_millis(300), &targets)
            .is_none());
        assert_eq!(
            pending
                .take_due(start + Duration::from_millis(450), &targets)
                .unwrap(),
            vec![path.clone()]
        );
        pending.mark(path, start);
        for offset in [200, 400, 600, 800, 999] {
            pending.mark(path, start + Duration::from_millis(offset));
        }
        assert!(pending
            .take_due(start + Duration::from_millis(999), &targets)
            .is_none());
        assert!(pending.take_due(start + MAX_DELAY, &targets).is_some());
    }

    #[test]
    fn notifications_ignore_siblings_and_nested_descendants() {
        let root = std::env::temp_dir().join("kuf-watch-scope");
        assert!(affects(&root, &root.join("file.txt")));
        assert!(affects(&root, &root));
        assert!(affects(&root, root.parent().unwrap()));
        assert!(!affects(&root, &root.join("nested/file.txt")));
        assert!(!affects(
            &root,
            &root.with_file_name("kuf-watch-scope-other")
        ));
    }

    #[test]
    fn real_watch_detects_create_overwrite_delete_and_directory_recreation() {
        let root = Fixture::new();
        let watched = root.0.join("visible");
        fs::create_dir(&watched).unwrap();
        let path = watched.to_string_lossy().to_string();
        let targets = normalize_targets(vec![path.clone()]).unwrap();
        let (sender, receiver) = mpsc::channel();
        let (session, statuses) = WatchSession::start(
            42,
            targets,
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .unwrap();
        assert!(statuses[0].error.is_none(), "{:?}", statuses[0]);
        let expect_refresh = || {
            let event = receiver
                .recv_timeout(Duration::from_secs(8))
                .expect("directory change notification");
            assert_eq!(event.generation, 42);
            assert_eq!(event.paths, vec![path.clone()]);
            while receiver.try_recv().is_ok() {}
        };
        let file = watched.join("sample.txt");
        fs::write(&file, b"created").unwrap();
        expect_refresh();
        fs::write(&file, b"direct overwrite with changed size").unwrap();
        expect_refresh();
        fs::remove_file(&file).unwrap();
        expect_refresh();
        fs::remove_dir(&watched).unwrap();
        expect_refresh();
        fs::create_dir(&watched).unwrap();
        expect_refresh();
        fs::write(&file, b"reattached watcher").unwrap();
        expect_refresh();
        drop(session);
        fs::write(&file, b"watch stopped").unwrap();
        assert!(receiver.recv_timeout(Duration::from_millis(400)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_directory_matches_canonical_events_and_rearms_after_replacement() {
        use std::os::unix::fs::symlink;
        let root = Fixture::new();
        let first = root.0.join("first");
        let second = root.0.join("second");
        let visible = root.0.join("shortcut");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        symlink(&first, &visible).unwrap();
        let display = visible.to_string_lossy().to_string();
        let targets = normalize_targets(vec![display.clone()]).unwrap();
        let (sender, receiver) = mpsc::channel();
        let (session, statuses) = WatchSession::start(
            8,
            targets,
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .unwrap();
        assert!(statuses[0].error.is_none(), "{:?}", statuses[0]);
        let expect_refresh = || {
            let event = receiver
                .recv_timeout(Duration::from_secs(8))
                .expect("change through directory symlink");
            assert_eq!(event.paths, vec![display.clone()]);
            assert_eq!(event.generation, 8);
        };
        fs::write(first.join("first.txt"), b"first target").unwrap();
        expect_refresh();
        fs::remove_file(&visible).unwrap();
        symlink(&second, &visible).unwrap();
        expect_refresh();
        // Settle replacement notifications before checking the new target.
        thread::sleep(QUIET_PERIOD + QUIET_PERIOD);
        while receiver.try_recv().is_ok() {}
        fs::write(second.join("second.txt"), b"replacement target").unwrap();
        expect_refresh();
        drop(session);
    }

    #[test]
    fn stale_registrations_cannot_replace_the_current_generation() {
        let root = Fixture::new();
        let visible = root.0.join("visible");
        let stale = root.0.join("stale");
        fs::create_dir(&visible).unwrap();
        fs::create_dir(&stale).unwrap();
        let state = Mutex::new(WatchState::default());
        let (sender, receiver) = mpsc::channel();
        let emit: Emit = Arc::new(move |event| {
            let _ = sender.send(event);
        });
        replace_session(
            &state,
            2,
            vec![visible.to_string_lossy().to_string()],
            Arc::clone(&emit),
        )
        .unwrap();
        assert!(
            replace_session(&state, 1, vec![stale.to_string_lossy().to_string()], emit)
                .unwrap()
                .is_empty()
        );
        fs::write(visible.join("current.txt"), b"current generation").unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(8))
                .unwrap()
                .generation,
            2
        );
        replace_session(&state, 3, Vec::new(), Arc::new(|_| {})).unwrap();
        assert!(state.lock().unwrap().session.is_none());
    }

    #[test]
    fn missing_directory_and_lost_parent_recover_without_recursive_scans() {
        let root = Fixture::new();
        let visible = root.0.join("visible");
        let targets = normalize_targets(vec![visible.to_string_lossy().to_string()]).unwrap();
        let (sender, receiver) = mpsc::channel();
        let (session, statuses) = WatchSession::start(
            7,
            targets,
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .unwrap();
        assert!(statuses[0].error.is_some());
        fs::create_dir(&visible).unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(8))
                .unwrap()
                .generation,
            7
        );
        fs::remove_dir(&visible).unwrap();
        fs::remove_dir(&root.0).unwrap();
        // Allow the existence probe to observe the lost parent. No watch can
        // survive here: recreation must recover through the bounded probe.
        thread::sleep(RECOVERY_INTERVAL + QUIET_PERIOD);
        while receiver.try_recv().is_ok() {}
        fs::create_dir_all(&visible).unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(8))
                .unwrap()
                .generation,
            7
        );
        while receiver.try_recv().is_ok() {}
        fs::write(visible.join("recovered.txt"), b"parent recovered").unwrap();
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(8))
                .unwrap()
                .generation,
            7
        );
        drop(session);
    }
}
