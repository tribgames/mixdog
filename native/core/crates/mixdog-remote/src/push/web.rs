//! Relay-owned Web Push, desktop side (remote-relay-web-push.ts). The relay owns the one VAPID
//! identity every PC delivers through. For each browser that registered this PC the relay hands
//! over `{endpoint, clientId, sealed}`; `sealed` is the browser's p256dh/auth sealed to this
//! desktop's E2EE identity, opened only here. The payload is encrypted for the subscription
//! (RFC 8291) on this machine, and the relay — which signs VAPID and posts — carries ciphertext
//! only. There is no direct send to a push service.

use std::collections::{HashMap, HashSet};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use p256::PublicKey;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::{Value, json};
use sha2::Sha256;

use crate::e2ee::{SealedBox, ServerIdentity, WebPushKeys, open_web_push_keys};

pub const MAX_TARGETS: usize = 64;
const RECORD_SIZE: u32 = 4096;
const AES_TAG_BYTES: usize = 16;
const HEADER_BYTES: usize = 16 + 4 + 1 + 65;
/// Leaves room for the padding delimiter and the GCM tag inside one record.
pub const MAX_WEB_PUSH_PAYLOAD_BYTES: usize = RECORD_SIZE as usize - HEADER_BYTES - AES_TAG_BYTES - 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebPushTarget {
    pub endpoint: String,
    /// The paired browser credential the association was made with.
    pub client_id: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WebPushError {
    #[error("Web Push payload exceeds {MAX_WEB_PUSH_PAYLOAD_BYTES} bytes.")]
    TooLarge,
    #[error("Web Push subscription keys are invalid.")]
    Keys,
}

fn hkdf(salt: &[u8], ikm: &[u8], info: &[u8], out: &mut [u8]) {
    // `expand` fails only for an output longer than 255 hash blocks.
    let _ = Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, out);
}

