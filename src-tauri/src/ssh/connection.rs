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

pub struct SshClientHandler;

#[async_trait::async_trait]
impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        let _ = server_public_key;
        Ok(true)
    }
}

pub type SshHandle = client::Handle<SshClientHandler>;

pub struct ConnectionManager {
    sessions: Mutex<HashMap<String, Arc<SshHandle>>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
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
            if let Some(handle) = sessions.get(&key) {
                return Ok(Arc::clone(handle));
            }
        }

        let effective_host = host.effective_host();
        let port = host.port;

        let config = Arc::new(client::Config::default());
        let handler = SshClientHandler;
        let mut handle = client::connect(config, (effective_host, port), handler)
            .await
            .map_err(|e| format!("SSH connect to {}:{}: {}", effective_host, port, e))?;

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
                            if let Ok(key_with_alg) = PrivateKeyWithHashAlg::new(
                                Arc::new(key_pair),
                                None,
                            ) {
                                if let Ok(true) = handle
                                    .authenticate_publickey(&username, key_with_alg)
                                    .await
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
                                    if let Ok(key_with_alg) = PrivateKeyWithHashAlg::new(
                                        Arc::new(key_pair),
                                        None,
                                    ) {
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
                    return Err(
                        "Authentication failed. No valid key found.".to_string()
                    );
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
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(key, Arc::clone(&handle_arc));

        Ok(handle_arc)
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
        sessions.get(&key).cloned()
    }
}

fn host_key(host: &SshHost) -> String {
    format!("{}:{}", host.alias, host.port)
}
