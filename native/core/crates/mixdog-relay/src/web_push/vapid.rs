//! The relay's VAPID identity (`loadOrCreateVapidKeys`, `vapidAuthorization` of `lib/web-push.mjs`), minted once and persisted
//! as `<DATA_DIR>/webpush-vapid.json`. Every browser subscription is bound to this public key (the applicationServerKey), so
//! reading the file unchanged is what keeps them alive; rotating the key would strand every subscription. A file that exists
//! but cannot be read DISABLES web push (`None`) instead of being replaced.

use std::io::ErrorKind;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::SecretKey;
use p256::ecdsa::SigningKey;
use p256::ecdsa::signature::Signer;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::{Value, json};
use url::Url;

use super::write_owner_only;
use crate::{js, logline};

pub const VAPID_FILE: &str = "webpush-vapid.json";
/// RFC 8292 wants a contactable sender; it names the software, not a user.
pub const VAPID_SUBJECT: &str = "mailto:support@mixdog.ai";
/// Comfortably inside the 24-hour ceiling even with a skewed push service.
const VAPID_LIFETIME_SECONDS: i64 = 12 * 60 * 60;

/// The sender identity: the applicationServerKey (the uncompressed point, base64url) and the key that signs with it.
pub struct VapidKeys {
    public_key: String,
    signing_key: SigningKey,
}

/// The uncompressed point (0x04 || X || Y), base64url.
fn raw_public_key(secret: &SecretKey) -> String {
    URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes())
}

/// The private JWK in the key order Node's `export({ format: 'jwk' })` writes.
fn private_jwk(secret: &SecretKey) -> Value {
    let point = secret.public_key().to_encoded_point(false);
    let coordinate = |bytes: Option<&[u8]>| URL_SAFE_NO_PAD.encode(bytes.unwrap_or_default());
    json!({
        "kty": "EC",
        "x": coordinate(point.x().map(|x| x.as_slice())),
        "y": coordinate(point.y().map(|y| y.as_slice())),
        "crv": "P-256",
        "d": URL_SAFE_NO_PAD.encode(secret.to_bytes()),
    })
}

impl VapidKeys {
    fn of(secret: &SecretKey) -> Self {
        Self { public_key: raw_public_key(secret), signing_key: SigningKey::from(secret) }
    }

    /// The applicationServerKey a browser subscribes with.
    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    /// Reads the identity of `data_dir`, or mints and stores one when there is no file. `None` (web push is off, the reason is
    /// logged once) when the file cannot be read, does not hold a usable key, names a public key that is not the private
    /// key's, or a new identity cannot be stored.
    pub fn load_or_create(data_dir: &Path) -> Option<Self> {
        let path = data_dir.join(VAPID_FILE);
        match mixdog_fsio::read(&mixdog_fsio::Unlaned, &path) {
            Ok(bytes) => match Self::parse(&js::decode_utf8(&bytes)) {
                Ok(keys) => Some(keys),
                Err(message) => {
                    logline::emit(&logline::web_push_identity_unusable(&message));
                    None
                }
            },
            Err(error) if error.kind() == ErrorKind::NotFound => Self::create(&path),
            Err(error) => {
                logline::emit(&logline::web_push_identity_unreadable(&js::read_file_error(&error, &path)));
                None
            }
        }
    }

    fn parse(text: &str) -> Result<Self, String> {
        let parsed = js::parse(text).map_err(|error| mixdog_js::v8_json_parse_error(text).unwrap_or_else(|| error.to_string()))?;
        let jwk = parsed.get("privateKeyJwk").ok_or("privateKeyJwk is missing")?;
        let secret = SecretKey::from_jwk_str(&jwk.to_string()).map_err(|error| error.to_string())?;
        let keys = Self::of(&secret);
        if parsed.get("publicKey").and_then(Value::as_str) != Some(keys.public_key.as_str()) {
            return Err("public key does not match the private key".to_owned());
        }
        Ok(keys)
    }

    fn create(path: &Path) -> Option<Self> {
        let secret = SecretKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
        let keys = Self::of(&secret);
        let text = js::pretty(&json!({ "version": 1, "publicKey": keys.public_key, "privateKeyJwk": private_jwk(&secret) }));
        match write_owner_only(path, &text) {
            Ok(()) => Some(keys),
            Err(error) => {
                // An identity that only lives in memory would change on the next start.
                logline::emit(&logline::web_push_identity_not_stored(&error.to_string()));
                None
            }
        }
    }
}

/// `Authorization` for one push service origin, short-lived (RFC 8292 section 2): `vapid t=<jwt>, k=<publicKey>`. The audience
/// is the endpoint's origin, the expiry twelve hours after `now_ms`.
pub fn vapid_authorization(endpoint: &str, keys: &VapidKeys, subject: &str, now_ms: i64) -> Result<String, String> {
    let issued_at = now_ms.div_euclid(1000);
    let origin = Url::parse(endpoint).map_err(|error| error.to_string())?.origin().ascii_serialization();
    let part = |value: &Value| URL_SAFE_NO_PAD.encode(js::wire(value));
    let header = part(&json!({ "typ": "JWT", "alg": "ES256" }));
    let claims = part(&json!({ "aud": origin, "exp": issued_at + VAPID_LIFETIME_SECONDS, "sub": subject }));
    // JWS wants raw r||s; DER is refused by every push service with a bare 401.
    let signature: p256::ecdsa::Signature = keys.signing_key.sign(format!("{header}.{claims}").as_bytes());
    Ok(format!("vapid t={header}.{claims}.{}, k={}", URL_SAFE_NO_PAD.encode(signature.to_bytes()), keys.public_key))
}
