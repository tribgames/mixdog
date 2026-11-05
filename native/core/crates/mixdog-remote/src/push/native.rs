//! Native app push (APNs/FCM) registrations of paired clients, and their relay envelopes
//! (native-push-store.ts, remote-relay-native-push.ts). A row is bound to the paired client that
//! registered it over the encrypted channel, so unpairing that client removes it. The token is
//! only an address; the content is encrypted for `public_key`, whose private half stays on the
//! phone.

use std::path::PathBuf;

use mixdog_rt::InLane;
use mixdog_store::fsio::WriteLane;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::identity::secret::{SecretError, read_secret, write_secret};
use crate::identity::roster::is_controller_key;
use crate::leg::caps::{NativePlatform, RelayCaps};

pub const MAX_SUBSCRIPTIONS: usize = 32;
const MAX_TOKEN_CHARS: usize = 4096;
const FILE: &str = "remote-native-push.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePushSubscription {
    pub client_id: String,
    pub platform: String,
    pub token: String,
    pub public_key: String,
    /// APNs only: the token belongs to the sandbox environment.
    #[serde(default)]
    pub sandbox: bool,
    pub created_at: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum NativePushError {
    #[error("Native push needs a paired client.")]
    NoClient,
    #[error("Native push platform must be 'apns' or 'fcm'.")]
    Platform,
    #[error("Native push token is invalid.")]
    Token,
    #[error("Native push publicKey must be an uncompressed P-256 point (base64url).")]
    PublicKey,
    #[error("Native push sandbox must be a boolean.")]
    Sandbox,
    #[error("{0}")]
    Store(String),
}

impl From<SecretError> for NativePushError {
    fn from(error: SecretError) -> Self {
        Self::Store(error.to_string())
    }
}

fn valid_token(platform: &str, token: &str) -> bool {
    let token = mixdog_js::js_trim(token);
    let len = token.len();
    if len == 0 || len > MAX_TOKEN_CHARS {
        return false;
    }
    if platform == "apns" {
        (32..=400).contains(&len) && token.bytes().all(|b| b.is_ascii_hexdigit())
    } else {
        (32..=4096).contains(&len)
            && token.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-'))
    }
}

pub struct NativePushInput<'a> {
    pub client_id: &'a str,
    pub platform: &'a Value,
    pub token: &'a Value,
    pub public_key: &'a Value,
    pub sandbox: Option<&'a Value>,
}

pub struct NativePushStore {
    path: PathBuf,
    rows: Vec<NativePushSubscription>,
}

impl NativePushStore {
    /// A missing or damaged file is an empty store: tokens re-register on the phone's next launch.
    pub fn load<L: WriteLane>(lane: &InLane<L>, dir: &std::path::Path) -> Result<Self, SecretError> {
        let path = dir.join(FILE);
        let rows = read_secret(lane, &path)?
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|file| file.get("subscriptions").cloned())
            .and_then(|rows| serde_json::from_value::<Vec<NativePushSubscription>>(rows).ok())
            .map(|rows| {
                rows.into_iter()
                    .filter(|row| (row.platform == "apns" || row.platform == "fcm") && is_controller_key(&row.public_key))
                    .take(MAX_SUBSCRIPTIONS)
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self { path, rows })
    }

    pub fn list(&self) -> &[NativePushSubscription] {
        &self.rows
    }

    fn persist<L: WriteLane>(&self, lane: &InLane<L>, rows: &[NativePushSubscription]) -> Result<(), SecretError> {
        let text = serde_json::to_vec_pretty(&json!({ "version": 1, "subscriptions": rows })).unwrap_or_default();
        write_secret(lane, &self.path, &text)
    }

