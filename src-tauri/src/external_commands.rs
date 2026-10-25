use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

static STORAGE_LOCK: Mutex<()> = Mutex::new(());
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExternalCommand {
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedCommands {
    version: u32,
    commands: Vec<ExternalCommand>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandContext {
    pub directory: String,
    pub other_directory: String,
    pub file: Option<String>,
    pub selected: Vec<String>,
}

fn path() -> Result<PathBuf, String> {
    Ok(crate::config::config_dir()?.join("external-commands.json"))
}

fn validate(commands: &[ExternalCommand]) -> Result<(), String> {
    if commands.len() > 100 {
        return Err("外部コマンドは100件まで登録できます".into());
    }
    let mut names = HashSet::new();
    for command in commands {
        if command.name.trim().is_empty()
            || command.name.len() > 240
            || !names.insert(&command.name)
        {
            return Err("外部コマンドの名前が空・長すぎる・重複しています".into());
        }
        if command.program.trim().is_empty()
            || command.program.len() > 32768
            || command.program.contains('\0')
            || command.args.len() > 128
        {
            return Err("実行ファイルと引数を確認してください（引数は128個まで）".into());
        }
        let program = command
            .program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_lowercase();
        let stem = program.strip_suffix(".exe").unwrap_or(&program);
        if program.ends_with(".bat")
            || program.ends_with(".cmd")
            || [
                "cmd",
                "powershell",
                "pwsh",
                "sh",
                "bash",
                "zsh",
                "fish",
                "dash",
                "ksh",
                "csh",
                "tcsh",
            ]
            .contains(&stem)
        {
            return Err("外部コマンドには通常の実行ファイルを指定してください。シェルやbat/cmdの実行は未対応です".into());
        }
        for arg in &command.args {
            if arg.len() > 32768
                || arg.contains('\0')
                || arg.contains("{selected}") && arg != "{selected}"
            {
                return Err("{selected} は独立した引数として指定してください".into());
            }
        }
    }
    Ok(())
}

fn load_from(path: &Path) -> Result<Vec<ExternalCommand>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("外部コマンド設定が大きすぎます。元のファイルは保持しました".into());
    }
    let data: SavedCommands = serde_json::from_slice(&bytes)
        .map_err(|e| format!("外部コマンド設定を読めません。元のファイルは保持しました: {e}"))?;
    if data.version != 1 {
        return Err("未対応の外部コマンド設定です。元のファイルは保持しました".into());
    }
    validate(&data.commands)?;
    Ok(data.commands)
}

