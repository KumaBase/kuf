pub mod local;
pub mod sftp;
pub mod transfer;

use crate::FileInfo;
use std::path::{Path, PathBuf};

pub trait FileSystem {
    fn read_dir(&self, path: &Path) -> Result<Vec<FileInfo>, String>;
    fn copy_items(&self, sources: &[PathBuf], dest: &Path) -> Result<(), String>;
    fn move_items(&self, sources: &[PathBuf], dest: &Path) -> Result<(), String>;
    fn delete_items(&self, paths: &[PathBuf]) -> Result<(), String>;
    fn rename_item(&self, path: &Path, new_name: &str) -> Result<(), String>;
    fn create_dir(&self, path: &Path, name: &str) -> Result<(), String>;
    fn path_exists(&self, path: &Path) -> Result<bool, String>;
    fn read_file_text(&self, path: &Path) -> Result<String, String>;
}
