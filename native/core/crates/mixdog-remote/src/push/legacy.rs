//! The PC-signed Web Push path the phone still uses while no relay key is known
//! (push-subscription-store.ts, web-push.ts, remote-push-methods.ts): this PC mints one VAPID
//! identity, keeps every browser that registered under it in `remote-push.json`, signs the
//! RFC 8292 header itself and posts the RFC 8291 body (push/web.rs) to the push service.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_js::{is_js_space, js_trim, slice_utf16};
use mixdog_rt::InLane;
use mixdog_store::fsio::WriteLane;
use p256::ecdsa::SigningKey;
use p256::ecdsa::signature::Signer;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::{Value, json};

use super::web::{WebPushError, WebPushTarget, encrypt_for_target};
use crate::identity::secret::{SecretError, read_secret, write_secret};

pub const MAX_SUBSCRIPTIONS: usize = 32;
const MAX_LABEL_CHARS: usize = 60;
const FILE: &str = "remote-push.json";
/// Twelve hours, inside the spec's 24-hour ceiling.
const VAPID_LIFETIME_SECONDS: u64 = 12 * 60 * 60;
const DEFAULT_TTL_SECONDS: u64 = 24 * 60 * 60;
pub const SEND_TIMEOUT_MS: u64 = 10_000;
/// RFC 8292 wants a contactable sender (push-notifier.ts `VAPID_SUBJECT`).
pub const VAPID_SUBJECT: &str = "mailto:support@mixdog.ai";

#[derive(Debug, thiserror::Error)]
pub enum LegacyPushError {
    /// A `TypeError` of the Node store: the sentence reaches the phone as is.
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Store(#[from] SecretError),
}

fn invalid<T>(message: &str) -> Result<T, LegacyPushError> {
    Err(LegacyPushError::Invalid(message.into()))
}

/// The sender identity: `publicKey` is the applicationServerKey a browser subscribes with and
/// `private_key_jwk` the stored JWK (kept as written so a Node-minted file survives).
#[derive(Clone, Debug, PartialEq)]
pub struct LegacyKeys {
    pub public_key: String,
    pub private_key_jwk: Value,
}

impl LegacyKeys {
    fn to_value(&self) -> Value {
        json!({ "publicKey": self.public_key, "privateKeyJwk": self.private_key_jwk })
    }

    fn of(value: &Value) -> Option<Self> {
        let public_key = value.get("publicKey")?.as_str()?.to_owned();
        Some(Self { public_key, private_key_jwk: value.get("privateKeyJwk").cloned().unwrap_or(Value::Null) })
    }

    /// `generateWebPushKeys()`.
    pub fn generate() -> Self {
        let secret = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let point = secret.public_key().to_encoded_point(false);
        let coordinate = |bytes: Option<&[u8]>| URL_SAFE_NO_PAD.encode(bytes.unwrap_or_default());
        Self {
            public_key: URL_SAFE_NO_PAD.encode(point.as_bytes()),
            private_key_jwk: json!({
                "kty": "EC",
                "crv": "P-256",
                "x": coordinate(point.x().map(|x| x.as_slice())),
                "y": coordinate(point.y().map(|y| y.as_slice())),
                "d": URL_SAFE_NO_PAD.encode(secret.to_bytes()),
            }),
        }
    }

    fn signing_key(&self) -> Result<SigningKey, WebPushError> {
        let d = self.private_key_jwk.get("d").and_then(Value::as_str).ok_or(WebPushError::Keys)?;
        let bytes = URL_SAFE_NO_PAD.decode(d).map_err(|_| WebPushError::Keys)?;
        SigningKey::from_slice(&bytes).map_err(|_| WebPushError::Keys)
    }
}

/// `Buffer.from(text, 'base64url')`: both alphabets, stops at `=`, skips anything else.
pub fn node_base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut width) = (0u32, 0u32);
    for c in text.chars() {
        let value = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        bits = (bits << 6) | value;
        width += 6;
        if width >= 8 {
            width -= 8;
            out.push((bits >> width) as u8);
            bits &= (1 << width) - 1;
        }
    }
    out
}