/// RFC 8291 §3.4 single-record `aes128gcm` body. The salt and ephemeral key are injectable so a
/// test reproduces a vector instead of asserting on randomness.
pub fn encrypt_web_push_payload(
    keys: &WebPushKeys,
    plaintext: &[u8],
    salt: [u8; 16],
    local: &p256::SecretKey,
) -> Result<Vec<u8>, WebPushError> {
    if plaintext.len() > MAX_WEB_PUSH_PAYLOAD_BYTES {
        return Err(WebPushError::TooLarge);
    }
    let ua_raw = URL_SAFE_NO_PAD.decode(&keys.p256dh).map_err(|_| WebPushError::Keys)?;
    let auth = URL_SAFE_NO_PAD.decode(&keys.auth).map_err(|_| WebPushError::Keys)?;
    let ua_public = PublicKey::from_sec1_bytes(&ua_raw).map_err(|_| WebPushError::Keys)?;
    let local_raw = local.public_key().to_encoded_point(false);
    let shared = diffie_hellman(local.to_nonzero_scalar(), ua_public.as_affine());
    // The derivation is bound to BOTH public keys, so a payload for one subscription cannot be
    // replayed against another.
    let mut info = b"WebPush: info\0".to_vec();
    info.extend_from_slice(&ua_raw);
    info.extend_from_slice(local_raw.as_bytes());
    let mut ikm = [0u8; 32];
    hkdf(&auth, shared.raw_secret_bytes(), &info, &mut ikm);
    let mut content_key = [0u8; 16];
    hkdf(&salt, &ikm, b"Content-Encoding: aes128gcm\0", &mut content_key);
    let mut nonce = [0u8; 12];
    hkdf(&salt, &ikm, b"Content-Encoding: nonce\0", &mut nonce);
    // 0x02 ends the padding of the LAST record; a lone record is always the last.
    let mut record = plaintext.to_vec();
    record.push(0x02);
    let sealed = Aes128Gcm::new((&content_key).into())
        .encrypt(Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| WebPushError::Keys)?;
    let mut body = Vec::with_capacity(HEADER_BYTES + sealed.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(local_raw.as_bytes().len() as u8);
    body.extend_from_slice(local_raw.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

/// `encrypt_web_push_payload` with a fresh salt and ephemeral key.
pub fn encrypt_for_target(target: &WebPushTarget, plaintext: &[u8]) -> Result<Vec<u8>, WebPushError> {
    let mut salt = [0u8; 16];
    rand::fill(&mut salt[..]);
    let local = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let keys = WebPushKeys { p256dh: target.p256dh.clone(), auth: target.auth.clone() };
    encrypt_web_push_payload(&keys, plaintext, salt, &local)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Diagnostic {
    Suppressed { browser: String },
    Delivered { browser: String },
    Expired { browser: String },
    Failed { browser: String, error: String },
}

fn sealed_key(row: &Value) -> Option<(String, String, String, SealedBox)> {
    let endpoint = row.get("endpoint")?.as_str().filter(|e| !e.is_empty())?.to_owned();
    let client_id = row.get("clientId")?.as_str().filter(|c| !c.is_empty())?.to_owned();
    let sealed = row.get("sealed")?;
    let ciphertext = sealed.get("ciphertext")?.as_str()?.to_owned();
    let sealed = serde_json::from_value::<SealedBox>(sealed.clone()).ok()?;
    Some((format!("{endpoint}\n{client_id}\n{ciphertext}"), endpoint, client_id, sealed))
}

pub struct RelayWebPush {
    identity: ServerIdentity,
    /// Opened keys by sealed box: a republished set re-opens only what changed.
    opened: HashMap<String, Option<WebPushTarget>>,
    targets: Vec<WebPushTarget>,
    announced: bool,
}

impl RelayWebPush {
    pub fn new(identity: ServerIdentity) -> Self {
        Self { identity, opened: HashMap::new(), targets: Vec::new(), announced: false }
    }

    /// Every subscription this PC may deliver to, keys opened.
    pub fn targets(&self) -> &[WebPushTarget] {
        &self.targets
    }

    /// A `webpush-subscriptions` frame: the relay's full set for this PC. The first one on a
    /// connection is answered with `webpush-ready`, saying this PC delivers through the relay.
    pub fn update(&mut self, envelope: &Value, relay_offers_web_push: bool) -> (Vec<Value>, Vec<Diagnostic>) {
        let mut replies = Vec::new();
        let mut diagnostics = Vec::new();
        if !self.announced && relay_offers_web_push {
            self.announced = true;
            replies.push(json!({ "type": "webpush-ready", "version": 1 }));
        }
        let rows = envelope.get("subscriptions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let mut live = HashSet::new();
        let mut targets = Vec::new();
        for row in rows.iter().filter(|row| row.is_object()).take(MAX_TARGETS) {
            let Some((cache_key, endpoint, client_id, sealed)) = sealed_key(row) else { continue };
            live.insert(cache_key.clone());
            if !self.opened.contains_key(&cache_key) {
                let target = open_web_push_keys(&self.identity, &endpoint, &sealed).map(|keys| WebPushTarget {
                    endpoint: endpoint.clone(),
                    client_id: client_id.clone(),
                    p256dh: keys.p256dh,
                    auth: keys.auth,
                });
                if target.is_none() {
                    // Sealed for a pairing this PC no longer has; the browser re-seals on launch.
                    diagnostics.push(Diagnostic::Suppressed { browser: mixdog_js::slice_utf16(&client_id, 8) });
                }
                self.opened.insert(cache_key.clone(), target);
            }
            if let Some(Some(target)) = self.opened.get(&cache_key) {
                targets.push(target.clone());
            }
        }
        // Forget boxes the relay no longer lists.
        self.opened.retain(|key, _| live.contains(key));
        self.targets = targets;
        (replies, diagnostics)
    }

    /// Hands one encrypted body to the relay.
    pub fn send_envelope(target: &WebPushTarget, body: &[u8]) -> Value {
        json!({
            "type": "webpush-send",
            "endpoint": target.endpoint,
            "clientId": target.client_id,
            "payload": URL_SAFE_NO_PAD.encode(body),
            "urgency": "high",
        })
    }

    pub fn on_result(envelope: &Value) -> Diagnostic {
        let browser = mixdog_js::slice_utf16(envelope.get("clientId").and_then(Value::as_str).unwrap_or_default(), 8);
        if envelope.get("ok") == Some(&Value::Bool(true)) {
            Diagnostic::Delivered { browser }
        } else if envelope.get("expired") == Some(&Value::Bool(true)) {
            Diagnostic::Expired { browser }
        } else {
            let error = envelope.get("error").and_then(Value::as_str).unwrap_or("unknown");
            Diagnostic::Failed { browser, error: mixdog_js::slice_utf16(error, 80) }
        }
    }

    /// A new relay connection: nothing the previous one said survives.
    pub fn reset(&mut self) {
        self.announced = false;
        self.targets.clear();
    }
}
