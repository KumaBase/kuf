//! Generated disk images only: never select or modify an existing volume.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::os::unix::fs::MetadataExt;

static NEXT: AtomicU64 = AtomicU64::new(0);

pub(crate) struct MacVolume {
    root: PathBuf,
    mount: PathBuf,
    attach_attempted: bool,
}

fn hdiutil(arguments: &[&std::ffi::OsStr]) -> Result<(), String> {
    let verb = arguments.first().map(|value| value.to_string_lossy()).unwrap_or_default();
    let mut child = Command::new("/usr/bin/hdiutil").args(arguments)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit())
        .spawn().map_err(|error| format!("Cannot start hdiutil: {error}"))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return if status.success() { Ok(()) } else { Err(format!("hdiutil {verb} failed: {status}")) };
        }
        if start.elapsed() >= Duration::from_secs(30) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("hdiutil {verb} timed out after 30 seconds"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

impl MacVolume {
    pub(crate) fn new(case_sensitive: bool) -> Self {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("kuf-rename-volume-{}-{nonce}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&root).unwrap();
        let mount = root.join("mount");
        std::fs::create_dir(&mount).unwrap();
        let mut volume = Self { root, mount, attach_attempted: false };
        let image = volume.root.join("test.sparseimage");
        let filesystem = if case_sensitive { "Case-sensitive APFS" } else { "APFS" };
        hdiutil(&["create".as_ref(), "-quiet".as_ref(), "-type".as_ref(), "SPARSE".as_ref(), "-size".as_ref(), "128m".as_ref(),
            "-fs".as_ref(), filesystem.as_ref(), "-volname".as_ref(), "KufRenameTest".as_ref(), "-o".as_ref(), image.as_os_str()]).unwrap();
        volume.attach_attempted = true;
        hdiutil(&["attach".as_ref(), "-quiet".as_ref(), "-nobrowse".as_ref(), "-noverify".as_ref(), "-mountpoint".as_ref(), volume.mount.as_os_str(), image.as_os_str()]).unwrap();
        assert_ne!(std::fs::metadata(&volume.root).unwrap().dev(), std::fs::metadata(&volume.mount).unwrap().dev(), "The generated image did not mount at its dedicated mountpoint");
        volume
    }

    pub(crate) fn path(&self) -> &Path { &self.mount }
}

impl Drop for MacVolume {
    fn drop(&mut self) {
        if self.attach_attempted {
            let detached = hdiutil(&["detach".as_ref(), "-quiet".as_ref(), self.mount.as_os_str()]);
            let unmounted = match (std::fs::metadata(&self.root), std::fs::symlink_metadata(&self.mount)) {
                (Ok(root), Ok(mount)) => mount.is_dir() && root.dev() == mount.dev(),
                (Ok(_), Err(error)) => error.kind() == std::io::ErrorKind::NotFound,
                _ => false,
            };
            if detached.is_err() || !unmounted {
                let message = format!("Generated rename volume retained at {}: detach={detached:?}, mountpoint_unmounted={unmounted}", self.root.display());
                eprintln!("{message}");
                if !std::thread::panicking() { panic!("{message}"); }
                return;
            }
        }
        // Only this nonce-named directory was created by the fixture; after an
        // attach attempt it is removed only after successful, verified detach.
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            eprintln!("Cannot remove generated rename fixture {}: {error}", self.root.display());
            if !std::thread::panicking() { panic!("Cannot remove generated rename fixture: {error}"); }
        }
    }
}
