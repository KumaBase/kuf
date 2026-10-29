use super::{local::LocalFs, FileSystem};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "kuf-test-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Only the unique directory created by this fixture is removed.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn local_listing_preserves_update_order_within_the_same_displayed_minute() {
    let root = Fixture::new();
    // These instants share one displayed minute; their names deliberately have
    // the opposite order so sorting by the rounded display cannot recover it.
    let earlier_millis = 1_700_000_045_000_u64;
    let later_millis = 1_700_000_085_000_u64;
    for (name, millis) in [
        ("z-earlier.txt", earlier_millis),
        ("a-later.txt", later_millis),
    ] {
        let file = std::fs::File::create(root.path().join(name)).unwrap();
        file.set_modified(UNIX_EPOCH + std::time::Duration::from_millis(millis))
            .unwrap();
    }

    let files = LocalFs.read_dir(root.path()).unwrap();
    let earlier = files
        .iter()
        .find(|file| file.name == "z-earlier.txt")
        .unwrap();
    let later = files
        .iter()
        .find(|file| file.name == "a-later.txt")
        .unwrap();
    assert!(earlier.modified.is_some());
    assert_eq!(earlier.modified, later.modified);
    assert_eq!(earlier.modified_timestamp, Some(earlier_millis as i64));
    assert_eq!(later.modified_timestamp, Some(later_millis as i64));
    assert!(earlier.modified_timestamp < later.modified_timestamp);
    let parent = files.iter().find(|file| file.name == "..").unwrap();
    assert_eq!(parent.modified_timestamp, None);
}

#[test]
fn local_copy_move_and_rename_preserve_contents_and_respect_conflicts() {
    let root = Fixture::new();
    let source = root.path().join("source");
    let dest = root.path().join("dest");
    std::fs::create_dir_all(source.join("nested")).unwrap();
    std::fs::create_dir(&dest).unwrap();
    std::fs::write(source.join("nested/original.txt"), b"original").unwrap();
    LocalFs
        .copy_items(&[source.clone()], &dest, false, Some(&["renamed".into()]))
        .unwrap();
    assert_eq!(
        std::fs::read(dest.join("renamed/nested/original.txt")).unwrap(),
        b"original"
    );
    assert!(source.join("nested/original.txt").exists());
    let file = source.join("nested/original.txt");
    LocalFs
        .move_items(&[file.clone()], &dest, false, None)
        .unwrap();
    assert!(!file.exists());
    let moved = dest.join("original.txt");
    LocalFs.rename_item(&moved, "changed.txt").unwrap();
    assert_eq!(
        std::fs::read(dest.join("changed.txt")).unwrap(),
        b"original"
    );
    std::fs::write(&file, b"new content").unwrap();
    LocalFs
        .copy_items(&[file.clone()], &dest, false, Some(&["changed.txt".into()]))
        .unwrap();
    assert_eq!(
        std::fs::read(dest.join("changed.txt")).unwrap(),
        b"original"
    );
    assert!(LocalFs
        .copy_items(&[source.clone()], &source.join("nested"), true, None)
        .is_err());
    assert!(LocalFs.create_dir(&dest, "../escape").is_err());
}

#[test]
fn copying_or_moving_a_file_onto_itself_never_modifies_the_source() {
    let root = Fixture::new();
    let source = root.path().join("original.txt");
    let original = b"The original must survive self-copy and self-move.\0\xff";
    std::fs::write(&source, original).unwrap();
    let same_name = ["original.txt".to_string()];

    for overwrite in [false, true] {
        for dest_names in [None, Some(same_name.as_slice())] {
            // The syntactically different destination still names the same directory.
            let destination = root.path().join(".");
            assert!(LocalFs
                .copy_items(&[source.clone()], &destination, overwrite, dest_names)
                .is_err());
            assert_eq!(std::fs::read(&source).unwrap(), original);
            assert!(LocalFs
                .move_items(&[source.clone()], &destination, overwrite, dest_names)
                .is_err());
            assert_eq!(std::fs::read(&source).unwrap(), original);
        }
    }
}

