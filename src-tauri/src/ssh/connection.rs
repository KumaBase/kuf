use crate::ssh::config::SshHost;
use russh::client;
use russh_keys::key::PrivateKeyWithHashAlg;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum AuthMethod {
    Default,
    Password { password: String },
}

#[derive(Clone)]
struct PendingHostKey {
    host: String,
    port: u16,
    key: russh::keys::PublicKey,
}

pub struct SshClientHandler {
    host: String,
    port: u16,
    known_hosts: std::path::PathBuf,
    result: Arc<Mutex<Option<Result<russh::keys::PublicKey, String>>>>,
}

#[async_trait::async_trait]
impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let checked =
            super::known_hosts::verify(&self.known_hosts, &self.host, self.port, server_public_key);
        match checked {
            Ok(true) => Ok(true),
            Ok(false) => {
                *self.result.lock().unwrap() = Some(Ok(server_public_key.clone()));
                Ok(false)
            }
            Err(error) => {
                *self.result.lock().unwrap() = Some(Err(error));
                Ok(false)
            }
        }
    }
}

pub type SshHandle = client::Handle<SshClientHandler>;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConnectedServer {
    pub alias: String,
    pub user: String,
    pub port: u16,
}

struct SessionEntry {
    handle: Arc<SshHandle>,
    alias: String,
    user: String,
    port: u16,
    effective_host: String,
}

