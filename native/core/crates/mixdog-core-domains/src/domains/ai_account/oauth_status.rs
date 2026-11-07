//! What an OAuth provider says of its own credential: the `describe*OAuthCredentials` functions
//! (`agent/orchestrator/providers/*-oauth-tokens.mjs`, `cursor-auth.mjs`, `devin-auth.mjs`) and the
//! helpers they share (`lib/oauth-token-utils.mjs`), over the credential document the provider's
//! `loadTokens()` returned. Reading the credential files is not here: the builders take the loaded
//! document and the clock, so they are pure.
//!
//! All ten providers. The files they read are in oauth_credentials.

use base64::Engine;
use base64::engine::DecodePaddingMode;
use base64::engine::GeneralPurpose;
use base64::engine::GeneralPurposeConfig;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `TOKEN_REFRESH_SKEW_MS`: a token that expires within this is "Refresh Soon".
const TOKEN_REFRESH_SKEW_MS: f64 = 5.0 * 60_000.0;

/// A JavaScript number as JSON: integral values print as integers, as `JSON.stringify` does.
pub(super) fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 { json!(value as i64) } else { json!(value) }
}

/// `Number(value)` for what a credential file holds; `NaN` becomes 0 where Node tests `|| 0`.
pub(super) fn js_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok().filter(|n| n.is_finite()).unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    }
}

/// JavaScript truthiness of a credential field.
pub(super) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// The field when it is a non-empty string.
pub(super) fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// `normalizeExpiresAtMs`: epoch seconds or milliseconds, a numeric string or an ISO-8601 string
/// as epoch milliseconds; 0 is unknown.
pub fn normalize_expires_at_ms(value: Option<&Value>) -> f64 {
    if let Some(Value::String(raw)) = value {
        // `Number(raw.trim() || NaN)` not finite: a date string.
        if raw.trim().parse::<f64>().ok().filter(|n| n.is_finite()).is_none() {
            return chrono::DateTime::parse_from_rfc3339(raw).map_or(0.0, |at| at.timestamp_millis() as f64);
        }
    }
    let n = js_number(value);
    if !n.is_finite() || n <= 0.0 {
        return 0.0;
    }
    if n < 1e12 { n * 1000.0 } else { n }
}

/// `expiryFromAccessToken`: the token's `exp` claim in epoch milliseconds; 0 for an opaque token.
pub fn expiry_from_access_token(token: &str) -> f64 {
    let exp = decode_jwt_payload(token).map_or(0.0, |claims| js_number(claims.get("exp")));
    if exp.is_finite() && exp > 0.0 { exp * 1000.0 } else { 0.0 }
}

/// `normalizeAccountIdentity`: `{ id?, email?, organizationId? }`, or `None` when it names neither an id nor an email.
pub fn normalize_account_identity(raw: Option<&Value>) -> Option<Value> {
    let id = clean_identity_text(raw.and_then(|raw| raw.get("id")));
    let email = clean_identity_text(raw.and_then(|raw| raw.get("email")));
    let organization = clean_identity_text(raw.and_then(|raw| raw.get("organizationId")));
    if id.is_empty() && email.is_empty() {
        return None;
    }
    let mut out = Map::new();
    for (key, value) in [("id", id), ("email", email), ("organizationId", organization)] {
        if !value.is_empty() {
            out.insert(key.to_owned(), Value::String(value));
        }
    }
    Some(Value::Object(out))
}

/// `decodeJwtPayload`: the claims of a three-part token, or `None`.
pub fn decode_jwt_payload(token: &str) -> Option<Map<String, Value>> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    // Node's base64 decoding takes either alphabet and ignores padding.
    let payload: String = parts[1].chars().filter(|c| !c.is_whitespace() && *c != '=').map(|c| match c {
        '-' => '+',
        '_' => '/',
        other => other,
    }).collect();
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

/// `cleanIdentityText`.
fn clean_identity_text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|text| text.trim().chars().take(200).collect()).unwrap_or_default()
}

/// `accountIdentityFields({ id, email })`: `email`, then `identityId`, each when present.
fn identity_fields(id: Option<&Value>, email: Option<&Value>) -> Vec<(&'static str, Value)> {
    let id = clean_identity_text(id);
    let email = clean_identity_text(email);
    let mut fields = Vec::new();
    if !email.is_empty() {
        fields.push(("email", json!(email)));
    }
    if !id.is_empty() {
        fields.push(("identityId", json!(id)));
    }
    fields
}

/// `accountIdentityFields(identity)` for a stored identity object.
fn stored_identity_fields(identity: Option<&Value>) -> Vec<(&'static str, Value)> {
    identity_fields(identity.and_then(|raw| raw.get("id")), identity.and_then(|raw| raw.get("email")))
}

