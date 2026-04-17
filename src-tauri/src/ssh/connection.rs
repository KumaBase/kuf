use crate::ssh::config::SshHost;
use crate::ssh::known_hosts;
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::net::TcpStream;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum AuthMethod {
    Default,
    Password { password: String },
}

pub struct ConnectionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn connect(&self, host: &SshHost, auth: &AuthMethod) -> Result<Arc<Session>, String> {
        let key = host_key(host);
        {
            let sessions = self.sessions.lock().unwrap();
            if let Some(session) = sessions.get(&key) {
                return Ok(Arc::clone(session));
            }
        }

        let effective_host = host.effective_host();
        let port = host.port;
        let addr = format!("{}:{}", effective_host, port);

        let tcp = TcpStream::connect(&addr)
            .map_err(|e| format!("TCP connect to {}: {}", addr, e))?;

        let mut session = Session::new().map_err(|e| format!("SSH session create: {}", e))?;
        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| format!("SSH handshake: {}", e))?;

        // --- Host key verification ---
        let (host_key_data, key_type_raw) = session
            .host_key()
            .ok_or_else(|| "Server did not send a host key".to_string())?;
        let key_type_str = key_type_name(key_type_raw);
        let fingerprint = format!(
            "SHA256:{}",
            base64_encode(&sha256_fingerprint(host_key_data))
        );

        match known_hosts::verify_host_key(effective_host, port, key_type_str, host_key_data) {
            Ok(true) => { /* trusted */ }
            Ok(false) => {
                // First connection — return structured error for UI to handle TOFU
                return Err(format!(
                    "[UNKNOWN_HOST_KEY]{}\n{}\n{}:{}",
                    key_type_str, fingerprint, effective_host, port
                ));
            }
            Err(msg) => {
                return Err(msg);
            }
        }

        // --- Authentication ---
        let username = host
            .effective_user()
            .map(|u| u.to_string())
            .ok_or_else(|| "No username specified. Set User in ssh config or provide credentials.".to_string())?;

        match auth {
            AuthMethod::Default => {
                // Try agent authentication first, then identity file from config
                let mut authenticated = false;

                if session.userauth_agent(&username).is_ok() {
                    let auth_result = session.authenticated();
                    if auth_result {
                        authenticated = true;
                    }
                }

                if !authenticated {
                    if let Some(ref identity_file) = host.identity_file {
                        let key_path = Path::new(identity_file);
                        session
                            .userauth_pubkey_file(
                                &username,
                                None,
                                key_path,
                                None,
                            )
                            .map_err(|e| format!("Public key auth with {}: {}", identity_file, e))?;
                        authenticated = true;
                    } else {
                        // Try default key files
                        if let Some(home) = dirs::home_dir() {
                            let ssh_dir = home.join(".ssh");
                            for key_name in &["id_ed25519", "id_rsa", "id_ecdsa"] {
                                let key_path = ssh_dir.join(key_name);
                                if key_path.exists() {
                                    if session
                                        .userauth_pubkey_file(&username, None, &key_path, None)
                                        .is_ok()
                                        && session.authenticated()
                                    {
                                        authenticated = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }

                if !authenticated {
                    return Err("Authentication failed. No valid key or agent found.".to_string());
                }
            }
            AuthMethod::Password { password } => {
                session
                    .userauth_password(&username, password)
                    .map_err(|e| format!("Password auth: {}", e))?;
            }
        }

        if !session.authenticated() {
            return Err("Authentication failed".to_string());
        }

        let session_arc = Arc::new(session);
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(key, Arc::clone(&session_arc));

        Ok(session_arc)
    }

    /// Accept unknown host key (TOFU) — call after user confirms
    pub fn accept_host_key(&self, host: &SshHost) -> Result<(), String> {
        // We need to peek at the host key — connect, verify, and save
        let effective_host = host.effective_host();
        let port = host.port;
        let addr = format!("{}:{}", effective_host, port);

        let tcp = TcpStream::connect(&addr)
            .map_err(|e| format!("TCP connect to {}: {}", addr, e))?;
        let mut session = Session::new().map_err(|e| format!("SSH session create: {}", e))?;
        session.set_tcp_stream(tcp);
        session
            .handshake()
            .map_err(|e| format!("SSH handshake: {}", e))?;

        let (host_key_data, key_type_raw) = session
            .host_key()
            .ok_or_else(|| "Server did not send a host key".to_string())?;
        let key_type_str = key_type_name(key_type_raw);

        known_hosts::add_host_key(effective_host, port, key_type_str, host_key_data)
    }

    pub fn disconnect(&self, host_alias: &str, port: u16) -> Result<(), String> {
        let key = format!("{}:{}", host_alias, port);
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(&key) {
            let _ = session.disconnect(None, "bye", None);
        }
        Ok(())
    }

    pub fn get(&self, host_alias: &str, port: u16) -> Option<Arc<Session>> {
        let key = format!("{}:{}", host_alias, port);
        let sessions = self.sessions.lock().unwrap();
        sessions.get(&key).cloned()
    }
}

fn host_key(host: &SshHost) -> String {
    format!("{}:{}", host.alias, host.port)
}

/// Convert ssh2 HostKeyType to string
fn key_type_name(kt: ssh2::HostKeyType) -> &'static str {
    match kt {
        ssh2::HostKeyType::Rsa => "ssh-rsa",
        ssh2::HostKeyType::Dss => "ssh-dss",
        ssh2::HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
        ssh2::HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
        ssh2::HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
        ssh2::HostKeyType::Ed25519 => "ssh-ed25519",
        _ => "unknown",
    }
}

/// Simple SHA-256 for fingerprint display (matches ssh-keygen -l -E sha256)
fn sha256_fingerprint(data: &[u8]) -> Vec<u8> {
    // Minimal SHA-256 implementation for fingerprinting
    let mut h = sha256::Sha256::new();
    sha256::Hasher::update(&mut h, data);
    sha256::Hasher::finalize(h).to_vec()
}

// Minimal base64 encode (for fingerprints)
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | input[i + 2] as u32;
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        out.push(TABLE[(n & 0x3F) as usize] as char);
        i += 3;
    }
    if input.len() - i == 1 {
        let n = (input[i] as u32) << 16;
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push('=');
        out.push('=');
    } else if input.len() - i == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        out.push('=');
    }
    out
}

