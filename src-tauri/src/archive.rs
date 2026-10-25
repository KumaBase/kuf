//! Local ZIP operations. Entries are inspected before any output is created.
//! Output names are exclusive: an existing file, folder or link is never replaced.
use chrono::{Datelike, TimeZone, Timelike};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Clone, Copy)]
struct Limits {
    entries: usize,
    file_bytes: u64,
    total_bytes: u64,
    depth: usize,
}

const LIMITS: Limits = Limits {
    entries: 100_000,
    file_bytes: 8 * 1024 * 1024 * 1024,
    total_bytes: 20 * 1024 * 1024 * 1024,
    depth: 64,
};
const MAX_DIRECTORY_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct ArchiveResult {
    pub path: String,
    pub entries: usize,
    pub bytes: u64,
}

#[tauri::command]
pub async fn zip_create(
    sources: Vec<String>,
    target_dir: String,
    name: String,
    operation_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::operation::Operations>,
) -> Result<ArchiveResult, String> {
    let operation = state.get(operation_id.as_deref())?;
    crate::background::run(move || {
        let mut last_progress = Instant::now();
        create_zip(
            &sources.iter().map(PathBuf::from).collect::<Vec<_>>(),
            Path::new(&target_dir),
            &name,
            LIMITS,
            &|| operation.as_ref().map_or(Ok(()), |op| op.check()),
            &mut |completed, total| {
                if let Some(op) = &operation {
                    if completed == 0
                        || completed == total
                        || last_progress.elapsed().as_millis() >= 100
                    {
                        op.progress(&app, completed, total);
                        last_progress = Instant::now();
                    }
                }
            },
        )
    })
    .await
}

#[tauri::command]
pub async fn zip_extract(
    archive_path: String,
    target_dir: String,
    name: String,
    operation_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::operation::Operations>,
) -> Result<ArchiveResult, String> {
    let operation = state.get(operation_id.as_deref())?;
    crate::background::run(move || {
        let mut last_progress = Instant::now();
        extract_zip(
            Path::new(&archive_path),
            Path::new(&target_dir),
            &name,
            LIMITS,
            &|| operation.as_ref().map_or(Ok(()), |op| op.check()),
            &mut |completed, total| {
                if let Some(op) = &operation {
                    if completed == 0
                        || completed == total
                        || last_progress.elapsed().as_millis() >= 100
                    {
                        op.progress(&app, completed, total);
                        last_progress = Instant::now();
                    }
                }
            },
        )
    })
    .await
}

fn validate_component(component: &str) -> Result<(), String> {
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.len() > 255
        || component.ends_with(['.', ' '])
        || component
            .chars()
            .any(|c| c.is_control() || "/\\:<>\"|?*".contains(c))
    {
        return Err(format!("ZIPで扱えない名前です: {component:?}"));
    }
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_uppercase();
    let device = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    if device {
        return Err(format!("予約名はZIPで扱えません: {component}"));
    }
    Ok(())
}

fn relative_entry(name: &str, directory: bool, limits: Limits) -> Result<PathBuf, String> {
    let path = if directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    if path.len() > 4096 || path.split('/').count() > limits.depth {
        return Err("ZIP内のパスが長すぎます".to_string());
    }
    let mut relative = PathBuf::new();
    for component in path.split('/') {
        validate_component(component)?;
        relative.push(component);
    }
    Ok(relative)
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn existing_directory(path: &Path) -> Result<PathBuf, String> {
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("フォルダを開けません: {error}"))?;
    if !canonical.is_dir() {
        return Err("保存先はローカルフォルダを指定してください".to_string());
    }
    Ok(canonical)
}

fn add_size(total: &mut u64, size: u64, limits: Limits) -> Result<(), String> {
    if size > limits.file_bytes {
        return Err("ZIP処理の1ファイル上限（8 GiB）を超えています".to_string());
    }
    *total = total.checked_add(size).ok_or("ZIPサイズが大きすぎます")?;
    if *total > limits.total_bytes {
        return Err("ZIP処理の合計サイズ上限（20 GiB）を超えています".to_string());
    }
    Ok(())
}

