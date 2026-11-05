//! Credential documents and login payload handling of the key-issuing
//! compat providers (PW §5.14, §5.15). Field names are the stored ones
//! (`mimo-oauth.json`, `command-code-oauth.json`, `muse-code-oauth.json`,
//! `opencode-go-oauth.json`); unknown fields survive a rewrite through
//! [`crate::oauth::CredentialFile`], which owns the file I/O and locking.
//! Nothing here touches the disk, the network or a clock.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_protocol::{JsonObject, JsonValue};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use x25519_dalek::{PublicKey, StaticSecret};

/// A key longer than this, or with a character outside printable ASCII, is
/// not an API key.
const MAX_API_KEY_LEN: usize = 512;
const MAX_UID_LEN: usize = 128;
const MAX_BASE_URL_LEN: usize = 2048;

fn is_api_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= MAX_API_KEY_LEN && key.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Why a login payload or document is refused.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("payload too short")]
    TooShort,
    #[error("could not decrypt the authorization payload")]
    Undecryptable,
    #[error("authorization payload is not an object")]
    NotAnObject,
    #[error("authorization payload carried no API key")]
    NoKey,
    #[error("authorization payload carried a malformed API key")]
    MalformedKey,
    #[error("authorization payload carried a malformed account id")]
    MalformedUid,
    #[error("authorization payload carried a gateway URL outside the Xiaomi MiMo API hosts")]
    GatewayOutsideAllowlist,
}

// ---------------------------------------------------------------------------
// MiMo
// ---------------------------------------------------------------------------

pub const MIMO_DEFAULT_BASE_URL: &str = "https://api.xiaomimimo.com/v1";
pub const MIMO_PLATFORM_ORIGIN: &str = "https://platform.xiaomimimo.com";
/// Probe order for a Token Plan key that arrives without a gateway URL.
pub const MIMO_TOKEN_PLAN_BASE_URLS: [&str; 3] = [
    "https://token-plan-sgp.xiaomimimo.com/v1",
    "https://token-plan-ams.xiaomimimo.com/v1",
    "https://token-plan-cn.xiaomimimo.com/v1",
];
const MIMO_HOSTS: [&str; 4] = [
    "api.xiaomimimo.com",
    "token-plan-sgp.xiaomimimo.com",
    "token-plan-ams.xiaomimimo.com",
    "token-plan-cn.xiaomimimo.com",
];

/// `mimo-oauth.json`. The key never expires and has no refresh grant: a 401
/// means the user signs in again.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MimoCredentials {
    pub api_key: String,
    #[serde(default)]
    pub uid: String,
    #[serde(default)]
    pub base_url: String,
}

impl MimoCredentials {
    pub fn base_url(&self) -> &str {
        if self.base_url.is_empty() { MIMO_DEFAULT_BASE_URL } else { &self.base_url }
    }
}

/// A gateway URL from the authorization payload, held to the Xiaomi MiMo API
/// hosts: HTTPS, no credentials, default port, no query or fragment, a plain
/// path. Returned without a trailing slash.
pub fn normalize_mimo_base_url(value: &str) -> Result<String, CredentialError> {
    let reject = || CredentialError::GatewayOutsideAllowlist;
    if value.len() > MAX_BASE_URL_LEN {
        return Err(reject());
    }
    let url = Url::parse(value).map_err(|_| reject())?;
    let plain_path = url
        .path()
        .split('/')
        .skip(1)
        .all(|seg| seg.is_empty() || seg.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-')));
    let host_ok = url.host_str().is_some_and(|h| MIMO_HOSTS.contains(&h));
    if url.scheme() != "https"
        || !host_ok
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !plain_path
    {
        return Err(reject());
    }
    Ok(format!("{}{}", url.origin().ascii_serialization(), url.path().trim_end_matches('/')))
}

/// One login's key pair. The public half goes into the authorize URL; the
/// platform seals the minted key to it.
pub struct MimoLoginKey {
    secret: StaticSecret,
}

/// SPKI prefix of a raw 32-byte X25519 public key.
const X25519_SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00];

impl MimoLoginKey {
    pub fn generate() -> Self {
        Self::from_bytes(rand::random())
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self { secret: StaticSecret::from(bytes) }
    }

    /// The SPKI DER of the public key, base64url without padding.
    pub fn public_key_b64(&self) -> String {
        let public = PublicKey::from(&self.secret);
        let mut der = X25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(public.as_bytes());
        URL_SAFE_NO_PAD.encode(der)
    }