#[test]
fn rename_rejects_path_changes_and_existing_destinations_without_touching_contents() {
    let root = Fixture::new();
    let original = root.path().join("original.TXT");
    std::fs::write(&original, b"original").unwrap();
    std::fs::write(root.path().join("occupied"), b"keep").unwrap();
    for name in ["../escape", "nested/escape", "nested\\escape", ".", "..", "occupied"] {
        assert!(LocalFs.rename_item(&original, name).is_err(), "{name}");
        assert_eq!(std::fs::read(&original).unwrap(), b"original");
        assert_eq!(std::fs::read(root.path().join("occupied")).unwrap(), b"keep");
    }
    assert!(LocalFs.rename_item(&original, &"x".repeat(256)).is_err());
    LocalFs.rename_item(&original, "original.TXT").unwrap();
    assert_eq!(std::fs::read(&original).unwrap(), b"original");
    std::fs::create_dir(root.path().join("folder")).unwrap();
    std::fs::create_dir(root.path().join("other-folder")).unwrap();
    assert!(LocalFs.rename_item(&root.path().join("folder"), "other-folder").is_err());
    assert!(root.path().join("folder").is_dir());
}

#[cfg(windows)]
#[test]
fn windows_case_only_rename_preserves_file_identity_and_contents() {
    let root = Fixture::new();
    let original = root.path().join("Original.TXT");
    std::fs::write(&original, b"case-only").unwrap();
    LocalFs.rename_item(&original, "original.txt").unwrap();
    let names: Vec<_> = std::fs::read_dir(root.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from("original.txt")]);
    assert_eq!(std::fs::read(root.path().join("original.txt")).unwrap(), b"case-only");
}

#[cfg(unix)]
#[test]
fn rename_rejects_a_dangling_symlink_destination() {
    let root = Fixture::new();
    let original = root.path().join("original");
    std::fs::write(&original, b"original").unwrap();
    std::os::unix::fs::symlink(root.path().join("missing"), root.path().join("dangling")).unwrap();
    assert!(LocalFs.rename_item(&original, "dangling").is_err());
    assert_eq!(std::fs::read(&original).unwrap(), b"original");
    assert!(std::fs::symlink_metadata(root.path().join("dangling")).unwrap().file_type().is_symlink());
}

