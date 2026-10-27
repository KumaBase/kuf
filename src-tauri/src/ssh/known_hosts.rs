use hmac::{Hmac, Mac};
use russh_keys::ssh_key::{
    known_hosts::{HostPatterns, KnownHosts, Marker},
    PublicKey,
};
use sha1::Sha1;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn pattern_matches(pattern: &str, value: &str) -> bool {
    let p = pattern.as_bytes();
    let s = value.as_bytes();
    let (mut i, mut j, mut star, mut backtrack) = (0, 0, None, 0);
    while j < s.len() {
        if i < p.len() && (p[i] == b'?' || p[i].eq_ignore_ascii_case(&s[j])) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            backtrack = j;
        } else if let Some(k) = star {
            backtrack += 1;
            j = backtrack;
            i = k + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}

fn host_matches(patterns: &HostPatterns, host: &str) -> Result<bool, String> {
    match patterns {
        HostPatterns::HashedName { salt, hash } => {
            let mut mac = Hmac::<Sha1>::new_from_slice(salt)
                .map_err(|_| "Invalid known_hosts hash".to_string())?;
            mac.update(host.as_bytes());
            Ok(mac.verify_slice(hash).is_ok())
        }
        HostPatterns::Patterns(patterns) => {
            let mut matched = false;
            for pattern in patterns {
                if let Some(negative) = pattern.strip_prefix('!') {
                    if pattern_matches(negative, host) {
                        return Ok(false);
                    }
                } else if pattern_matches(pattern, host) {
                    matched = true;
                }
            }
            Ok(matched)
        }
    }
}

pub fn known_hosts_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|p| p.join(".ssh").join("known_hosts"))
        .ok_or_else(|| "Cannot determine home directory".to_string())
}

fn host_token(host: &str, port: u16) -> Result<String, String> {
    if host.is_empty()
        || host
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || ",*!?|[]".contains(c))
    {
        return Err("Invalid SSH host name".into());
    }
    Ok(if port == 22 {
        host.to_lowercase()
    } else {
        format!("[{}]:{}", host.to_lowercase(), port)
    })
}

pub fn verify(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<bool, String> {
    let token = host_token(host, port)?;
    let content = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("Cannot read known_hosts: {e}")),
    };
    // The upstream parser accepts spaces as separators. Normalize tabs only in the fields.
    let normalized = content
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n");
    let mut found = false;
    let mut matched = false;
    let mut ca_found = false;
    for entry in KnownHosts::new(&normalized) {
        let entry = entry.map_err(|e| format!("Cannot safely parse known_hosts: {e}"))?;
        if !host_matches(entry.host_patterns(), &token)? {
            continue;
        }
        match entry.marker() {
            Some(Marker::Revoked) if entry.public_key().key_data() == key.key_data() => {
                return Err("Server host key is revoked".into())
            }
            Some(Marker::Revoked) => {}
            Some(Marker::CertAuthority) => {
                ca_found = true;
            }
            None => {
                found = true;
                if entry.public_key().key_data() == key.key_data() {
                    matched = true;
                }
            }
        }
    }
    if matched {
        Ok(true)
    } else if found {
        Err(format!(
            "HOST KEY MISMATCH for {host}:{port}; check ~/.ssh/known_hosts"
        ))
    } else if ca_found {
        Err("Host certificate authorities are not supported by kuf".into())
    } else {
        Ok(false)
    }
}

pub(super) fn add_at(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<(), String> {
    host_token(host, port)?;
    if verify(path, host, port, key)? {
        return Ok(());
    }
    russh_keys::known_hosts::learn_known_hosts_path(host, port, key, path)
        .map_err(|e| format!("Cannot save host key: {e}"))?;
    if !verify(path, host, port, key)? {
        return Err("Cannot verify saved host key".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";

    #[test]
    fn known_host_matching_and_rejection() {
        let dir = std::env::temp_dir().join(format!("kuf-known-hosts-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts");
        let a = russh_keys::parse_public_key_base64(A).unwrap();
        let b = russh_keys::parse_public_key_base64(B).unwrap();
        assert!(!verify(&path, "host.example", 22, &a).unwrap());
        add_at(&path, "host.example", 22, &a).unwrap();
        assert!(verify(&path, "host.example", 22, &a).unwrap());
        assert!(verify(&path, "host.example", 22, &b).is_err());
        assert!(add_at(&path, "host.example", 22, &b).is_err());
        fs::write(
            &path,
            format!("host.example ssh-ed25519 {B}\n  host.example\tssh-ed25519  {A} comment\n"),
        )
        .unwrap();
        assert!(verify(&path, "host.example", 22, &a).unwrap());
        assert!(verify(&path, "host.example", 23, &a).is_ok_and(|v| !v));
        fs::write(&path, format!("host.example ssh-ed25519 {B}\n")).unwrap();
        assert!(verify(&path, "host.example", 22, &a).is_err());
        fs::write(
            &path,
            format!("host.example ssh-ed25519 {A}\n@revoked host.example ssh-ed25519 {A}\n"),
        )
        .unwrap();
        assert!(verify(&path, "host.example", 22, &a).is_err());
        fs::write(
            &path,
            format!(
                "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 {B}\n"
            ),
        )
        .unwrap();
        assert!(verify(&path, "example.com", 22, &b).unwrap());
        fs::write(&path, format!("*.example,!bad.example ssh-ed25519 {A}\n")).unwrap();
        assert!(verify(&path, "ok.example", 22, &a).unwrap());
        assert!(!verify(&path, "bad.example", 22, &a).unwrap());
        fs::write(
            &path,
            format!("@cert-authority *.example ssh-ed25519 {B}\nhost.example ssh-ed25519 {A}\n"),
        )
        .unwrap();
        assert!(verify(&path, "host.example", 22, &a).unwrap());
        assert!(verify(&path, "other.example", 22, &a).is_err());
        fs::write(&path, "invalid\n").unwrap();
        assert!(verify(&path, "host.example", 22, &a).is_err());
        assert!(verify(&path, "bad\nentry", 22, &a).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