    /// Opens the `u` payload `ephemeralPub(32) | nonce(12) | ciphertext | tag(16)`:
    /// AES-256-GCM under the SHA-256 of the X25519 shared secret.
    pub fn open(&self, payload: &str) -> Result<MimoCredentials, CredentialError> {
        const EPHEMERAL: usize = 32;
        const NONCE: usize = 12;
        const TAG: usize = 16;
        let bytes = URL_SAFE_NO_PAD
            .decode(mixdog_js::js_trim(payload))
            .map_err(|_| CredentialError::Undecryptable)?;
        if bytes.len() <= EPHEMERAL + NONCE + TAG {
            return Err(CredentialError::TooShort);
        }
        let ephemeral: [u8; 32] = bytes[..EPHEMERAL].try_into().map_err(|_| CredentialError::TooShort)?;
        let shared = self.secret.diffie_hellman(&PublicKey::from(ephemeral));
        let key = Sha256::digest(shared.as_bytes());
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CredentialError::Undecryptable)?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&bytes[EPHEMERAL..EPHEMERAL + NONCE]), &bytes[EPHEMERAL + NONCE..])
            .map_err(|_| CredentialError::Undecryptable)?;
        let doc: JsonValue = serde_json::from_slice(&plain).map_err(|_| CredentialError::Undecryptable)?;
        let JsonValue::Object(doc) = doc else {
            return Err(CredentialError::NotAnObject);
        };
        mimo_credentials_from(&doc)
    }
}

fn mimo_credentials_from(doc: &JsonObject) -> Result<MimoCredentials, CredentialError> {
    let api_key = doc.get("sk").and_then(JsonValue::as_str).map(str::trim).unwrap_or_default();
    if api_key.is_empty() {
        return Err(CredentialError::NoKey);
    }
    if !is_api_key(api_key) {
        return Err(CredentialError::MalformedKey);
    }
    let uid = match doc.get("uid") {
        None | Some(JsonValue::Null) => String::new(),
        Some(JsonValue::String(s)) => s.clone(),
        Some(JsonValue::Number(n)) => n.to_string(),
        Some(_) => return Err(CredentialError::MalformedUid),
    };
    if uid.len() > MAX_UID_LEN || uid.chars().any(|c| c.is_control()) {
        return Err(CredentialError::MalformedUid);
    }
    let base_url = match doc.get("url") {
        None | Some(JsonValue::Null) => String::new(),
        Some(JsonValue::String(s)) if s.is_empty() => String::new(),
        Some(JsonValue::String(s)) => normalize_mimo_base_url(s)?,
        Some(_) => return Err(CredentialError::GatewayOutsideAllowlist),
    };
    Ok(MimoCredentials { api_key: api_key.to_owned(), uid, base_url })
}

/// A pasted value is the bare `u` code or the callback URL holding it.
pub fn mimo_code_from_input(input: &str) -> Option<String> {
    let text = mixdog_js::js_trim(input);
    if text.is_empty() {
        return None;
    }
    if text.starts_with("http://") || text.starts_with("https://") {
        return Url::parse(text)
            .ok()?
            .query_pairs()
            .find(|(k, _)| k == "u")
            .map(|(_, v)| v.into_owned());
    }
    Some(text.to_owned())
}

/// The platform's authorize URL for a login key, redirect and key name.
pub fn mimo_authorize_url(public_key_b64: &str, redirect_uri: &str, key_name: &str) -> String {
    let mut url = Url::parse(&format!("{MIMO_PLATFORM_ORIGIN}/authorize")).expect("a constant URL parses");
    url.query_pairs_mut()
        .append_pair("pk", public_key_b64)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("kn", "mimocode")
        .append_pair("key_name", key_name);
    url.into()
}

// ---------------------------------------------------------------------------
// Command Code, Muse Code, OpenCode Go
// ---------------------------------------------------------------------------

pub const COMMAND_CODE_API_ORIGIN: &str = "https://api.commandcode.ai";
pub const COMMAND_CODE_STUDIO_ORIGIN: &str = "https://commandcode.ai";

/// `command-code-oauth.json`: a Studio-issued key that never expires.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeCredentials {
    pub api_key: String,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub user_name: String,
}

impl CommandCodeCredentials {
    pub fn is_valid(&self) -> bool {
        is_api_key(&self.api_key)
    }
}

/// `muse-code-oauth.json`: usable only with both the device-grant access
/// token and the inference key it was exchanged for.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuseCodeCredentials {
    pub access_token: String,
    pub api_key: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

impl MuseCodeCredentials {
    pub fn is_valid(&self) -> bool {
        !self.access_token.is_empty() && is_api_key(&self.api_key)
    }
}

/// `opencode-go-oauth.json`. Unlike the keys above it refreshes: within
/// [`OPENCODE_REFRESH_SKEW_SECS`] of `expires_at` the refresh grant runs.
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct OpenCodeGoCredentials {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    /// Unix milliseconds; 0 when the grant states no expiry.
    #[serde(default)]
    pub expires_at: u64,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub org_name: Option<String>,
}

pub const OPENCODE_REFRESH_SKEW_SECS: u64 = 300;

