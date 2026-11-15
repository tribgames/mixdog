//! Time-limited TURN credentials for the coturn instance that runs beside the relay (`lib/turn-credentials.mjs`). coturn runs
//! with `use-auth-secret`, which accepts
//!
//! ```text
//! username   = "<expiry unix seconds>:<user id>"
//! credential = base64(HMAC-SHA1(shared secret, username))
//! ```
//!
//! (draft-uberti-behave-turn-rest-00 section 2.2 and 4.2). The secret exists only on the relay host: coturn reads it from its
//! config, the relay from its environment. A credential cannot be forged without it and coturn rejects it once the expiry has
//! passed, so there is nothing to revoke and nothing to store.

use std::collections::BTreeMap;
use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::Sha256;

/// coturn's `listening-port` default: UDP and TCP.
pub const TURN_DEFAULT_PORT: u16 = 3478;
/// coturn's `tls-listening-port` default.
pub const TURN_DEFAULT_TLS_PORT: u16 = 5349;
/// draft-uberti-behave-turn-rest-00 section 2.2: one day (86400 seconds) is recommended.
pub const TURN_CREDENTIAL_TTL_SECONDS: i64 = 86_400;
/// RFC 2104 section 3: keys shorter than the hash output length (20 bytes for SHA-1) are strongly discouraged.
pub const TURN_SECRET_MIN_BYTES: usize = 20;

/// Why the TURN settings are unusable: the text the relay logs after `TURN credential issuance disabled:`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnConfigError(pub String);

impl fmt::Display for TurnConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TurnConfigError {}

/// The TURN settings of a deployment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnConfig {
    pub secret: String,
    pub host: String,
    pub port: u16,
    /// 0 when the deploy offers no TLS port.
    pub tls_port: u16,
    pub ttl_seconds: i64,
    pub issue_limit: u64,
}

/// A credential for one user id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedCredential {
    pub username: String,
    pub credential: String,
    pub expires_at: i64,
    pub ttl_seconds: i64,
    pub remaining_ms: i64,
}

