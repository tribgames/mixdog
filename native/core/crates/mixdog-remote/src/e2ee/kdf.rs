//! Key agreement and handshake proofs (shared/remote-e2ee.ts).

use hmac::{Hmac, Mac};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{CONTEXT, E2eeError, b64, unb64};

pub(crate) fn public_key_b64(key: &PublicKey) -> String {
    b64(key.to_encoded_point(false).as_bytes())
}

pub(crate) fn parse_public_key(raw: &str) -> Result<PublicKey, E2eeError> {
    let bytes = unb64(raw)?;
    if bytes.len() != 65 || bytes[0] != 4 {
        return Err(E2eeError::Invalid("Invalid P-256 public key."));
    }
    PublicKey::from_sec1_bytes(&bytes).map_err(|_| E2eeError::Invalid("Invalid P-256 public key."))
}

/// ECDH shared secret → HKDF-SHA-256 → 32-byte AES-GCM key.
pub(crate) fn derive_key(
    private: &SecretKey,
    peer_public: &str,
    salt: &[u8],
    info: &[u8],
) -> Result<[u8; 32], E2eeError> {
    let peer = parse_public_key(peer_public)?;
    let shared = p256::ecdh::diffie_hellman(private.to_nonzero_scalar(), peer.as_affine());
    let hkdf = hkdf::Hkdf::<Sha256>::new(Some(salt), shared.raw_secret_bytes());
    let mut key = [0u8; 32];
    hkdf.expand(info, &mut key).map_err(|_| E2eeError::Invalid("hkdf"))?;
    Ok(key)
}

/// The ids shared by every key of one session.
pub(crate) struct SessionMaterial<'a> {
    pub private: &'a SecretKey,
    pub peer_public: &'a str,
    pub pairing_secret: &'a str,
    pub challenge: &'a str,
    pub server_public: &'a str,
    pub client_public: &'a str,
}

impl SessionMaterial<'_> {
    pub fn key(&self, purpose: &str) -> Result<[u8; 32], E2eeError> {
        let info = format!(
            "{CONTEXT}\0{purpose}\0{}\0{}\0{}",
            self.challenge, self.server_public, self.client_public
        );
        derive_key(self.private, self.peer_public, &unb64(self.pairing_secret)?, info.as_bytes())
    }

    pub fn transport_key(&self, domain: &str, direction: &str) -> Result<[u8; 32], E2eeError> {
        self.key(&format!("transport\0{domain}\0{direction}"))
    }
}

fn proof_payload(challenge: &str, server_public: &str, client_public: &str, transcript: Option<&str>) -> Vec<u8> {
    let legacy = format!("{CONTEXT}\0hello\0{challenge}\0{server_public}\0{client_public}");
    match transcript {
        None => legacy.into_bytes(),
        Some(t) => format!("{legacy}\0transport\0{t}").into_bytes(),
    }
}

pub(crate) fn hello_proof(
    secret: &str,
    challenge: &str,
    server_public: &str,
    client_public: &str,
    transcript: Option<&str>,
) -> Result<String, E2eeError> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&unb64(secret)?).map_err(|_| E2eeError::Auth)?;
    mac.update(&proof_payload(challenge, server_public, client_public, transcript));
    Ok(b64(&mac.finalize().into_bytes()))
}

pub(crate) fn verify_hello_proof(
    secret: &str,
    proof: &str,
    challenge: &str,
    server_public: &str,
    client_public: &str,
    transcript: Option<&str>,
) -> Result<(), E2eeError> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&unb64(secret)?).map_err(|_| E2eeError::Auth)?;
    mac.update(&proof_payload(challenge, server_public, client_public, transcript));
    mac.verify_slice(&unb64(proof).map_err(|_| E2eeError::Auth)?)
        .map_err(|_| E2eeError::Auth)
}

/// Stable JSON: object keys sorted, as the TS side's `canonicalJson`.
pub(crate) fn canonical_json(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String((*key).clone()).to_string());
                out.push(':');
                canonical_json(&map[*key], out);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// SHA-256 over the challenge as offered and the hello as sent, without its proof.
pub(crate) fn handshake_transcript(challenge: &Value, hello: &Value) -> String {
    let mut unsigned = hello.clone();
    if let Some(map) = unsigned.as_object_mut() {
        map.remove("proof");
    }
    let mut text = format!("{CONTEXT}\0transcript\0");
    canonical_json(challenge, &mut text);
    text.push('\0');
    canonical_json(&unsigned, &mut text);
    b64(&Sha256::digest(text.as_bytes()))
}