#[cfg(unix)]
fn assert_case_sensitive_rename_conflicts_preserve_both_entries(root: &Path) {
    use std::os::unix::fs::MetadataExt;
    use super::local::is_case_only_alias;
    let source = root.join("Report.txt");
    let target = root.join("report.txt");
    std::fs::write(&source, b"source").unwrap();
    let mut target_file = std::fs::OpenOptions::new().write(true).create_new(true).open(&target).unwrap();
    std::io::Write::write_all(&mut target_file, b"target").unwrap();
    drop(target_file);
    assert!(!is_case_only_alias(&source, &target));
    assert!(LocalFs.rename_item(&source, "report.txt").is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"source");
    assert_eq!(std::fs::read(&target).unwrap(), b"target");

    let hard_source = root.join("Hard.txt");
    let hard_target = root.join("hard.txt");
    std::fs::hard_link(&source, &hard_source).unwrap();
    std::fs::hard_link(&source, &hard_target).unwrap();
    assert_eq!(std::fs::metadata(&hard_source).unwrap().ino(), std::fs::metadata(&hard_target).unwrap().ino());
    assert!(!is_case_only_alias(&hard_source, &hard_target));
    assert!(LocalFs.rename_item(&hard_source, "hard.txt").is_err());
    assert!(hard_source.exists() && hard_target.exists());

    let linked_source = root.join("Linked.txt");
    let linked_target = root.join("linked.txt");
    std::fs::write(&linked_source, b"linked source").unwrap();
    std::os::unix::fs::symlink("Linked.txt", &linked_target).unwrap();
    assert_eq!(std::fs::metadata(&linked_source).unwrap().ino(), std::fs::metadata(&linked_target).unwrap().ino());
    assert!(!is_case_only_alias(&linked_source, &linked_target));
    assert!(LocalFs.rename_item(&linked_source, "linked.txt").is_err());
    assert_eq!(std::fs::read(&linked_source).unwrap(), b"linked source");
    assert_eq!(std::fs::read_link(&linked_target).unwrap(), Path::new("Linked.txt"));
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn unix_case_sensitive_case_only_rename_and_conflicts_preserve_contents() {
    let root = Fixture::new();
    let original = root.path().join("Original.txt");
    std::fs::write(&original, b"case change").unwrap();
    assert!(!root.path().join("original.txt").exists());
    LocalFs.rename_item(&original, "original.txt").unwrap();
    assert_eq!(std::fs::read(root.path().join("original.txt")).unwrap(), b"case change");
    assert_case_sensitive_rename_conflicts_preserve_both_entries(root.path());
}

#[cfg(target_os = "macos")]
#[test]
fn mac_case_insensitive_case_only_rename_preserves_the_single_entry() {
    use std::os::unix::fs::MetadataExt;
    use super::local::{is_case_only_alias, rename_test_volume::MacVolume};
    let volume = MacVolume::new(false);
    let root = volume.path();
    let source = root.join("Report.txt");
    let target = root.join("report.txt");
    std::fs::write(&source, b"preserve report").unwrap();
    let identity = std::fs::symlink_metadata(&source).unwrap().ino();
    assert!(std::fs::symlink_metadata(&target).is_ok(), "The generated APFS volume must be case insensitive");
    assert!(is_case_only_alias(&source, &target));
    LocalFs.rename_item(&source, "report.txt").unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"preserve report");
    assert_eq!(std::fs::symlink_metadata(&target).unwrap().ino(), identity);
    let names: Vec<_> = std::fs::read_dir(root).unwrap().map(|entry| entry.unwrap().file_name())
        .filter(|name| name.to_str().is_some_and(|name| name.eq_ignore_ascii_case("report.txt"))).collect();
    assert_eq!(names, vec![std::ffi::OsString::from("report.txt")]);

    std::fs::create_dir(root.join("Folder")).unwrap();
    std::fs::write(root.join("Folder/inside"), b"inside").unwrap();
    assert!(is_case_only_alias(&root.join("Folder"), &root.join("folder")));
    LocalFs.rename_item(&root.join("Folder"), "folder").unwrap();
    assert_eq!(std::fs::read(root.join("folder/inside")).unwrap(), b"inside");

    std::os::unix::fs::symlink("report.txt", root.join("ReportLink")).unwrap();
    assert!(is_case_only_alias(&root.join("ReportLink"), &root.join("reportlink")));
    LocalFs.rename_item(&root.join("ReportLink"), "reportlink").unwrap();
    assert_eq!(std::fs::read_link(root.join("reportlink")).unwrap(), Path::new("report.txt"));
}

#[cfg(target_os = "macos")]
#[test]
fn mac_case_sensitive_volume_never_treats_distinct_entries_as_case_aliases() {
    use super::local::rename_test_volume::MacVolume;
    let volume = MacVolume::new(true);
    let original = volume.path().join("Original.txt");
    std::fs::write(&original, b"case change").unwrap();
    assert!(!volume.path().join("original.txt").exists(), "The generated APFS volume must be case sensitive");
    LocalFs.rename_item(&original, "original.txt").unwrap();
    assert_eq!(std::fs::read(volume.path().join("original.txt")).unwrap(), b"case change");
    assert_case_sensitive_rename_conflicts_preserve_both_entries(volume.path());
}

