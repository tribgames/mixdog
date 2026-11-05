//! End-to-end encryption of a native (APNs/FCM) push (shared/native-push-crypto.ts): the desktop
//! encrypts for the phone's own P-256 key, so the relay and Apple/Google carry only the opaque
//! `mx` string.
//!
//! `secret = ECDH(ephemeral, device)` x coordinate; `key = HKDF-SHA256(secret, salt = empty,
//! info = "mixdog-native-push-v1")`; AES-256-GCM, random 12-byte IV, no AAD; `ct` is
//! ciphertext || tag; `mx = base64url({v:1, epk, iv, ct})` with the members in that order.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hkdf::Hkdf;
use p256::PublicKey;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde::Serialize;
use sha2::{Digest, Sha256};

pub const NATIVE_PUSH_INFO: &[u8] = b"mixdog-native-push-v1";
pub const NATIVE_PUSH_VERSION: u64 = 1;
const NATIVE_TITLE_CHARS: usize = 120;
const NATIVE_BODY_CHARS: usize = 300;

/// What the relay is told. A failed turn travels as a finished one; only the encrypted content
/// says failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Reason {
    #[serde(rename = "turn-finished")]
    TurnFinished,
    #[serde(rename = "turn-failed")]
    TurnFailed,
    #[serde(rename = "approval-pending")]
    ApprovalPending,
    #[serde(rename = "input-needed")]
    InputNeeded,
}

impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Self::TurnFinished => "turn-finished",
            Self::TurnFailed => "turn-failed",
            Self::ApprovalPending => "approval-pending",
            Self::InputNeeded => "input-needed",
        }
    }

    /// The reason the relay knows.
    pub fn for_relay(self) -> &'static str {
        match self {
            Self::TurnFailed => Self::TurnFinished.name(),
            other => other.name(),
        }
    }
}

/// The plaintext of one native push; member order is the wire order (`JSON.stringify`).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePushContent {
    pub title: String,
    pub body: String,
    pub session_id: String,
    pub reason: Reason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    /// Only `true`: this PC's card allows the approval once with a bare Enter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_once: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
}

impl NativePushContent {
    /// The clipped title and body of a notification: 120 and 300 UTF-16 units.
    pub fn clip(title: &str, body: &str) -> (String, String) {
        (mixdog_js::slice_utf16(title, NATIVE_TITLE_CHARS), mixdog_js::slice_utf16(body, NATIVE_BODY_CHARS))
    }
}

#[derive(Serialize)]
struct Envelope {
    v: u64,
    epk: String,
    iv: String,
    ct: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Native push device key is invalid.")]
pub struct NativeKeyError;

/// `ephemeral` and `iv` are injectable so a test reproduces a vector.
pub fn encrypt_native_push(
    device_public_key: &str,
    content: &NativePushContent,
    ephemeral: &p256::SecretKey,
    iv: [u8; 12],
) -> Result<String, NativeKeyError> {
    let raw = URL_SAFE_NO_PAD.decode(device_public_key).map_err(|_| NativeKeyError)?;
    let device = PublicKey::from_sec1_bytes(&raw).map_err(|_| NativeKeyError)?;
    let shared = diffie_hellman(ephemeral.to_nonzero_scalar(), device.as_affine());
    let mut key = [0u8; 32];
    // `expand` fails only for an output longer than 255 hash blocks.
    let _ = Hkdf::<Sha256>::new(None, shared.raw_secret_bytes()).expand(NATIVE_PUSH_INFO, &mut key);
    let plaintext = serde_json::to_vec(content).map_err(|_| NativeKeyError)?;
    let ct = Aes256Gcm::new((&key).into()).encrypt(Nonce::from_slice(&iv), plaintext.as_slice()).map_err(|_| NativeKeyError)?;
    let envelope = Envelope {
        v: NATIVE_PUSH_VERSION,
        epk: URL_SAFE_NO_PAD.encode(ephemeral.public_key().to_encoded_point(false).as_bytes()),
        iv: URL_SAFE_NO_PAD.encode(iv),
        ct: URL_SAFE_NO_PAD.encode(ct),
    };
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).map_err(|_| NativeKeyError)?))
}

/// A fresh ephemeral key and IV per message.
pub fn encrypt_native_push_fresh(device_public_key: &str, content: &NativePushContent) -> Result<String, NativeKeyError> {
    let ephemeral = p256::SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let mut iv = [0u8; 12];
    rand::fill(&mut iv[..]);
    encrypt_native_push(device_public_key, content, &ephemeral, iv)
}

/// APNs caps apns-collapse-id at 64 bytes, so the key is a fixed-size digest:
/// `sha256(sessionId + "\n" + reason)` base64url, 32 characters.
pub fn collapse_key(session_id: &str, reason: Reason) -> String {
    let digest = Sha256::digest(format!("{session_id}\n{}", reason.name()).as_bytes());
    URL_SAFE_NO_PAD.encode(digest)[..32].to_owned()
}
