//! The credential files of the ten OAuth providers and how each provider loads them
//! (`loadTokens()` / `loadCredentials()` / `loadStoredCredentials()` of the
//! `agent/orchestrator/providers/*` modules): where the file is, which documents are a sign-in,
//! and the document the describe functions read ([`describe_oauth`](super::oauth_status::describe_oauth)).
//!
//! Every function here reads files, so a caller runs it in a lane job. The loaded document leaves
//! out `mtimeMs`: the describe functions never read it. An account binding (`withProviderAccount`)
//! is the caller's: it passes the bound file as `path`. Not here: the model-proxy client mode,
//! where every loader answers nothing.

use std::path::Path;
use std::path::PathBuf;

use mixdog_ai::accounts::validity::signed_in_until;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::oauth_status::decode_jwt_payload;
use super::oauth_status::expiry_from_access_token;
use super::oauth_status::js_number;
use super::oauth_status::normalize_account_identity;
use super::oauth_status::normalize_expires_at_ms;
use super::oauth_status::number;
use super::oauth_status::truthy;

const SOURCE_OWN: &str = "Mixdog token store";
const MIMO_DEFAULT_BASE_URL: &str = "https://api.xiaomimimo.com/v1";
const OPENAI_AUTH_CLAIM: &str = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM: &str = "https://api.openai.com/profile";

/// `(provider, file in the data folder, variable that names another file)`.
const FILES: [(&str, &str, &str); 10] = [
    ("openai-oauth", "openai-oauth.json", "OPENAI_OAUTH_CREDENTIALS_PATH"),
    ("anthropic-oauth", "anthropic-oauth-credentials.json", "ANTHROPIC_OAUTH_CREDENTIALS_PATH"),
    ("grok-oauth", "grok-oauth.json", "GROK_OAUTH_CREDENTIALS_PATH"),
    ("muse-code-oauth", "muse-code-oauth.json", "MUSE_CODE_OAUTH_CREDENTIALS_PATH"),
    ("command-code-oauth", "command-code-oauth.json", "COMMAND_CODE_OAUTH_CREDENTIALS_PATH"),
    ("opencode-go-oauth", "opencode-go-oauth.json", "OPENCODE_GO_OAUTH_CREDENTIALS_PATH"),
    ("mimo-oauth", "mimo-oauth.json", "MIMO_OAUTH_CREDENTIALS_PATH"),
    ("cursor-oauth", "cursor-oauth.json", "CURSOR_OAUTH_CREDENTIALS_PATH"),
    ("devin-oauth", "devin-oauth.json", "DEVIN_OAUTH_CREDENTIALS_PATH"),
    ("antigravity-oauth", "antigravity-oauth.json", "ANTIGRAVITY_OAUTH_CREDENTIALS_PATH"),
];

/// The credential file of `provider` without an account binding: the file the provider's
/// `*_OAUTH_CREDENTIALS_PATH` variable names (resolved against `cwd`), else its file in the
/// plugin data folder. `None` for a provider that is not one of the ten.
pub fn credential_file(provider: &str, env: &dyn Fn(&str) -> Option<String>, cwd: &Path, plugin_data: &Path) -> Option<PathBuf> {
    let (_, file, variable) = FILES.iter().find(|(id, _, _)| *id == provider)?;
    match env(variable).filter(|path| !path.is_empty()) {
        Some(explicit) => {
            let explicit = PathBuf::from(explicit);
            Some(if explicit.is_absolute() { explicit } else { cwd.join(explicit) })
        }
        None => Some(plugin_data.join(file)),
    }
}

fn read_document(path: &Path) -> Option<Value> {
    // The one disk read of an OAuth credential file on the describe path; it does not pass `mixdog_ai`'s `CredentialFile`.
    #[cfg(feature = "count-work")]
    mixdog_ai::work::credential_read();
    let bytes = mixdog_statefile::read_content(path).ok()??;
    serde_json::from_slice(&bytes).ok()
}

/// `String(value)` for what a credential file holds.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".to_owned(),
        _ => "[object Object]".to_owned(),
    }
}