#[test]
fn copying_and_moving_to_a_different_name_in_the_same_directory_still_work() {
    let root = Fixture::new();
    for overwrite in [false, true] {
        let source = root.path().join(format!("original-{overwrite}.txt"));
        let copy_name = format!("copy-{overwrite}.txt");
        let move_name = format!("move-{overwrite}.txt");
        let original = b"Different paths and file identities are valid targets.";
        std::fs::write(&source, original).unwrap();
        if overwrite {
            std::fs::write(root.path().join(&copy_name), b"replaced copy").unwrap();
            std::fs::write(root.path().join(&move_name), b"replaced move").unwrap();
        }
        LocalFs
            .copy_items(
                &[source.clone()],
                root.path(),
                overwrite,
                Some(&[copy_name.clone()]),
            )
            .unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(
            std::fs::read(root.path().join(&copy_name)).unwrap(),
            original
        );
        LocalFs
            .move_items(
                &[source.clone()],
                root.path(),
                overwrite,
                Some(&[move_name.clone()]),
            )
            .unwrap();
        assert!(!source.exists());
        assert_eq!(
            std::fs::read(root.path().join(move_name)).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read(root.path().join(copy_name)).unwrap(),
            original
        );
    }
}

#[test]
fn hard_link_targets_are_rejected_before_copy_or_move_changes_either_name() {
    let root = Fixture::new();
    let source = root.path().join("original.txt");
    let alias = root.path().join("alias.txt");
    let original = b"A different filename can still identify the original file.";
    std::fs::write(&source, original).unwrap();
    std::fs::hard_link(&source, &alias).unwrap();

    for overwrite in [false, true] {
        assert!(LocalFs
            .copy_items(
                &[source.clone()],
                root.path(),
                overwrite,
                Some(&["alias.txt".into()])
            )
            .is_err());
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(std::fs::read(&alias).unwrap(), original);
        assert!(LocalFs
            .move_items(
                &[source.clone()],
                root.path(),
                overwrite,
                Some(&["alias.txt".into()])
            )
            .is_err());
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert_eq!(std::fs::read(&alias).unwrap(), original);
    }
}

#[test]
fn directory_merge_refuses_a_nested_hard_link_to_the_source_file() {
    let root = Fixture::new();
    let source = root.path().join("source");
    let destination = root.path().join("destination");
    let nested_target = destination.join("source");
    std::fs::create_dir(&source).unwrap();
    std::fs::create_dir_all(&nested_target).unwrap();
    let original = b"Recursive copying must not truncate a shared inode.";
    std::fs::write(source.join("original.txt"), original).unwrap();
    std::fs::hard_link(
        source.join("original.txt"),
        nested_target.join("original.txt"),
    )
    .unwrap();

    assert!(LocalFs
        .copy_items(&[source.clone()], &destination, true, None)
        .is_err());
    assert_eq!(
        std::fs::read(source.join("original.txt")).unwrap(),
        original
    );
    assert_eq!(
        std::fs::read(nested_target.join("original.txt")).unwrap(),
        original
    );
    // The existing directory guard also refuses a folder copied or moved onto itself.
    for overwrite in [false, true] {
        assert!(LocalFs
            .copy_items(&[source.clone()], root.path(), overwrite, None)
            .is_err());
        assert!(LocalFs
            .move_items(&[source.clone()], root.path(), overwrite, None)
            .is_err());
        assert_eq!(
            std::fs::read(source.join("original.txt")).unwrap(),
            original
        );
    }
}