// Reject collisions on case-insensitive filesystems too, before writing. A
// later explicit directory entry may refer to an already implied parent.
fn register_path(
    relative: &Path,
    directory: bool,
    paths: &mut HashMap<String, (PathBuf, bool)>,
    explicit: &mut HashSet<String>,
) -> Result<(), String> {
    let mut part = PathBuf::new();
    let components: Vec<_> = relative.iter().collect();
    for (index, component) in components.iter().enumerate() {
        part.push(component);
        let is_directory = index + 1 < components.len() || directory;
        let key = part.to_string_lossy().replace('\\', "/").to_lowercase();
        if index + 1 == components.len() && !explicit.insert(key.clone()) {
            return Err(format!(
                "ZIP内で名前が重複しています: {}",
                relative.display()
            ));
        }
        if let Some((existing, existing_directory)) = paths.get(&key) {
            if existing != &part || !existing_directory || !is_directory {
                return Err(format!(
                    "ZIP内でパスが衝突しています: {}",
                    relative.display()
                ));
            }
        } else {
            paths.insert(key, (part.clone(), is_directory));
        }
    }
    Ok(())
}

struct SourceEntry {
    path: PathBuf,
    relative: PathBuf,
    metadata: Metadata,
}

fn source_plan(
    sources: &[PathBuf],
    directory: &Path,
    limits: Limits,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(Vec<SourceEntry>, u64), String> {
    if sources.is_empty() {
        return Err("圧縮するファイルを選択してください".to_string());
    }
    if sources.len() > limits.entries {
        return Err("ZIPの項目数上限（100,000件）を超えています".to_string());
    }
    let mut pending = Vec::new();
    for source in sources {
        check()?;
        let metadata =
            fs::symlink_metadata(source).map_err(|error| format!("対象を読めません: {error}"))?;
        if is_link(&metadata) {
            return Err("リンクやジャンクションはZIPに含められません".to_string());
        }
        let path = fs::canonicalize(source).map_err(|error| error.to_string())?;
        if path.parent() != Some(directory) {
            return Err("圧縮対象は操作中のフォルダ内から選択してください".to_string());
        }
        let name = path.file_name().ok_or("圧縮対象の名前を取得できません")?;
        pending.push((path.clone(), PathBuf::from(name)));
    }
    pending.sort_by(|a, b| b.1.cmp(&a.1));
    let mut entries = Vec::new();
    let mut total = 0;
    let mut paths = HashMap::new();
    let mut explicit = HashSet::new();
    while let Some((path, relative)) = pending.pop() {
        check()?;
        if entries.len() >= limits.entries {
            return Err("ZIPの項目数上限（100,000件）を超えています".to_string());
        }
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if is_link(&metadata) || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(format!(
                "通常のファイル・フォルダのみ圧縮できます: {}",
                path.display()
            ));
        }
        let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
        if canonical != path || !canonical.starts_with(directory) {
            return Err("圧縮対象のパスが処理中に変更されました".to_string());
        }
        let name = relative
            .iter()
            .map(|component| {
                let name = component
                    .to_str()
                    .ok_or("UTF-8で表せないファイル名は圧縮できません")?;
                validate_component(name)?;
                Ok(name)
            })
            .collect::<Result<Vec<_>, String>>()?
            .join("/");
        let relative = relative_entry(&name, metadata.is_dir(), limits)?;
        register_path(&relative, metadata.is_dir(), &mut paths, &mut explicit)?;
        if metadata.is_dir() {
            let mut children = Vec::new();
            for entry in fs::read_dir(&path).map_err(|error| error.to_string())? {
                check()?;
                if entries.len() + pending.len() + children.len() + 1 >= limits.entries {
                    return Err("ZIPの項目数上限（100,000件）を超えています".to_string());
                }
                let entry = entry.map_err(|error| error.to_string())?;
                children.push((entry.path(), relative.join(entry.file_name())));
            }
            children.sort_by(|a, b| b.1.cmp(&a.1));
            pending.extend(children);
        } else {
            add_size(&mut total, metadata.len(), limits)?;
        }
        entries.push(SourceEntry {
            path,
            relative,
            metadata,
        });
    }
    Ok((entries, total))
}

fn zip_time(metadata: &Metadata) -> zip::DateTime {
    metadata
        .modified()
        .ok()
        .and_then(|time| {
            let time: chrono::DateTime<chrono::Local> = time.into();
            zip::DateTime::from_date_and_time(
                u16::try_from(time.year()).ok()?,
                time.month() as u8,
                time.day() as u8,
                time.hour() as u8,
                time.minute() as u8,
                time.second() as u8,
            )
            .ok()
        })
        .unwrap_or_default()
}