/// `oauthCredentialStatus`: the status record of a stored credential that has an access token.
fn credential_status(has_refresh: bool, expires_at: f64, detail: &str, now: f64) -> Map<String, Value> {
    let expired = expires_at > 0.0 && expires_at <= now;
    let expiring = expires_at > 0.0 && expires_at < now + TOKEN_REFRESH_SKEW_MS;
    let mut out = Map::new();
    if !has_refresh {
        let usable = expires_at == 0.0 || !expired;
        out.insert("authenticated".into(), json!(usable));
        out.insert("usable".into(), json!(usable));
        out.insert("refreshable".into(), json!(false));
        out.insert("reauthRequired".into(), json!(expired));
        out.insert("status".into(), json!(if expired { "Reauth Required" } else { "Access Only" }));
        out.insert("detail".into(), json!(format!("{detail}; no refresh token")));
        out.insert("expiresAt".into(), number(expires_at));
        return out;
    }
    let status = if expired {
        "Refresh Required"
    } else if expiring {
        "Refresh Soon"
    } else {
        "Valid"
    };
    out.insert("authenticated".into(), json!(true));
    out.insert("usable".into(), json!(!expired));
    out.insert("refreshable".into(), json!(true));
    out.insert("reauthRequired".into(), json!(false));
    out.insert("status".into(), json!(status));
    out.insert("detail".into(), json!(detail));
    out.insert("expiresAt".into(), number(expires_at));
    out
}

/// The "no credential" description every provider returns.
fn not_set(detail: &str) -> Value {
    json!({
        "authenticated": false,
        "usable": false,
        "refreshable": false,
        "reauthRequired": false,
        "status": "Not Set",
        "detail": detail,
    })
}

/// `{ ...status, ...fields }` with a later duplicate keeping the first key's place, as a spread does.
fn with_fields(mut out: Map<String, Value>, fields: Vec<(&str, Value)>) -> Value {
    for (key, value) in fields {
        out.insert(key.to_owned(), value);
    }
    Value::Object(out)
}

/// A credential that is valid without expiry (an API key the provider handed out).
fn valid_key(detail: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("authenticated".into(), json!(true));
    out.insert("usable".into(), json!(true));
    out.insert("refreshable".into(), json!(false));
    out.insert("reauthRequired".into(), json!(false));
    out.insert("status".into(), json!("Valid"));
    out.insert("detail".into(), json!(detail));
    out.insert("expiresAt".into(), json!(0));
    out
}

/// `planFromTokens(...tokens)`: the ChatGPT plan of the first token carrying the claim.
fn openai_plan(tokens: [Option<&Value>; 2]) -> Value {
    for token in tokens.into_iter().flatten().filter_map(Value::as_str) {
        let plan = decode_jwt_payload(token)
            .and_then(|claims| claims.get("https://api.openai.com/auth").cloned())
            .and_then(|auth| auth.get("chatgpt_plan_type").and_then(Value::as_str).filter(|plan| !plan.is_empty()).map(str::to_owned));
        if let Some(plan) = plan {
            return Value::String(plan);
        }
    }
    Value::Null
}

fn describe_openai(tokens: &Value, now: f64) -> Value {
    if !truthy(tokens.get("access_token")) {
        return not_set("Mixdog token store");
    }
    let has_refresh = truthy(tokens.get("refresh_token"));
    let expires_at = normalize_expires_at_ms(tokens.get("expires_at").filter(|v| !v.is_null()).or(tokens.get("expiresAt")));
    let source = text(tokens.get("source")).unwrap_or("oauth");
    // A short prefix of the ChatGPT account id as a display fallback.
    let account_id = text(tokens.get("account_id")).map(|id| format!("{}…", id.chars().take(8).collect::<String>()));
    let mut fields = stored_identity_fields(tokens.get("identity"));
    if let Some(account_id) = account_id {
        fields.push(("accountId", json!(account_id)));
    }
    fields.push(("plan", openai_plan([tokens.get("id_token"), tokens.get("access_token")])));
    with_fields(credential_status(has_refresh, expires_at, source, now), fields)
}

fn describe_grok(tokens: &Value, now: f64) -> Value {
    if !truthy(tokens.get("access_token")) {
        return not_set("Mixdog token store");
    }
    let has_refresh = truthy(tokens.get("refresh_token"));
    let expires_at = normalize_expires_at_ms(tokens.get("expires_at"));
    let detail = match tokens.get("source").and_then(Value::as_str) {
        Some("own") => "Mixdog token store",
        _ => text(tokens.get("source")).unwrap_or("oauth"),
    };
    with_fields(credential_status(has_refresh, expires_at, detail, now), identity_fields(tokens.get("user_id"), tokens.get("email")))
}