#[test]
fn exclusive_transfers_preserve_existing_items_and_copy_directories() {
    let root = Fixture::new();
    let src = root.path().join("source");
    let dest = root.path().join("destination");
    std::fs::create_dir(&src).unwrap();
    std::fs::create_dir(&dest).unwrap();
    std::fs::write(src.join("one.txt"), b"source").unwrap();
    std::fs::write(dest.join("one.txt"), b"existing").unwrap();
    assert!(super::local::copy_item_exclusive(&src.join("one.txt"), &dest).is_err());
    assert!(super::local::move_item_exclusive(&src.join("one.txt"), &dest).is_err());
    assert_eq!(std::fs::read(src.join("one.txt")).unwrap(), b"source");
    assert_eq!(std::fs::read(dest.join("one.txt")).unwrap(), b"existing");
    std::fs::create_dir(src.join("folder")).unwrap();
    std::fs::write(src.join("folder/inside.txt"), b"nested").unwrap();
    super::local::copy_item_exclusive(&src.join("folder"), &dest).unwrap();
    assert_eq!(std::fs::read(dest.join("folder/inside.txt")).unwrap(), b"nested");
    assert!(super::local::copy_item_exclusive(&src.join("folder"), &src.join("folder")).is_err());
    std::fs::write(src.join("move.txt"), b"move").unwrap();
    super::local::move_item_exclusive(&src.join("move.txt"), &dest).unwrap();
    assert!(!src.join("move.txt").exists());
    assert_eq!(std::fs::read(dest.join("move.txt")).unwrap(), b"move");
}

#[test]
fn mouse_transfer_only_overwrites_names_explicitly_approved() {
    let root = Fixture::new();
    let src = root.path().join("source");
    let dest = root.path().join("destination");
    std::fs::create_dir(&src).unwrap();
    std::fs::create_dir(&dest).unwrap();
    for name in ["approved.txt", "new-conflict.txt"] {
        std::fs::write(src.join(name), b"source").unwrap();
        std::fs::write(dest.join(name), b"existing").unwrap();
    }
    let approved = vec!["approved.txt".to_string()];
    super::local::transfer_item_for_mouse(&src.join("approved.txt"), &dest, &approved, false).unwrap();
    assert_eq!(std::fs::read(dest.join("approved.txt")).unwrap(), b"source");
    for moving in [false, true] {
        assert!(super::local::transfer_item_for_mouse(&src.join("new-conflict.txt"), &dest, &approved, moving).is_err());
        assert_eq!(std::fs::read(dest.join("new-conflict.txt")).unwrap(), b"existing");
        assert_eq!(std::fs::read(src.join("new-conflict.txt")).unwrap(), b"source");
    }
}

#[cfg(any(unix, windows))]
#[test]
fn exclusive_move_copies_only_for_cross_device_errors() {
    let root = Fixture::new();
    let src = root.path().join("source");
    let dest = root.path().join("destination");
    std::fs::create_dir(&src).unwrap();
    std::fs::create_dir(&dest).unwrap();
    std::fs::write(src.join("move.txt"), b"content").unwrap();
    let failed = super::local::move_item_exclusive_with(&src.join("move.txt"), &dest, |_, _| {
        Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
    });
    assert!(failed.is_err());
    assert!(!dest.join("move.txt").exists());
    assert_eq!(std::fs::read(src.join("move.txt")).unwrap(), b"content");
    #[cfg(windows)]
    let cross_device = 17; // ERROR_NOT_SAME_DEVICE
    #[cfg(unix)]
    let cross_device = libc::EXDEV;
    super::local::move_item_exclusive_with(&src.join("move.txt"), &dest, |_, _| {
        Err(std::io::Error::from_raw_os_error(cross_device))
    }).unwrap();
    assert!(!src.join("move.txt").exists());
    assert_eq!(std::fs::read(dest.join("move.txt")).unwrap(), b"content");
}

#[test]
fn concurrent_exclusive_copies_never_replace_each_other() {
    use std::sync::{Arc, Barrier};
    let root = Fixture::new();
    let first = root.path().join("first");
    let second = root.path().join("second");
    let dest = root.path().join("destination");
    for dir in [&first, &second, &dest] { std::fs::create_dir(dir).unwrap(); }
    std::fs::write(first.join("same.txt"), b"first").unwrap();
    std::fs::write(second.join("same.txt"), b"second").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = [first.join("same.txt"), second.join("same.txt")].into_iter().map(|src| {
        let dest = dest.clone(); let barrier = barrier.clone();
        std::thread::spawn(move || { barrier.wait(); super::local::copy_item_exclusive(&src, &dest) })
    }).collect();
    let succeeded = workers.into_iter().map(|worker| worker.join().unwrap().is_ok()).filter(|ok| *ok).count();
    assert_eq!(succeeded, 1);
    assert!([b"first".as_slice(), b"second".as_slice()].contains(&std::fs::read(dest.join("same.txt")).unwrap().as_slice()));
    assert_eq!(std::fs::read(first.join("same.txt")).unwrap(), b"first");
    assert_eq!(std::fs::read(second.join("same.txt")).unwrap(), b"second");
}

