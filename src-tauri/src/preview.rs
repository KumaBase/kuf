//! Bounded file bytes for the viewer. Images use per-file Blob URLs in the
//! frontend, so preview never expands Tauri's global asset protocol scope.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{fs::File, io::Read, path::Path};
use tokio::io::AsyncReadExt;

const TEXT_LIMIT: usize = 2 * 1024 * 1024;
const IMAGE_LIMIT: usize = 20 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct PreviewBytes {
    pub data_base64: String,
    pub size: usize,
}

fn limit(image: bool) -> usize {
    if image {
        IMAGE_LIMIT
    } else {
        TEXT_LIMIT
    }
}
fn too_large(maximum: usize) -> String {
    format!(
        "プレビューの上限は{} MiBです。外部アプリで開いてください。",
        maximum / 1024 / 1024
    )
}
fn pack(bytes: Vec<u8>) -> PreviewBytes {
    PreviewBytes {
        data_base64: STANDARD.encode(&bytes),
        size: bytes.len(),
    }
}

fn read_local(path: &Path, image: bool) -> Result<PreviewBytes, String> {
    let maximum = limit(image);
    let file = File::open(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("ファイル情報を取得できません: {e}"))?;
    if !metadata.is_file() {
        return Err("通常のファイルだけをプレビューできます".into());
    }
    if metadata.len() > maximum as u64 {
        return Err(too_large(maximum));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("ファイルを読み取れません: {e}"))?;
    if bytes.len() > maximum {
        return Err(too_large(maximum));
    }
    Ok(pack(bytes))
}

#[tauri::command]
pub async fn read_preview(path: String, image: bool) -> Result<PreviewBytes, String> {
    crate::background::run(move || read_local(Path::new(&path), image)).await
}

async fn bounded_remote_bytes(
    reader: impl tokio::io::AsyncRead + Unpin,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    reader
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| format!("SFTPの読み取りに失敗しました: {e}"))?;
    if bytes.len() > maximum {
        return Err(too_large(maximum));
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn ssh_read_preview(
    host: String,
    port: Option<u16>,
    path: String,
    image: bool,
    state: tauri::State<'_, crate::ssh::connection::ConnectionManager>,
) -> Result<PreviewBytes, String> {
    let handle = state
        .get(&host, port.unwrap_or(22))
        .ok_or_else(|| format!("未接続のサーバーです: {host}"))?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("SFTPチャンネルを開けません: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("SFTPを開始できません: {e}"))?;
    let session = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("SFTPの初期化に失敗しました: {e}"))?;
    let metadata = session
        .metadata(&path)
        .await
        .map_err(|e| format!("ファイル情報を取得できません: {e}"))?;
    if metadata.is_dir() {
        return Err("フォルダはプレビューできません".into());
    }
    let maximum = limit(image);
    if metadata.len() > maximum as u64 {
        return Err(too_large(maximum));
    }
    let reader = session
        .open(&path)
        .await
        .map_err(|e| format!("ファイルを開けません: {e}"))?;
    // Server metadata is advisory. The read itself enforces the limit if the
    // remote file grows or its reported length is absent or inaccurate.
    let bytes = bounded_remote_bytes(reader, maximum).await?;
    crate::background::run(move || Ok(pack(bytes))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_preview_preserves_bytes_and_rejects_oversized_files() {
        let path = std::env::temp_dir().join(format!(
            "kuf-preview-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let _fixture = Fixture(path.clone());
        let original = [0x82, 0xb1, 0x82, 0xf1, 0x00, 0xff];
        std::fs::write(&path, original).unwrap();
        let response = read_local(&path, false).unwrap();
        assert_eq!(response.size, original.len());
        assert_eq!(STANDARD.decode(response.data_base64).unwrap(), original);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        let file = File::options().write(true).open(&path).unwrap();
        file.set_len(TEXT_LIMIT as u64 + 1).unwrap();
        drop(file);
        assert!(read_local(&path, false).unwrap_err().contains("2 MiB"));
        assert!(read_local(&path, true).is_ok());
        let file = File::options().write(true).open(&path).unwrap();
        file.set_len(IMAGE_LIMIT as u64 + 1).unwrap();
        drop(file);
        assert!(read_local(&path, true).unwrap_err().contains("20 MiB"));
    }

    #[tokio::test]
    async fn remote_reader_enforces_actual_bytes_without_trusting_metadata() {
        let original = [0_u8, 1, 2, 3, 4];
        assert_eq!(
            bounded_remote_bytes(&original[..], 5).await.unwrap(),
            original
        );
        assert!(bounded_remote_bytes(&original[..], 4)
            .await
            .unwrap_err()
            .contains("上限"));
        assert!(bounded_remote_bytes(&[][..], 4).await.unwrap().is_empty());
    }
}
