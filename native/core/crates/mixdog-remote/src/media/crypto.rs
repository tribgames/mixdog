//! Authenticated encryption for the relay's HTTP media lane (shared/remote-media-crypto.ts).
//!
//! `frame = u32be(length) | nonce(12) | AES-GCM ciphertext+tag`; the response is a meta frame,
//! then one data frame per 64 KiB plaintext segment. Every frame has its own random nonce and
//! its AAD binds the asset id, variant and position, so a frame cannot move to another asset,
//! offset or size; another session has another key.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use serde_json::{Value, json};

const MEDIA_CONTEXT: &str = "mixdog-relay-media-v1";
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const LENGTH_BYTES: usize = 4;
const MAX_META_PLAINTEXT_BYTES: usize = 4096;

/// The `enc` query value a client sends to opt into this protocol.
pub const MEDIA_SCHEME: &str = "e2ee1";
/// Plaintext bytes per data frame; ranges are served on this grid.
pub const MEDIA_SEGMENT_BYTES: u64 = 64 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MediaCryptoError {
    #[error("Truncated media frame.")]
    Truncated,
    #[error("Media frame failed authentication.")]
    Auth,
    #[error("Invalid media frame length.")]
    FrameLength,
    #[error("Invalid media window.")]
    InvalidWindow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaWindowMeta {
    pub size: u64,
    pub mime: String,
    pub start: u64,
    /// Inclusive plaintext bound; `start - 1` for an empty window.
    pub end: i128,
    pub version: Option<String>,
}

fn meta_aad(asset_id: &str, variant: &str, start: u64) -> Vec<u8> {
    format!("{MEDIA_CONTEXT}\0meta\0{asset_id}\0{variant}\0{start}").into_bytes()
}

fn data_aad(asset_id: &str, variant: &str, offset: u64, size: u64) -> Vec<u8> {
    format!("{MEDIA_CONTEXT}\0data\0{asset_id}\0{variant}\0{offset}\0{size}").into_bytes()
}

fn seal(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce = [0u8; NONCE_BYTES];
    rand::fill(&mut nonce[..]);
    // AES-GCM encryption of in-memory bytes only fails past 2^36 bytes.
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .unwrap_or_default();
    let mut frame = Vec::with_capacity(LENGTH_BYTES + NONCE_BYTES + sealed.len());
    frame.extend_from_slice(&((NONCE_BYTES + sealed.len()) as u32).to_be_bytes());
    frame.extend_from_slice(&nonce);
    frame.extend_from_slice(&sealed);
    frame
}

fn open(key: &[u8; 32], body: &[u8], aad: &[u8]) -> Result<Vec<u8>, MediaCryptoError> {
    if body.len() < NONCE_BYTES + TAG_BYTES {
        return Err(MediaCryptoError::Truncated);
    }
    Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(&body[..NONCE_BYTES]), Payload { msg: &body[NONCE_BYTES..], aad })
        .map_err(|_| MediaCryptoError::Auth)
}

pub fn encrypt_media_meta(key: &[u8; 32], asset_id: &str, variant: &str, meta: &MediaWindowMeta) -> Vec<u8> {
    let mut body = json!({ "size": meta.size, "mime": meta.mime, "start": meta.start, "end": meta.end as i64 });
    if let (Some(version), Some(map)) = (&meta.version, body.as_object_mut()) {
        map.insert("version".into(), Value::from(version.as_str()));
    }
    seal(key, body.to_string().as_bytes(), &meta_aad(asset_id, variant, meta.start))
}

pub fn encrypt_media_segment(
    key: &[u8; 32],
    asset_id: &str,
    variant: &str,
    offset: u64,
    size: u64,
    plaintext: &[u8],
) -> Vec<u8> {
    seal(key, plaintext, &data_aad(asset_id, variant, offset, size))
}

/// `expected_start` is the segment-aligned offset the caller asked for: a meta frame answering
/// another request fails authentication.
pub fn decrypt_media_meta(
    key: &[u8; 32],
    asset_id: &str,
    variant: &str,
    expected_start: u64,
    body: &[u8],
) -> Result<MediaWindowMeta, MediaCryptoError> {
    let plaintext = open(key, body, &meta_aad(asset_id, variant, expected_start))?;
    let value: Value = serde_json::from_slice(&plaintext).map_err(|_| MediaCryptoError::InvalidWindow)?;
    let field = |name: &str| value.get(name).and_then(Value::as_u64);
    let (Some(size), Some(start), Some(mime)) = (field("size"), field("start"), value.get("mime").and_then(Value::as_str))
    else {
        return Err(MediaCryptoError::InvalidWindow);
    };
    let end = value.get("end").and_then(Value::as_i64).ok_or(MediaCryptoError::InvalidWindow)?;
    let end = i128::from(end);
    if start != expected_start || end < i128::from(start) - 1 || end >= i128::from(size) {
        return Err(MediaCryptoError::InvalidWindow);
    }
    Ok(MediaWindowMeta {
        size,
        mime: mime.to_owned(),
        start,
        end,
        version: value.get("version").and_then(Value::as_str).map(str::to_owned),
    })
}

pub fn decrypt_media_segment(
    key: &[u8; 32],
    asset_id: &str,
    variant: &str,
    offset: u64,
    size: u64,
    body: &[u8],
) -> Result<Vec<u8>, MediaCryptoError> {
    open(key, body, &data_aad(asset_id, variant, offset, size))
}

/// Re-frames an arbitrarily chunked byte stream into frame bodies (nonce + ciphertext),
/// rejecting lengths no honest host produces.
#[derive(Default)]
pub struct MediaFrameReader {
    pending: Vec<u8>,
}

impl MediaFrameReader {
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, MediaCryptoError> {
        self.pending.extend_from_slice(chunk);
        let max_body = MEDIA_SEGMENT_BYTES as usize + NONCE_BYTES + TAG_BYTES;
        let max_body = max_body.max(MAX_META_PLAINTEXT_BYTES + NONCE_BYTES + TAG_BYTES);
        let mut bodies = Vec::new();
        let mut at = 0;
        while self.pending.len() - at >= LENGTH_BYTES {
            let mut length = [0u8; LENGTH_BYTES];
            length.copy_from_slice(&self.pending[at..at + LENGTH_BYTES]);
            let length = u32::from_be_bytes(length) as usize;
            if length < NONCE_BYTES + TAG_BYTES || length > max_body {
                return Err(MediaCryptoError::FrameLength);
            }
            if self.pending.len() - at - LENGTH_BYTES < length {
                break;
            }
            bodies.push(self.pending[at + LENGTH_BYTES..at + LENGTH_BYTES + length].to_vec());
            at += LENGTH_BYTES + length;
        }
        self.pending.drain(..at);
        Ok(bodies)
    }
}
