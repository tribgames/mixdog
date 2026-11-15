//! Credential rules of the device store (`lib/device-store-auth.mjs`, `readDeviceCredentials`, the id and secret checks of
//! `authenticateLeg`): the digests secrets are kept as, the Basic header, the profile fields a browser registers with.

use ring::constant_time::verify_slices_are_equal;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::js;

/// `PROFILE_FIELD_LIMIT`: a profile field is cut to this many UTF-16 units.
pub const PROFILE_FIELD_LIMIT: usize = 80;
/// The name a browser registered without one is shown as.
pub const DEFAULT_CLIENT_NAME: &str = "Browser";
/// The most browsers one desktop may have paired.
pub const MAX_PAIRED_CLIENTS_PER_DEVICE: usize = 256;
/// The shortest secret a desktop or hook leg may dial with, and the shortest pairing token it may announce, in UTF-16 units.
pub const MIN_SECRET_LEN: usize = 16;

/// Trust-on-first-use binds only ids that cannot be guessed ahead of the device that owns them: a full UUID or a 32 to 64
/// digit lowercase hex id (`registrableDeviceId`).
pub use crate::ids::is_registrable_device_id as registrable_device_id;

/// `createHash('sha256').update(text).digest('hex')` of text that is not parsed JSON: the Basic secret, a query or cookie token.
pub fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// [`sha256_hex`] of text that `JSON.parse` produced (a pairing token of a desktop frame): a lone surrogate hashes as U+FFFD,
/// as Node's `update(string)` encodes it.
pub fn sha256_hex_parsed(text: &str) -> String {
    hex(&Sha256::digest(js::node_utf8(text)))
}

pub(super) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    out
}

/// `hashesMatch`: the stored digest against the digest of the candidate, in constant time. An empty side never matches.
pub(super) fn hashes_match(expected_hex: &str, candidate: &str) -> bool {
    if expected_hex.is_empty() || candidate.is_empty() {
        return false;
    }
    let Some(expected) = decode_hex(expected_hex) else { return false };
    let actual = Sha256::digest(candidate.as_bytes());
    expected.len() == actual.len() && verify_slices_are_equal(&expected, &actual).is_ok()
}

/// `Buffer.from(hex, 'hex')` of a string that is whole hex pairs; anything else cannot be a stored digest.
fn decode_hex(text: &str) -> Option<Vec<u8>> {
    let digit = |b: u8| char::from(b).to_digit(16).map(|d| d as u8);
    if text.len() % 2 != 0 {
        return None;
    }
    text.as_bytes().chunks(2).map(|pair| Some((digit(pair[0])? << 4) | digit(pair[1])?)).collect()
}

/// A device id and secret.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Credentials {
    pub device_id: String,
    pub secret: String,
}

/// `readDeviceCredentials`: the id and secret of an `Authorization: Basic` header, split at the first `:` with at least one
/// character before it. A query string never carries credentials. Anything else is empty.
pub fn read_device_credentials(authorization: Option<&str>) -> Credentials {
    authorization.and_then(basic_credentials).unwrap_or_default()
}

fn basic_credentials(header: &str) -> Option<Credentials> {
    // /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i
    let scheme = header.get(..5).filter(|scheme| scheme.eq_ignore_ascii_case("basic"))?;
    let rest = &header[scheme.len()..];
    let payload = rest.trim_start_matches(js_whitespace);
    if payload.len() == rest.len() {
        return None;
    }
    let data = payload.trim_end_matches('=');
    if payload.len() - data.len() > 2 || data.is_empty() || !data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/') {
        return None;
    }
    let decoded = js::decode_utf8(&lenient_base64(data.as_bytes())).into_owned();
    let divider = decoded.find(':').filter(|at| *at > 0)?;
    Some(Credentials { device_id: decoded[..divider].to_owned(), secret: decoded[divider + 1..].to_owned() })
}

/// What `\s` matches in JavaScript.
fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `Buffer.from(text, 'base64')` of standard-alphabet text without padding: the bits are read six at a time and a trailing
/// partial byte is dropped.
fn lenient_base64(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut held) = (0u32, 0u32);
    for &c in text {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            _ => 63,
        };
        bits = (bits << 6) | u32::from(value);
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    out
}

/// The id and secret checks of `authenticateLeg` that come before any limiter: a routing id and a secret of at least
/// [`MIN_SECRET_LEN`] UTF-16 units (of the UTF-8 decoded text). False is the 401.
pub fn leg_credentials_usable(device_id: &str, secret: &str) -> bool {
    crate::ids::is_routing_id(device_id) && secret.encode_utf16().count() >= MIN_SECRET_LEN
}

/// `typeof token === 'string' && token.length >= 16` of the `set-client-token` frame, for the text `JSON.parse` produced.
pub fn client_token_usable(token: &str) -> bool {
    js::js_len(token) >= MIN_SECRET_LEN
}

/// The profile a browser registers with, as `JSON.parse` produced the fields: any JSON value, since Node coerces with `String()`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProfileInput {
    pub name: Value,
    pub platform: Value,
    pub browser: Value,
}

impl ProfileInput {
    /// The `name`, `platform` and `browser` of a request body or frame; a value that is not an object has none.
    pub fn from_value(value: &Value) -> Self {
        let field = |key: &str| value.get(key).cloned().unwrap_or(Value::Null);
        Self { name: field("name"), platform: field("platform"), browser: field("browser") }
    }

    /// A profile of plain strings.
    pub fn text(name: &str, platform: &str, browser: &str) -> Self {
        let field = |text: &str| Value::String(mixdog_js::json_parsed_text(text));
        Self { name: field(name), platform: field(platform), browser: field(browser) }
    }
}

/// A profile after clipping: what is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientProfile {
    pub name: String,
    pub platform: String,
    pub browser: String,
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

/// `String(value || fallback)`.
pub(super) fn text_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(value) if truthy(value) => mixdog_js::value_to_string(value),
        _ => fallback.to_owned(),
    }
}

/// `clipField(value, fallback)`: `String(value || fallback).slice(0, 80)`.
pub(super) fn clip_field(value: Option<&Value>, fallback: &str) -> String {
    js::js_slice(&text_or(value, fallback), PROFILE_FIELD_LIMIT)
}

/// `clientProfile(profile, defaultName)`.
pub fn client_profile(profile: &ProfileInput, default_name: &str) -> ClientProfile {
    ClientProfile {
        name: clip_field(Some(&profile.name), default_name),
        platform: clip_field(Some(&profile.platform), ""),
        browser: clip_field(Some(&profile.browser), ""),
    }
}