fn copy_limited(
    reader: &mut impl Read,
    writer: &mut impl Write,
    expected: u64,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<u64, String> {
    let mut buffer = [0_u8; 64 * 1024];
    let mut copied = 0_u64;
    loop {
        check()?;
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("ZIP読込エラー: {error}"))?;
        if read == 0 {
            break;
        }
        copied = copied
            .checked_add(read as u64)
            .ok_or("ZIPサイズが大きすぎます")?;
        if copied > expected {
            return Err("ファイルサイズが処理前の情報と一致しません".to_string());
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("ZIP書込エラー: {error}"))?;
    }
    if copied != expected {
        return Err("ファイルサイズが処理前の情報と一致しません".to_string());
    }
    Ok(copied)
}

fn partial_error(error: String, path: &Path) -> String {
    format!(
        "{error}\n作成途中の成果物を次の場所に保持しました。不要なら削除してください:\n{}",
        path.display()
    )
}

fn create_zip(
    sources: &[PathBuf],
    target_dir: &Path,
    name: &str,
    limits: Limits,
    check: &dyn Fn() -> Result<(), String>,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<ArchiveResult, String> {
    validate_component(name)?;
    if !name.to_ascii_lowercase().ends_with(".zip") || name.len() <= 4 {
        return Err("新しいZIP名は .zip で終わる名前にしてください".to_string());
    }
    let directory = existing_directory(target_dir)?;
    let destination = directory.join(name);
    let (entries, total) = source_plan(sources, &directory, limits, check)?;
    check()?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|error| {
            format!("新しいZIPを作れません（既存の名前には上書きしません）: {error}")
        })?;
    let result = (|| {
        let mut writer = ZipWriter::new(file);
        progress(0, entries.len());
        for (index, entry) in entries.iter().enumerate() {
            check()?;
            let metadata = fs::symlink_metadata(&entry.path).map_err(|error| error.to_string())?;
            if is_link(&metadata)
                || metadata.is_dir() != entry.metadata.is_dir()
                || metadata.is_file() != entry.metadata.is_file()
                || fs::canonicalize(&entry.path).map_err(|error| error.to_string())? != entry.path
            {
                return Err("圧縮対象のパスが処理中に変更されました".to_string());
            }
            let name = entry
                .relative
                .to_str()
                .ok_or("UTF-8で表せないファイル名です")?
                .replace('\\', "/");
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .last_modified_time(zip_time(&entry.metadata))
                .large_file(entry.metadata.len() > u32::MAX as u64);
            #[cfg(unix)]
            let options = {
                use std::os::unix::fs::PermissionsExt;
                options.unix_permissions(entry.metadata.permissions().mode() & 0o777)
            };
            if entry.metadata.is_dir() {
                writer
                    .add_directory(format!("{name}/"), options)
                    .map_err(|error| error.to_string())?;
            } else {
                let mut input = File::open(&entry.path).map_err(|error| error.to_string())?;
                writer
                    .start_file(name, options)
                    .map_err(|error| error.to_string())?;
                copy_limited(&mut input, &mut writer, entry.metadata.len(), check)?;
            }
            progress(index + 1, entries.len());
        }
        check()?;
        writer
            .finish()
            .map_err(|error| error.to_string())?
            .sync_all()
            .map_err(|error| error.to_string())?;
        Ok(ArchiveResult {
            path: destination.to_string_lossy().into_owned(),
            entries: entries.len(),
            bytes: total,
        })
    })();
    result.map_err(|error| partial_error(error, &destination))
}

struct ExtractEntry {
    relative: PathBuf,
    directory: bool,
    size: u64,
    modified: Option<zip::DateTime>,
    permissions: Option<u32>,
}

