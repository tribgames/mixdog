//! The two signed tokens: the ES256 APNs provider token and the RS256 service-account assertion FCM's OAuth endpoint
//! exchanges for an access token, with the caches that keep both from being minted per push.

use std::sync::{Mutex, PoisonError};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::SigningKey;
use p256::ecdsa::signature::Signer;
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde_json::json;

use crate::js;

/// An APNs provider token is replaced after this long (Apple refuses one older than an hour).
pub const APNS_JWT_TTL_MS: i64 = 40 * 60_000;
pub const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// An access token is replaced this long before it expires.
const ACCESS_TOKEN_MARGIN_MS: i64 = 60_000;

pub fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn segment(value: &serde_json::Value) -> String {
    base64url(&js::node_utf8(&js::wire(value)))
}

/// `Math.floor(ms / 1000)`.
fn seconds(now_ms: i64) -> i64 {
    now_ms.div_euclid(1000)
}

/// The APNs provider token: ES256, the signature as `r || s` (IEEE P1363).
pub fn apns_provider_token(key: &SigningKey, key_id: &str, team_id: &str, now_ms: i64) -> String {
    let header = segment(&json!({ "alg": "ES256", "kid": key_id }));
    let claims = segment(&json!({ "iss": team_id, "iat": seconds(now_ms) }));
    let signing_input = format!("{header}.{claims}");
    let signature: p256::ecdsa::Signature = key.sign(signing_input.as_bytes());
    format!("{signing_input}.{}", base64url(&signature.to_bytes()))
}

/// The service-account assertion: RS256, scope `firebase.messaging`, audience the token endpoint, valid for an hour.
pub fn fcm_assertion(key: &RsaKeyPair, client_email: &str, token_uri: &str, now_ms: i64) -> Result<String, String> {
    let issued = seconds(now_ms);
    let header = segment(&json!({ "alg": "RS256", "typ": "JWT" }));
    let claims = segment(&json!({
        "iss": client_email,
        "scope": FCM_SCOPE,
        "aud": token_uri,
        "iat": issued,
        "exp": issued + 3600,
    }));
    let signing_input = format!("{header}.{claims}");
    let mut signature = vec![0_u8; key.public().modulus_len()];
    key.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), signing_input.as_bytes(), &mut signature)
        .map_err(|_| "error:02000079:rsa routines::oaep decoding error".to_owned())?;
    Ok(format!("{signing_input}.{}", base64url(&signature)))
}

/// The cached provider token and when it was signed.
#[derive(Default)]
pub struct ProviderTokenCache {
    slot: Mutex<(String, i64)>,
}

impl ProviderTokenCache {
    /// The cached token, or the one `mint` signs when there is none or it is older than [`APNS_JWT_TTL_MS`].
    pub fn get_or_mint(&self, now_ms: i64, mint: impl FnOnce() -> String) -> String {
        let mut slot = self.slot.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.0.is_empty() || now_ms - slot.1 > APNS_JWT_TTL_MS {
            *slot = (mint(), now_ms);
        }
        slot.0.clone()
    }

    /// A 403 means the token was refused: a fresh one is signed next time.
    pub fn discard(&self) {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = (String::new(), 0);
    }
}

/// The cached OAuth access token and its expiry.
#[derive(Default)]
pub struct AccessTokenCache {
    slot: Mutex<(String, i64)>,
}

impl AccessTokenCache {
    /// The token, until 60 s before it expires.
    pub fn get(&self, now_ms: i64) -> Option<String> {
        let slot = self.slot.lock().unwrap_or_else(PoisonError::into_inner);
        (!slot.0.is_empty() && now_ms < slot.1 - ACCESS_TOKEN_MARGIN_MS).then(|| slot.0.clone())
    }

    pub fn store(&self, token: &str, expires_at_ms: i64) {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = (token.to_owned(), expires_at_ms);
    }

    /// A 401 means the token was refused: a new one is exchanged next time.
    pub fn discard(&self) {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = (String::new(), 0);
    }
}