fn save_to(
    path: &Path,
    commands: &[ExternalCommand],
    expected: &[ExternalCommand],
) -> Result<(), String> {
    validate(commands)?;
    let dir = path.parent().ok_or("設定フォルダがありません")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(".external-commands.lock"))
        .map_err(|e| e.to_string())?;
    fs4::fs_std::FileExt::lock_exclusive(&lock).map_err(|e| e.to_string())?;
    if load_from(path)? != expected {
        return Err("外部コマンド設定が他の画面で変更されました。閉じて開き直してください".into());
    }
    let data = serde_json::to_vec_pretty(&SavedCommands {
        version: 1,
        commands: commands.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    if data.len() > 1024 * 1024 {
        return Err("外部コマンド設定が大きすぎます".into());
    }
    let mut allocated = None;
    for _ in 0..100 {
        let temp = dir.join(format!(
            ".external-{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => {
                allocated = Some((temp, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let (temp, mut file) = allocated.ok_or("一時ファイルを作成できません")?;
    let result = file.write_all(&data).and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|e| format!("外部コマンドを保存できません: {e}"))
}

fn expand(command: &ExternalCommand, context: &CommandContext) -> Result<Vec<String>, String> {
    if context.directory.starts_with("sftp://") || context.selected.len() > 10000 {
        return Err("外部コマンドはローカルで使えます（選択は10000件まで）".into());
    }
    let file = context.file.as_deref().unwrap_or("");
    let name = Path::new(file)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let mut args = Vec::new();
    for template in &command.args {
        if template == "{selected}" {
            if args.len() + context.selected.len() > 10000 {
                return Err("引数が多すぎます。選択を減らしてください（最大10000個）".into());
            }
            args.extend(context.selected.iter().cloned());
            continue;
        }
        if (template.contains("{file}") || template.contains("{name}")) && file.is_empty() {
            return Err("ファイルにカーソルを合わせてください".into());
        }
        if template.contains("{other}") && context.other_directory.starts_with("sftp://") {
            return Err("相手ペインにローカルフォルダを開いてください".into());
        }
        // Replace tokens in one pass: a filename containing a token stays data.
        let mut expanded = String::new();
        let mut rest = template.as_str();
        while !rest.is_empty() {
            let found = [
                ("{dir}", context.directory.as_str()),
                ("{other}", context.other_directory.as_str()),
                ("{file}", file),
                ("{name}", name),
            ]
            .into_iter()
            .filter_map(|(token, value)| rest.find(token).map(|offset| (offset, token, value)))
            .min_by_key(|v| v.0);
            if let Some((offset, token, value)) = found {
                expanded.push_str(&rest[..offset]);
                expanded.push_str(value);
                rest = &rest[offset + token.len()..];
            } else {
                expanded.push_str(rest);
                break;
            }
        }
        args.push(expanded);
    }
    if args.iter().any(|arg| arg.contains('\0')) {
        return Err("引数に無効な文字があります".into());
    }
    if args.len() > 10000 || args.iter().map(String::len).sum::<usize>() > 2 * 1024 * 1024 {
        return Err("引数が長すぎます。選択を減らしてください".into());
    }
    #[cfg(windows)]
    {
        // Leave room for argv[0], separators, quotes and escaped backslashes.
        let upper_bound = command.program.encode_utf16().count()
            + 3
            + args
                .iter()
                .map(|arg| {
                    3 + arg.encode_utf16().count()
                        + arg.chars().filter(|c| *c == '\\' || *c == '"').count()
                })
                .sum::<usize>();
        if upper_bound >= 32767 {
            return Err("Windowsの引数の長さ上限を超えます。選択を減らして実行してください".into());
        }
    }
    Ok(args)
}

#[tauri::command]
pub async fn external_commands_load() -> Result<Vec<ExternalCommand>, String> {
    crate::background::run(|| {
        let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
        load_from(&path()?)
    })
    .await
}

#[tauri::command]
pub async fn external_commands_save(
    commands: Vec<ExternalCommand>,
    expected: Vec<ExternalCommand>,
) -> Result<(), String> {
    crate::background::run(move || {
        let _guard = STORAGE_LOCK.lock().map_err(|e| e.to_string())?;
        save_to(&path()?, &commands, &expected)
    })
    .await
}

#[tauri::command]
pub async fn external_command_run(name: String, context: CommandContext) -> Result<(), String> {
    crate::background::run(move || {
        let commands = load_from(&path()?)?;
        let command = commands
            .iter()
            .find(|command| command.name == name)
            .ok_or("外部コマンドが見つかりません。画面を開き直してください")?;
        let args = expand(command, &context)?;
        if !Path::new(&context.directory).is_dir() {
            return Err("作業フォルダが見つかりません".into());
        }
        let mut child = std::process::Command::new(&command.program)
            .args(args)
            .current_dir(&context.directory)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("外部コマンドを起動できません: {e}"))?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("kuf-external-test-{}-{nonce}-{}", std::process::id(), NEXT_TEMP.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn expands_arguments_without_shell_or_recursive_substitution() {
        let command = ExternalCommand {
            name: "tool".into(),
            program: "tool".into(),
            args: vec![
                "{selected}".into(),
                "--dir={dir}".into(),
                "{name}".into(),
                "".into(),
            ],
        };
        let context = CommandContext {
            directory: "/files".into(),
            other_directory: "/other".into(),
            file: Some("/files/{dir}; a.txt".into()),
            selected: vec!["/files/{dir}; a.txt".into(), "/files/b.txt".into()],
        };
        assert_eq!(
            expand(&command, &context).unwrap(),
            vec![
                "/files/{dir}; a.txt",
                "/files/b.txt",
                "--dir=/files",
                "{dir}; a.txt",
                ""
            ]
        );
    }
    #[test]
    fn invalid_and_duplicate_profiles_are_rejected() {
        let mut command = ExternalCommand {
            name: "tool".into(),
            program: "tool".into(),
            args: vec!["prefix{selected}".into()],
        };
        assert!(validate(&[command.clone()]).is_err());
        command.args.clear();
        assert!(validate(&[command.clone(), command]).is_err());
        for program in [
            "cmd.exe",
            "C:\\Windows\\System32\\cmd.exe",
            "tools.cmd",
            "pwsh",
        ] {
            assert!(validate(&[ExternalCommand {
                name: "shell".into(),
                program: program.into(),
                args: vec![]
            }])
            .is_err());
        }
    }
    #[test]
    fn expanded_arguments_are_bounded_and_suggest_reducing_selection() {
        let command = ExternalCommand {
            name: "tool".into(),
            program: "tool".into(),
            args: vec!["{selected}".into(), "{selected}".into()],
        };
        let context = CommandContext {
            directory: "/files".into(),
            other_directory: "/other".into(),
            file: None,
            selected: vec!["a".repeat(300); 6000],
        };
        assert!(expand(&command, &context)
            .unwrap_err()
            .contains("選択を減ら"));
    }
    #[test]
    fn corrupt_profile_file_is_preserved() {
        let directory = fixture();
        let path = directory.join("external-commands.json");
        fs::write(&path, b"invalid").unwrap();
        assert!(save_to(&path, &[], &[]).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid");
        fs::remove_dir_all(&directory).unwrap();
    }
    #[test]
    fn saving_detects_other_instance_changes() {
        let directory = fixture();
        let path = directory.join("external-commands.json");
        let command = ExternalCommand {
            name: "tool".into(),
            program: "tool".into(),
            args: vec![],
        };
        save_to(&path, &[command.clone()], &[]).unwrap();
        assert!(save_to(&path, &[], &[]).is_err());
        assert_eq!(load_from(&path).unwrap(), vec![command]);
        fs::remove_dir_all(&directory).unwrap();
    }
}