fn extract_plan<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    limits: Limits,
    check: &dyn Fn() -> Result<(), String>,
) -> Result<(Vec<ExtractEntry>, u64), String> {
    if archive.len() > limits.entries {
        return Err("ZIPの項目数上限（100,000件）を超えています".to_string());
    }
    archive
        .validate_header_consistency()
        .map_err(|error| format!("ZIP構造が不正です: {error}"))?;
    let mut entries = Vec::with_capacity(archive.len());
    let mut total = 0;
    let mut paths = HashMap::new();
    let mut explicit = HashSet::new();
    for index in 0..archive.len() {
        check()?;
        let file = archive
            .by_index(index)
            .map_err(|error| format!("ZIP項目を読めません: {error}"))?;
        if file.encrypted()
            || file.is_symlink()
            || file
                .unix_mode()
                .is_some_and(|mode| !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000))
        {
            return Err("暗号化・リンク・特殊ファイルを含むZIPは展開できません".to_string());
        }
        let name = file.name().map_err(|error| error.to_string())?;
        let relative = relative_entry(&name, file.is_dir(), limits)?;
        register_path(&relative, file.is_dir(), &mut paths, &mut explicit)?;
        if file.is_dir() && file.size() != 0 {
            return Err("データを含むフォルダ項目は展開できません".to_string());
        }
        add_size(&mut total, file.size(), limits)?;
        entries.push(ExtractEntry {
            relative,
            directory: file.is_dir(),
            size: file.size(),
            modified: file.last_modified(),
            // File-type and privileged bits are never restored from an archive.
            permissions: file.unix_mode().map(|mode| mode & 0o777),
        });
    }
    Ok((entries, total))
}

fn new_directory(path: &Path) -> std::io::Result<()> {
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder.create(path)
}

fn ensure_parents(
    root: &Path,
    relative: &Path,
    created: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let root_metadata = fs::symlink_metadata(root).map_err(|error| error.to_string())?;
    if is_link(&root_metadata)
        || !root_metadata.is_dir()
        || fs::canonicalize(root).map_err(|error| error.to_string())? != root
    {
        return Err("展開先のフォルダが処理中に変更されました".to_string());
    }
    let mut path = root.to_path_buf();
    for component in relative.iter() {
        path.push(component);
        if created.contains(&path) {
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if is_link(&metadata) || !metadata.is_dir() {
                return Err("展開先のフォルダが処理中に変更されました".to_string());
            }
        } else {
            new_directory(&path).map_err(|error| format!("新しい展開先を作れません: {error}"))?;
            created.insert(path.clone());
        }
        if !fs::canonicalize(&path)
            .map_err(|error| error.to_string())?
            .starts_with(root)
        {
            return Err("展開先が指定フォルダの外を指しています".to_string());
        }
    }
    Ok(())
}

fn restore_modified(file: &File, time: Option<zip::DateTime>) -> Result<(), String> {
    if let Some(time) = time {
        if let Some(local) = chrono::Local
            .with_ymd_and_hms(
                time.year() as i32,
                time.month() as u32,
                time.day() as u32,
                time.hour() as u32,
                time.minute() as u32,
                time.second() as u32,
            )
            .earliest()
        {
            file.set_modified(local.into())
                .map_err(|error| format!("更新日時を設定できません: {error}"))?;
        }
    }
    Ok(())
}

fn restore_permissions(file: &File, mode: Option<u32>) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode & 0o777))
            .map_err(|error| format!("ファイルの権限を設定できません: {error}"))?;
    }
    #[cfg(not(unix))]
    let _ = (file, mode);
    Ok(())
}

