//! User-requested deletion goes to the OS trash; internal move cleanup stays in LocalFs.
//! There is deliberately no permanent-deletion fallback in this module.

use std::path::{Component, Path, PathBuf};

#[tauri::command]
pub async fn trash_items(
    paths: Vec<String>,
    operation_id: Option<String>,
    operations: tauri::State<'_, crate::operation::Operations>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let op = operations.get(operation_id.as_deref())?;
    crate::background::run(move || {
        // Validate the entire batch before changing any item.
        let paths = prepare_paths(&paths)?;
        let work = move || {
            crate::operation::process_items(&paths, op.as_ref(), &app, |path, _| {
                // Refuse changed parents rather than following a newly replaced junction.
                if prepare_path(path)? != *path {
                    return Err(format!("対象の場所が変更されています: {}", path.display()));
                }
                platform::trash_one(path)
            })
        };
        #[cfg(windows)]
        {
            platform::on_sta(work)
        }
        #[cfg(not(windows))]
        {
            work()
        }
    })
    .await
}

fn prepare_paths(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    paths
        .iter()
        .map(|path| prepare_path(Path::new(path)))
        .collect()
}

fn prepare_path(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err("ごみ箱へ移動する対象は絶対パスで指定してください。".into());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("親フォルダーを含むパスはごみ箱へ移動できません。".into());
    }
    let name = path.file_name().ok_or_else(|| {
        "ドライブやファイルシステムのルートはごみ箱へ移動できません。".to_string()
    })?;
    let parent = path
        .parent()
        .ok_or_else(|| "対象の親フォルダーがありません。".to_string())?;
    platform::validate_syntax(path)?;
    // Do not canonicalize the final component: a symlink is the item, not its target.
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("対象の場所を確認できません: {}: {error}", path.display()))?;
    let normalized = parent.join(name);
    std::fs::symlink_metadata(&normalized)
        .map_err(|error| format!("対象を確認できません: {}: {error}", normalized.display()))?;
    platform::validate_location(&normalized)?;
    Ok(normalized)
}

#[cfg(not(windows))]
mod platform {
    use std::path::Path;

    pub fn validate_location(_: &Path) -> Result<(), String> {
        Ok(())
    }

    pub fn validate_syntax(_: &Path) -> Result<(), String> {
        Ok(())
    }

    pub fn trash_one(path: &Path) -> Result<(), String> {
        ::trash::delete(path).map_err(|error| {
            format!(
                "ごみ箱へ移動できませんでした。完全削除は行いません: {}: {error}",
                path.display()
            )
        })
    }
}