#[test]
fn concurrent_exclusive_moves_keep_the_losing_source() {
    use std::sync::{Arc, Barrier};
    let root = Fixture::new();
    let first = root.path().join("first");
    let second = root.path().join("second");
    let dest = root.path().join("destination");
    for dir in [&first, &second, &dest] { std::fs::create_dir(dir).unwrap(); }
    std::fs::write(first.join("same.txt"), b"first").unwrap();
    std::fs::write(second.join("same.txt"), b"second").unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = [first.join("same.txt"), second.join("same.txt")].into_iter().map(|src| {
        let dest = dest.clone(); let barrier = barrier.clone();
        std::thread::spawn(move || { barrier.wait(); super::local::move_item_exclusive(&src, &dest) })
    }).collect();
    let succeeded = workers.into_iter().map(|worker| worker.join().unwrap().is_ok()).filter(|ok| *ok).count();
    assert_eq!(succeeded, 1);
    let result = std::fs::read(dest.join("same.txt")).unwrap();
    if result == b"first" {
        assert!(!first.join("same.txt").exists());
        assert_eq!(std::fs::read(second.join("same.txt")).unwrap(), b"second");
    } else {
        assert_eq!(result, b"second");
        assert_eq!(std::fs::read(first.join("same.txt")).unwrap(), b"first");
        assert!(!second.join("same.txt").exists());
    }
}

#[cfg(unix)]
#[test]
fn exclusive_transfers_do_not_follow_or_replace_dangling_destinations() {
    let root = Fixture::new();
    let src = root.path().join("source");
    let dest = root.path().join("destination");
    std::fs::create_dir(&src).unwrap();
    std::fs::create_dir(&dest).unwrap();
    std::fs::write(src.join("one.txt"), b"original").unwrap();
    std::os::unix::fs::symlink("missing-target", dest.join("one.txt")).unwrap();
    assert!(super::local::copy_item_exclusive(&src.join("one.txt"), &dest).is_err());
    assert!(super::local::move_item_exclusive(&src.join("one.txt"), &dest).is_err());
    assert_eq!(std::fs::read(src.join("one.txt")).unwrap(), b"original");
    assert_eq!(std::fs::read_link(dest.join("one.txt")).unwrap(), PathBuf::from("missing-target"));
    assert!(!dest.join("missing-target").exists());
}

#[test]
#[ignore = "Creates 10000 fixture files; run explicitly for performance measurement"]
fn benchmark_local_filesystem() {
    let root = Fixture::new();
    let source = root.path().join("source");
    let dest = root.path().join("dest");
    std::fs::create_dir(&source).unwrap();
    std::fs::create_dir(&dest).unwrap();
    for i in 0..10000 {
        std::fs::write(source.join(format!("file-{i:06}.txt")), b"fixture").unwrap();
    }
    let mut samples = Vec::new();
    for _ in 0..6 {
        let start = Instant::now();
        let files = LocalFs.read_dir(&source).unwrap();
        assert_eq!(files.len(), 10001);
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples.remove(0);
    samples.sort_by(f64::total_cmp);
    let start = Instant::now();
    LocalFs
        .copy_items(&[source.clone()], &dest, false, None)
        .unwrap();
    println!(
        "10000 local entries: read_dir median={:.3}ms, copy={:.3}ms (debug build, OS cache warm)",
        samples[2],
        start.elapsed().as_secs_f64() * 1000.0
    );
    assert!(dest.join("source/file-000001.txt").exists());
}