/// `sanitizeText`: collapse white space runs to one space, trim, clip.
fn sanitize_text(value: Option<&Value>, limit: usize) -> String {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    };
    let mut collapsed = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    slice_utf16(js_trim(&collapsed), limit)
}

/// `validEndpoint`: only an https URL without credentials.
fn valid_endpoint(value: &str) -> Result<String, LegacyPushError> {
    let Ok(url) = url::Url::parse(js_trim(value)) else { return invalid("Push endpoint must be an absolute URL.") };
    if url.scheme() != "https" {
        return invalid("Push endpoint must use https.");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return invalid("Push endpoint must not carry credentials.");
    }
    Ok(url.to_string())
}

fn valid_key_material(p256dh: &str, auth: &str) -> Result<(String, String), LegacyPushError> {
    let (public, secret) = (js_trim(p256dh), js_trim(auth));
    if node_base64_decode(public).len() != 65 {
        return invalid("Push subscription key must be a 65-byte P-256 point.");
    }
    if node_base64_decode(secret).len() != 16 {
        return invalid("Push subscription auth secret must be 16 bytes.");
    }
    Ok((public.to_owned(), secret.to_owned()))
}

/// `requiredString(value, name)`: a string, trimmed, non-empty, at most 32 768 units.
pub fn required_string(value: Option<&Value>, name: &str) -> Result<String, LegacyPushError> {
    let Some(Value::String(text)) = value else { return Err(LegacyPushError::Invalid(format!("{name} must be a string."))) };
    let text = js_trim(text);
    if text.is_empty() || mixdog_js::utf16_len(text) > 32_768 {
        return Err(LegacyPushError::Invalid(format!("{name} is invalid.")));
    }
    Ok(text.to_owned())
}

#[derive(Clone, Debug)]
struct FileShape {
    keys: Option<Value>,
    subscriptions: Vec<Value>,
}

impl FileShape {
    fn read(bytes: Option<Vec<u8>>) -> Self {
        // A corrupt file must not disable notifications forever; the next write replaces it.
        let empty = Self { keys: None, subscriptions: Vec::new() };
        let Some(parsed) = bytes.and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return empty };
        let keys = parsed.get("keys").filter(|k| k.get("publicKey").is_some_and(Value::is_string)).cloned();
        let subscriptions = parsed
            .get("subscriptions")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter(|row| row.get("endpoint").is_some_and(Value::is_string) && row.get("p256dh").is_some_and(Value::is_string))
                    .take(MAX_SUBSCRIPTIONS)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        Self { keys, subscriptions }
    }

    fn to_bytes(&self) -> Vec<u8> {
        let value = json!({ "version": 1, "keys": self.keys, "subscriptions": self.subscriptions });
        serde_json::to_vec_pretty(&value).unwrap_or_default()
    }
}

/// One browser registered with this PC's own VAPID key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacySubscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub client_id: String,
    pub label: String,
}

impl LegacySubscription {
    fn of(row: &Value) -> Option<Self> {
        let text = |name: &str| row.get(name).and_then(Value::as_str).unwrap_or_default().to_owned();
        Some(Self {
            endpoint: row.get("endpoint")?.as_str()?.to_owned(),
            p256dh: row.get("p256dh")?.as_str()?.to_owned(),
            auth: text("auth"),
            client_id: text("clientId"),
            label: text("label"),
        })
    }
}

/// `remote-push.json` under the user data directory. Every call reads and writes the file inside
/// the durability lane, so there is no cache to go stale.
pub struct LegacyPushStore {
    path: PathBuf,
}

impl LegacyPushStore {
    pub fn new(dir: &Path) -> Self {
        Self { path: dir.join(FILE) }
    }

    fn read<L: WriteLane>(&self, lane: &InLane<L>) -> Result<FileShape, SecretError> {
        Ok(FileShape::read(read_secret(lane, &self.path)?))
    }

    fn write<L: WriteLane>(&self, lane: &InLane<L>, shape: &FileShape) -> Result<(), SecretError> {
        write_secret(lane, &self.path, &shape.to_bytes())
    }

