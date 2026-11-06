//! Editor input → stored MCP server config (Node `mcp-glue/server-input.mjs`,
//! `resource-mcp-servers.mjs` and `mergeMcpServerConfig` of `plugin-mcp.mjs`): the name slug, the
//! transport of a URL or a command, the per-server timeouts, and the merge of a partial edit over
//! the stored entry.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use mixdog_js::JsRegex;
use mixdog_js::to_number;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::config::ConfigError;
use crate::config::normalize_url;
use crate::plugin_admin::clean;
use crate::plugin_admin::truthy;

/// The fields a transport edit replaces as a whole (`MCP_TRANSPORT_FIELDS`).
const TRANSPORT_FIELDS: [&str; 13] = [
    "type",
    "transport",
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "headers",
    "bearer_token_env_var",
    "env_http_headers",
    "env_vars",
    "autoDetect",
    "oauthClientId",
];

/// Every spelling the startup and call timeout resolvers read (`MCP_TIMEOUT_FIELD_GROUPS`): a
/// newly supplied value replaces its whole group.
pub const TIMEOUT_FIELD_GROUPS: [&[&str]; 2] = [
    &["startupTimeoutMs", "startup_timeout_ms", "startupTimeoutSec", "startup_timeout_sec"],
    &["timeoutMs", "timeout_ms", "callTimeoutMs", "call_timeout_ms"],
];

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

/// `a || b`.
fn either<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    if truthy(a) { a } else { b }
}

/// `mergeMcpServerConfig(existing, next)`: the stored entry without its transport (and without
/// the timeout groups `next` sets), then `next` over it.
pub fn merge_mcp_server_config(existing: &Value, next: &Value) -> Value {
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    for key in TRANSPORT_FIELDS {
        merged.shift_remove(key);
    }
    let next = next.as_object().cloned().unwrap_or_default();
    for group in TIMEOUT_FIELD_GROUPS {
        if group.iter().any(|f| next.contains_key(*f)) {
            for f in group {
                merged.shift_remove(*f);
            }
        }
    }
    merged.extend(next);
    Value::Object(merged)
}

/// `{ ...value }`: an object's entries, an array's or string's elements under their indexes.
fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(list) => list.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::String(text) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| (i.to_string(), Value::String(String::from_utf16_lossy(&[unit]))))
            .collect(),
        _ => Map::new(),
    }
}

fn transport_type(kind: &Value) -> Value {
    if kind.as_str() == Some("streamable-http") { json!("http") } else { kind.clone() }
}

/// `mergedServerInput(input, existing, originalName)`: UI editors send complete transports;
/// setup may send a partial patch, which is merged over the existing entry, keeping omitted
/// fields (credentials included) unless the transport itself changed.
pub fn merged_server_input(input: &Value, existing: &Value, original_name: &str) -> Value {
    let existing_kind = {
        let kind = field(existing, "type");
        if truthy(kind) { kind.clone() } else if truthy(field(existing, "url")) { json!("http") } else { json!("stdio") }
    };
    let transport_changed = (truthy(field(input, "type")) && transport_type(field(input, "type")) != transport_type(&existing_kind))
        || (truthy(field(input, "command")) && truthy(field(existing, "url")))
        || (truthy(field(input, "url")) && !truthy(field(existing, "url")));
    let mut maps = Map::new();
    if !transport_changed {
        for key in ["env", "headers", "env_http_headers"] {
            if let Some(patch) = input.get(key) {
                let current = field(existing, key);
                let mut merged = if truthy(current) { spread(current) } else { Map::new() };
                merged.extend(spread(patch));
                maps.insert(key.to_owned(), Value::Object(merged));
            }
        }
    }
    let mut out = if transport_changed { Map::new() } else { existing.as_object().cloned().unwrap_or_default() };
    for group in TIMEOUT_FIELD_GROUPS {
        for f in group {
            out.shift_remove(*f);
        }
    }
    out.extend(input.as_object().cloned().unwrap_or_default());
    out.extend(maps);
    let name = clean(field(input, "name"));
    out.insert("name".to_owned(), json!(if name.is_empty() { original_name.to_owned() } else { name }));
    Value::Object(out)
}

/// `coerceStringRecord`: an object's entries as strings, `None` when it has none.
fn string_record(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    let out: Map<String, Value> =
        map.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), Value::String(value_to_string(v)))).collect();
    (!out.is_empty()).then_some(Value::Object(out))
}

fn string_array(value: &Value) -> Vec<Value> {
    value.as_array().map(|list| list.iter().map(clean).filter(|s| !s.is_empty()).map(Value::String).collect()).unwrap_or_default()
}

fn positive_number(value: &Value, label: &str) -> Result<f64, String> {
    let n = to_number(value);
    if n.is_finite() && n > 0.0 { Ok(n) } else { Err(format!("{label} must be a positive number")) }
}

fn number_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

fn present(value: &Value) -> bool {
    !value.is_null() && value != &json!("")
}