#[cfg(windows)]
mod platform {
    use std::{ffi::OsString, os::windows::ffi::OsStrExt, path::Path};
    use windows::{
        core::{Result as WinResult, PCWSTR},
        Win32::{
            Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW},
            System::{
                Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
                WindowsProgramming::DRIVE_FIXED,
            },
            UI::Shell::{
                BHID_Transfer, FOLDERID_RecycleBinFolder, IShellItem, ITransferSource,
                SHCreateItemFromParsingName, SHGetKnownFolderItem, KF_FLAG_DEFAULT, TSF_NORMAL,
            },
        },
    };

    pub fn on_sta<T: Send + 'static>(
        work: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        // A fresh thread cannot already have an incompatible COM apartment.
        std::thread::Builder::new()
            .name("kuf-trash-sta".into())
            .spawn(move || {
                unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                    .ok()
                    .map_err(|error| format!("ごみ箱処理を初期化できません: {error}"))?;
                struct Apartment;
                impl Drop for Apartment {
                    fn drop(&mut self) {
                        unsafe { CoUninitialize() };
                    }
                }
                let _apartment = Apartment;
                work()
            })
            .map_err(|error| format!("ごみ箱処理を開始できません: {error}"))?
            .join()
            .map_err(|_| {
                "ごみ箱処理が異常終了しました。対象の状態を確認してください。".to_string()
            })?
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    // Shell parsing names do not accept canonicalize()'s verbatim drive prefix.
    fn shell_path(path: &Path) -> Result<OsString, String> {
        use std::path::{Component, Prefix};
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return Err("ローカルドライブのパスではありません。".into());
        };
        match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                let mut normal = OsString::from(format!("{}:", letter as char));
                normal.push(components.as_path());
                Ok(normal)
            }
            _ => Err("ネットワークやデバイス上の項目はごみ箱へ移動できません。".into()),
        }
    }

    pub fn validate_syntax(path: &Path) -> Result<(), String> {
        let shell = shell_path(path)?;
        if shell.encode_wide().any(|character| character == 0) {
            return Err("無効なパスです。".into());
        }
        for component in path.components() {
            if let std::path::Component::Normal(name) = component {
                let name: Vec<u16> = name.encode_wide().collect();
                // Removing the verbatim prefix must not let Shell normalize this
                // into a different item's name (e.g. "item." versus "item").
                if matches!(name.last(), Some(32 | 46))
                    || name.iter().any(|character| {
                        [b'<', b'>', b':', b'"', b'|', b'?', b'*']
                            .iter()
                            .any(|invalid| *character == *invalid as u16)
                    })
                {
                    return Err("Windowsのごみ箱で安全に扱えない名前がパスに含まれています。完全削除は行いません。".into());
                }
            }
        }
        Ok(())
    }

    pub fn validate_location(path: &Path) -> Result<(), String> {
        let shell = shell_path(path)?;
        let path_wide = wide(Path::new(&shell));
        if path_wide[..path_wide.len() - 1].contains(&0) {
            return Err("無効なパスです。".into());
        }
        // GetVolumePathName also handles a volume mounted below a drive root.
        let mut volume = vec![0u16; 32768];
        unsafe { GetVolumePathNameW(PCWSTR(path_wide.as_ptr()), &mut volume) }
            .map_err(|error| format!("対象のドライブを確認できません: {error}"))?;
        if unsafe { GetDriveTypeW(PCWSTR(volume.as_ptr())) } != DRIVE_FIXED {
            return Err("ごみ箱への移動はローカルの固定ドライブだけに対応しています。完全削除は行いません。".into());
        }
        Ok(())
    }

    // RecycleItem has a recycle-only contract, unlike DeleteItem's optional undo.
    // It returns the new Shell item, which also lets the fixture test restore exactly
    // its own item without enumerating or changing any existing Recycle Bin entries.
    // https://learn.microsoft.com/windows/win32/api/shobjidl_core/nf-shobjidl_core-itransfersource-recycleitem
    fn trash_with_receipt(path: &Path) -> Result<IShellItem, String> {
        validate_location(path)?;
        let path_wide = wide(Path::new(&shell_path(path)?));
        let result = unsafe {
            (|| -> WinResult<IShellItem> {
                let item: IShellItem =
                    SHCreateItemFromParsingName(PCWSTR(path_wide.as_ptr()), None)?;
                let parent = item.GetParent()?;
                let source: ITransferSource = parent.BindToHandler(None, &BHID_Transfer)?;
                let recycle_bin: IShellItem =
                    SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None)?;
                // No RemoveItem/DeleteItem call exists in this execution path.
                source.RecycleItem(&item, &recycle_bin, TSF_NORMAL.0 as u32)
            })()
        };
        result.map_err(|error| {
            format!(
                "ごみ箱へ移動できませんでした。完全削除の再試行は行いません: {}: {error}",
                path.display()
            )
        })
    }
    pub fn trash_one(path: &Path) -> Result<(), String> {
        trash_with_receipt(path).map(|_| ())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::{SystemTime, UNIX_EPOCH};
        use windows::Win32::{
            System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER},
            UI::Shell::{
                FileOperation, IFileOperation, FOFX_EARLYFAILURE, FOF_NO_UI,
                SIGDN_DESKTOPABSOLUTEPARSING,
            },
        };

        fn restore_receipt(path: &Path, receipt: &IShellItem) {
            let parent_shell = shell_path(path.parent().unwrap()).unwrap();
            let parent_wide = wide(Path::new(&parent_shell));
            let name_wide = wide(Path::new(path.file_name().unwrap()));
            unsafe {
                let parent: IShellItem =
                    SHCreateItemFromParsingName(PCWSTR(parent_wide.as_ptr()), None).unwrap();
                let restore: IFileOperation =
                    CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER).unwrap();
                // No overwrite or rename-on-collision flag: a collision must fail.
                restore
                    .SetOperationFlags(FOF_NO_UI | FOFX_EARLYFAILURE)
                    .unwrap();
                assert!(!path.exists());
                restore
                    .MoveItem(receipt, &parent, PCWSTR(name_wide.as_ptr()), None)
                    .unwrap();
                restore.PerformOperations().unwrap();
                assert!(!restore.GetAnyOperationsAborted().unwrap().as_bool());
            }
            assert!(
                path.exists(),
                "the exact returned Recycle Bin item must be restored"
            );
        }

        #[test]
        fn rejects_network_and_device_paths_without_touching_them() {
            for path in [
                r"\\server\share\item",
                r"\\?\UNC\server\share\item",
                r"\\.\pipe\item",
            ] {
                assert!(shell_path(Path::new(path)).is_err());
            }
            assert_eq!(
                shell_path(Path::new(r"\\?\C:\folder\日本語.txt")).unwrap(),
                OsString::from(r"C:\folder\日本語.txt")
            );
            assert!(validate_syntax(Path::new(r"\\?\C:\folder\ambiguous.")).is_err());
            assert!(validate_syntax(Path::new(r"C:\folder\file:stream")).is_err());
        }

        #[test]
        #[ignore = "Moves only newly generated fixture data to the Windows Recycle Bin and restores the exact returned items"]
        fn windows_recycle_and_restore_generated_items() {
            on_sta(|| {
                let nonce = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let root = std::env::current_dir()
                    .unwrap()
                    .join("target")
                    .join(format!(
                        "kuf-recycle-fixture-{}-{nonce}",
                        std::process::id()
                    ));
                std::fs::create_dir_all(&root).unwrap();
                // No Drop cleanup: a failure leaves its generated paths available for diagnosis.
                let file = root.join("日本語 fixture.txt");
                let folder = root.join("nested fixture");
                let empty = root.join("empty fixture");
                std::fs::write(&file, b"kuf recycle fixture unique contents").unwrap();
                std::fs::create_dir_all(folder.join("inner")).unwrap();
                std::fs::write(folder.join("inner/payload.txt"), b"nested contents").unwrap();
                std::fs::create_dir(&empty).unwrap();
                for path in [&file, &folder, &empty] {
                    let path = crate::trash::prepare_path(path).unwrap();
                    let receipt = trash_with_receipt(&path).unwrap();
                    assert!(
                        !path.exists(),
                        "source must have moved into the Recycle Bin"
                    );
                    let identity =
                        unsafe { receipt.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) }.unwrap();
                    let identity_text = unsafe { identity.to_string() }.unwrap();
                    unsafe { CoTaskMemFree(Some(identity.0.cast())) };
                    assert!(!identity_text.is_empty());
                    eprintln!("recycled fixture: {} -> {}", path.display(), identity_text);
                    restore_receipt(&path, &receipt);
                }
                assert_eq!(
                    std::fs::read(&file).unwrap(),
                    b"kuf recycle fixture unique contents"
                );
                assert_eq!(
                    std::fs::read(folder.join("inner/payload.txt")).unwrap(),
                    b"nested contents"
                );
                assert_eq!(std::fs::read_dir(&empty).unwrap().count(), 0);
                eprintln!(
                    "Restored fixture contents verified; retained for inspection: {}",
                    root.display()
                );
                Ok(())
            })
            .unwrap();
        }

        #[test]
        #[ignore = "Creates an exclusive-locked fixture and verifies that a recycle failure preserves its contents"]
        fn windows_recycle_failure_preserves_generated_item() {
            use std::os::windows::fs::OpenOptionsExt;
            on_sta(|| {
                let nonce = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let root = std::env::current_dir()
                    .unwrap()
                    .join("target")
                    .join(format!(
                        "kuf-recycle-locked-fixture-{}-{nonce}",
                        std::process::id()
                    ));
                std::fs::create_dir_all(&root).unwrap();
                let file = root.join("locked fixture.txt");
                std::fs::write(&file, b"must remain when recycling is unavailable").unwrap();
                let path = crate::trash::prepare_path(&file).unwrap();
                let lock = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .share_mode(0)
                    .open(&file)
                    .unwrap();
                let result = trash_with_receipt(&path);
                drop(lock);
                match result {
                    Ok(receipt) => {
                        // Preserve even this generated data if the lock was unexpectedly ignored.
                        restore_receipt(&path, &receipt);
                        panic!("exclusive-locked fixture was unexpectedly recycled");
                    }
                    Err(error) => eprintln!("Expected recycle refusal: {error}"),
                }
                assert_eq!(
                    std::fs::read(&file).unwrap(),
                    b"must remain when recycling is unavailable"
                );
                eprintln!("Unmodified failure fixture retained: {}", file.display());
                Ok(())
            })
            .unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_relative_root_and_parent_paths_before_io() {
        assert!(prepare_path(Path::new("")).is_err());
        assert!(prepare_path(Path::new("relative-file.txt")).is_err());
        #[cfg(windows)]
        let paths = [r"C:\", r"C:\fixture\..\target"];
        #[cfg(not(windows))]
        let paths = ["/", "/fixture/../target"];
        for path in paths {
            assert!(prepare_path(Path::new(path)).is_err());
        }
    }

    #[test]
    fn invalid_batch_is_rejected_before_any_deletion() {
        assert!(prepare_paths(&["relative-item".into(), "".into()]).is_err());
        assert_eq!(prepare_paths(&[]).unwrap(), Vec::<PathBuf>::new());
    }
}
