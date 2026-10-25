use super::*;
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "kuf-archive-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn make_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let mut writer = ZipWriter::new(File::create(path).unwrap());
    for (name, bytes) in entries {
        writer
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
}

#[test]
fn nested_unicode_and_empty_directories_round_trip_without_changing_sources() {
    let root = Fixture::new();
    fs::create_dir_all(root.path("資料/空フォルダ")).unwrap();
    fs::write(root.path("資料/メモ.txt"), "元の内容\n").unwrap();
    fs::write(root.path("photo.bin"), [0, 1, 255]).unwrap();
    let result = create_zip(
        &[root.path("資料"), root.path("photo.bin")],
        &root.0,
        "backup.zip",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {},
    )
    .unwrap();
    assert_eq!(result.entries, 4);
    assert_eq!(
        fs::read(root.path("資料/メモ.txt")).unwrap(),
        "元の内容\n".as_bytes()
    );
    let result = extract_zip(
        &root.path("backup.zip"),
        &root.0,
        "restored",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {},
    )
    .unwrap();
    assert_eq!(result.entries, 4);
    assert!(root.path("restored/資料/空フォルダ").is_dir());
    assert_eq!(
        fs::read(root.path("restored/資料/メモ.txt")).unwrap(),
        "元の内容\n".as_bytes()
    );
    assert_eq!(
        fs::read(root.path("restored/photo.bin")).unwrap(),
        [0, 1, 255]
    );
}