    /// The sender identity; minted and persisted on first ask.
    pub fn keys<L: WriteLane>(&self, lane: &InLane<L>) -> Result<LegacyKeys, SecretError> {
        let mut shape = self.read(lane)?;
        if let Some(keys) = shape.keys.as_ref().and_then(LegacyKeys::of) {
            return Ok(keys);
        }
        let keys = LegacyKeys::generate();
        shape.keys = Some(keys.to_value());
        self.write(lane, &shape)?;
        Ok(keys)
    }

    pub fn public_key<L: WriteLane>(&self, lane: &InLane<L>) -> Result<String, SecretError> {
        Ok(self.keys(lane)?.public_key)
    }

    pub fn list<L: WriteLane>(&self, lane: &InLane<L>) -> Result<Vec<LegacySubscription>, SecretError> {
        Ok(self.read(lane)?.subscriptions.iter().filter_map(LegacySubscription::of).collect())
    }

    /// `registerPushSubscription`: `input` is the one record the phone sent.
    pub fn register<L: WriteLane>(&self, lane: &InLane<L>, input: &Value, now_ms: u64) -> Result<LegacySubscription, LegacyPushError> {
        let record = if input.is_object() { input } else { &Value::Null };
        let endpoint = required_string(record.get("endpoint"), "endpoint")?;
        let p256dh = required_string(record.get("p256dh"), "p256dh")?;
        let auth = required_string(record.get("auth"), "auth")?;
        let endpoint = valid_endpoint(&endpoint)?;
        let (p256dh, auth) = valid_key_material(&p256dh, &auth)?;
        self.keys(lane)?;
        let mut shape = self.read(lane)?;
        let client_id = match record.get("clientId") {
            Some(Value::String(id)) => sanitize_text(Some(&Value::String(id.clone())), 64),
            _ => String::new(),
        };
        let label = match record.get("label") {
            Some(Value::String(label)) => sanitize_text(Some(&Value::String(label.clone())), MAX_LABEL_CHARS),
            _ => String::new(),
        };
        let entry = json!({
            "endpoint": endpoint, "p256dh": p256dh, "auth": auth,
            "clientId": client_id, "label": label, "createdAt": now_ms,
        });
        // Re-subscribing replaces the old row: a browser may rotate its endpoint at any time.
        let mut rows: Vec<Value> = shape
            .subscriptions
            .into_iter()
            .filter(|row| {
                row.get("endpoint").and_then(Value::as_str) != Some(endpoint.as_str())
                    && !(!client_id.is_empty() && row.get("clientId").and_then(Value::as_str) == Some(client_id.as_str()))
            })
            .collect();
        rows.push(entry.clone());
        let overflow = rows.len().saturating_sub(MAX_SUBSCRIPTIONS);
        shape.subscriptions = rows.split_off(overflow);
        self.write(lane, &shape)?;
        LegacySubscription::of(&entry).ok_or_else(|| LegacyPushError::Invalid("Push subscription is invalid.".into()))
    }

    fn drop_where<L: WriteLane>(&self, lane: &InLane<L>, drop: impl Fn(&Value) -> bool) -> Result<bool, SecretError> {
        let mut shape = self.read(lane)?;
        let before = shape.subscriptions.len();
        shape.subscriptions.retain(|row| !drop(row));
        if shape.subscriptions.len() == before {
            return Ok(false);
        }
        self.write(lane, &shape)?;
        Ok(true)
    }

    pub fn remove<L: WriteLane>(&self, lane: &InLane<L>, endpoint: &str) -> Result<bool, SecretError> {
        self.drop_where(lane, |row| row.get("endpoint").and_then(Value::as_str) == Some(endpoint))
    }

    /// Revoking a browser's access must also stop its notifications.
    pub fn remove_by_client<L: WriteLane>(&self, lane: &InLane<L>, client_id: &str) -> Result<bool, SecretError> {
        let id = sanitize_text(Some(&Value::String(client_id.to_owned())), 64);
        if id.is_empty() {
            return Ok(false);
        }
        self.drop_where(lane, |row| row.get("clientId").and_then(Value::as_str) == Some(id.as_str()))
    }
}

