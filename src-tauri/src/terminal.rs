//! Open an interactive Windows console without interpreting a filesystem path
//! as cmd syntax. Keep the launch plan inspectable without spawning a terminal.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};

// Win32 CREATE_NEW_CONSOLE. Using std's CommandExt avoids another Win32 API
// feature dependency just to pass the process creation flag.
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

struct TerminalLaunch {
    command: Command,
    creation_flags: u32,
}

impl TerminalLaunch {
    fn new(path: &Path) -> Self {
        let mut command = Command::new("cmd.exe");
        // /D suppresses registry AutoRun commands. /K opens the prompt with no
        // shell command to execute; the directory is passed only as process cwd.
        command.args(["/D", "/K"]).current_dir(path);
        Self {
            command,
            creation_flags: CREATE_NEW_CONSOLE,
        }
    }

    fn spawn(mut self) -> std::io::Result<Child> {
        self.command.creation_flags(self.creation_flags).spawn()
    }
}

pub fn open(path: &Path) -> std::io::Result<Child> {
    TerminalLaunch::new(path).spawn()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn folder_names_are_only_passed_as_the_working_directory() {
        // Each is a valid Windows filename component whose characters have
        // special meaning when interpolated into a cmd command string.
        for path in [
            r"C:\files & calc & rem",
            r"C:\%COMSPEC%\!TEMP!",
            r"C:\日本語 資料\a^(b)",
        ] {
            let launch = TerminalLaunch::new(Path::new(path));
            assert_eq!(launch.command.get_program(), OsStr::new("cmd.exe"));
            assert_eq!(
                launch.command.get_args().collect::<Vec<_>>(),
                vec![OsStr::new("/D"), OsStr::new("/K")]
            );
            assert_eq!(launch.command.get_current_dir(), Some(Path::new(path)));
        }
    }

    #[test]
    fn launch_requests_a_new_console_for_the_gui_application() {
        let launch = TerminalLaunch::new(Path::new(r"C:\files"));
        // Check the documented CreateProcess flag value, not a child process:
        // tests must never launch or send input to an interactive terminal.
        assert_eq!(launch.creation_flags, 0x0000_0010);
    }
}
