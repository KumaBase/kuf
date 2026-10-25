//! Read-only local filename search. Its cancellation state is independent of
//! file transfers, and every filesystem call runs on the blocking pool.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, ReadDir},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;

const MAX_RESULTS: usize = 5_000;
const MAX_VISITED: usize = 1_000_000;
const MAX_DEPTH: usize = 128;

#[derive(Default)]
pub struct SearchState(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl SearchState {
    fn begin(&self, id: &str) -> Result<(), String> {
        if id.is_empty() || id.len() > 128 {
            return Err("検索IDが不正です".into());
        }
        let mut searches = self.0.lock().map_err(|e| e.to_string())?;
        if searches.contains_key(id) {
            return Err("同じ検索が実行中です".into());
        }
        if searches.len() >= 8 {
            return Err("実行中の検索が多すぎます".into());
        }
        searches.insert(id.into(), Arc::new(AtomicBool::new(false)));
        Ok(())
    }
    fn token(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "検索は終了しています".into())
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        if let Some(token) = self.0.lock().map_err(|e| e.to_string())?.get(id) {
            token.store(true, Ordering::Relaxed);
        }
        Ok(())
    }
    fn finish(&self, id: &str) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.remove(id);
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct SearchRequest {
    pub search_id: String,
    pub root_path: String,
    pub query: String,
    pub include_files: bool,
    pub include_directories: bool,
    pub show_hidden: bool,
    pub case_sensitive: bool,
    pub max_results: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchResult {
    pub path: String,
    pub parent_path: String,
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

#[derive(Clone, Serialize)]
pub struct SearchProgress {
    pub search_id: String,
    pub visited: usize,
    pub matched: usize,
    pub skipped: usize,
}

#[derive(Debug, Serialize)]
pub struct SearchResponse {
    pub search_id: String,
    pub results: Vec<SearchResult>,
    pub visited: usize,
    pub skipped: usize,
    pub truncated: bool,
    pub limit_reason: Option<&'static str>,
    pub cancelled: bool,
    pub elapsed_ms: u128,
}

#[tauri::command]
pub fn search_begin(search_id: String, state: tauri::State<SearchState>) -> Result<(), String> {
    state.begin(&search_id)
}

#[tauri::command]
pub fn search_cancel(search_id: String, state: tauri::State<SearchState>) -> Result<(), String> {
    state.cancel(&search_id)
}

#[tauri::command]
pub async fn search_files(
    request: SearchRequest,
    state: tauri::State<'_, SearchState>,
    app: tauri::AppHandle,
) -> Result<SearchResponse, String> {
    let id = request.search_id.clone();
    let token = state.token(&id)?;
    let result = crate::background::run(move || {
        search_inner(request, &token, |progress| {
            let _ = app.emit("file-search-progress", progress);
        })
    })
    .await;
    // Even invalid requests and worker failures release their independent slot.
    state.finish(&id)?;
    result
}

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points must not turn into recursive walks.
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    false
}

fn is_hidden(name: &str, metadata: &fs::Metadata) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x2 != 0;
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

struct NameMatcher {
    pattern: Vec<char>,
    wildcard: bool,
    case_sensitive: bool,
}
impl NameMatcher {
    fn new(query: &str, case_sensitive: bool) -> Self {
        let pattern = if case_sensitive {
            query.into()
        } else {
            query.to_lowercase()
        };
        Self {
            pattern: pattern.chars().collect(),
            wildcard: query.contains(['*', '?']),
            case_sensitive,
        }
    }
    fn matches(&self, name: &str) -> bool {
        let name = if self.case_sensitive {
            name.into()
        } else {
            name.to_lowercase()
        };
        let name: Vec<char> = name.chars().collect();
        if !self.wildcard {
            return name
                .windows(self.pattern.len())
                .any(|part| part == self.pattern);
        }
        // '*' covers any sequence; '?' covers one Unicode scalar. Match the
        // whole filename for wildcard queries, as the list filter does.
        let (mut n, mut p, mut star, mut retry) = (0, 0, None, 0);
        while n < name.len() {
            if p < self.pattern.len() && (self.pattern[p] == '?' || self.pattern[p] == name[n]) {
                n += 1;
                p += 1;
            } else if p < self.pattern.len() && self.pattern[p] == '*' {
                star = Some(p);
                p += 1;
                retry = n;
            } else if let Some(index) = star {
                retry += 1;
                n = retry;
                p = index + 1;
            } else {
                return false;
            }
        }
        while p < self.pattern.len() && self.pattern[p] == '*' {
            p += 1;
        }
        p == self.pattern.len()
    }
}

fn search_inner(
    request: SearchRequest,
    cancelled: &AtomicBool,
    report: impl FnMut(SearchProgress),
) -> Result<SearchResponse, String> {
    search_with_reader(request, cancelled, report, |path| fs::read_dir(path))
}

fn search_with_reader(
    request: SearchRequest,
    cancelled: &AtomicBool,
    mut report: impl FnMut(SearchProgress),
    mut read_directory: impl FnMut(&Path) -> std::io::Result<ReadDir>,
) -> Result<SearchResponse, String> {
    let query = request.query.trim();
    if query.is_empty() || query.chars().count() > 256 || query.contains('\0') {
        return Err("検索する名前を1〜256文字で入力してください".into());
    }
    if !request.include_files && !request.include_directories {
        return Err("検索対象を選んでください".into());
    }
    if request.root_path.starts_with("sftp://") {
        return Err("配下検索はローカルフォルダで利用できます".into());
    }
    let root = PathBuf::from(&request.root_path);
    if !root.is_absolute() {
        return Err("検索元には絶対パスを指定してください".into());
    }
    let root_metadata =
        fs::symlink_metadata(&root).map_err(|e| format!("検索元を開けません: {e}"))?;
    if is_link(&root_metadata) || !root_metadata.is_dir() {
        return Err(
            "実体のあるローカルフォルダを検索元に選んでください（リンクの配下は検索しません）"
                .into(),
        );
    }
    let started = Instant::now();
    let mut last_report = started;
    let mut response = SearchResponse {
        search_id: request.search_id,
        results: Vec::new(),
        visited: 0,
        skipped: 0,
        truncated: false,
        limit_reason: None,
        cancelled: false,
        elapsed_ms: 0,
    };
    let max_results = request
        .max_results
        .unwrap_or(MAX_RESULTS)
        .clamp(1, MAX_RESULTS);
    let matcher = NameMatcher::new(query, request.case_sensitive);
    let progress = |response: &SearchResponse| SearchProgress {
        search_id: response.search_id.clone(),
        visited: response.visited,
        matched: response.results.len(),
        skipped: response.skipped,
    };
    report(progress(&response));
    if cancelled.load(Ordering::Relaxed) {
        response.cancelled = true;
        return Ok(response);
    }
    let first = read_directory(&root).map_err(|e| format!("検索元を読み取れません: {e}"))?;
    // Retain only the current DFS path of iterators, rather than accumulating
    // every pending subdirectory of a large tree in memory.
    let mut stack: Vec<(PathBuf, ReadDir)> = vec![(root, first)];
    while !stack.is_empty() {
        if cancelled.load(Ordering::Relaxed) {
            response.cancelled = true;
            break;
        }
        if last_report.elapsed() >= Duration::from_millis(100) {
            report(progress(&response));
            last_report = Instant::now();
        }
        if response.visited >= MAX_VISITED {
            response.truncated = true;
            response.limit_reason = Some("visited");
            break;
        }
        let next = stack.last_mut().unwrap().1.next();
        let entry = match next {
            None => {
                stack.pop();
                continue;
            }
            Some(Err(_)) => {
                response.visited += 1;
                response.skipped += 1;
                continue;
            }
            Some(Ok(entry)) => entry,
        };
        response.visited += 1;
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                response.skipped += 1;
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if !request.show_hidden && is_hidden(&name, &metadata) {
            continue;
        }
        let link = is_link(&metadata);
        let directory = metadata.is_dir() && !link;
        if ((directory && request.include_directories) || (!directory && request.include_files))
            && matcher.matches(&name)
        {
            response.results.push(SearchResult {
                path: path.to_string_lossy().to_string(),
                parent_path: path
                    .parent()
                    .unwrap_or(Path::new(""))
                    .to_string_lossy()
                    .to_string(),
                name,
                is_dir: directory,
                is_symlink: link,
            });
            if response.results.len() >= max_results {
                response.truncated = true;
                response.limit_reason = Some("results");
                break;
            }
        }
        if directory {
            if stack.len() >= MAX_DEPTH {
                response.truncated = true;
                response.limit_reason = Some("depth");
                break;
            }
            // Check again immediately before entering. Reparse points and
            // symlinks that appeared since enumeration are never intentional targets.
            match fs::symlink_metadata(&path) {
                Ok(current) if is_link(&current) || !current.is_dir() => {}
                Err(_) => response.skipped += 1,
                Ok(_) => match read_directory(&path) {
                    Ok(entries) => stack.push((path, entries)),
                    Err(_) => response.skipped += 1,
                },
            }
        }
    }
    response.elapsed_ms = started.elapsed().as_millis();
    report(progress(&response));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "kuf-search-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn request(&self, query: &str) -> SearchRequest {
            SearchRequest {
                search_id: "fixture".into(),
                root_path: self.0.to_string_lossy().into(),
                query: query.into(),
                include_files: true,
                include_directories: true,
                show_hidden: true,
                case_sensitive: false,
                max_results: None,
            }
        }
        fn run(&self, request: SearchRequest) -> SearchResponse {
            search_inner(request, &AtomicBool::new(false), |_| {}).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn names_match_substrings_case_preferences_and_unicode_wildcards() {
        assert!(NameMatcher::new("PH", false).matches("Alpha.txt"));
        assert!(!NameMatcher::new("PH", true).matches("Alpha.txt"));
        assert!(NameMatcher::new("*資料?.TXT", false).matches("日本資料一.txt"));
        assert!(!NameMatcher::new("*.txt", false).matches("notes.txt.bak"));
        assert!(NameMatcher::new("a*b?c", true).matches("axybzc"));
        assert!(!NameMatcher::new("a*b?c", true).matches("abdcx"));
        assert!(NameMatcher::new("?", true).matches("熊"));
        assert!(!NameMatcher::new("?", true).matches("熊熊"));
    }

    #[test]
    fn searches_nested_names_filters_types_and_keeps_source_bytes() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("資料Folder")).unwrap();
        fs::write(fixture.0.join("資料Folder").join("資料.txt"), b"original").unwrap();
        fs::write(fixture.0.join("different.log"), b"other").unwrap();
        let response = fixture.run(fixture.request("資料"));
        assert_eq!(response.results.len(), 2);
        assert_eq!(response.visited, 3);
        assert!(response
            .results
            .iter()
            .all(|item| Path::new(&item.path).parent().unwrap() == Path::new(&item.parent_path)));
        let mut request = fixture.request("資料");
        request.include_files = false;
        assert_eq!(
            fixture
                .run(request)
                .results
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            vec!["資料Folder"]
        );
        let mut request = fixture.request("資料");
        request.include_directories = false;
        assert_eq!(
            fixture
                .run(request)
                .results
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            vec!["資料.txt"]
        );
        assert_eq!(
            fs::read(fixture.0.join("資料Folder").join("資料.txt")).unwrap(),
            b"original"
        );
    }

    #[test]
    fn hidden_directories_are_pruned_and_limits_are_reported() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join(".hidden")).unwrap();
        fs::write(
            fixture.0.join(".hidden").join("visible.txt"),
            b"hidden parent",
        )
        .unwrap();
        fs::write(fixture.0.join("first.txt"), b"one").unwrap();
        fs::write(fixture.0.join("second.txt"), b"two").unwrap();
        let mut request = fixture.request("*.txt");
        request.show_hidden = false;
        assert_eq!(fixture.run(request).results.len(), 2);
        assert_eq!(fixture.run(fixture.request("*.txt")).results.len(), 3);
        let mut request = fixture.request("*.txt");
        request.max_results = Some(1);
        let response = fixture.run(request);
        assert_eq!(response.results.len(), 1);
        assert!(response.truncated);
        assert_eq!(response.limit_reason, Some("results"));
    }

    #[test]
    fn cancellation_returns_partial_results_and_is_scoped_to_a_search() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("one.txt"), b"one").unwrap();
        let token = AtomicBool::new(false);
        let response = search_inner(fixture.request("*"), &token, |_| {
            token.store(true, Ordering::Relaxed)
        })
        .unwrap();
        assert!(response.cancelled);
        assert!(response.results.is_empty());
        let state = SearchState::default();
        state.begin("one").unwrap();
        state.begin("two").unwrap();
        assert!(state.begin("one").is_err());
        state.cancel("one").unwrap();
        assert!(state.token("one").unwrap().load(Ordering::Relaxed));
        assert!(!state.token("two").unwrap().load(Ordering::Relaxed));
        state.finish("one").unwrap();
        assert!(state.token("one").is_err());
        state.begin("one").unwrap();
        assert!(!state.token("one").unwrap().load(Ordering::Relaxed));
    }

    #[test]
    fn invalid_roots_queries_and_empty_targets_fail_clearly() {
        let fixture = Fixture::new();
        assert!(search_inner(fixture.request(" "), &AtomicBool::new(false), |_| {}).is_err());
        let mut request = fixture.request("*");
        request.root_path = "sftp://fixture/path".into();
        assert!(search_inner(request, &AtomicBool::new(false), |_| {}).is_err());
        let mut request = fixture.request("*");
        request.include_files = false;
        request.include_directories = false;
        assert!(search_inner(request, &AtomicBool::new(false), |_| {}).is_err());
    }

    #[test]
    fn unreadable_subdirectory_is_counted_and_other_results_continue() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("denied")).unwrap();
        fs::write(fixture.0.join("kept.txt"), b"kept").unwrap();
        let response = search_with_reader(
            fixture.request("*.txt"),
            &AtomicBool::new(false),
            |_| {},
            |path| {
                if path.ends_with("denied") {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "fixture permission denial",
                    ))
                } else {
                    fs::read_dir(path)
                }
            },
        )
        .unwrap();
        assert_eq!(response.skipped, 1);
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].name, "kept.txt");
        assert_eq!(fs::read(fixture.0.join("kept.txt")).unwrap(), b"kept");
    }

    #[test]
    fn cancelling_after_one_directory_returns_partial_results() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("child")).unwrap();
        fs::write(fixture.0.join("child").join("not-reached.txt"), b"kept").unwrap();
        let cancelled = AtomicBool::new(false);
        let response = search_with_reader(
            fixture.request("*"),
            &cancelled,
            |_| {},
            |path| {
                if path.ends_with("child") {
                    cancelled.store(true, Ordering::Relaxed);
                }
                fs::read_dir(path)
            },
        )
        .unwrap();
        assert!(response.cancelled);
        assert_eq!(response.results.len(), 1);
        assert_eq!(response.results[0].name, "child");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_results_do_not_follow_directories_or_cycles() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("must-not-find.txt"), b"outside").unwrap();
        symlink(&outside.0, fixture.0.join("external-link")).unwrap();
        symlink(&fixture.0, fixture.0.join("cycle")).unwrap();
        let response = fixture.run(fixture.request("*"));
        assert_eq!(response.results.len(), 2);
        assert_eq!(response.visited, 2);
        assert!(response
            .results
            .iter()
            .all(|item| item.is_symlink && !item.is_dir));
        let mut request = fixture.request("*");
        request.root_path = fixture.0.join("external-link").to_string_lossy().into();
        assert!(search_inner(request, &AtomicBool::new(false), |_| {}).is_err());
    }
}