impl OpenCodeGoCredentials {
    /// Whether the access token should be refreshed at `now_ms`.
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.expires_at > 0 && self.expires_at < now_ms + OPENCODE_REFRESH_SKEW_SECS * 1000
    }

    /// The request headers of an authenticated call: bearer plus the org.
    pub fn headers(&self) -> Vec<(String, String)> {
        let mut headers = vec![("authorization".to_owned(), format!("Bearer {}", self.access_token))];
        if let Some(org) = self.org_id.as_deref().filter(|o| !o.is_empty()) {
            headers.push(("x-org-id".to_owned(), org.to_owned()));
        }
        headers
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seals `doc` to `key` the way the platform does, for a fixed ephemeral key.
    fn seal(key: &MimoLoginKey, doc: &JsonValue) -> String {
        let ephemeral = StaticSecret::from([7u8; 32]);
        let shared = ephemeral.diffie_hellman(&PublicKey::from(&key.secret));
        let sym = Sha256::digest(shared.as_bytes());
        let cipher = Aes256Gcm::new_from_slice(&sym).unwrap();
        let nonce = [3u8; 12];
        let sealed = cipher.encrypt(Nonce::from_slice(&nonce), doc.to_string().as_bytes()).unwrap();
        let mut payload = PublicKey::from(&ephemeral).as_bytes().to_vec();
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&sealed);
        URL_SAFE_NO_PAD.encode(payload)
    }

    #[test]
    fn the_login_payload_opens_only_with_its_own_key() {
        let key = MimoLoginKey::from_bytes([1u8; 32]);
        let doc = serde_json::json!({"sk": "tp-abc123", "uid": 42, "url": "https://token-plan-sgp.xiaomimimo.com/v1/"});
        let payload = seal(&key, &doc);
        assert_eq!(
            key.open(&payload),
            Ok(MimoCredentials {
                api_key: "tp-abc123".into(),
                uid: "42".into(),
                base_url: "https://token-plan-sgp.xiaomimimo.com/v1".into(),
            })
        );
        assert_eq!(MimoLoginKey::from_bytes([2u8; 32]).open(&payload), Err(CredentialError::Undecryptable));
        assert_eq!(key.open("AAAA"), Err(CredentialError::TooShort));
    }

    #[test]
    fn a_payload_is_checked_after_it_opens() {
        let key = MimoLoginKey::from_bytes([1u8; 32]);
        let open = |doc: JsonValue| key.open(&seal(&key, &doc));
        assert_eq!(open(serde_json::json!({"uid": 1})), Err(CredentialError::NoKey));
        assert_eq!(open(serde_json::json!({"sk": "has space"})), Err(CredentialError::MalformedKey));
        assert_eq!(open(serde_json::json!({"sk": "k", "uid": ["x"]})), Err(CredentialError::MalformedUid));
        assert_eq!(
            open(serde_json::json!({"sk": "k", "url": "https://evil.example/v1"})),
            Err(CredentialError::GatewayOutsideAllowlist)
        );
        assert_eq!(open(serde_json::json!([1])), Err(CredentialError::NotAnObject));
    }

    #[test]
    fn gateway_urls_are_held_to_the_allowlist() {
        for ok in [
            "https://api.xiaomimimo.com/v1",
            "https://token-plan-cn.xiaomimimo.com/v1/",
            "https://api.xiaomimimo.com",
        ] {
            assert!(normalize_mimo_base_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://api.xiaomimimo.com/v1",
            "https://api.xiaomimimo.com:8443/v1",
            "https://u:p@api.xiaomimimo.com/v1",
            "https://api.xiaomimimo.com/v1?x=1",
            "https://api.xiaomimimo.com/v1#f",
            "https://api.xiaomimimo.com/a b",
            "https://xiaomimimo.com/v1",
        ] {
            assert!(normalize_mimo_base_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn authorize_url_and_pasted_input() {
        let url = mimo_authorize_url("PK", "http://localhost:5000/", "mimo-code-cli-key-ab");
        assert_eq!(
            url,
            "https://platform.xiaomimimo.com/authorize?pk=PK&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2F&kn=mimocode&key_name=mimo-code-cli-key-ab"
        );
        assert_eq!(mimo_code_from_input("  abc "), Some("abc".into()));
        assert_eq!(mimo_code_from_input("http://localhost:5000/?u=xyz"), Some("xyz".into()));
        assert_eq!(mimo_code_from_input("http://localhost:5000/"), None);
        assert!(MimoLoginKey::generate().public_key_b64().len() > 40);
    }

    #[test]
    fn documents_keep_the_stored_field_names_and_validity_rules() {
        let cc: CommandCodeCredentials = serde_json::from_str(r#"{"apiKey":"k","userId":"u","userName":"n"}"#).unwrap();
        assert!(cc.is_valid());
        let muse: MuseCodeCredentials = serde_json::from_str(r#"{"accessToken":"a","apiKey":"k"}"#).unwrap();
        assert!(muse.is_valid());
        assert!(!MuseCodeCredentials { access_token: String::new(), ..muse }.is_valid());
        let go: OpenCodeGoCredentials = serde_json::from_str(
            r#"{"access_token":"t","refresh_token":"r","expires_at":1000000,"org_id":"o"}"#,
        )
        .unwrap();
        assert!(!go.needs_refresh(600_000));
        assert!(go.needs_refresh(700_001), "within five minutes of expiry");
        assert!(!OpenCodeGoCredentials { expires_at: 0, ..go.clone() }.needs_refresh(u64::MAX / 2));
        assert_eq!(go.headers()[1], ("x-org-id".into(), "o".into()));
    }
}
