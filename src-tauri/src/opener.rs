//! Open an associated application without interpolating a file path into a shell command.

fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') {
        return Err("開くパスが空、または無効な文字を含んでいます".to_string());
    }
    Ok(())
}

pub fn open(path: &str) -> Result<(), String> {
    validate_path(path)?;
    platform::open(path)
}

#[cfg(windows)]
mod platform {
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            System::Com::{
                CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
            },
            UI::{
                Shell::{
                    ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
                },
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
    };

    fn wide_path(path: &str) -> Result<Vec<u16>, String> {
        super::validate_path(path)?;
        Ok(path.encode_utf16().chain(Some(0)).collect())
    }

    fn shell_open_request(path: &[u16]) -> SHELLEXECUTEINFOW {
        SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            // No message loop lives on this short-lived STA thread. Wait for
            // association/DDE dispatch before its COM apartment is released.
            fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: w!("open"),
            lpFile: PCWSTR(path.as_ptr()),
            // A path is never a command line. In particular, do not set
            // lpParameters or enable SEE_MASK_DOENVSUBST for percent signs.
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        }
    }

    pub fn open(path: &str) -> Result<(), String> {
        let path = wide_path(path)?;
        // A dedicated thread avoids an incompatible COM apartment left by
        // another operation on the shared blocking-worker pool.
        std::thread::Builder::new()
            .name("kuf-open-sta".to_string())
            .spawn(move || {
                unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }
                    .ok()
                    .map_err(|error| format!("ファイルを開く準備に失敗しました: {error}"))?;
                struct Apartment;
                impl Drop for Apartment {
                    fn drop(&mut self) {
                        unsafe { CoUninitialize() };
                    }
                }
                let _apartment = Apartment;
                let mut request = shell_open_request(&path);
                // Both the request and its UTF-16 storage remain alive until
                // synchronous association dispatch has finished.
                unsafe { ShellExecuteExW(&mut request) }
                    .map_err(|error| format!("ファイルを開けません: {error}"))
            })
            .map_err(|error| format!("ファイルを開く処理を開始できません: {error}"))?
            .join()
            .map_err(|_| "ファイルを開く処理が異常終了しました".to_string())?
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::UI::Shell::SEE_MASK_DOENVSUBST;

        #[test]
        fn windows_path_is_a_literal_utf16_file_parameter_with_no_command_arguments() {
            let path = r"C:\作業 & backup\a ^ %PATH% ! 日本語.txt";
            let encoded = wide_path(path).unwrap();
            assert_eq!(encoded.last(), Some(&0));
            assert!(!encoded[..encoded.len() - 1].contains(&0));
            assert_eq!(
                String::from_utf16(&encoded[..encoded.len() - 1]).unwrap(),
                path
            );
            let request = shell_open_request(&encoded);
            assert_eq!(request.lpFile.as_ptr(), encoded.as_ptr());
            assert!(request.lpParameters.is_null());
            assert!(request.lpDirectory.is_null());
            assert_eq!(request.fMask & SEE_MASK_DOENVSUBST, 0);
            assert_ne!(request.fMask & SEE_MASK_NOASYNC, 0);
            assert_ne!(request.fMask & SEE_MASK_FLAG_NO_UI, 0);
            assert_eq!(unsafe { request.lpVerb.to_string() }.unwrap(), "open");
        }

        #[test]
        fn embedded_nul_is_rejected_instead_of_truncating_the_windows_path() {
            assert!(wide_path("C:\\safe.txt\0C:\\other.txt").is_err());
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod platform {
    fn command(path: &str) -> std::process::Command {
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("open");
        #[cfg(target_os = "linux")]
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path);
        command
    }

    pub fn open(path: &str) -> Result<(), String> {
        let mut child = command(path)
            .spawn()
            .map_err(|error| format!("ファイルを開けません: {error}"))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn special_characters_are_passed_as_one_literal_argument() {
            let path = "/tmp/作業 & backup/a; $(data) 日本語.txt";
            let command = command(path);
            assert_eq!(
                command.get_args().collect::<Vec<_>>(),
                vec![std::ffi::OsStr::new(path)]
            );
            #[cfg(target_os = "macos")]
            assert_eq!(command.get_program(), "open");
            #[cfg(target_os = "linux")]
            assert_eq!(command.get_program(), "xdg-open");
        }
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod platform {
    pub fn open(_: &str) -> Result<(), String> {
        Err("この環境の関連付け起動には対応していません".to_string())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn invalid_paths_fail_before_any_application_is_launched() {
        assert!(super::open("").is_err());
        assert!(super::open("safe\0other").is_err());
    }
}
