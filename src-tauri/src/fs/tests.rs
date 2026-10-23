use super::{local::LocalFs, FileSystem};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("kuf-test-{}-{nonce}", std::process::id()));
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