/// `a || b || ...`: the first truthy value, else `Null`.
fn first_truthy(values: &[Option<&Value>]) -> Value {
    values.iter().copied().flatten().find(|value| truthy(Some(value))).cloned().unwrap_or(Value::Null)
}

/// `value || ''`.
fn or_empty(value: Value) -> Value {
    if value.is_null() { json!("") } else { value }
}

/// `String(token || '')`.
fn token_text(value: Option<&Value>) -> String {
    value.filter(|value| truthy(Some(value))).map(js_string).unwrap_or_default()
}

/// `text(value)` of the token stores: a string, trimmed; `''` otherwise.
fn trimmed(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(|text| text.trim().to_owned()).unwrap_or_default()
}

fn non_empty_string(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty())
}

/// `emailFromJwts(...tokens)`: the first token carrying a non-blank `email` claim, trimmed.
fn email_from_jwts(tokens: &[String]) -> String {
    for token in tokens {
        let email = decode_jwt_payload(token).and_then(|claims| claims.get("email").and_then(Value::as_str).map(|email| email.trim().to_owned()));
        if let Some(email) = email.filter(|email| !email.is_empty()) {
            return email;
        }
    }
    String::new()
}

/// `value ?? fallback` needs the value to be neither null nor missing.
fn non_null(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// `identityFromTokens(...tokens)` of `openai-oauth-tokens.mjs`: `<sub>:<chatgpt_account_id>` and the email.
fn openai_identity(tokens: &[String]) -> Option<Value> {
    let (mut email, mut account_id, mut sub) = (Value::Null, Value::Null, Value::Null);
    for token in tokens {
        let Some(claims) = decode_jwt_payload(token) else { continue };
        let auth = claims.get(OPENAI_AUTH_CLAIM).cloned().unwrap_or_else(|| json!({}));
        let profile = claims.get(OPENAI_PROFILE_CLAIM).cloned().unwrap_or_else(|| json!({}));
        if !truthy(Some(&email)) {
            email = first_truthy(&[claims.get("email"), profile.get("email")]);
        }
        if !truthy(Some(&account_id)) {
            account_id = first_truthy(&[auth.get("chatgpt_account_id")]);
        }
        if !truthy(Some(&sub)) {
            sub = first_truthy(&[claims.get("sub")]);
        }
    }
    let id = [&sub, &account_id].into_iter().filter(|part| truthy(Some(part))).map(js_string).collect::<Vec<_>>().join(":");
    normalize_account_identity(Some(&json!({ "id": id, "email": or_empty(email) })))
}

fn load_openai(raw: &Value, now: f64) -> Option<Value> {
    // Not an object: no `access_token`, so never a sign-in (Node's `raw?.access_token`).
    if raw.as_object().map_or(0.0, signed_in_until) <= now {
        return None;
    }
    let own = raw.as_object()?;
    let tokens = [token_text(own.get("id_token")), token_text(own.get("access_token"))];
    let access = &tokens[1];
    let mut out = own.clone();
    let identity = normalize_account_identity(own.get("identity")).or_else(|| openai_identity(&tokens));
    out.insert("identity".into(), identity.unwrap_or(Value::Null));
    let stored = normalize_expires_at_ms(non_null(own.get("expires_at")).or(own.get("expiresAt")));
    out.insert("expires_at".into(), number(if stored != 0.0 { stored } else { expiry_from_access_token(access) }));
    if !truthy(own.get("account_id")) {
        let extracted = decode_jwt_payload(access).and_then(|claims| claims.get(OPENAI_AUTH_CLAIM).and_then(|auth| auth.get("chatgpt_account_id")).cloned());
        match extracted {
            Some(account_id) => {
                out.insert("account_id".into(), account_id);
            }
            None => {
                out.shift_remove("account_id");
            }
        }
    }
    out.insert("source".into(), json!(SOURCE_OWN));
    Some(Value::Object(out))
}

fn load_grok(raw: &Value) -> Option<Value> {
    if !truthy(raw.get("access_token")) || !truthy(raw.get("refresh_token")) {
        return None;
    }
    let access = token_text(raw.get("access_token"));
    // `_identityFromAccessToken`
    let claims = decode_jwt_payload(&access).unwrap_or_default();
    let principal_id = first_truthy(&[claims.get("principal_id"), claims.get("principalId")]);
    let principal_type = first_truthy(&[claims.get("principal_type"), claims.get("principalType")]);
    let user_id = first_truthy(&[claims.get("user_id"), claims.get("userId"), Some(&principal_id), claims.get("sub")]);
    let text_of = |value: &Value| if truthy(Some(value)) { json!(js_string(value)) } else { Value::Null };
    let (claim_user, claim_type, claim_principal) = (text_of(&user_id), text_of(&principal_type), text_of(&principal_id));
    let stored = normalize_expires_at_ms(non_null(raw.get("expires_at")).or(raw.get("expiresAt")));
    let mut out = Map::new();
    out.insert("access_token".into(), raw["access_token"].clone());
    out.insert("refresh_token".into(), raw["refresh_token"].clone());
    out.insert("expires_at".into(), number(if stored != 0.0 { stored } else { expiry_from_access_token(&access) }));
    out.insert("token_endpoint".into(), if truthy(raw.get("token_endpoint")) { raw["token_endpoint"].clone() } else { Value::Null });
    out.insert("user_id".into(), or_empty(first_truthy(&[raw.get("user_id"), raw.get("userId"), Some(&claim_user)])));
    out.insert("principal_type".into(), or_empty(first_truthy(&[raw.get("principal_type"), raw.get("principalType"), Some(&claim_type)])));
    out.insert("principal_id".into(), or_empty(first_truthy(&[raw.get("principal_id"), raw.get("principalId"), Some(&claim_principal)])));
    let email = if truthy(raw.get("email")) {
        raw["email"].clone()
    } else {
        json!(email_from_jwts(&[token_text(raw.get("id_token")), access]))
    };
    out.insert("email".into(), email);
    out.insert("source".into(), json!("own"));
    Some(Value::Object(out))
}

fn load_muse_code(raw: &Value) -> Option<Value> {
    if !non_empty_string(raw.get("accessToken")) || !non_empty_string(raw.get("apiKey")) {
        return None;
    }
    Some(json!({
        "accessToken": raw["accessToken"],
        "apiKey": raw["apiKey"],
        "accountId": or_empty(first_truthy(&[raw.get("accountId")])),
        "email": or_empty(first_truthy(&[raw.get("email")])),
    }))
}

fn load_command_code(raw: &Value) -> Option<Value> {
    let api_key = trimmed(raw.get("apiKey"));
    if api_key.is_empty() {
        return None;
    }
    Some(json!({ "apiKey": api_key, "userId": trimmed(raw.get("userId")), "userName": trimmed(raw.get("userName")) }))
}

fn load_opencode_go(raw: &Value) -> Option<Value> {
    if trimmed(raw.get("access_token")).is_empty() || trimmed(raw.get("refresh_token")).is_empty() {
        return None;
    }
    Some(json!({
        "access_token": raw["access_token"],
        "refresh_token": raw["refresh_token"],
        "expires_at": number(js_number(raw.get("expires_at"))),
        "account_id": trimmed(raw.get("account_id")),
        "email": trimmed(raw.get("email")),
        "org_id": trimmed(raw.get("org_id")),
        "org_name": trimmed(raw.get("org_name")),
    }))
}

fn load_mimo(raw: &Value) -> Option<Value> {
    if !truthy(raw.get("apiKey")) {
        return None;
    }
    let base_url = first_truthy(&[raw.get("baseUrl")]);
    Some(json!({
        "apiKey": js_string(&raw["apiKey"]),
        "uid": if truthy(raw.get("uid")) { js_string(&raw["uid"]) } else { String::new() },
        "baseUrl": if base_url.is_null() { json!(MIMO_DEFAULT_BASE_URL) } else { base_url },
        "source": "own",
    }))
}

fn load_antigravity(raw: &Value) -> Option<Value> {
    if !truthy(raw.get("access_token")) || !truthy(raw.get("refresh_token")) {
        return None;
    }
    let string_of = |values: &[Option<&Value>]| js_string(&or_empty(first_truthy(values)));
    Some(json!({
        "access_token": js_string(&raw["access_token"]),
        "refresh_token": js_string(&raw["refresh_token"]),
        "expires_at": number(normalize_expires_at_ms(non_null(raw.get("expires_at")).or(raw.get("expiresAt")))),
        "project_id": string_of(&[raw.get("project_id"), raw.get("projectId")]),
        "tier_id": string_of(&[raw.get("tier_id")]),
        "email": string_of(&[raw.get("email")]),
        "user_id": string_of(&[raw.get("user_id"), raw.get("userId")]),
        "source": "own",
    }))
}

fn load_anthropic(raw: &Value, path: &Path) -> Option<Value> {
    let oauth = raw.get("claudeAiOauth")?;
    if !truthy(oauth.get("accessToken")) {
        return None;
    }
    let stored = normalize_expires_at_ms(non_null(oauth.get("expiresAt")).or(oauth.get("expires_at")));
    let expires_at = if stored != 0.0 { stored } else { expiry_from_access_token(&token_text(oauth.get("accessToken"))) };
    Some(json!({
        "path": path.to_string_lossy(),
        "accessToken": oauth["accessToken"],
        "refreshToken": if truthy(oauth.get("refreshToken")) { oauth["refreshToken"].clone() } else { Value::Null },
        "reauthRequired": oauth.get("reauthRequired") == Some(&Value::Bool(true)),
        "expiresAt": number(expires_at),
        "scopes": oauth.get("scopes").filter(|scopes| scopes.is_array()).cloned().unwrap_or_else(|| json!([])),
        "subscriptionType": if truthy(oauth.get("subscriptionType")) { oauth["subscriptionType"].clone() } else { Value::Null },
        "identity": normalize_account_identity(oauth.get("identity")).unwrap_or(Value::Null),
    }))
}

/// `{ ...raw, expires_at, identity, source }` of the cursor and devin stores: the stored expiry
/// (as `Number(...) || 0`), else the access token's; the stored identity, else the token's `sub`/`email`.
fn load_token_file(raw: &Value) -> Option<Value> {
    if !truthy(raw.get("access_token")) {
        return None;
    }
    let mut out = raw.as_object()?.clone();
    let access = token_text(raw.get("access_token"));
    let stored = js_number(raw.get("expires_at"));
    out.insert("expires_at".into(), number(if stored != 0.0 { stored } else { expiry_from_access_token(&access) }));
    let from_token = decode_jwt_payload(&access).and_then(|claims| normalize_account_identity(Some(&json!({ "id": claims.get("sub"), "email": claims.get("email") }))));
    out.insert("identity".into(), normalize_account_identity(raw.get("identity")).or(from_token).unwrap_or(Value::Null));
    out.insert("source".into(), json!(SOURCE_OWN));
    Some(Value::Object(out))
}

/// The loaded document of `provider`'s credential file at `path` (`None` when the file is missing,
/// unreadable or not a sign-in), as its `loadTokens()` returns it. `now_ms` is `Date.now()`;
/// `cursor_env_token` is `CURSOR_ACCESS_TOKEN` (it stands in for the file, unless an account is bound).
pub fn load_oauth_credentials(provider: &str, path: &Path, now_ms: i64, cursor_env_token: Option<&str>) -> Option<Value> {
    let env_token = cursor_env_token.filter(|token| provider == "cursor-oauth" && !token.is_empty());
    if let Some(token) = env_token {
        return Some(json!({
            "access_token": token,
            "refresh_token": Value::Null,
            "expires_at": number(expiry_from_access_token(token)),
            "source": "CURSOR_ACCESS_TOKEN",
        }));
    }
    let raw = read_document(path)?;
    match provider {
        "openai-oauth" => load_openai(&raw, now_ms as f64),
        "anthropic-oauth" => load_anthropic(&raw, path),
        "grok-oauth" => load_grok(&raw),
        "muse-code-oauth" => load_muse_code(&raw),
        "command-code-oauth" => load_command_code(&raw),
        "opencode-go-oauth" => load_opencode_go(&raw),
        "mimo-oauth" => load_mimo(&raw),
        "cursor-oauth" | "devin-oauth" => load_token_file(&raw),
        "antigravity-oauth" => load_antigravity(&raw),
        _ => None,
    }
}