    /// One registration per paired client; a token moves to its latest owner. In-memory state is
    /// published only after the write succeeds.
    pub fn register<L: WriteLane>(
        &mut self,
        lane: &InLane<L>,
        input: &NativePushInput<'_>,
        now_ms: u64,
    ) -> Result<NativePushSubscription, NativePushError> {
        let client_id = mixdog_js::slice_utf16(input.client_id, 64);
        if client_id.is_empty() {
            return Err(NativePushError::NoClient);
        }
        let platform = match input.platform.as_str() {
            Some(p @ ("apns" | "fcm")) => p,
            _ => return Err(NativePushError::Platform),
        };
        let token = input.token.as_str().map(str::trim).filter(|t| valid_token(platform, t)).ok_or(NativePushError::Token)?;
        let public_key = input.public_key.as_str().filter(|k| is_controller_key(k)).ok_or(NativePushError::PublicKey)?;
        let sandbox = match input.sandbox {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => platform == "apns" && *flag,
            Some(_) => return Err(NativePushError::Sandbox),
        };
        let entry = NativePushSubscription {
            client_id: client_id.clone(),
            platform: platform.to_owned(),
            token: token.to_owned(),
            public_key: public_key.to_owned(),
            sandbox,
            created_at: now_ms,
        };
        let mut next: Vec<_> =
            self.rows.iter().filter(|row| row.client_id != client_id && row.token != entry.token).cloned().collect();
        next.push(entry.clone());
        if next.len() > MAX_SUBSCRIPTIONS {
            next.drain(..next.len() - MAX_SUBSCRIPTIONS);
        }
        self.persist(lane, &next)?;
        self.rows = next;
        Ok(entry)
    }

    fn drop_where<L: WriteLane>(
        &mut self,
        lane: &InLane<L>,
        drop: impl Fn(&NativePushSubscription) -> bool,
    ) -> Result<Vec<NativePushSubscription>, SecretError> {
        let (gone, kept): (Vec<_>, Vec<_>) = self.rows.iter().cloned().partition(|row| drop(row));
        if gone.is_empty() {
            return Ok(gone);
        }
        self.persist(lane, &kept)?;
        self.rows = kept;
        Ok(gone)
    }

    /// Removes the client's registration (or only the row holding `token`).
    pub fn remove<L: WriteLane>(
        &mut self,
        lane: &InLane<L>,
        client_id: &str,
        token: Option<&str>,
    ) -> Result<Vec<NativePushSubscription>, SecretError> {
        self.drop_where(lane, |row| row.client_id == client_id && token.is_none_or(|t| row.token == t))
    }

    /// Drops a token the relay reported invalid, whoever registered it.
    pub fn remove_token<L: WriteLane>(&mut self, lane: &InLane<L>, token: &str) -> Result<bool, SecretError> {
        Ok(!self.drop_where(lane, |row| row.token == token)?.is_empty())
    }

    pub fn remove_by_client<L: WriteLane>(&mut self, lane: &InLane<L>, client_id: &str) -> Result<bool, SecretError> {
        Ok(!self.remove(lane, client_id, None)?.is_empty())
    }
}

fn platform_of(name: &str) -> Option<NativePlatform> {
    match name {
        "apns" => Some(NativePlatform::Apns),
        "fcm" => Some(NativePlatform::Fcm),
        _ => None,
    }
}

/// The relay only sends to tokens this desktop bound to a paired client, so a bind precedes the
/// first send on every connection.
pub fn bind_envelope(row: &NativePushSubscription, caps: &RelayCaps) -> Option<Value> {
    caps.can_deliver_native(platform_of(&row.platform)?).then(|| {
        json!({ "type": "native-push-bind", "clientId": row.client_id, "platform": row.platform, "token": row.token })
    })
}

pub fn unbind_envelope(row: &NativePushSubscription) -> Value {
    json!({ "type": "native-push-unbind", "token": row.token, "clientId": row.client_id })
}

/// A message to one token, when the relay can deliver it right now. `message` keeps its own fields.
pub fn send_envelope(platform: &str, message: &Value, caps: &RelayCaps, connected: bool) -> Option<Value> {
    if !connected || !caps.can_deliver_native(platform_of(platform)?) {
        return None;
    }
    let mut envelope = message.clone();
    envelope.as_object_mut()?.insert("type".into(), json!("native-push"));
    Some(envelope)
}

/// The token a `native-push-result` reports dead (APNs 410 / FCM UNREGISTERED).
pub fn invalid_token_of(result: &Value) -> Option<&str> {
    (result.get("invalid") == Some(&Value::Bool(true))).then(|| result.get("token")?.as_str())?
}
