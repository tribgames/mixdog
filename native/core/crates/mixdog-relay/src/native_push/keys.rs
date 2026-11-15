//! The credentials of the two push services, read from the environment the way `native-push.mjs` read them: inline or as a
//! path to a file, with every private key form Node's `createPrivateKey` took for these keys.

use std::collections::BTreeMap;

use p256::ecdsa::SigningKey;
use p256::pkcs8::DecodePrivateKey;
use ring::signature::RsaKeyPair;
use serde_json::Value;

use crate::js;

const DEFAULT_APNS_KEY_ID: &str = "6S9P5W53QC";
const DEFAULT_APNS_TEAM_ID: &str = "Q6C35DQU78";
const DEFAULT_TOPIC: &str = "io.mixdog.app";
const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

/// What OpenSSL says of a PEM it cannot use.
const UNSUPPORTED_KEY: &str = "error:1E08010C:DECODER routines::unsupported";

/// The APNs provider credentials.
pub struct ApnsConfig {
    pub key_id: String,
    pub team_id: String,
    pub key: SigningKey,
    pub topic: String,
    /// `APNS_ENVIRONMENT=sandbox`: where a registration that did not say its environment is sent.
    pub sandbox_default: bool,
}

/// The FCM service account.
pub struct FcmConfig {
    pub project_id: String,
    pub client_email: String,
    pub key: RsaKeyPair,
    pub token_uri: String,
}

/// `String(env[name] || '').trim()`.
fn env_text(env: &BTreeMap<String, String>, name: &str) -> String {
    js::js_trim(env.get(name).map_or("", String::as_str)).to_owned()
}

/// `String(env[name] || '').trim() || default`.
fn env_or(env: &BTreeMap<String, String>, name: &str, default: &str) -> String {
    let text = env_text(env, name);
    if text.is_empty() { default.to_owned() } else { text }
}

/// `readFileSync(path, 'utf8')`, with Node's message for a file that cannot be read.
fn read_file(path: &str) -> Result<String, String> {
    mixdog_fsio::read_to_string(&mixdog_fsio::Unlaned, path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{path}'"),
        std::io::ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{path}'"),
        _ => format!("{error}, open '{path}'"),
    })
}

/// A secret that may be given inline or as a path to a file: empty when unset.
fn inline_or_file(value: &str, inline_prefix: &str) -> Result<String, String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    if value.starts_with(inline_prefix) { Ok(value.to_owned()) } else { read_file(value) }
}

/// The label and DER of the first PEM block that holds a private key of an accepted form. Blocks of other kinds are
/// skipped as OpenSSL skips them: `openssl ecparam -genkey` writes `EC PARAMETERS` before the `EC PRIVATE KEY`.
fn pem_block(text: &str, accepted: &[&str]) -> Result<(String, Vec<u8>), String> {
    let blocks = pem::parse_many(text).map_err(|_| UNSUPPORTED_KEY.to_owned())?;
    blocks
        .into_iter()
        .find(|block| accepted.iter().any(|tag| *tag == block.tag()))
        .map(|block| (block.tag().to_owned(), block.into_contents()))
        .ok_or_else(|| UNSUPPORTED_KEY.to_owned())
}

/// An EC P-256 private key: PKCS#8 (`PRIVATE KEY`) or SEC1 (`EC PRIVATE KEY`).
pub fn parse_ec_p256_pem(text: &str) -> Result<SigningKey, String> {
    let (tag, der) = pem_block(text, &["PRIVATE KEY", "EC PRIVATE KEY"])?;
    let secret = match tag.as_str() {
        "PRIVATE KEY" => p256::SecretKey::from_pkcs8_der(&der).map_err(|_| UNSUPPORTED_KEY.to_owned())?,
        "EC PRIVATE KEY" => p256::SecretKey::from_sec1_der(&der).map_err(|_| UNSUPPORTED_KEY.to_owned())?,
        _ => return Err(UNSUPPORTED_KEY.to_owned()),
    };
    Ok(SigningKey::from(secret))
}

/// An RSA private key: PKCS#8 (`PRIVATE KEY`) or PKCS#1 (`RSA PRIVATE KEY`).
pub fn parse_rsa_pem(text: &str) -> Result<RsaKeyPair, String> {
    let (tag, der) = pem_block(text, &["PRIVATE KEY", "RSA PRIVATE KEY"])?;
    let pair = match tag.as_str() {
        "PRIVATE KEY" => RsaKeyPair::from_pkcs8(&der),
        "RSA PRIVATE KEY" => RsaKeyPair::from_der(&der),
        _ => return Err(UNSUPPORTED_KEY.to_owned()),
    };
    pair.map_err(|_| UNSUPPORTED_KEY.to_owned())
}

/// The APNs credentials of the environment: `None` when `APNS_KEY_P8` is unset, an error when it cannot be used.
pub fn read_apns_config(env: &BTreeMap<String, String>) -> Result<Option<ApnsConfig>, String> {
    let key_id = env_or(env, "APNS_KEY_ID", DEFAULT_APNS_KEY_ID);
    let team_id = env_or(env, "APNS_TEAM_ID", DEFAULT_APNS_TEAM_ID);
    let p8 = inline_or_file(&env_text(env, "APNS_KEY_P8"), "-----BEGIN")?;
    if p8.is_empty() {
        return Ok(None);
    }
    let topic = env_or(env, "APNS_TOPIC", DEFAULT_TOPIC);
    Ok(Some(ApnsConfig {
        key_id,
        team_id,
        key: parse_ec_p256_pem(&p8)?,
        topic,
        sandbox_default: env_text(env, "APNS_ENVIRONMENT").to_lowercase() == "sandbox",
    }))
}

/// The FCM credentials of the environment: `None` when `FCM_SERVICE_ACCOUNT_JSON` is unset or lacks `project_id`,
/// `client_email` or `private_key`, an error when it cannot be used.
pub fn read_fcm_config(env: &BTreeMap<String, String>) -> Result<Option<FcmConfig>, String> {
    let json = inline_or_file(&env_text(env, "FCM_SERVICE_ACCOUNT_JSON"), "{")?;
    if json.is_empty() {
        return Ok(None);
    }
    let account = js::parse(&json).map_err(|error| error.to_string())?;
    let field = |name: &str| -> Result<Value, String> {
        match &account {
            Value::Null => Err(format!("Cannot read properties of null (reading '{name}')")),
            Value::Object(map) => Ok(map.get(name).cloned().unwrap_or(Value::Null)),
            _ => Ok(Value::Null),
        }
    };
    let (project_id, client_email, private_key) = (field("project_id")?, field("client_email")?, field("private_key")?);
    if !truthy(&project_id) || !truthy(&client_email) || !truthy(&private_key) {
        return Ok(None);
    }
    let token_uri = field("token_uri")?;
    Ok(Some(FcmConfig {
        project_id: js_string(&project_id),
        client_email: js_string(&client_email),
        key: parse_rsa_pem(&js_string(&private_key))?,
        token_uri: if truthy(&token_uri) { js_string(&token_uri) } else { DEFAULT_TOKEN_URI.to_owned() },
    }))
}

/// JavaScript truthiness of a parsed JSON value.
pub(super) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `String(value)` of a parsed JSON value.
pub(super) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => mixdog_js::number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(|item| if item.is_null() { String::new() } else { js_string(item) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}