fn hmac_sha1(secret: &str, data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hmac_sha256(secret: &str, data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// The TURN password for `username`: the value coturn recomputes.
pub fn turn_password(secret: &str, username: &str) -> String {
    STANDARD.encode(hmac_sha1(secret, username))
}

/// The user id part of a username: stable per device, so coturn's per-user quota and log lines tell devices apart, and opaque,
/// so the device's routing id never travels in a STUN message. The full HMAC-SHA-256 digest (64 hex characters).
pub fn turn_user_id(secret: &str, device_id: &str) -> String {
    hmac_sha256(secret, &format!("turn-user\0{device_id}")).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A credential for `user_id` that stops working `ttl_seconds` after `now_ms`. The expiry is a whole second, `floor(now) + ttl`,
/// so the credential really lives `remaining_ms`: up to 999 ms less than `ttl_seconds`.
pub fn issue_turn_credential(secret: &str, user_id: &str, now_ms: i64, ttl_seconds: i64) -> IssuedCredential {
    let expires_at = now_ms.div_euclid(1000) + ttl_seconds;
    let username = format!("{expires_at}:{user_id}");
    IssuedCredential {
        credential: turn_password(secret, &username),
        username,
        expires_at,
        ttl_seconds,
        remaining_ms: expires_at * 1000 - now_ms,
    }
}

/// What coturn decides for a long-term credential under `use-auth-secret`: the expiry is still ahead and the password is the
/// HMAC of the username. A username or credential that is not text is refused.
pub fn verify_turn_credential(secret: &str, username: Option<&str>, credential: Option<&str>, now_ms: i64) -> bool {
    let (Some(username), Some(credential)) = (username, credential) else { return false };
    let Some((digits, rest)) = username.split_once(':') else { return false };
    let line_end = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || rest.is_empty() || rest.contains(line_end) {
        return false;
    }
    if mixdog_js::string_to_number(digits) <= now_ms.div_euclid(1000) as f64 {
        return false;
    }
    let expected = turn_password(secret, username);
    ring::constant_time::verify_slices_are_equal(expected.as_bytes(), credential.as_bytes()).is_ok()
}

/// `Number(value)` as a port, 1 to 65535.
fn parse_port(value: Option<&String>, fallback: u16, name: &str) -> Result<u16, TurnConfigError> {
    let Some(text) = value.filter(|v| !v.is_empty()) else { return Ok(fallback) };
    let port = mixdog_js::string_to_number(text);
    if port.is_finite() && port.fract() == 0.0 && (1.0..=65_535.0).contains(&port) {
        return Ok(port as u16);
    }
    Err(TurnConfigError(format!("{name} must be a port number.")))
}

fn is_host(host: &str) -> bool {
    let bytes = host.as_bytes();
    let (Some(first), Some(last)) = (bytes.first(), bytes.last()) else { return false };
    first.is_ascii_alphanumeric() && last.is_ascii_alphanumeric() && bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
}

/// TURN settings from the environment the deploy writes (`/etc/mixdog-relay/turn.env`): `TURN_AUTH_SECRET`, `TURN_HOST`,
/// `TURN_PORT` (default 3478), `TURN_TLS_PORT` (absent: no `turns:` URL), `TURN_ISSUE_LIMIT` (credential requests one device may
/// make per credential lifetime: no default, issuance stays off without it). `Ok(None)` when neither secret nor host is set
/// (TURN not provisioned); an error when the settings are present but unusable.
pub fn turn_config_from_env(env: &BTreeMap<String, String>) -> Result<Option<TurnConfig>, TurnConfigError> {
    let text = |name: &str| env.get(name).map_or("", String::as_str);
    let (secret, host) = (text("TURN_AUTH_SECRET"), text("TURN_HOST"));
    if secret.is_empty() && host.is_empty() {
        return Ok(None);
    }
    if secret.is_empty() || host.is_empty() {
        return Err(TurnConfigError("TURN needs both TURN_AUTH_SECRET and TURN_HOST.".into()));
    }
    let limit_text = text("TURN_ISSUE_LIMIT");
    let limit = mixdog_js::string_to_number(limit_text);
    let limit_ok = !limit_text.is_empty() && limit_text.bytes().all(|b| b.is_ascii_digit()) && (1.0..=9_007_199_254_740_991.0).contains(&limit);
    if !limit_ok {
        return Err(TurnConfigError("TURN_ISSUE_LIMIT must be a positive whole number.".into()));
    }
    if secret.len() < TURN_SECRET_MIN_BYTES {
        return Err(TurnConfigError(format!("TURN_AUTH_SECRET must be at least {TURN_SECRET_MIN_BYTES} bytes.")));
    }
    if !is_host(host) {
        return Err(TurnConfigError("TURN_HOST must be a host name or IPv4 address.".into()));
    }
    Ok(Some(TurnConfig {
        secret: secret.to_owned(),
        host: host.to_owned(),
        port: parse_port(env.get("TURN_PORT"), TURN_DEFAULT_PORT, "TURN_PORT")?,
        tls_port: parse_port(env.get("TURN_TLS_PORT"), 0, "TURN_TLS_PORT")?,
        ttl_seconds: TURN_CREDENTIAL_TTL_SECONDS,
        issue_limit: limit as u64,
    }))
}

/// The unauthenticated STUN URL coturn answers on the same port as TURN.
pub fn stun_urls(config: &TurnConfig) -> Vec<String> {
    vec![format!("stun:{}:{}", config.host, config.port)]
}

/// `turn:` URLs for each transport the deploy provisioned (RFC 7064/7065).
pub fn turn_urls(config: &TurnConfig) -> Vec<String> {
    let mut urls = vec![
        format!("turn:{}:{}?transport=udp", config.host, config.port),
        format!("turn:{}:{}?transport=tcp", config.host, config.port),
    ];
    if config.tls_port != 0 {
        urls.push(format!("turns:{}:{}?transport=tcp", config.host, config.tls_port));
    }
    urls
}

/// The list a WebRTC peer connection takes as `iceServers`, keys in the order the relay writes them.
pub fn ice_servers_for(config: &TurnConfig, issued: &IssuedCredential) -> Value {
    json!([
        { "urls": stun_urls(config) },
        { "urls": turn_urls(config), "username": issued.username, "credential": issued.credential },
    ])
}
