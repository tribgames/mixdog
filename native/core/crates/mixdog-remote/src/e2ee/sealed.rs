//! Boxes sealed to one party: the pairing approval handed to a credential-less container, and
//! a browser's Web Push keys sealed to this PC.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::Nonce;
use p256::SecretKey;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::channel::cipher;
use super::kdf::{derive_key, public_key_b64};
use super::{CONTEXT, E2eeError, VERSION, b64, is_b64url_len, random, unb64};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingMaterial {
    pub version: u64,
    pub server_public_key: String,
    pub pairing_secret: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedBox {
    pub version: u64,
    pub ephemeral_public_key: String,
    pub nonce: String,
    pub ciphertext: String,
}

pub struct ClaimKeyPair {
    pub public_key: String,
    pub secret: SecretKey,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebPushKeys {
    pub p256dh: String,
    pub auth: String,
}

pub fn generate_claim_key_pair() -> ClaimKeyPair {
    let secret = SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    ClaimKeyPair { public_key: public_key_b64(&secret.public_key()), secret }
}

/// A claim public key: an uncompressed P-256 point, 86-88 base64url characters.
pub fn is_claim_public_key(value: &str) -> bool {
    (86..=88).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn claim_key(private: &SecretKey, peer: &str, client_public: &str, ephemeral: &str) -> Result<[u8; 32], E2eeError> {
    let info = format!("{CONTEXT}\0claim\0{client_public}\0{ephemeral}");
    derive_key(private, peer, &[0u8; 32], info.as_bytes())
}

pub fn seal_pairing(material: &PairingMaterial, client_public_key: &str) -> Result<SealedBox, E2eeError> {
    if !is_claim_public_key(client_public_key) {
        return Err(E2eeError::Invalid("Invalid approval key."));
    }
    let ephemeral = SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let ephemeral_public = public_key_b64(&ephemeral.public_key());
    let key = claim_key(&ephemeral, client_public_key, client_public_key, &ephemeral_public)?;
    let nonce: [u8; 12] = random();
    let body = json!({"version": material.version, "serverPublicKey": material.server_public_key, "pairingSecret": material.pairing_secret});
    let ciphertext = cipher(&key)
        .encrypt(Nonce::from_slice(&nonce), body.to_string().as_bytes())
        .map_err(|_| E2eeError::Auth)?;
    Ok(SealedBox { version: VERSION, ephemeral_public_key: ephemeral_public, nonce: b64(&nonce), ciphertext: b64(&ciphertext) })
}

/// `None` for anything that does not open: a refused approval, never a half-applied pairing.
pub fn open_sealed_pairing(sealed: &SealedBox, pair: &ClaimKeyPair) -> Option<PairingMaterial> {
    if sealed.version != VERSION || !is_claim_public_key(&sealed.ephemeral_public_key) {
        return None;
    }
    let key = claim_key(&pair.secret, &sealed.ephemeral_public_key, &pair.public_key, &sealed.ephemeral_public_key).ok()?;
    let nonce = unb64(&sealed.nonce).ok().filter(|n| n.len() == 12)?;
    let plaintext = cipher(&key).decrypt(Nonce::from_slice(&nonce), unb64(&sealed.ciphertext).ok()?.as_slice()).ok()?;
    let parsed: PairingMaterial = serde_json::from_slice(&plaintext).ok()?;
    (parsed.version == VERSION
        && is_b64url_len(&parsed.server_public_key, 87)
        && is_b64url_len(&parsed.pairing_secret, 43))
    .then_some(parsed)
}

fn web_push_key(private: &SecretKey, peer: &str, secret: &str, server_public: &str, ephemeral: &str) -> Result<[u8; 32], E2eeError> {
    let info = format!("{CONTEXT}\0webpush\0{server_public}\0{ephemeral}");
    derive_key(private, peer, &unb64(secret)?, info.as_bytes())
}

/// The browser side: its subscription keys sealed to one paired PC, bound to the endpoint.
pub fn seal_web_push_keys(pairing: &PairingMaterial, endpoint: &str, keys: &WebPushKeys) -> Result<SealedBox, E2eeError> {
    let ephemeral = SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let ephemeral_public = public_key_b64(&ephemeral.public_key());
    let key = web_push_key(&ephemeral, &pairing.server_public_key, &pairing.pairing_secret, &pairing.server_public_key, &ephemeral_public)?;
    let nonce: [u8; 12] = random();
    let body = json!({"p256dh": keys.p256dh, "auth": keys.auth});
    let ciphertext = cipher(&key)
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: body.to_string().as_bytes(), aad: endpoint.as_bytes() })
        .map_err(|_| E2eeError::Auth)?;
    Ok(SealedBox { version: VERSION, ephemeral_public_key: ephemeral_public, nonce: b64(&nonce), ciphertext: b64(&ciphertext) })
}

/// `None` for a box sealed for another PC, another endpoint, or without the pairing secret.
pub fn open_web_push_keys(identity: &super::ServerIdentity, endpoint: &str, sealed: &SealedBox) -> Option<WebPushKeys> {
    if sealed.version != VERSION || !is_b64url_len(&sealed.ephemeral_public_key, 87) {
        return None;
    }
    let key = web_push_key(identity.secret(), &sealed.ephemeral_public_key, &identity.pairing_secret, &identity.server_public_key, &sealed.ephemeral_public_key).ok()?;
    let nonce = unb64(&sealed.nonce).ok().filter(|n| n.len() == 12)?;
    let ct = unb64(&sealed.ciphertext).ok()?;
    let plaintext = cipher(&key)
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad: endpoint.as_bytes() })
        .ok()?;
    let parsed: serde_json::Value = serde_json::from_slice(&plaintext).ok()?;
    let p256dh = parsed["p256dh"].as_str().filter(|v| is_b64url_len(v, 87))?;
    let auth = parsed["auth"].as_str().filter(|v| is_b64url_len(v, 22))?;
    Some(WebPushKeys { p256dh: p256dh.to_owned(), auth: auth.to_owned() })
}
