//! Relay end-to-end encryption (shared/remote-e2ee.ts): P-256 ECDH + HKDF-SHA-256 + AES-256-GCM
//! sessions between this PC and one paired phone, the control lanes of the transport sessions,
//! the sealed approval and Web Push key boxes, and the media key.
//!
//! Everything here is synchronous and allocation-bounded; a session is a plain value owned by
//! the one client task that uses it, so no session ever waits on another.

mod channel;
mod control;
mod handshake;
mod kdf;
mod pack;
mod sealed;

pub use channel::{Channel, ControlOpen, Sealed, Wire};
pub use control::ControlLane;
pub use handshake::{
    accept_client_hello, create_client_handshake, is_hello, secret_from_jwk, Challenge, ClientHandshakeOptions, ServerIdentity,
};
pub use pack::{pack_plaintext, unpack_plaintext, MAX_PLAINTEXT_BYTES};
pub use sealed::{
    generate_claim_key_pair, is_claim_public_key, open_sealed_pairing, open_web_push_keys, seal_pairing, seal_web_push_keys,
    ClaimKeyPair, PairingMaterial, SealedBox, WebPushKeys,
};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

pub const VERSION: u64 = 1;
pub(crate) const CONTEXT: &str = "mixdog-relay-e2ee-v1";
pub(crate) const BINARY_MAGIC: [u8; 4] = [0x4d, 0x58, 0x45, 0x01];
pub(crate) const CONTROL_MAGIC: [u8; 4] = [0x4d, 0x58, 0x43, 0x01];
pub(crate) const BOX_HEADER_BYTES: usize = 24;
/// Largest application plaintext of one transport record (1 MiB).
pub const TRANSPORT_MAX_PLAINTEXT_BYTES: usize = 1024 * 1024;
pub const TRANSPORT_MAX_BOX_BYTES: usize = BOX_HEADER_BYTES + TRANSPORT_MAX_PLAINTEXT_BYTES + 16;

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum E2eeError {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("Relay encryption authentication failed.")]
    Auth,
    #[error("Rejected replayed relay frame.")]
    Replay,
    #[error("Relay encryption handshake is not confirmed.")]
    Unconfirmed,
    #[error("Relay transport stream is broken.")]
    Broken,
    #[error("Relay plaintext exceeds its bound.")]
    TooLarge,
    #[error("Relay encryption handshake transcript mismatch.")]
    TranscriptMismatch,
}

pub(crate) fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn unb64(value: &str) -> Result<Vec<u8>, E2eeError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| E2eeError::Invalid("Invalid base64url value."))
}

pub(crate) fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    rand::fill(&mut out[..]);
    out
}

/// `[A-Za-z0-9_-]{len}` exactly.
pub(crate) fn is_b64url_len(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
