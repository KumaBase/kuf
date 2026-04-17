use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SshHost {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: u16,
    pub identity_file: Option<String>,
}

impl SshHost {
    pub fn effective_host(&self) -> &str {
        self.host_name.as_deref().unwrap_or(&self.alias)
    }

    pub fn effective_user(&self) -> Option<&str> {
        self.user.as_deref()
    }
}

#[derive(Debug)]
struct RawHost {
    patterns: Vec<String>,
    host_name: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
}

pub fn load_ssh_config() -> Result<Vec<SshHost>, String> {
    let config_path = ssh_config_path()?;
    if !config_path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&config_path).map_err(|e| format!("Read ssh config: {}", e))?;
    parse_ssh_config(&content)
}

fn ssh_config_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|p| p.join(".ssh/config"))
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

fn parse_ssh_config(content: &str) -> Result<Vec<SshHost>, String> {
    let mut hosts: Vec<SshHost> = Vec::new();
    let mut current: Option<RawHost> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.trim(), v.trim()),
            None => continue,
        };

        let key_lower = key.to_lowercase();

        if key_lower == "host" {
            if let Some(raw) = current.take() {
                for pattern in &raw.patterns {
                    if !pattern.contains('*') && !pattern.contains('?') {
                        hosts.push(SshHost {
                            alias: pattern.clone(),
                            host_name: raw.host_name.clone(),
                            user: raw.user.clone(),
                            port: raw.port.unwrap_or(22),
                            identity_file: raw.identity_file.clone(),
                        });
                    }
                }
            }
            current = Some(RawHost {
                patterns: value.split_whitespace().map(|s| s.to_string()).collect(),
                host_name: None,
                user: None,
                port: None,
                identity_file: None,
            });
            continue;
        }

        if let Some(ref mut raw) = current {
            match key_lower.as_str() {
                "hostname" => raw.host_name = Some(value.to_string()),
                "user" => raw.user = Some(value.to_string()),
                "port" => raw.port = value.parse().ok(),
                "identityfile" => {
                    // Expand ~ to home directory
                    let expanded = if value.starts_with("~/") {
                        dirs::home_dir()
                            .map(|h| h.join(&value[2..]).to_string_lossy().to_string())
                            .unwrap_or_else(|| value.to_string())
                    } else {
                        value.to_string()
                    };
                    raw.identity_file = Some(expanded);
                }
                _ => {}
            }
        }
    }

    if let Some(raw) = current.take() {
        for pattern in &raw.patterns {
            if !pattern.contains('*') && !pattern.contains('?') {
                hosts.push(SshHost {
                    alias: pattern.clone(),
                    host_name: raw.host_name.clone(),
                    user: raw.user.clone(),
                    port: raw.port.unwrap_or(22),
                    identity_file: raw.identity_file.clone(),
                });
            }
        }
    }

    Ok(hosts)
}