/// The `Authorization` header proving this PC owns the key the browser subscribed with: scoped
/// to the push service's origin and short-lived (`vapidAuthorizationHeader`).
pub fn vapid_authorization_header(endpoint: &str, keys: &LegacyKeys, subject: &str, now_ms: u64) -> Result<String, WebPushError> {
    let audience = url::Url::parse(endpoint).map_err(|_| WebPushError::Keys)?.origin().ascii_serialization();
    let issued_at = now_ms / 1000;
    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let payload = URL_SAFE_NO_PAD.encode(mixdog_js::json_stringify(&json!({
        "aud": audience, "exp": issued_at + VAPID_LIFETIME_SECONDS, "sub": subject,
    })));
    let signing_input = format!("{header}.{payload}");
    // JWS wants the raw r||s pair.
    let signature: p256::ecdsa::Signature = keys.signing_key()?.sign(signing_input.as_bytes());
    Ok(format!("vapid t={signing_input}.{}, k={}", URL_SAFE_NO_PAD.encode(signature.to_bytes()), keys.public_key))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebPushSendResult {
    pub status_code: u16,
    /// 404/410: the browser dropped this subscription for good.
    pub expired: bool,
    pub error: Option<String>,
}

/// One POST to a push service; the transport is injectable for tests.
#[async_trait]
pub trait PushPoster: Send + Sync {
    async fn post(&self, endpoint: &str, headers: &[(&str, String)], body: Vec<u8>) -> Result<u16, String>;
}

fn failed(error: impl ToString) -> WebPushSendResult {
    WebPushSendResult { status_code: 0, expired: false, error: Some(error.to_string()) }
}

/// `sendWebPush`: network and protocol failures both resolve, so an unreachable phone never
/// breaks the turn that triggered the notification.
pub async fn send_web_push(
    poster: &dyn PushPoster,
    subscription: &LegacySubscription,
    payload: &str,
    keys: &LegacyKeys,
    now_ms: u64,
) -> WebPushSendResult {
    let normalized = |text: &str| URL_SAFE_NO_PAD.encode(node_base64_decode(text));
    let target = WebPushTarget {
        endpoint: subscription.endpoint.clone(),
        client_id: subscription.client_id.clone(),
        p256dh: normalized(&subscription.p256dh),
        auth: normalized(&subscription.auth),
    };
    let body = match encrypt_for_target(&target, payload.as_bytes()) {
        Ok(body) => body,
        Err(WebPushError::Keys) => return failed("Web Push subscription key is not an uncompressed P-256 point."),
        Err(other) => return failed(other),
    };
    let authorization = match vapid_authorization_header(&subscription.endpoint, keys, VAPID_SUBJECT, now_ms) {
        Ok(header) => header,
        Err(error) => return failed(error),
    };
    let headers = [
        ("Authorization", authorization),
        ("Content-Encoding", "aes128gcm".to_owned()),
        ("Content-Type", "application/octet-stream".to_owned()),
        ("TTL", DEFAULT_TTL_SECONDS.to_string()),
        ("Urgency", "high".to_owned()),
    ];
    match poster.post(&subscription.endpoint, &headers, body).await {
        Ok(status) => WebPushSendResult { status_code: status, expired: status == 404 || status == 410, error: None },
        Err(error) => failed(error),
    }
}

/// The production transport: a 10-second POST.
pub struct ReqwestPoster(reqwest::Client);

impl ReqwestPoster {
    pub fn new() -> Self {
        Self(reqwest::Client::builder().timeout(std::time::Duration::from_millis(SEND_TIMEOUT_MS)).build().unwrap_or_default())
    }
}

impl Default for ReqwestPoster {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl PushPoster for ReqwestPoster {
    async fn post(&self, endpoint: &str, headers: &[(&str, String)], body: Vec<u8>) -> Result<u16, String> {
        let mut request = self.0.post(endpoint).body(body);
        for (name, value) in headers {
            request = request.header(*name, value);
        }
        request.send().await.map(|response| response.status().as_u16()).map_err(|error| error.to_string())
    }
}
