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
