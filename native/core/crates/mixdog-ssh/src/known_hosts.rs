//! known_hosts reading: which keys the user's files (and the system-wide one) hold for a server, including hashed
//! entries, wildcard patterns and the @revoked / @cert-authority markers. Pure text in, entries out.

use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD, STANDARD_NO_PAD};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use hmac::{Hmac, Mac};
use regex::RegexBuilder;
use sha1::Sha1;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KnownHostMarker {
    None,
    Revoked,
    CertAuthority,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownHostEntry {
    pub marker: KnownHostMarker,
    /// The host field as written (patterns, or a |1|salt|hash).
    pub hosts: String,
    pub key_type: String,
    pub key: String,
}

impl KnownHostEntry {
    /// Does this entry cover `host` on `port`? (ssh writes a non-default port as `[host]:port`.)
    pub fn matches(&self, host: &str, port: u16) -> bool {
        host_field_matches(&self.hosts, &known_hosts_spec(host, port))
    }
}

/// `host` on port 22, `[host]:port` otherwise: how known_hosts names a server.
pub fn known_hosts_spec(host: &str, port: u16) -> String {
    if port == 22 { host.to_owned() } else { format!("[{host}]:{port}") }
}

/// Parses the text of a known_hosts file; comments, unknown `@` markers and malformed lines are skipped.
pub fn parse(text: &str) -> Vec<KnownHostEntry> {
    let mut entries = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields: Vec<&str> = line.split_whitespace().collect();
        let marker = match fields[0] {
            "@revoked" => KnownHostMarker::Revoked,
            "@cert-authority" => KnownHostMarker::CertAuthority,
            other if other.starts_with('@') => continue,
            _ => KnownHostMarker::None,
        };
        if marker != KnownHostMarker::None {
            fields.remove(0);
        }
        let [hosts, key_type, key, ..] = fields[..] else { continue };
        if !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')) {
            entries.push(KnownHostEntry {
                marker,
                hosts: hosts.to_owned(),
                key_type: key_type.to_owned(),
                key: key.to_owned(),
            });
        }
    }
    entries
}

fn wildcard_matches(pattern: &str, spec: &str) -> bool {
    let mut source = String::from("^");
    for c in pattern.chars() {
        match c {
            '*' => source.push_str(".*"),
            '?' => source.push('.'),
            other => source.push_str(&regex::escape(&other.to_string())),
        }
    }
    source.push('$');
    RegexBuilder::new(&source).case_insensitive(true).build().is_ok_and(|regex| regex.is_match(spec))
}

fn lenient_base64() -> GeneralPurpose {
    GeneralPurpose::new(&alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent))
}

fn pattern_matches(pattern: &str, spec: &str) -> bool {
    if pattern.starts_with("|1|") {
        let mut parts = pattern.split('|').skip(2);
        let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else { return false };
        if salt.is_empty() || hash.is_empty() {
            return false;
        }
        let Ok(salt) = lenient_base64().decode(salt) else { return false };
        let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(&salt) else { return false };
        mac.update(spec.as_bytes());
        return STANDARD.encode(mac.finalize().into_bytes()) == hash;
    }
    wildcard_matches(pattern, spec)
}

/// Does the known_hosts host field cover `spec` (`host` or `[host]:port`)? A `!pattern` that matches excludes the
/// whole line.
pub fn host_field_matches(field: &str, spec: &str) -> bool {
    let mut matched = false;
    for pattern in field.split(',') {
        if let Some(negated) = pattern.strip_prefix('!') {
            if pattern_matches(negated, spec) {
                return false;
            }
        } else if pattern_matches(pattern, spec) {
            matched = true;
        }
    }
    matched
}

/// The entries whose host field covers `spec`.
pub fn entries_for<'a>(entries: &'a [KnownHostEntry], spec: &str) -> Vec<&'a KnownHostEntry> {
    entries.iter().filter(|entry| host_field_matches(&entry.hosts, spec)).collect()
}

/// `SHA256:<unpadded base64>`, the form ssh and server panels print.
pub fn key_fingerprint(key_base64: &str) -> String {
    let bytes = lenient_base64().decode(key_base64).unwrap_or_default();
    format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(bytes)))
}
