//! How a catalog connector is stored and connected (Node `runtime/shared/connector-catalog.mjs`):
//! a connector is ONE server holding its accounts,
//!
//! ```text
//! { type: "http", url: <accounts url>, connector: <id>,
//!   accounts: [{ name, id?, type?, url?, headers?, oauthClientId?, oauthKey?, command?, args?, env? }, …] }
//! ```
//!
//! and each account keeps the transport it connects with. This module reads and edits that shape
//! and builds the server input that connects a catalog entry. Merging the one-account servers of
//! an older version into it is a one-time data migration and not part of the runtime.

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::connectors::Backend;
use crate::connectors::Connector;
use crate::connectors::connector;

/// Mixdog's Gmail app-password server.
pub const GMAIL_APP_PASSWORD_URL: &str = "https://gmail-imap.mixdog.invalid/mcp";
pub const GMAIL_ACCOUNT_HEADER: &str = "X-Mixdog-Gmail-Account";

/// What an account holds as its own connection.
const ACCOUNT_FIELDS: [&str; 8] = ["type", "url", "headers", "oauthClientId", "oauthKey", "command", "args", "env"];

fn is_record(value: &Value) -> bool {
    value.is_object()
}

/// The catalog id a configured server connects: its `connector` marker, `None` for none (or a
/// marker the catalog no longer knows).
pub fn connector_of_server(cfg: &Value) -> Option<&'static Connector> {
    cfg.get("connector").and_then(Value::as_str).and_then(connector)
}

