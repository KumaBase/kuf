use std::fs;
use std::path::PathBuf;

/// Parsed entry from a known_hosts file (hashed or plain).
struct KnownHost {
    /// hostname or `[host]:port` pattern (plain-text entries only)
    host_pattern: String,
    /// key type marker, e.g. "ssh-ed25519", "ssh-rsa"
    key_type: String,
    /// base64-encoded public key data
    key_data: Vec<u8>,
}

/// Parse `~/.ssh/known_hosts` and return entries that match `host:port`.
fn load_known_hosts() -> Result<Vec<KnownHost>, String> {
    let path = known_hosts_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("read known_hosts: {}", e))?;
    let mut entries = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Format: [host_pattern,...] key_type base64_key
        // or: @cert-authority host_pattern key_type base64_key
        // or: @revoked host_pattern key_type base64_key
        // Skip markers for now
        let rest = if line.starts_with("@") {
            // skip marker and the following token
            match line.splitn(3, ' ').nth(2) {
                Some(r) => r,
                None => continue,
            }
        } else {
            line
        };
        let parts: Vec<&str> = rest.splitn(3, ' ').collect();
        if parts.len() < 3 {
            continue;
        }
        let host_pattern = parts[0].to_string();
        let key_type = parts[1].to_string();
        let key_data = match base64_decode(parts[2]) {
            Ok(d) => d,
            Err(_) => continue,
        };
        entries.push(KnownHost {
            host_pattern,
            key_type,
            key_data,
        });
    }
    Ok(entries)
}

/// Check if a host pattern matches the given host and port.
fn host_matches(pattern: &str, host: &str, port: u16) -> bool {
    // Plain hostname or comma-separated list
    // Pattern can be: "host", "[host]:port", or "host1,host2"
    for pat in pattern.split(',') {
        let pat = pat.trim();
        if pat.starts_with('|') {
            // Hashed entry — we can't match without hmac, skip
            continue;
        }
        // Check [host]:port format
        if pat.starts_with('[') && pat.contains("]:") {
            // [host]:port
            if let Some(bracket_end) = pat.find("]:") {
                let pat_host = &pat[1..bracket_end];
                let pat_port_str = &pat[bracket_end + 2..];
                let pat_port: u16 = match pat_port_str.parse() {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                if pat_host == host && pat_port == port {
                    return true;
                }
            }
            continue;
        }
        // Plain hostname — only matches port 22 (OpenSSH convention:
        // plain hostname in known_hosts implies port 22)
        if pat == host && port == 22 {
            return true;
        }
    }
    false
}

/// Verify the server's host key against known_hosts.
///
/// Returns:
/// - `Ok(true)` — key found and matches
/// - `Ok(false)` — key NOT found in known_hosts (first connection)
/// - `Err(...)` — key found but DOES NOT match (MITM or re-provisioned server)
pub fn verify_host_key(
    host: &str,
    port: u16,
    key_type: &str,
    key_data: &[u8],
) -> Result<bool, String> {
    let entries = load_known_hosts()?;
    for entry in &entries {
        if host_matches(&entry.host_pattern, host, port) {
            if entry.key_type == key_type && entry.key_data == key_data {
                return Ok(true);
            }
            // Key type or data mismatch — potential MITM
            return Err(format!(
                "HOST KEY MISMATCH for {}:{} — possible man-in-the-middle attack! \
                 Remove the old entry from ~/.ssh/known_hosts if this is expected.",
                host, port
            ));
        }
    }
    // Not found — first connection
    Ok(false)
}

/// Add a host key to known_hosts (TOFU — Trust On First Use).
pub fn add_host_key(host: &str, port: u16, key_type: &str, key_data: &[u8]) -> Result<(), String> {
    let path = known_hosts_path()?;
    // Ensure ~/.ssh exists
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create ~/.ssh dir: {}", e))?;
        }
    }
    let host_pattern = if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    };
    let line = format!("{} {} {}\n", host_pattern, key_type, base64_encode(key_data));
    fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()))
        .map_err(|e| format!("write known_hosts: {}", e))
}

/// Get the path to ~/.ssh/known_hosts
pub fn known_hosts_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|p| p.join(".ssh").join("known_hosts"))
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

// --- Minimal base64 (no external crate needed) ---

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let input = input.trim_end_matches('=');
    let mut buf = Vec::with_capacity(input.len() * 3 / 4);
    let mut accum: u64 = 0;
    let mut bits = 0u32;
    for ch in input.bytes() {
        let val = if (b'A'..=b'Z').contains(&ch) {
            ch - b'A'
        } else if (b'a'..=b'z').contains(&ch) {
            ch - b'a' + 26
        } else if (b'0'..=b'9').contains(&ch) {
            ch - b'0' + 52
        } else if ch == b'+' {
            62
        } else if ch == b'/' {
            63
        } else {
            return Err(format!("Invalid base64 char: {}", ch as char));
        };
        accum = (accum << 6) | val as u64;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push((accum >> bits) as u8);
        }
    }
    Ok(buf)
}

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