// --- Minimal SHA-256 (for host key fingerprints, avoids extra dependency) ---
mod sha256 {
    pub struct Sha256 {
        state: [u32; 8],
        block: [u8; 64],
        len: usize,
        total_len: u64,
    }

    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    impl Sha256 {
        pub fn new() -> Self {
            Self {
                state: [
                    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
                ],
                block: [0u8; 64],
                len: 0,
                total_len: 0,
            }
        }

        pub fn update(&mut self, data: &[u8]) {
            self.total_len += data.len() as u64;
            let mut data = data;
            if self.len > 0 {
                let take = (64 - self.len).min(data.len());
                self.block[self.len..self.len + take].copy_from_slice(&data[..take]);
                self.len += take;
                data = &data[take..];
                if self.len == 64 {
                    self.process_block();
                    self.len = 0;
                }
            }
            while data.len() >= 64 {
                self.block.copy_from_slice(&data[..64]);
                self.process_block();
                data = &data[64..];
            }
            if !data.is_empty() {
                self.block[..data.len()].copy_from_slice(data);
                self.len = data.len();
            }
        }

        pub fn finalize(mut self) -> [u8; 32] {
            let bit_len = self.total_len * 8;
            self.block[self.len] = 0x80;
            self.len += 1;
            if self.len > 56 {
                self.block[self.len..].fill(0);
                self.process_block();
                self.block.fill(0);
            } else {
                self.block[self.len..56].fill(0);
            }
            for (i, byte) in bit_len.to_be_bytes().iter().enumerate() {
                self.block[56 + i] = *byte;
            }
            self.process_block();
            let mut out = [0u8; 32];
            for (i, &w) in self.state.iter().enumerate() {
                out[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
            }
            out
        }

        fn process_block(&mut self) {
            let mut w = [0u32; 64];
            for i in 0..16 {
                w[i] = u32::from_be_bytes([
                    self.block[i * 4],
                    self.block[i * 4 + 1],
                    self.block[i * 4 + 2],
                    self.block[i * 4 + 3],
                ]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
            }
            let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
            for i in 0..64 {
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let ch = (e & f) ^ ((!e) & g);
                let temp1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let maj = (a & b) ^ (a & c) ^ (b & c);
                let temp2 = s0.wrapping_add(maj);
                h = g;
                g = f;
                f = e;
                e = d.wrapping_add(temp1);
                d = c;
                c = b;
                b = a;
                a = temp1.wrapping_add(temp2);
            }
            self.state[0] = self.state[0].wrapping_add(a);
            self.state[1] = self.state[1].wrapping_add(b);
            self.state[2] = self.state[2].wrapping_add(c);
            self.state[3] = self.state[3].wrapping_add(d);
            self.state[4] = self.state[4].wrapping_add(e);
            self.state[5] = self.state[5].wrapping_add(f);
            self.state[6] = self.state[6].wrapping_add(g);
            self.state[7] = self.state[7].wrapping_add(h);
        }
    }

    pub trait Hasher {
        fn update(&mut self, data: &[u8]);
        fn finalize(self) -> [u8; 32];
    }

    impl Hasher for Sha256 {
        fn update(&mut self, data: &[u8]) {
            Sha256::update(self, data);
        }
        fn finalize(self) -> [u8; 32] {
            Sha256::finalize(self)
        }
    }
}