pub struct ConnectionManager {
    sessions: Mutex<HashMap<String, SessionEntry>>,
    pending: Mutex<HashMap<String, PendingHostKey>>,
    next_challenge: std::sync::atomic::AtomicU64,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_challenge: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub async fn connect(
        &self,
        host: &SshHost,
        auth: &AuthMethod,
    ) -> Result<Arc<SshHandle>, String> {
        let key = host_key(host);
        {
            let sessions = self.sessions.lock().unwrap();
            if let Some(entry) = sessions.get(&key) {
                if entry.effective_host == host.effective_host()
                    && Some(entry.user.as_str()) == host.effective_user()
                {
                    return Ok(Arc::clone(&entry.handle));
                }
                return Err(
                    "SSH configuration changed; disconnect the existing session first".into(),
                );
            }
        }

        let effective_host = host.effective_host();
        let port = host.port;

        let config = Arc::new(client::Config::default());
        let result = Arc::new(Mutex::new(None));
        let handler = SshClientHandler {
            host: effective_host.to_string(),
            port,
            known_hosts: super::known_hosts::known_hosts_path()?,
            result: result.clone(),
        };
        let mut handle = match client::connect(config, (effective_host, port), handler).await {
            Ok(handle) => handle,
            Err(error) => match result.lock().unwrap().take() {
                Some(Err(error)) => return Err(error),
                Some(Ok(key)) => {
                    let id = self
                        .next_challenge
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                        .to_string();
                    let fingerprint = key.fingerprint(russh_keys::HashAlg::Sha256).to_string();
                    let kind = key.algorithm().to_string();
                    let mut pending = self.pending.lock().unwrap();
                    pending.clear();
                    pending.insert(
                        id.clone(),
                        PendingHostKey {
                            host: effective_host.to_string(),
                            port,
                            key,
                        },
                    );
                    let info = serde_json::json!({ "id": id, "host": effective_host, "port": port, "keyType": kind, "fingerprint": fingerprint });
                    return Err(format!("[UNKNOWN_HOST_KEY]{}", info));
                }
                None => {
                    return Err(format!(
                        "SSH connect to {}:{}: {}",
                        effective_host, port, error
                    ))
                }
            },
        };

        let username = host
            .effective_user()
            .map(|u| u.to_string())
            .ok_or_else(|| {
                "No username specified. Set User in ssh config or provide credentials.".to_string()
            })?;

        let mut authenticated = false;

        match auth {
            AuthMethod::Default => {
                // Try identity file from config
                if !authenticated {
                    if let Some(ref identity_file) = host.identity_file {
                        if let Ok(key_pair) = russh::keys::load_secret_key(identity_file, None) {
                            if let Ok(key_with_alg) =
                                PrivateKeyWithHashAlg::new(Arc::new(key_pair), None)
                            {
                                if let Ok(true) =
                                    handle.authenticate_publickey(&username, key_with_alg).await
                                {
                                    authenticated = true;
                                }
                            }
                        }
                    }
                }

                // Try default key files
                if !authenticated {
                    if let Some(home) = dirs::home_dir() {
                        let ssh_dir = home.join(".ssh");
                        for key_name in &["id_ed25519", "id_rsa", "id_ecdsa"] {
                            let key_path = ssh_dir.join(key_name);
                            if key_path.exists() {
                                if let Ok(key_pair) = russh::keys::load_secret_key(&key_path, None)
                                {
                                    if let Ok(key_with_alg) =
                                        PrivateKeyWithHashAlg::new(Arc::new(key_pair), None)
                                    {
                                        if let Ok(true) = handle
                                            .authenticate_publickey(&username, key_with_alg)
                                            .await
                                        {
                                            authenticated = true;
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                if !authenticated {
                    return Err("Authentication failed. No valid key found.".to_string());
                }
            }
            AuthMethod::Password { password } => {
                let result = handle
                    .authenticate_password(&username, password)
                    .await
                    .map_err(|e| format!("Password auth: {}", e))?;
                if !result {
                    return Err("Password authentication failed".to_string());
                }
            }
        }

        let handle_arc = Arc::new(handle);
        let entry = SessionEntry {
            handle: Arc::clone(&handle_arc),
            alias: host.alias.clone(),
            user: username,
            port: host.port,
            effective_host: effective_host.to_string(),
        };
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(key, entry);

        Ok(handle_arc)
    }

    pub fn accept_host(&self, id: &str) -> Result<(), String> {
        self.accept_host_at(id, &super::known_hosts::known_hosts_path()?)
    }

    fn accept_host_at(&self, id: &str, path: &std::path::Path) -> Result<(), String> {
        let pending = self
            .pending
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| "Host key confirmation expired; connect again".to_string())?;
        super::known_hosts::add_at(path, &pending.host, pending.port, &pending.key)
    }

    pub fn disconnect(&self, host_alias: &str, port: u16) -> Result<(), String> {
        let key = format!("{}:{}", host_alias, port);
        let mut sessions = self.sessions.lock().unwrap();
        sessions.remove(&key);
        Ok(())
    }

    pub fn get(&self, host_alias: &str, port: u16) -> Option<Arc<SshHandle>> {
        let key = format!("{}:{}", host_alias, port);
        let sessions = self.sessions.lock().unwrap();
        sessions.get(&key).map(|e| Arc::clone(&e.handle))
    }

    pub fn list_connections(&self) -> Vec<ConnectedServer> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .values()
            .map(|e| ConnectedServer {
                alias: e.alias.clone(),
                user: e.user.clone(),
                port: e.port,
            })
            .collect()
    }
}

fn host_key(host: &SshHost) -> String {
    format!("{}:{}", host.alias, host.port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::server::{self, Auth};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestServer(Arc<AtomicUsize>);

    #[test]
    fn confirmation_saves_only_the_captured_key_and_cannot_be_reused() {
        let temp = std::env::temp_dir().join(format!("kuf-ssh-confirm-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        let path = temp.join("known_hosts");
        let mut rng = russh_keys::ssh_key::rand_core::OsRng;
        let key = russh_keys::PrivateKey::random(&mut rng, russh_keys::Algorithm::Ed25519).unwrap();
        let other =
            russh_keys::PrivateKey::random(&mut rng, russh_keys::Algorithm::Ed25519).unwrap();
        let manager = ConnectionManager::new();
        manager.pending.lock().unwrap().insert(
            "1".into(),
            PendingHostKey {
                host: "example.test".into(),
                port: 2222,
                key: key.public_key().clone(),
            },
        );
        assert!(manager.accept_host_at("1", &path).is_ok());
        assert!(manager.accept_host_at("1", &path).is_err());
        assert!(
            super::super::known_hosts::verify(&path, "example.test", 2222, key.public_key())
                .unwrap()
        );
        assert!(
            super::super::known_hosts::verify(&path, "example.test", 2222, other.public_key())
                .is_err()
        );
        std::fs::remove_dir_all(temp).unwrap();
    }
    #[async_trait::async_trait]
    impl server::Handler for TestServer {
        type Error = russh::Error;
        async fn auth_password(&mut self, _: &str, _: &str) -> Result<Auth, Self::Error> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Auth::Accept)
        }
    }

    #[tokio::test]
    async fn host_key_is_verified_before_password_authentication() {
        let temp = std::env::temp_dir().join(format!("kuf-ssh-boundary-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        let known_hosts = temp.join("known_hosts");
        let mut rng = russh_keys::ssh_key::rand_core::OsRng;
        let server_key =
            russh_keys::PrivateKey::random(&mut rng, russh_keys::Algorithm::Ed25519).unwrap();
        let other_key =
            russh_keys::PrivateKey::random(&mut rng, russh_keys::Algorithm::Ed25519).unwrap();
        let mut config = server::Config::default();
        config.keys.push(server_key.clone());
        let config = Arc::new(config);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        let server_task = tokio::spawn(async move {
            for _ in 0..3 {
                let (socket, _) = listener.accept().await.unwrap();
                let config = config.clone();
                let count = count.clone();
                tokio::spawn(async move {
                    if let Ok(session) = server::run_stream(config, socket, TestServer(count)).await
                    {
                        let _ = session.await;
                    }
                });
            }
        });
        for case in 0..3 {
            if case == 1 {
                std::fs::write(
                    &known_hosts,
                    format!(
                        "[127.0.0.1]:{port} {}\n",
                        other_key.public_key().to_openssh().unwrap()
                    ),
                )
                .unwrap();
            }
            if case == 2 {
                std::fs::write(
                    &known_hosts,
                    format!(
                        "[127.0.0.1]:{port} {}\n",
                        server_key.public_key().to_openssh().unwrap()
                    ),
                )
                .unwrap();
            }
            let result = Arc::new(Mutex::new(None));
            let handler = SshClientHandler {
                host: "127.0.0.1".into(),
                port,
                known_hosts: known_hosts.clone(),
                result: result.clone(),
            };
            let connection = client::connect(
                Arc::new(client::Config::default()),
                ("127.0.0.1", port),
                handler,
            )
            .await;
            if case < 2 {
                assert!(connection.is_err());
                assert_eq!(attempts.load(Ordering::SeqCst), 0);
                assert!(result.lock().unwrap().is_some());
            } else {
                let mut connection = connection.unwrap();
                assert!(connection
                    .authenticate_password("test", "test-only")
                    .await
                    .unwrap());
                assert_eq!(attempts.load(Ordering::SeqCst), 1);
            }
        }
        server_task.await.unwrap();
        std::fs::remove_dir_all(temp).unwrap();
    }
}