#[test]
fn existing_archive_or_destination_is_never_overwritten() {
    let root = Fixture::new();
    fs::write(root.path("source.txt"), b"source").unwrap();
    fs::write(root.path("existing.zip"), b"keep archive").unwrap();
    assert!(create_zip(
        &[root.path("source.txt")],
        &root.0,
        "existing.zip",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert_eq!(
        fs::read(root.path("existing.zip")).unwrap(),
        b"keep archive"
    );
    make_zip(&root.path("valid.zip"), &[("item.txt", b"new")]);
    fs::create_dir(root.path("existing")).unwrap();
    fs::write(root.path("existing/item.txt"), b"keep file").unwrap();
    assert!(extract_zip(
        &root.path("valid.zip"),
        &root.0,
        "existing",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert_eq!(
        fs::read(root.path("existing/item.txt")).unwrap(),
        b"keep file"
    );
    assert!(extract_zip(
        &root.path("valid.zip"),
        &root.0,
        "valid.zip",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert!(ZipArchive::new(File::open(root.path("valid.zip")).unwrap()).is_ok());
}

#[test]
fn dangerous_paths_and_windows_aliases_are_rejected_before_output_is_created() {
    let root = Fixture::new();
    for name in [
        "../escape.txt",
        "/absolute.txt",
        "C:/drive.txt",
        "folder\\escape.txt",
        "file.txt:stream",
        "AUX.txt",
        "folder/NUL",
        "folder/COM1.log",
        "CONIN$",
        "dir/../file",
        "dir/./file",
        "dir//file",
        "trailing. ",
        "file.",
        "LPT¹.txt",
    ] {
        make_zip(&root.path("bad.zip"), &[(name, b"unsafe")]);
        assert!(
            extract_zip(
                &root.path("bad.zip"),
                &root.0,
                "output",
                LIMITS,
                &|| Ok(()),
                &mut |_, _| {}
            )
            .is_err(),
            "{name}"
        );
        assert!(!root.path("output").exists(), "{name}");
    }
    for name in ["bad\0name", "", ".", "..", "file\nname"] {
        assert!(relative_entry(name, false, LIMITS).is_err(), "{name:?}");
    }
}

#[test]
fn case_collisions_and_file_directory_conflicts_are_rejected_in_preflight() {
    let root = Fixture::new();
    for entries in [
        vec![("One.txt", b"a".as_slice()), ("one.txt", b"b".as_slice())],
        vec![("dir", b"a".as_slice()), ("dir/child", b"b".as_slice())],
        vec![("Dir/one", b"a".as_slice()), ("dir/two", b"b".as_slice())],
    ] {
        make_zip(&root.path("conflict.zip"), &entries);
        assert!(extract_zip(
            &root.path("conflict.zip"),
            &root.0,
            "output",
            LIMITS,
            &|| Ok(()),
            &mut |_, _| {}
        )
        .is_err());
        assert!(!root.path("output").exists());
    }
}

#[test]
fn file_entry_count_total_size_and_depth_limits_are_checked_before_writing() {
    let root = Fixture::new();
    make_zip(
        &root.path("limited.zip"),
        &[("dir/one", b"12"), ("two", b"34")],
    );
    for limits in [
        Limits {
            entries: 1,
            ..LIMITS
        },
        Limits {
            file_bytes: 1,
            ..LIMITS
        },
        Limits {
            total_bytes: 3,
            ..LIMITS
        },
        Limits { depth: 1, ..LIMITS },
    ] {
        assert!(extract_zip(
            &root.path("limited.zip"),
            &root.0,
            "output",
            limits,
            &|| Ok(()),
            &mut |_, _| {}
        )
        .is_err());
        assert!(!root.path("output").exists());
    }
    fs::write(root.path("source"), b"12").unwrap();
    assert!(create_zip(
        &[root.path("source")],
        &root.0,
        "limited-create.zip",
        Limits {
            total_bytes: 1,
            ..LIMITS
        },
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert!(!root.path("limited-create.zip").exists());
}

#[test]
fn cancellation_mid_create_or_extract_keeps_originals_and_identifies_partial_output() {
    let root = Fixture::new();
    fs::write(root.path("large.bin"), vec![42_u8; 256 * 1024]).unwrap();
    let checks = Cell::new(0);
    let error = create_zip(
        &[root.path("large.bin")],
        &root.0,
        "partial.zip",
        LIMITS,
        &|| {
            checks.set(checks.get() + 1);
            if checks.get() > 5 {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        },
        &mut |_, _| {},
    )
    .unwrap_err();
    assert!(
        error.contains("cancelled") && error.contains("作成途中") && error.contains("partial.zip")
    );
    assert!(root.path("partial.zip").exists());
    assert_eq!(
        fs::read(root.path("large.bin")).unwrap(),
        vec![42_u8; 256 * 1024]
    );

    make_zip(
        &root.path("extract.zip"),
        &[("one", b"first"), ("two", b"second")],
    );
    let cancel = Cell::new(false);
    let error = extract_zip(
        &root.path("extract.zip"),
        &root.0,
        "partial",
        LIMITS,
        &|| {
            if cancel.get() {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        },
        &mut |completed, _| {
            if completed == 1 {
                cancel.set(true);
            }
        },
    )
    .unwrap_err();
    assert!(error.contains("cancelled") && error.contains("作成途中") && error.contains("partial"));
    assert_eq!(fs::read(root.path("partial/one")).unwrap(), b"first");
    assert!(!root.path("partial/two").exists());
    assert!(ZipArchive::new(File::open(root.path("extract.zip")).unwrap()).is_ok());
}

#[test]
fn zip_symlink_entries_are_rejected_before_output() {
    let root = Fixture::new();
    let mut writer = ZipWriter::new(File::create(root.path("link.zip")).unwrap());
    writer
        .add_symlink("link", "../outside", SimpleFileOptions::default())
        .unwrap();
    writer.finish().unwrap();
    assert!(extract_zip(
        &root.path("link.zip"),
        &root.0,
        "output",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert!(!root.path("output").exists());
}

#[test]
fn oversized_directory_declarations_are_rejected_before_index_allocation() {
    let root = Fixture::new();
    make_zip(&root.path("small.zip"), &[("one", b"1"), ("two", b"2")]);
    let original = fs::read(root.path("small.zip")).unwrap();
    let eocd = original
        .windows(4)
        .rposition(|window| window == [0x50, 0x4b, 0x05, 0x06])
        .unwrap();
    let mut oversized = original.clone();
    oversized[eocd + 12..eocd + 16]
        .copy_from_slice(&((MAX_DIRECTORY_BYTES + 1) as u32).to_le_bytes());
    fs::write(root.path("oversized.zip"), oversized).unwrap();
    assert!(extract_zip(
        &root.path("oversized.zip"),
        &root.0,
        "output",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert!(!root.path("output").exists());
    let mut file = File::open(root.path("small.zip")).unwrap();
    assert!(check_directory_budget(
        &mut file,
        Limits {
            entries: 1,
            ..LIMITS
        }
    )
    .is_err());
    let mut writer = ZipWriter::new(File::create(root.path("zip64.zip")).unwrap());
    writer
        .start_file("one", SimpleFileOptions::default().large_file(true))
        .unwrap();
    writer.write_all(b"ZIP64-compatible payload").unwrap();
    writer.finish().unwrap();
    extract_zip(
        &root.path("zip64.zip"),
        &root.0,
        "zip64",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {},
    )
    .unwrap();
    assert_eq!(
        fs::read(root.path("zip64/one")).unwrap(),
        b"ZIP64-compatible payload"
    );
}

#[test]
fn zip64_directory_counts_and_encrypted_entries_are_checked_before_output() {
    let root = Fixture::new();
    make_zip(&root.path("plain.zip"), &[("one", b"payload")]);
    let plain = fs::read(root.path("plain.zip")).unwrap();
    let eocd = plain.len() - 22;
    let mut record64 = [0_u8; 56];
    record64[..4].copy_from_slice(&[0x50, 0x4b, 0x06, 0x06]);
    record64[4..12].copy_from_slice(&44_u64.to_le_bytes());
    record64[12..14].copy_from_slice(&45_u16.to_le_bytes());
    record64[14..16].copy_from_slice(&45_u16.to_le_bytes());
    record64[24..32].copy_from_slice(&1_u64.to_le_bytes());
    record64[32..40].copy_from_slice(&1_u64.to_le_bytes());
    let directory_bytes =
        u32::from_le_bytes(plain[eocd + 12..eocd + 16].try_into().unwrap()) as u64;
    let directory_offset =
        u32::from_le_bytes(plain[eocd + 16..eocd + 20].try_into().unwrap()) as u64;
    record64[40..48].copy_from_slice(&directory_bytes.to_le_bytes());
    record64[48..56].copy_from_slice(&directory_offset.to_le_bytes());
    let mut locator = [0_u8; 20];
    locator[..4].copy_from_slice(&[0x50, 0x4b, 0x06, 0x07]);
    locator[8..16].copy_from_slice(&(eocd as u64).to_le_bytes());
    locator[16..20].copy_from_slice(&1_u32.to_le_bytes());
    let mut trailer = plain[eocd..].to_vec();
    trailer[8..20].fill(0xff);
    let mut zip64 = plain[..eocd].to_vec();
    zip64.extend_from_slice(&record64);
    zip64.extend_from_slice(&locator);
    zip64.extend_from_slice(&trailer);
    fs::write(root.path("directory64.zip"), &zip64).unwrap();
    extract_zip(
        &root.path("directory64.zip"),
        &root.0,
        "output64",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {},
    )
    .unwrap();
    assert_eq!(fs::read(root.path("output64/one")).unwrap(), b"payload");
    zip64[eocd + 24..eocd + 32].copy_from_slice(&((LIMITS.entries + 1) as u64).to_le_bytes());
    zip64[eocd + 32..eocd + 40].copy_from_slice(&((LIMITS.entries + 1) as u64).to_le_bytes());
    fs::write(root.path("large64.zip"), zip64).unwrap();
    assert!(extract_zip(
        &root.path("large64.zip"),
        &root.0,
        "bad64",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert!(!root.path("bad64").exists());

    let mut encrypted = plain;
    encrypted[6] |= 1;
    encrypted[directory_offset as usize + 8] |= 1;
    fs::write(root.path("encrypted.zip"), encrypted).unwrap();
    assert!(extract_zip(
        &root.path("encrypted.zip"),
        &root.0,
        "encrypted",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert!(!root.path("encrypted").exists());
}

#[cfg(unix)]
#[test]
fn source_symlinks_and_existing_destination_symlinks_cannot_escape() {
    use std::os::unix::fs::symlink;
    let root = Fixture::new();
    let outside = Fixture::new();
    fs::write(outside.path("keep"), b"keep").unwrap();
    symlink(&outside.0, root.path("linked")).unwrap();
    assert!(create_zip(
        &[root.path("linked")],
        &root.0,
        "output.zip",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert!(!root.path("output.zip").exists());
    make_zip(&root.path("source.zip"), &[("keep", b"replace")]);
    assert!(extract_zip(
        &root.path("source.zip"),
        &root.0,
        "linked",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {}
    )
    .is_err());
    assert_eq!(fs::read(outside.path("keep")).unwrap(), b"keep");
}

#[test]
fn crc_failure_is_reported_and_original_archive_bytes_are_unchanged() {
    let root = Fixture::new();
    make_zip(&root.path("corrupt.zip"), &[("item", b"unique payload")]);
    let mut bytes = fs::read(root.path("corrupt.zip")).unwrap();
    let position = bytes
        .windows(b"unique payload".len())
        .position(|window| window == b"unique payload")
        .unwrap();
    bytes[position] ^= 0xff;
    fs::write(root.path("corrupt.zip"), &bytes).unwrap();
    let error = extract_zip(
        &root.path("corrupt.zip"),
        &root.0,
        "partial",
        LIMITS,
        &|| Ok(()),
        &mut |_, _| {},
    )
    .unwrap_err();
    assert!(error.contains("作成途中"));
    assert_eq!(fs::read(root.path("corrupt.zip")).unwrap(), bytes);
}