fn describe_muse_code(tokens: &Value) -> Value {
    if !truthy(tokens.get("apiKey")) {
        return not_set("Mixdog token store");
    }
    with_fields(valid_key("Mixdog token store"), identity_fields(tokens.get("accountId"), tokens.get("email")))
}

fn describe_command_code(tokens: &Value) -> Value {
    let mut fields = identity_fields(tokens.get("userId"), None);
    if let Some(name) = text(tokens.get("userName")) {
        fields.push(("accountId", json!(name)));
    }
    with_fields(valid_key("Mixdog token store; API key"), fields)
}

fn describe_opencode_go(tokens: &Value, now: f64) -> Value {
    let org_name = text(tokens.get("org_name"));
    let detail = org_name.map_or_else(|| "OpenCode Console".to_owned(), |name| format!("OpenCode Console · {name}"));
    // The stored expiry is compared as it is: no seconds-to-milliseconds normalizing here.
    let expires_at = js_number(tokens.get("expires_at"));
    let mut fields = identity_fields(tokens.get("account_id"), tokens.get("email"));
    if let Some(org_id) = text(tokens.get("org_id")) {
        fields.push(("orgId", json!(org_id)));
    }
    if let Some(name) = org_name {
        fields.push(("orgName", json!(name)));
    }
    with_fields(credential_status(true, expires_at, &detail, now), fields)
}

fn describe_mimo(tokens: &Value) -> Value {
    with_fields(valid_key("Mixdog token store; API key"), identity_fields(tokens.get("uid"), None))
}

fn describe_antigravity(tokens: &Value, now: f64) -> Value {
    if !truthy(tokens.get("access_token")) {
        return not_set("Mixdog token store");
    }
    let has_refresh = truthy(tokens.get("refresh_token"));
    let expires_at = js_number(tokens.get("expires_at"));
    let expired = expires_at > 0.0 && expires_at <= now;
    // An expired access token is not a dead credential while a refresh token remains.
    let usable = !expired || has_refresh;
    let email = text(tokens.get("email"));
    let project = text(tokens.get("project_id"));
    let detail = [Some(email.unwrap_or("Mixdog token store").to_owned()), project.map(|project| format!("project {project}"))]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
    let mut out = Map::new();
    out.insert("authenticated".into(), json!(true));
    out.insert("usable".into(), json!(usable));
    out.insert("refreshable".into(), json!(has_refresh));
    out.insert("reauthRequired".into(), json!(!usable));
    out.insert("status".into(), json!(if usable { "Signed In" } else { "Reauth Required" }));
    out.insert("detail".into(), json!(detail));
    let mut fields = identity_fields(tokens.get("user_id"), tokens.get("email"));
    fields.push(("email", json!(email.unwrap_or_default())));
    fields.push(("projectId", json!(project.unwrap_or_default())));
    fields.push(("plan", text(tokens.get("tier_id")).map_or(Value::Null, |tier| json!(tier))));
    with_fields(out, fields)
}

/// `describeAnthropicOAuthCredentials`: `creds` is `loadCredentials()`'s document.
fn describe_anthropic(creds: &Value, now: f64) -> Value {
    let has_inference_scope =
        creds.get("scopes").and_then(Value::as_array).is_some_and(|scopes| scopes.iter().any(|scope| scope == "user:inference"));
    let has_refresh = truthy(creds.get("refreshToken"));
    let expires_at = normalize_expires_at_ms(creds.get("expiresAt"));
    let detail = text(creds.get("path")).unwrap_or_default();
    let refused = |status: &str| {
        json!({
            "authenticated": false,
            "usable": false,
            "refreshable": false,
            "reauthRequired": true,
            "status": status,
            "detail": detail,
            "expiresAt": number(expires_at),
        })
    };
    if !has_inference_scope {
        return refused("Missing Scope");
    }
    if creds.get("reauthRequired") == Some(&Value::Bool(true)) {
        return refused("Reauth Required");
    }
    let mut fields = stored_identity_fields(creds.get("identity"));
    fields.push(("plan", text(creds.get("subscriptionType")).map_or(Value::Null, |plan| json!(plan))));
    with_fields(credential_status(has_refresh, expires_at, detail, now), fields)
}