/// Per-server timeouts under the keys the client config reads.
fn timeout_fields(input: &Value) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    let startup_sec = {
        let a = field(input, "startupTimeoutSec");
        if a.is_null() { field(input, "startup_timeout_sec") } else { a }
    };
    if present(startup_sec) {
        out.insert("startupTimeoutSec".to_owned(), number_value(positive_number(startup_sec, "startupTimeoutSec")?));
    } else if present(field(input, "startupTimeoutMs")) {
        out.insert("startupTimeoutMs".to_owned(), number_value(positive_number(field(input, "startupTimeoutMs"), "startupTimeoutMs")?));
    }
    if present(field(input, "toolTimeoutSec")) {
        let sec = positive_number(field(input, "toolTimeoutSec"), "toolTimeoutSec")?;
        out.insert("timeoutMs".to_owned(), number_value((sec * 1000.0 + 0.5).floor()));
    } else if present(field(input, "timeoutMs")) {
        let ms = positive_number(field(input, "timeoutMs"), "timeoutMs")?;
        out.insert("timeoutMs".to_owned(), number_value((ms + 0.5).floor()));
    }
    Ok(out)
}

/// `path.resolve(base, path)` without touching the disk.
fn resolve(base: &Path, path: &str) -> PathBuf {
    let joined = if Path::new(path).has_root() { PathBuf::from(path) } else { base.join(path) };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn url_message(error: ConfigError, kind: &str) -> String {
    match error {
        ConfigError::InvalidUrl => format!("MCP {kind} URL is invalid"),
        other => other.to_string(),
    }
}

/// `normalizeMcpServerInput(input)`: the server's name and its stored config.
pub fn normalize_mcp_server_input(input: &Value, current_cwd: &Path, home: &Path) -> Result<(String, Value), String> {
    static NAME_RUNS: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"[^a-z0-9_.-]+", "g"));
    static EDGE_DASHES: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"^-+|-+$", "g"));
    static WS_URL: std::sync::LazyLock<JsRegex> = std::sync::LazyLock::new(|| JsRegex::new_static(r"^wss?://", "i"));
    let lowered = clean(field(input, "name")).to_lowercase();
    let dashed = NAME_RUNS.replace_all_with(&lowered, |_| "-".to_owned());
    let name = EDGE_DASHES.replace_all_with(&dashed, |_| String::new());
    if name.is_empty() {
        return Err("MCP server name is required".to_owned());
    }
    let url = clean(field(input, "url"));
    let kind = clean(field(input, "type")).to_lowercase();
    let mut config = Map::new();
    if !url.is_empty() {
        let kind = match kind.as_str() {
            "sse" => "sse",
            "ws" => "ws",
            "http" | "streamable-http" => "http",
            _ if WS_URL.is_match(&url) => "ws",
            _ => "http",
        };
        let normalized = normalize_url(&url, kind == "ws").map_err(|e| url_message(e, kind))?.to_string();
        let secure = if normalized == format!("{url}/") { url.clone() } else { normalized };
        config.insert("type".to_owned(), json!(kind));
        config.insert("url".to_owned(), json!(secure));
        if let Some(headers) = string_record(field(input, "headers")) {
            config.insert("headers".to_owned(), headers);
        }
        let bearer = clean(either(field(input, "bearer_token_env_var"), field(input, "bearerTokenEnvVar")));
        if !bearer.is_empty() {
            config.insert("bearer_token_env_var".to_owned(), json!(bearer));
        }
        if let Some(env_headers) = string_record(either(field(input, "env_http_headers"), field(input, "envHttpHeaders"))) {
            config.insert("env_http_headers".to_owned(), env_headers);
        }
        let client = clean(field(input, "oauthClientId"));
        if !client.is_empty() {
            config.insert("oauthClientId".to_owned(), json!(client));
        }
    } else {
        let command = clean(field(input, "command"));
        if command.is_empty() {
            return Err("MCP server command or URL is required".to_owned());
        }
        let args: Vec<Value> = match field(input, "args") {
            Value::Array(list) => list.iter().map(|v| value_to_string(v)).filter(|s| !s.is_empty()).map(Value::String).collect(),
            other => split_words(&clean(other)),
        };
        let requested = clean(field(input, "cwd"));
        let expanded = expand_home(&requested, home);
        config.insert("type".to_owned(), json!("stdio"));
        config.insert("command".to_owned(), json!(command));
        config.insert("args".to_owned(), Value::Array(args));
        if !expanded.is_empty() {
            config.insert("cwd".to_owned(), json!(resolve(current_cwd, &expanded).to_string_lossy()));
        }
        if let Some(env) = string_record(field(input, "env")) {
            config.insert("env".to_owned(), env);
        }
        let env_vars = string_array(either(field(input, "env_vars"), field(input, "envVars")));
        if !env_vars.is_empty() {
            config.insert("env_vars".to_owned(), Value::Array(env_vars));
        }
    }
    config.extend(timeout_fields(input)?);
    Ok((name, Value::Object(config)))
}

fn split_words(text: &str) -> Vec<Value> {
    text.split(mixdog_js::is_js_space).filter(|s| !s.is_empty()).map(|s| Value::String(s.to_owned())).collect()
}

/// `replace(/^~(?=$|[\\/])/, homedir())`.
fn expand_home(path: &str, home: &Path) -> String {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => format!("{}{rest}", home.to_string_lossy()),
        _ => path.to_owned(),
    }
}