// Check the fixed EOCD/ZIP64 records before the ZIP reader allocates its index.
// The ZIP reader still performs the complete structural validation afterwards.
fn check_directory_budget(file: &mut File, limits: Limits) -> Result<(), String> {
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let window = length.min(22 + u16::MAX as u64);
    file.seek(SeekFrom::Start(length - window))
        .map_err(|error| error.to_string())?;
    let mut tail = vec![0_u8; window as usize];
    file.read_exact(&mut tail)
        .map_err(|error| error.to_string())?;
    let offset = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&index| {
            tail[index..index + 4] == [0x50, 0x4b, 0x05, 0x06]
                && index + 22 + u16::from_le_bytes([tail[index + 20], tail[index + 21]]) as usize
                    == tail.len()
        })
        .ok_or("ZIPの末尾レコードが不正です")?;
    let record = &tail[offset..offset + 22];
    if record[4..8] != [0, 0, 0, 0] || record[8..10] != record[10..12] {
        return Err("分割ZIPは展開できません".to_string());
    }
    let mut entries = u16::from_le_bytes([record[10], record[11]]) as u64;
    let mut bytes = u32::from_le_bytes(record[12..16].try_into().unwrap()) as u64;
    if entries == u16::MAX as u64 || bytes == u32::MAX as u64 || record[16..20] == [0xff; 4] {
        let eocd_position = length - window + offset as u64;
        let locator_position = eocd_position
            .checked_sub(20)
            .ok_or("ZIP64の末尾レコードが不正です")?;
        file.seek(SeekFrom::Start(locator_position))
            .map_err(|error| error.to_string())?;
        let mut locator = [0_u8; 20];
        file.read_exact(&mut locator)
            .map_err(|error| error.to_string())?;
        if locator[..4] != [0x50, 0x4b, 0x06, 0x07]
            || locator[4..8] != [0; 4]
            || locator[16..20] != [1, 0, 0, 0]
        {
            return Err("分割ZIP64または不正なZIP64です".to_string());
        }
        let position = u64::from_le_bytes(locator[8..16].try_into().unwrap());
        if position
            .checked_add(56)
            .is_none_or(|end| end > locator_position)
        {
            return Err("ZIP64の末尾レコードが不正です".to_string());
        }
        file.seek(SeekFrom::Start(position))
            .map_err(|error| error.to_string())?;
        let mut record64 = [0_u8; 56];
        file.read_exact(&mut record64)
            .map_err(|error| error.to_string())?;
        let record_bytes = u64::from_le_bytes(record64[4..12].try_into().unwrap());
        if record64[..4] != [0x50, 0x4b, 0x06, 0x06]
            || record64[16..24] != [0; 8]
            || record64[24..32] != record64[32..40]
            || !(44..=MAX_DIRECTORY_BYTES).contains(&record_bytes)
        {
            return Err("ZIP64の末尾レコードが不正です".to_string());
        }
        entries = u64::from_le_bytes(record64[32..40].try_into().unwrap());
        bytes = u64::from_le_bytes(record64[40..48].try_into().unwrap());
    }
    if entries > limits.entries as u64 || bytes > MAX_DIRECTORY_BYTES {
        return Err("ZIPの項目数または管理情報のサイズ上限を超えています".to_string());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn extract_zip(
    archive_path: &Path,
    target_dir: &Path,
    name: &str,
    limits: Limits,
    check: &dyn Fn() -> Result<(), String>,
    progress: &mut dyn FnMut(usize, usize),
) -> Result<ArchiveResult, String> {
    validate_component(name)?;
    let metadata = fs::symlink_metadata(archive_path).map_err(|error| error.to_string())?;
    if is_link(&metadata) || !metadata.is_file() {
        return Err("ローカルの通常のZIPファイルを選択してください".to_string());
    }
    let directory = existing_directory(target_dir)?;
    let destination = directory.join(name);
    check()?;
    let mut input = File::open(archive_path).map_err(|error| error.to_string())?;
    check_directory_budget(&mut input, limits)?;
    let mut archive =
        ZipArchive::new(input).map_err(|error| format!("ZIPを開けません: {error}"))?;
    let (entries, total) = extract_plan(&mut archive, limits, check)?;
    check()?;
    new_directory(&destination).map_err(|error| {
        format!("新しい展開先を作れません（既存の名前には上書きしません）: {error}")
    })?;
    let result = (|| {
        let mut created = HashSet::new();
        progress(0, entries.len());
        for (index, entry) in entries.iter().enumerate() {
            check()?;
            if entry.directory {
                ensure_parents(&destination, &entry.relative, &mut created)?;
            } else {
                ensure_parents(
                    &destination,
                    entry.relative.parent().unwrap_or(Path::new("")),
                    &mut created,
                )?;
                let path = destination.join(&entry.relative);
                let mut output = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|error| format!("新しい展開ファイルを作れません: {error}"))?;
                let mut input = archive.by_index(index).map_err(|error| error.to_string())?;
                copy_limited(&mut input, &mut output, entry.size, check)?;
                restore_modified(&output, entry.modified)?;
                restore_permissions(&output, entry.permissions)?;
                output.sync_all().map_err(|error| error.to_string())?;
            }
            progress(index + 1, entries.len());
        }
        check()?;
        Ok(ArchiveResult {
            path: destination.to_string_lossy().into_owned(),
            entries: entries.len(),
            bytes: total,
        })
    })();
    result.map_err(|error| partial_error(error, &destination))
}

#[cfg(test)]
mod tests;