/// The reserved (never resolvable) address of connector `id`'s accounts server.
pub fn accounts_url(id: &str) -> String {
    format!("https://connectors.mixdog.invalid/{}/mcp", encode_uri_component(id))
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The stored accounts of a connector server; none for any other config (a legacy one-account
/// server included).
pub fn accounts_of(cfg: &Value) -> Vec<Value> {
    if connector_of_server(cfg).is_none() {
        return Vec::new();
    }
    let Some(list) = cfg.get("accounts").and_then(Value::as_array) else { return Vec::new() };
    list.iter()
        .filter(|account| {
            is_record(account)
                && account.get("name").and_then(Value::as_str).is_some_and(|n| !n.is_empty())
                && (account.get("url").is_some_and(Value::is_string) || account.get("command").is_some_and(Value::is_string))
        })
        .cloned()
        .collect()
}

/// The one-account server config of `account` of server `cfg` (the shape the account had as a
/// server of its own), named by the account.
pub fn account_server(cfg: &Value, account: &Value) -> Value {
    let mut out = Map::new();
    out.insert("name".to_owned(), account.get("name").cloned().unwrap_or(Value::Null));
    out.insert("type".to_owned(), json!("http"));
    for field in ACCOUNT_FIELDS {
        if let Some(value) = account.get(field) {
            out.insert(field.to_owned(), value.clone());
        }
    }
    out.insert("connector".to_owned(), cfg.get("connector").cloned().unwrap_or(Value::Null));
    Value::Object(out)
}

/// `cfg` without what is an account's own connection: the settings of the server holding its
/// accounts (timeouts, enabled…).
pub fn server_settings(cfg: &Value) -> Map<String, Value> {
    cfg.as_object()
        .map(|map| map.iter().filter(|(key, _)| *key != "accounts" && !ACCOUNT_FIELDS.contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// Every account of `cfg` as its one-account server config.
pub fn account_servers(cfg: &Value) -> Vec<Value> {
    accounts_of(cfg).iter().map(|account| account_server(cfg, account)).collect()
}

/// Whether stored account `account` is switched on (`enabled: false` is off).
pub fn account_enabled(account: &Value) -> bool {
    account.get("enabled") != Some(&Value::Bool(false))
}

/// The switched-on accounts of `cfg` as their one-account server configs.
pub fn live_account_servers(cfg: &Value) -> Vec<Value> {
    accounts_of(cfg).iter().filter(|a| account_enabled(a)).map(|account| account_server(cfg, account)).collect()
}

/// Server `cfg` with its account `name` switched on or off. Off flags the account and switches
/// the server off with its last switched-on account. On drops the flag and switches the server
/// on. Every other entry stays as stored.
pub fn with_account_enabled(cfg: &Value, name: &str, enabled: bool) -> Value {
    let accounts: Vec<Value> = cfg
        .get("accounts")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|account| {
                    if !is_record(account) || account.get("name").and_then(Value::as_str) != Some(name) {
                        return account.clone();
                    }
                    let mut rest = account.as_object().cloned().unwrap_or_default();
                    rest.shift_remove("enabled");
                    if !enabled {
                        rest.insert("enabled".to_owned(), Value::Bool(false));
                    }
                    Value::Object(rest)
                })
                .collect()
        })
        .unwrap_or_default();
    let mut next = cfg.as_object().cloned().unwrap_or_default();
    next.insert("accounts".to_owned(), Value::Array(accounts));
    if enabled {
        next.insert("enabled".to_owned(), Value::Bool(true));
        return Value::Object(next);
    }
    let next = Value::Object(next);
    if accounts_of(&next).iter().any(account_enabled) {
        return next;
    }
    let mut off = next.as_object().cloned().unwrap_or_default();
    off.insert("enabled".to_owned(), Value::Bool(false));
    Value::Object(off)
}

/// The stored account entry of one-account config `cfg` under `name` (an http transport is the
/// default and is not stored).
pub fn account_entry(name: &str, cfg: &Value) -> Value {
    let mut out = Map::new();
    out.insert("name".to_owned(), json!(name));
    for field in ACCOUNT_FIELDS {
        if let Some(value) = cfg.get(field) {
            out.insert(field.to_owned(), value.clone());
        }
    }
    if out.get("type") == Some(&json!("http")) {
        out.shift_remove("type");
    }
    Value::Object(out)
}

/// The multi-account connector account `name` names in `servers`.
pub struct AccountTarget {
    pub server_name: String,
    pub cfg: Value,
    pub account: Value,
    pub account_cfg: Value,
}

pub fn account_target(servers: &Map<String, Value>, name: &str) -> Option<AccountTarget> {
    for (server_name, cfg) in servers {
        let account = accounts_of(cfg).into_iter().find(|entry| entry.get("name").and_then(Value::as_str) == Some(name));
        if let Some(account) = account {
            let account_cfg = account_server(cfg, &account);
            return Some(AccountTarget { server_name: server_name.clone(), cfg: cfg.clone(), account, account_cfg });
        }
    }
    None
}

/// The refusal of a new server name that is taken. A name a connector account holds is an
/// account to the user (never a server), so it says so.
pub fn name_taken_message(servers: &Map<String, Value>, name: &str) -> String {
    let holder = account_target(servers, name).and_then(|h| connector_of_server(&h.cfg));
    match holder {
        Some(connector) => format!("The name \"{name}\" is used by a {} account. Choose another name.", connector.name),
        None => format!("MCP server already exists: {name}"),
    }
}

// ── Gmail ────────────────────────────────────────────────────────────────────────────────────

fn url_key(url: &str) -> String {
    let trimmed = js_trim(url);
    trimmed.trim_end_matches('/').to_lowercase()
}

/// A Gmail address as typed (trimmed, lowercased), or "" when it is none.
pub fn gmail_address(value: &Value) -> String {
    static EMAIL: std::sync::LazyLock<JsRegex> =
        std::sync::LazyLock::new(|| JsRegex::new_static(r#"^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]+$"#, ""));
    let address = if value.is_null() { String::new() } else { js_trim(&mixdog_js::value_to_string(value)).to_lowercase() };
    if EMAIL.is_match(&address) { address } else { String::new() }
}

/// A Google app password as typed, its spaces removed; "" unless it then has the 16 characters
/// Google issues.
pub fn gmail_app_password_value(value: &Value) -> String {
    let text = if value.is_null() { String::new() } else { mixdog_js::value_to_string(value) };
    let password: String = text.chars().filter(|c| !mixdog_js::is_js_space(*c)).collect();
    if utf16_len(&password) == 16 { password } else { String::new() }
}

/// The account of a Gmail app-password server config, "" for any other.
pub fn gmail_app_password_account(cfg: &Value) -> String {
    let url = cfg.get("url").map(|u| if u.is_null() { String::new() } else { mixdog_js::value_to_string(u) }).unwrap_or_default();
    if url_key(&url) != url_key(GMAIL_APP_PASSWORD_URL) {
        return String::new();
    }
    let Some(headers) = cfg.get("headers").and_then(Value::as_object) else { return String::new() };
    let wanted = GMAIL_ACCOUNT_HEADER.to_lowercase();
    headers.iter().find(|(name, _)| name.to_lowercase() == wanted).map(|(_, value)| gmail_address(value)).unwrap_or_default()
}

/// The MCP server input that connects Gmail under `name` as `email` with an app password.
pub fn gmail_app_password_server_input(name: &str, email: &Value, password: &Value) -> Result<Value, String> {
    let address = gmail_address(email);
    if address.is_empty() {
        return Err("GMAIL_APP_PASSWORD_ADDRESS: Enter a Gmail address.".to_owned());
    }
    let app_password = gmail_app_password_value(password);
    if app_password.is_empty() {
        return Err("GMAIL_APP_PASSWORD_FORMAT: An app password has 16 characters.".to_owned());
    }
    Ok(json!({
        "name": name,
        "type": "http",
        "url": GMAIL_APP_PASSWORD_URL,
        "headers": { (GMAIL_ACCOUNT_HEADER): address },
        "connector": "gmail",
        "appPassword": app_password,
    }))
}

/// The MCP server input that connects catalog entry `entry` under `name`; `key` fills an apiKey
/// backend.
pub fn connector_server_input(entry: &Connector, name: &str, key: &Value) -> Result<Value, String> {
    match &entry.backend {
        Backend::OAuth { url } => Ok(json!({"name": name, "type": "http", "url": url, "connector": entry.id})),
        Backend::ApiKey { url, header, prefix, command, args, env } => {
            let value = if key.is_null() || !crate::plugin_admin::truthy(key) { String::new() } else { js_trim(&mixdog_js::value_to_string(key)).to_owned() };
            if value.is_empty() {
                return Err(format!("{} needs a key", entry.name));
            }
            Ok(match url {
                Some(url) => json!({
                    "name": name,
                    "type": "http",
                    "url": url,
                    "headers": { (*header): format!("{prefix}{value}") },
                    "connector": entry.id,
                }),
                None => json!({
                    "name": name,
                    "type": "stdio",
                    "command": command,
                    "args": args,
                    "env": { (*env): value },
                    "connector": entry.id,
                }),
            })
        }
    }
}
