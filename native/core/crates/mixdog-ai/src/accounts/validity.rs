//! Whether a stored OAuth document is a sign-in, per provider: the rules of the ten credential probes
//! (`oauth-credential-probes.mjs`) over the document the provider's file holds
//! (`fixtures/oauth-credential-validity/golden.json`, from the real `oauthCredentialProbeState`). A
//! document the rule rejects reads absent, as a logout does; Node's probes are memoised for 3 s and
//! keyed on the file, which changes nothing about the answer.
//!
//! Not here: Cursor's `CURSOR_ACCESS_TOKEN` environment token, which the Rust Cursor provider never reads.

use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::GeneralPurpose;
use base64::engine::GeneralPurposeConfig;
use mixdog_js::js_trim;
use mixdog_js::string_to_number;
use mixdog_js::time::date_parse;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

/// JavaScript truthiness of a credential field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// A string with something besides white space (`typeof v === 'string' && v.trim() !== ''`).
fn non_blank(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| !js_trim(text).is_empty())
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let n = to_number_of(value);
    if n.is_nan() { 0.0 } else { n }
}

/// `value ?? fallback`: null counts as absent.
fn non_null(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `normalizeExpiresAtMs`: epoch seconds or milliseconds, a numeric string or a date string (V8's
/// `Date.parse`) as epoch milliseconds; 0 is unknown.
pub fn normalize_expires_at_ms(value: Option<&Value>) -> f64 {
    if let Some(Value::String(text)) = value {
        let trimmed = js_trim(text);
        let numeric = if trimmed.is_empty() { f64::NAN } else { string_to_number(trimmed) };
        if !numeric.is_finite() {
            let at = date_parse(text);
            return if at.is_finite() { at } else { 0.0 };
        }
    }
    let n = if truthy(value) { to_number_of(value) } else { 0.0 };
    if !n.is_finite() || n <= 0.0 {
        return 0.0;
    }
    if n < 1e12 { n * 1000.0 } else { n }
}

/// `decodeJwtPayload`: the claims of a three-part token, or `None`. Node's base64 decoding takes
/// either alphabet and ignores padding.
pub fn decode_jwt_payload(token: &str) -> Option<Map<String, Value>> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload: String = parts[1]
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    let engine = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
    );
    let bytes = engine.decode(payload).ok()?;
    match serde_json::from_slice::<Value>(&bytes).ok()? {
        Value::Object(claims) => Some(claims),
        _ => None,
    }
}

/// `expiryFromAccessToken`: the `exp` claim of a token in epoch milliseconds; 0 for an opaque one.
pub fn expiry_from_access_token(token: &str) -> f64 {
    let exp = decode_jwt_payload(token).map_or(f64::NAN, |claims| to_number_of(claims.get("exp")));
    if exp.is_finite() && exp > 0.0 { exp * 1000.0 } else { 0.0 }
}
/// `signedInTokenDocumentUntil`: until when the document is a sign-in; infinity with a refresh
/// token, else its access token's expiry; 0 when it never is.
pub fn signed_in_until(doc: &Map<String, Value>) -> f64 {
    if !truthy(doc.get("access_token")) {
        return 0.0;
    }
    if truthy(doc.get("refresh_token")) {
        return f64::INFINITY;
    }
    let stored = normalize_expires_at_ms(non_null(doc.get("expires_at")).or(doc.get("expiresAt")));
    if stored != 0.0 { stored } else { expiry_from_access_token(&doc.get("access_token").map(value_to_string).unwrap_or_default()) }
}

/// Anthropic: an access token with the `user:inference` scope, valid until its expiry unless a
/// refresh token renews it.
fn anthropic_until(doc: &Map<String, Value>) -> f64 {
    let Some(oauth) = doc.get("claudeAiOauth").and_then(Value::as_object) else { return 0.0 };
    let inference = oauth.get("scopes").and_then(Value::as_array).is_some_and(|scopes| scopes.iter().any(|scope| scope.as_str() == Some("user:inference")));
    if !truthy(oauth.get("accessToken")) || !inference {
        return 0.0;
    }
    let expires_at = number_or_zero(non_null(oauth.get("expiresAt")).or(oauth.get("expires_at")));
    if expires_at == 0.0 || truthy(oauth.get("refreshToken")) { f64::INFINITY } else { expires_at }
}

/// Cursor: an access token that is not marked for re-login, valid until its expiry unless a refresh
/// token renews it.
fn cursor_until(doc: &Map<String, Value>) -> f64 {
    if !truthy(doc.get("access_token")) || doc.get("reauth_required") == Some(&Value::Bool(true)) {
        return 0.0;
    }
    let expires_at = number_or_zero(doc.get("expires_at"));
    if expires_at == 0.0 || truthy(doc.get("refresh_token")) { f64::INFINITY } else { expires_at }
}

/// Devin: an access token not past its expiry (the stored one, else the token's own claim).
fn devin_until(doc: &Map<String, Value>) -> f64 {
    if !truthy(doc.get("access_token")) {
        return 0.0;
    }
    let stored = number_or_zero(doc.get("expires_at"));
    let expires_at = if stored != 0.0 { stored } else { expiry_from_access_token(doc.get("access_token").and_then(Value::as_str).unwrap_or("")) };
    if expires_at > 0.0 { expires_at } else { f64::INFINITY }
}

/// Until when `doc`, the document of `provider`'s credential file, is a sign-in (epoch ms): infinity for one that
/// does not expire, 0 for one that never is.
pub fn credential_until(provider: &str, doc: &Map<String, Value>) -> f64 {
    let both = |a: &str, b: &str| truthy(doc.get(a)) && truthy(doc.get(b));
    let always = |signed_in: bool| if signed_in { f64::INFINITY } else { 0.0 };
    match provider {
        "anthropic-oauth" => anthropic_until(doc),
        "openai-oauth" => signed_in_until(doc),
        "cursor-oauth" => cursor_until(doc),
        "devin-oauth" => devin_until(doc),
        "grok-oauth" => always(both("access_token", "refresh_token")),
        "mimo-oauth" => always(truthy(doc.get("apiKey"))),
        "command-code-oauth" => always(non_blank(doc.get("apiKey"))),
        "muse-code-oauth" => always(non_blank(doc.get("accessToken")) && non_blank(doc.get("apiKey"))),
        "opencode-go-oauth" => always(non_blank(doc.get("access_token")) && non_blank(doc.get("refresh_token"))),
        "antigravity-oauth" => always(both("access_token", "refresh_token") && truthy(doc.get("project_id"))),
        _ => 0.0,
    }
}

/// Whether `doc`, the document of `provider`'s credential file, is a sign-in at `now_ms`.
pub fn credential_valid(provider: &str, doc: &Map<String, Value>, now_ms: f64) -> bool {
    credential_until(provider, doc) > now_ms
}