/// `describeCursorOAuthCredentials`: `tokens` is `loadStoredCredentials()`'s document.
fn describe_cursor(tokens: &Value, now: f64) -> Value {
    let detail = text(tokens.get("source")).unwrap_or("Cursor OAuth");
    let expires_at = js_number(tokens.get("expires_at"));
    let identity = stored_identity_fields(tokens.get("identity"));
    let mut out = Map::new();
    if tokens.get("reauth_required") == Some(&Value::Bool(true)) {
        out.insert("authenticated".into(), json!(false));
        out.insert("usable".into(), json!(false));
        out.insert("refreshable".into(), json!(false));
        out.insert("reauthRequired".into(), json!(true));
        out.insert("status".into(), json!("Reauth Required"));
        out.insert("detail".into(), json!(detail));
        out.insert("expiresAt".into(), if expires_at != 0.0 { number(expires_at) } else { Value::Null });
        return with_fields(out, identity);
    }
    let expired = expires_at > 0.0 && expires_at <= now;
    let expiring = expires_at > 0.0 && expires_at <= now + TOKEN_REFRESH_SKEW_MS;
    let refreshable = truthy(tokens.get("refresh_token"));
    let reauth_required = expired && !refreshable;
    let status = if reauth_required {
        "Reauth Required"
    } else if expired {
        "Refresh Required"
    } else if expiring {
        "Refresh Soon"
    } else if refreshable {
        "Valid"
    } else {
        "Access Only"
    };
    out.insert("authenticated".into(), json!(!reauth_required));
    out.insert("usable".into(), json!(!expired));
    out.insert("refreshable".into(), json!(refreshable));
    out.insert("reauthRequired".into(), json!(reauth_required));
    out.insert("status".into(), json!(status));
    out.insert("detail".into(), json!(detail));
    out.insert("expiresAt".into(), if expires_at != 0.0 { number(expires_at) } else { Value::Null });
    with_fields(out, identity)
}

/// `describeDevinOAuthCredentials`: `tokens` is `loadStoredCredentials()`'s document.
fn describe_devin(tokens: &Value, now: f64) -> Value {
    let expires_at = js_number(tokens.get("expires_at"));
    let expired = expires_at > 0.0 && expires_at <= now;
    let mut out = Map::new();
    out.insert("authenticated".into(), json!(!expired));
    out.insert("usable".into(), json!(!expired));
    out.insert("refreshable".into(), json!(false));
    out.insert("reauthRequired".into(), json!(expired));
    out.insert("status".into(), json!(if expired { "Reauth Required" } else { "Access Only" }));
    out.insert("detail".into(), json!(text(tokens.get("source")).unwrap_or("Devin OAuth")));
    out.insert("expiresAt".into(), if expires_at != 0.0 { number(expires_at) } else { Value::Null });
    with_fields(out, stored_identity_fields(tokens.get("identity")))
}

/// What a provider reports with no credential.
fn not_set_detail(provider: &str) -> &'static str {
    match provider {
        "anthropic-oauth" => "Mixdog OAuth credentials",
        "cursor-oauth" => "Mixdog token store or CURSOR_ACCESS_TOKEN",
        _ => "Mixdog token store",
    }
}

/// The ten OAuth providers, in the order the setup lists them.
pub const PROVIDERS: [&str; 10] = [
    "openai-oauth",
    "anthropic-oauth",
    "grok-oauth",
    "muse-code-oauth",
    "command-code-oauth",
    "opencode-go-oauth",
    "mimo-oauth",
    "cursor-oauth",
    "devin-oauth",
    "antigravity-oauth",
];

/// `describe<Provider>OAuthCredentials()` over the document the provider's loader returned
/// (`oauth_credentials::load_oauth_credentials`; `None` when it returned nothing) and the clock
/// (`Date.now()` in epoch milliseconds). `None` for a provider that is not one of the ten.
pub fn describe_oauth(provider: &str, loaded: Option<&Value>, now_ms: i64) -> Option<Value> {
    let now = now_ms as f64;
    if !PROVIDERS.contains(&provider) {
        return None;
    }
    let Some(tokens) = loaded.filter(|tokens| !tokens.is_null()) else { return Some(not_set(not_set_detail(provider))) };
    Some(match provider {
        "openai-oauth" => describe_openai(tokens, now),
        "anthropic-oauth" => describe_anthropic(tokens, now),
        "grok-oauth" => describe_grok(tokens, now),
        "muse-code-oauth" => describe_muse_code(tokens),
        "command-code-oauth" => describe_command_code(tokens),
        "opencode-go-oauth" => describe_opencode_go(tokens, now),
        "mimo-oauth" => describe_mimo(tokens),
        "cursor-oauth" => describe_cursor(tokens, now),
        "devin-oauth" => describe_devin(tokens, now),
        _ => describe_antigravity(tokens, now),
    })
}

/// `isOAuthProviderAvailable(provider)` over the stored `agent.developer` options: a dev-only
/// provider is unknown to settings and login while its option is off. Only a stored boolean counts.
pub fn oauth_available(provider: &str, developer: &Value) -> bool {
    let option = match provider {
        "antigravity-oauth" => "antigravityOAuth",
        "cursor-oauth" => "cursorOAuth",
        "devin-oauth" => "devinOAuth",
        "mimo-oauth" => "mimoOAuth",
        _ => return true,
    };
    developer.get(option) == Some(&Value::Bool(true))
}
