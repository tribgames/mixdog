//! Interpreting one MCP server entry (T §4): transport kind, `${VAR}` expansion, stdio
//! environment, HTTP headers, URL policy and the per-server numbers. Every number the Node
//! client fixed in code is a field here, defaulting to the old value.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::time::Duration;

use mixdog_core_api::domain::approval::ActionKind;
use mixdog_js::js_trim;
use mixdog_js::string_to_number;
use mixdog_js::utf16_len;
use serde_json::Value;
use url::Url;

/// A process environment as a plain map, so resolution is a pure function of its inputs.
pub type Env = HashMap<String, String>;

pub const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(120);
pub const DEFAULT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_MAX_TOTAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_MAX_QUEUE: usize = 256;
pub const DEFAULT_MIN_OWNER_QUEUE: usize = 8;
pub const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum TransportConfig {
    Stdio {
        command: String,
        args: Vec<String>,
        /// The complete child environment.
        env: BTreeMap<String, String>,
        cwd: Option<String>,
    },
    /// Streamable HTTP.
    Http {
        url: Url,
        headers: BTreeMap<String, String>,
    },
    /// Legacy HTTP+SSE: a GET event stream announces the endpoint messages are POSTed to.
    Sse {
        url: Url,
        headers: BTreeMap<String, String>,
    },
    WebSocket {
        url: Url,
        headers: BTreeMap<String, String>,
    },
}

/// A client secret held in memory; never printed.
#[derive(Clone, PartialEq, Eq)]
pub struct InlineSecret(pub String);

impl std::fmt::Debug for InlineSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

/// A pre-registered OAuth client, used in place of dynamic client registration.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StaticClient {
    pub client_id: String,
    /// The secret-store account of the user's client secret.
    pub secret_account: String,
    /// The secret of the build's own client (Google's non-confidential desktop secret).
    pub inline_secret: Option<InlineSecret>,
    pub scopes: Vec<String>,
    /// Extra authorization-URL parameters the provider needs (Google's offline access).
    pub auth_params: BTreeMap<String, String>,
}

/// How an HTTP/SSE server signs in when no authentication is configured.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct OAuthBinding {
    /// The exact server URL (also the RFC 8707 resource).
    pub url: Url,
    /// What the sign-in is stored under: the exact URL, or a connector account's own key.
    pub credential_key: String,
    /// What the sign-in page calls the server.
    pub display_name: String,
    pub client: Option<StaticClient>,
    /// A catalog connector that needs a built-in sign-in client this build has none of.
    pub client_unavailable: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct McpServerConfig {
    pub name: String,
    pub enabled: bool,
    pub transport: TransportConfig,
    /// `None`: the client imposes no in-flight cap of its own.
    pub max_concurrency: Option<usize>,
    pub max_queue: usize,
    pub min_owner_queue: usize,
    pub wait_timeout: Duration,
    /// Bound of the connect and the first tool listing. `None`: disabled, the connect may never settle.
    pub startup_timeout: Option<Duration>,
    /// Idle bound of one call, reset by each progress notification. `None`: disabled.
    pub call_timeout: Option<Duration>,
    /// Hard ceiling of a call that keeps reporting progress. `None`: disabled.
    pub max_total_timeout: Option<Duration>,
    pub shutdown_grace: Duration,
    /// Outbound action kind each tool performs, declared per server (T §6 #14): the policy
    /// asks for these tools instead of guessing from tool names.
    pub outbound_kinds: BTreeMap<String, ActionKind>,
    /// The catalog connector this server connects (`connector` in the entry), if it names one.
    pub connector: Option<String>,
    /// Set for an HTTP/SSE server with no configured authentication.
    pub oauth: Option<OAuthBinding>,
    /// The plugin that declared the server (`_mixdogPlugin.id`, Node's `mcpPluginId`): its scope limits the server too.
    pub plugin_id: Option<String>,
    /// `_mixdogRootsFollowScope`: the root the client advertises is its scope's current folder, and the server is told
    /// when that changes (`createMcpClient`, mcp/client.mjs:1569).
    pub roots_follow_scope: bool,
    /// The fixed root the client advertises (`_mixdogProjectRoot`, else `cwd`); none: no root of its own.
    pub project_root: Option<String>,
    /// What the configuration could not resolve but connects with anyway (`missingEnvWarnings`: the unset variables of a
    /// server that is not strict about them, names only); logged at each connect.
    pub warnings: Vec<String>,
    /// Why the server cannot connect: the plugin data folder it needs could not be made (`ensurePluginServerData`
    /// throws before its connect). The connect fails with this text.
    pub blocked: Option<String>,
}

/// `mcpLog` (mcp/client.mjs:147): the client's own log lines are dropped while `MIXDOG_QUIET_MCP_LOG` is set to
/// anything but the empty string.
pub fn log_quiet() -> bool {
    quiet(std::env::var_os("MIXDOG_QUIET_MCP_LOG").as_deref())
}

fn quiet(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

/// One line of the MCP client's log (`mcpLog`), unless it is quiet.
pub(crate) fn mcp_log(line: &str) {
    if !log_quiet() {
        tracing::warn!("{line}");
    }
}

/// The wire name of an [`ActionKind`] in config.
pub fn parse_action_kind(name: &str) -> Option<ActionKind> {
    Some(match name {
        "comment" => ActionKind::Comment,
        "review" => ActionKind::Review,
        "message" => ActionKind::Message,
        "email" => ActionKind::Email,
        "publish" => ActionKind::Publish,
        "form" => ActionKind::Form,
        "payment" => ActionKind::Payment,
        "delete" => ActionKind::Delete,
        "trash" => ActionKind::Trash,
        "browserSubmit" => ActionKind::BrowserSubmit,
        "browserPost" => ActionKind::BrowserPost,
        "browserUpload" => ActionKind::BrowserUpload,
        _ => return None,
    })
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("server entry must be an object")]
    NotAnObject,
    #[error("\"type\" must be one of stdio, http, streamable-http, sse, ws")]
    UnknownType,
    #[error("need type (stdio/http/sse/ws), url (http), or command (stdio)")]
    NoTransport,
    #[error("stdio server requires \"command\"")]
    MissingCommand,
    #[error("{0} server requires \"url\"")]
    MissingUrl(&'static str),
    #[error("MCP URL is invalid")]
    InvalidUrl,
    #[error("MCP URLs must not contain credentials")]
    UrlCredentials,
    #[error("MCP URLs must use https://; http:// is allowed only for loopback")]
    InsecureUrl,
    #[error("MCP WebSocket URLs must use wss://; ws:// is allowed only for loopback")]
    InsecureWebSocketUrl,
    /// `missingEnvWarnings` under `strictEnv`: the names of the unset variables, never their values.
    #[error("missing environment variable(s): {}", .0.join(", "))]
    MissingEnv(Vec<String>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TransportKind {
    Stdio,
    Http,
    Sse,
    WebSocket,
}

/// The transport an entry asks for: explicit `type`, then `transport: "http"`, then `command`,
/// then `url`.
pub fn transport_kind(entry: &Value) -> Result<TransportKind, ConfigError> {
    let explicit = entry.get("type").filter(|v| !v.is_null() && v.as_str() != Some(""));
    if let Some(value) = explicit {
        let kind = value.as_str().map(str::to_lowercase);
        return match kind.as_deref() {
            Some("stdio") => Ok(TransportKind::Stdio),
            Some("http" | "streamable-http" | "streamablehttp") => Ok(TransportKind::Http),
            Some("sse") => Ok(TransportKind::Sse),
            Some("ws") => Ok(TransportKind::WebSocket),
            _ => Err(ConfigError::UnknownType),
        };
    }
    if entry.get("transport").and_then(Value::as_str) == Some("http") {
        return Ok(TransportKind::Http);
    }
    if truthy(entry.get("command")) {
        return Ok(TransportKind::Stdio);
    }
    if truthy(entry.get("url")) {
        return Ok(TransportKind::Http);
    }
    Err(ConfigError::NoTransport)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Expands `${VAR}`, `${env:VAR}` and `${VAR:-default}`. The default applies only when the
/// variable is unset and runs to the first `}`. An unset variable without a default expands to
/// the empty string and is recorded in `missing`.
pub fn expand_env(text: &str, env: &Env, missing: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match parse_reference(after) {
            Some((name, default, consumed)) => {
                match env_lookup(env, name) {
                    Some(value) => out.push_str(value),
                    None => match default {
                        Some(default) => out.push_str(default),
                        None => {
                            if !missing.iter().any(|m| m == name) {
                                missing.push(name.to_owned());
                            }
                        }
                    },
                }
                rest = &after[consumed..];
            }
            None => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `(name, default, bytes consumed after "${")` of a well-formed reference.
fn parse_reference(after: &str) -> Option<(&str, Option<&str>, usize)> {
    let body = after.strip_prefix("env:").unwrap_or(after);
    let skipped = after.len() - body.len();
    let name_len = body
        .char_indices()
        .take_while(|(i, c)| c.is_ascii_alphabetic() || *c == '_' || (*i > 0 && c.is_ascii_digit()))
        .count();
    if name_len == 0 {
        return None;
    }
    let name = &body[..name_len];
    let tail = &body[name_len..];
    if tail.starts_with('}') {
        return Some((name, None, skipped + name_len + 1));
    }
    let default_and_rest = tail.strip_prefix(":-")?;
    let close = default_and_rest.find('}')?;
    Some((name, Some(&default_and_rest[..close]), skipped + name_len + 2 + close + 1))
}

fn env_lookup<'a>(env: &'a Env, name: &str) -> Option<&'a str> {
    if cfg!(windows) {
        env.iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    } else {
        env.get(name).map(String::as_str)
    }
}

const STDIO_BASE_ENV: &[&str] = if cfg!(windows) {
    &[
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERDOMAIN",
        "USERNAME",
        "USERPROFILE",
    ]
} else {
    &["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]
};

fn string_map(value: Option<&Value>) -> Vec<(String, String)> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(k, v)| {
                    let text = match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    (k.clone(), text)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The child environment: the whole process environment plus `env`, unless `env_vars` is
/// given, in which case only the base keys, the named keys and `env`.
fn stdio_environment(entry: &Value, env: &Env, missing: &mut Vec<String>) -> BTreeMap<String, String> {
    let explicit: Vec<(String, String)> = string_map(entry.get("env"))
        .into_iter()
        .map(|(k, v)| (k, expand_env(&v, env, missing)))
        .collect();
    let mut out: BTreeMap<String, String> = match entry.get("env_vars").and_then(Value::as_array) {
        None => env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Some(named) => {
            let mut inherited = BTreeMap::new();
            let wanted = STDIO_BASE_ENV
                .iter()
                .map(|s| (*s).to_owned())
                .chain(named.iter().filter_map(Value::as_str).map(|s| js_trim(s).to_owned()))
                .filter(|s| !s.is_empty());
            for key in wanted {
                if let Some((actual, value)) = env
                    .iter()
                    .find(|(k, _)| if cfg!(windows) { k.eq_ignore_ascii_case(&key) } else { **k == key })
                {
                    inherited.insert(actual.clone(), value.clone());
                }
            }
            inherited
        }
    };
    out.extend(explicit);
    out
}

fn http_headers(entry: &Value, env: &Env, missing: &mut Vec<String>) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    for (header, env_name) in string_map(entry.get("env_http_headers")) {
        if let Some(value) = env.get(&env_name).filter(|v| !v.is_empty()) {
            headers.insert(header, value.clone());
        }
    }
    if let Some(name) = entry.get("bearer_token_env_var").and_then(Value::as_str)
        && let Some(value) = env.get(js_trim(name)).filter(|v| !v.is_empty())
    {
        headers.insert("Authorization".to_owned(), format!("Bearer {value}"));
    }
    for (header, value) in string_map(entry.get("headers")) {
        headers.insert(header, expand_env(&value, env, missing));
    }
    headers
}

/// Configured authentication stays authoritative even when its variables are unset or resolve
/// empty: the server then fails as configured instead of turning into an OAuth login.
fn has_configured_auth(entry: &Value) -> bool {
    let configured = |key: &str| entry.get(key).and_then(Value::as_object).is_some_and(|m| !m.is_empty());
    entry
        .get("bearer_token_env_var")
        .and_then(Value::as_str)
        .is_some_and(|name| !js_trim(name).is_empty())
        || configured("headers")
        || configured("env_http_headers")
}

fn is_loopback(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host == "::1"
        || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

/// Validates an HTTP/SSE/WebSocket URL: no credentials; TLS except for loopback.
pub fn normalize_url(raw: &str, websocket: bool) -> Result<Url, ConfigError> {
    let mut url = Url::parse(js_trim(raw)).map_err(|_| ConfigError::InvalidUrl)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigError::UrlCredentials);
    }
    let loopback = url.host_str().is_some_and(is_loopback);
    let scheme = url.scheme();
    let encrypted = if websocket {
        matches!(scheme, "wss" | "https")
    } else {
        scheme == "https"
    };
    let local_plaintext = loopback
        && if websocket {
            matches!(scheme, "ws" | "http")
        } else {
            scheme == "http"
        };
    if !encrypted && !local_plaintext {
        return Err(if websocket {
            ConfigError::InsecureWebSocketUrl
        } else {
            ConfigError::InsecureUrl
        });
    }
    url.set_fragment(None);
    Ok(url)
}

fn duration_ms(entry: &Value, keys: &[&str], seconds_keys: &[&str]) -> Option<Option<Duration>> {
    for key in keys {
        if let Some(parsed) = entry.get(*key).and_then(number_or_off) {
            return Some(parsed.map(Duration::from_millis));
        }
    }
    for key in seconds_keys {
        if let Some(parsed) = entry.get(*key).and_then(number_or_off) {
            return Some(parsed.map(|s| Duration::from_millis(s.saturating_mul(1000))));
        }
    }
    None
}

/// Node's largest timer (`MCP_MAX_TIMER_MS`).
const MAX_TIMER_MS: f64 = 2_147_483_647.0;

/// `resolveMcpStartupTimeoutMs`: the entry's milliseconds, else its seconds, else the environment's
/// `MIXDOG_MCP_STARTUP_TIMEOUT_MS`, else the default. The first of them that is set decides alone: `0`, `off`,
/// `none` or `false` in it disables the budget (`None`), and anything unusable in it is the default.
fn startup_timeout(entry: &Value, env: &Env) -> Option<Duration> {
    // `a ?? b`, then `!= null && !== ''`.
    let set = |a: &str, b: &str| {
        entry.get(a).filter(|v| !v.is_null()).or_else(|| entry.get(b)).filter(|v| !v.is_null() && v.as_str() != Some("")).cloned()
    };
    let (raw, scale) = if let Some(ms) = set("startupTimeoutMs", "startup_timeout_ms") {
        (ms, 1.0)
    } else if let Some(seconds) = set("startupTimeoutSec", "startup_timeout_sec") {
        (seconds, 1000.0)
    } else if let Some(text) = env.get("MIXDOG_MCP_STARTUP_TIMEOUT_MS").filter(|text| !text.is_empty()) {
        (Value::String(text.clone()), 1.0)
    } else {
        return Some(DEFAULT_STARTUP_TIMEOUT);
    };
    let number = match &raw {
        Value::Number(n) if n.as_f64() == Some(0.0) => return None,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let text = js_trim(s);
            if matches!(text.to_ascii_lowercase().as_str(), "0" | "off" | "none" | "false") {
                return None;
            }
            string_to_number(text)
        }
        // `Number(true)` is 1 and `Number(false)` 0, which is not the literal 0 that disables.
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => f64::NAN,
    };
    let ms = number * scale;
    if !ms.is_finite() || ms <= 0.0 {
        return Some(DEFAULT_STARTUP_TIMEOUT);
    }
    // A positive value that rounds to no millisecond is Node's 0: disabled.
    Some(ms.round().min(MAX_TIMER_MS) as u64).filter(|ms| *ms > 0).map(Duration::from_millis)
}

/// `Some(None)`: explicitly disabled (`0`, `off`, `none`, `false`); `Some(Some(n))`: a positive
/// number; `None`: absent or unusable.
fn number_or_off(value: &Value) -> Option<Option<u64>> {
    match value {
        Value::Bool(false) => Some(None),
        Value::Number(n) => match n.as_f64() {
            Some(0.0) => Some(None),
            Some(f) if f > 0.0 && f.is_finite() => Some(Some(f as u64)),
            _ => None,
        },
        Value::String(s) => {
            let t = js_trim(s);
            if matches!(t.to_ascii_lowercase().as_str(), "0" | "off" | "none" | "false") {
                return Some(None);
            }
            Some(string_to_number(t)).filter(|f| *f > 0.0 && f.is_finite()).map(|f| Some(f as u64))
        }
        _ => None,
    }
}

/// `a ?? b ?? env.NAME`: the entry's first key that is set (not null), else the environment's variable.
fn first_set(entry: &Value, keys: &[&str], env: &Env, name: &str) -> Option<Value> {
    keys.iter()
        .find_map(|key| entry.get(*key).filter(|v| !v.is_null()).cloned())
        .or_else(|| env.get(name).map(|text| Value::String(text.clone())))
}

/// `Number(value)` for the values a config entry or an environment variable holds.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_to_number(js_trim(s)),
        Value::Bool(b) => f64::from(u8::from(*b)),
        _ => f64::NAN,
    }
}

/// `positiveInt` (runtime/shared/numbers.mjs): `Math.floor(Number(value))` when that is at least 1.
fn positive_int(value: &Value) -> Option<u64> {
    let floored = js_number(value).floor();
    (floored.is_finite() && floored >= 1.0).then_some(floored as u64)
}

/// `resolveMcpMaxTotalTimeoutMs` (client-config.mjs:347): the entry's `maxTotalTimeoutMs` / `max_total_timeout_ms`, else
/// the environment's `MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS`, else the default. `0`, `off`, `none` or `false` (as text) in
/// the one that is set removes the cap (`None`); the empty string, `false` and anything unusable are the default.
fn max_total_cap(entry: &Value, env: &Env) -> Option<Duration> {
    let Some(raw) = first_set(entry, &["maxTotalTimeoutMs", "max_total_timeout_ms"], env, "MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS") else {
        return Some(DEFAULT_MAX_TOTAL_TIMEOUT);
    };
    match &raw {
        Value::Bool(false) => return Some(DEFAULT_MAX_TOTAL_TIMEOUT),
        Value::String(s) if s.is_empty() => return Some(DEFAULT_MAX_TOTAL_TIMEOUT),
        Value::Number(n) if n.as_f64() == Some(0.0) => return None,
        Value::String(s) if matches!(js_trim(s).to_ascii_lowercase().as_str(), "0" | "off" | "none" | "false") => return None,
        _ => {}
    }
    let parsed = js_number(&raw);
    if !parsed.is_finite() || parsed <= 0.0 {
        return Some(DEFAULT_MAX_TOTAL_TIMEOUT);
    }
    Some(Duration::from_millis(parsed.round().min(MAX_TIMER_MS) as u64))
}

fn positive(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(number_or_off)
        .flatten()
        .and_then(|n| usize::try_from(n).ok())
}

impl McpServerConfig {
    /// Builds a config from a JSON entry. `env` is the process environment (plus
    /// `MIXDOG_MCP_*` overrides, read from it like any other variable).
    pub fn from_entry(name: &str, entry: &Value, env: &Env) -> Result<Self, ConfigError> {
        if !entry.is_object() {
            return Err(ConfigError::NotAnObject);
        }
        let kind = transport_kind(entry)?;
        let mut missing = Vec::new();
        let transport = match kind {
            TransportKind::Stdio => {
                let command = entry
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|c| !c.is_empty())
                    .ok_or(ConfigError::MissingCommand)?;
                let args = entry
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|v| expand_env(v.as_str().unwrap_or_default(), env, &mut missing))
                            .collect()
                    })
                    .unwrap_or_default();
                TransportConfig::Stdio {
                    command: expand_env(command, env, &mut missing),
                    args,
                    env: stdio_environment(entry, env, &mut missing),
                    cwd: entry
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(|c| expand_env(c, env, &mut missing)),
                }
            }
            TransportKind::Http | TransportKind::Sse | TransportKind::WebSocket => {
                let label = match kind {
                    TransportKind::Http => "http",
                    TransportKind::Sse => "sse",
                    _ => "ws",
                };
                let raw = entry
                    .get("url")
                    .and_then(Value::as_str)
                    .filter(|u| !js_trim(u).is_empty())
                    .ok_or(ConfigError::MissingUrl(label))?;
                let url = normalize_url(&expand_env(raw, env, &mut missing), kind == TransportKind::WebSocket)?;
                let headers = http_headers(entry, env, &mut missing);
                match kind {
                    TransportKind::Http => TransportConfig::Http { url, headers },
                    TransportKind::Sse => TransportConfig::Sse { url, headers },
                    _ => TransportConfig::WebSocket { url, headers },
                }
            }
        };
        let connector = entry
            .get("connector")
            .and_then(Value::as_str)
            .filter(|id| crate::connectors::connector(id).is_some())
            .map(str::to_owned);
        let oauth = match &transport {
            TransportConfig::Http { url, .. } | TransportConfig::Sse { url, .. } if !has_configured_auth(entry) => {
                Some(crate::connectors::oauth_binding(name, entry, url, connector.as_deref()))
            }
            _ => None,
        };
        // `missingEnvWarnings` (client-transport.mjs:261): a server that is strict about its variables (a plugin's,
        // `_mixdogStrictEnv`) fails on an unset one; any other connects with it expanded to the empty string and says so.
        let mut warnings = Vec::new();
        if !missing.is_empty() {
            let mut names: Vec<String> = Vec::new();
            for name in missing {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
            if entry.get("_mixdogStrictEnv").and_then(Value::as_bool) == Some(true) {
                return Err(ConfigError::MissingEnv(names));
            }
            warnings.push(ConfigError::MissingEnv(names).to_string());
        }
        let call_timeout = duration_ms(
            entry,
            &["timeoutMs", "timeout_ms", "callTimeoutMs", "call_timeout_ms"],
            &[],
        )
        .or_else(|| {
            env.get("MIXDOG_MCP_CALL_TIMEOUT_MS")
                .and_then(|v| number_or_off(&Value::String(v.clone())))
                .map(|p| p.map(Duration::from_millis))
        })
        .unwrap_or(Some(DEFAULT_CALL_TIMEOUT));
        let startup_timeout = startup_timeout(entry, env);
        let max_concurrency = positive(entry.get("maxConcurrency").or_else(|| entry.get("max_concurrency")))
            .or_else(|| {
                env.get("MIXDOG_MCP_MAX_INFLIGHT")
                    .and_then(|v| positive(Some(&Value::String(v.clone()))))
            });
        // `resolveMcpRequestTimeouts` (client-config.mjs:362): a call without a timeout has no ceiling either, and the
        // ceiling is never below the call timeout.
        let max_total_timeout = call_timeout.and_then(|call| max_total_cap(entry, env).map(|cap| cap.max(call)));
        // `callAdmissionFor` (mcp/client.mjs:340): `positiveInt(cfg.maxQueue ?? cfg.max_queue ?? MIXDOG_MCP_MAX_QUEUE, 256)`
        // and `positiveInt(cfg.waitTimeoutMs ?? cfg.wait_timeout_ms ?? MIXDOG_MCP_WAIT_TIMEOUT_MS, 30_000)`.
        let max_queue = first_set(entry, &["maxQueue", "max_queue"], env, "MIXDOG_MCP_MAX_QUEUE")
            .and_then(|v| positive_int(&v))
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(DEFAULT_MAX_QUEUE);
        let wait_timeout = first_set(entry, &["waitTimeoutMs", "wait_timeout_ms"], env, "MIXDOG_MCP_WAIT_TIMEOUT_MS")
            .and_then(|v| positive_int(&v))
            .map_or(DEFAULT_WAIT_TIMEOUT, Duration::from_millis);
        // `createMcpClient`'s fixed root: `String(cfg._mixdogProjectRoot || cfg.cwd || '').trim()`.
        let project_root = ["_mixdogProjectRoot", "cwd"]
            .iter()
            .find_map(|key| entry.get(*key).and_then(Value::as_str).filter(|root| !root.is_empty()))
            .map(js_trim)
            .filter(|root| !root.is_empty())
            .map(str::to_owned);
        Ok(Self {
            name: name.to_owned(),
            enabled: entry.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            transport,
            max_concurrency,
            max_queue,
            min_owner_queue: DEFAULT_MIN_OWNER_QUEUE,
            wait_timeout,
            startup_timeout,
            call_timeout,
            max_total_timeout,
            roots_follow_scope: entry.get("_mixdogRootsFollowScope").and_then(Value::as_bool) == Some(true),
            project_root,
            warnings,
            blocked: None,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
            outbound_kinds: string_map(entry.get("outbound"))
                .into_iter()
                .filter_map(|(tool, kind)| Some((tool, parse_action_kind(&kind)?)))
                .collect(),
            connector,
            oauth,
            plugin_id: entry.pointer("/_mixdogPlugin/id").and_then(Value::as_str).map(js_trim).filter(|id| !id.is_empty()).map(str::to_owned),
        })
    }

    /// Header values and URL query values that must never reach a model-visible message.
    pub fn secret_values(&self) -> Vec<String> {
        let mut out = Vec::new();
        if let TransportConfig::Http { url, headers }
        | TransportConfig::Sse { url, headers }
        | TransportConfig::WebSocket { url, headers } = &self.transport
        {
            out.extend(headers.values().filter(|v| utf16_len(v) >= 4).cloned());
            out.extend(url.query_pairs().map(|(_, v)| v.into_owned()).filter(|v| utf16_len(v) >= 4));
        }
        out
    }
}

/// `text` with every one of `secrets` replaced by `[redacted]`.
pub fn scrub(text: &str, secrets: &[String]) -> String {
    secrets
        .iter()
        .filter(|s| !s.is_empty())
        .fold(text.to_owned(), |acc, s| acc.replace(s.as_str(), "[redacted]"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
    }

    #[test]
    fn expansion_covers_default_env_prefix_and_missing() {
        let e = env(&[("A", "1")]);
        let mut missing = Vec::new();
        assert_eq!(expand_env("${A}-${env:A}-${B:-x}-${C}-$D-${", &e, &mut missing), "1-1-x--$D-${");
        assert_eq!(missing, vec!["C".to_owned()]);
    }

    #[test]
    fn transport_is_inferred_in_node_order() {
        assert_eq!(transport_kind(&json!({"command": "x"})), Ok(TransportKind::Stdio));
        assert_eq!(transport_kind(&json!({"url": "https://a"})), Ok(TransportKind::Http));
        assert_eq!(transport_kind(&json!({"type": "streamableHttp"})), Ok(TransportKind::Http));
        assert_eq!(transport_kind(&json!({"type": "nope"})), Err(ConfigError::UnknownType));
        assert_eq!(transport_kind(&json!({})), Err(ConfigError::NoTransport));
    }

    #[test]
    fn url_policy_requires_tls_except_loopback() {
        assert!(normalize_url("https://example.com/mcp#f", false).is_ok());
        assert!(normalize_url("http://127.0.0.1:3/mcp", false).is_ok());
        assert_eq!(normalize_url("http://example.com", false), Err(ConfigError::InsecureUrl));
        assert_eq!(normalize_url("https://u:p@example.com", false), Err(ConfigError::UrlCredentials));
        assert_eq!(normalize_url("ws://example.com", true), Err(ConfigError::InsecureWebSocketUrl));
    }

    #[test]
    fn env_vars_allowlist_limits_inherited_environment() {
        let e = env(&[("PATH", "/bin"), ("SECRET", "s"), ("KEEP", "k")]);
        let cfg = McpServerConfig::from_entry(
            "s",
            &json!({"command": "c", "env_vars": ["KEEP"], "env": {"X": "${KEEP}"}}),
            &e,
        )
        .unwrap();
        let TransportConfig::Stdio { env, .. } = cfg.transport else { panic!() };
        assert_eq!(env.get("KEEP").map(String::as_str), Some("k"));
        assert_eq!(env.get("X").map(String::as_str), Some("k"));
        assert!(!env.contains_key("SECRET"));
    }

    /// `missingEnvWarnings` (client-transport.mjs:261): a user's server connects with an unset variable expanded to
    /// the empty string and one warning that names it; a plugin's server (`_mixdogStrictEnv`) fails with the same text.
    #[test]
    fn an_unset_variable_is_a_warning_for_a_users_server_and_a_failure_for_a_plugins() {
        let entry = json!({"command": "c", "args": ["--key=${MISSING_KEY}", "${OTHER}", "${MISSING_KEY}"], "env": {"X": "${SET:-d}"}});
        let cfg = McpServerConfig::from_entry("s", &entry, &Env::new()).unwrap();
        assert_eq!(cfg.warnings, ["missing environment variable(s): MISSING_KEY, OTHER"]);
        let TransportConfig::Stdio { args, env: child, .. } = &cfg.transport else { panic!() };
        assert_eq!(args, &["--key=", "", ""]);
        assert_eq!(child.get("X").map(String::as_str), Some("d"));

        let mut strict = entry.clone();
        strict["_mixdogStrictEnv"] = json!(true);
        let refused = McpServerConfig::from_entry("s", &strict, &Env::new()).unwrap_err();
        assert_eq!(refused.to_string(), "missing environment variable(s): MISSING_KEY, OTHER");
        // With the variables set neither warns.
        let set = env(&[("MISSING_KEY", "k"), ("OTHER", "o")]);
        assert!(McpServerConfig::from_entry("s", &strict, &set).unwrap().warnings.is_empty());
    }

    /// `callAdmissionFor` (mcp/client.mjs:352-357) and `resolveMcpMaxTotalTimeoutMs` / `resolveMcpRequestTimeouts`
    /// (client-config.mjs:347-372): the entry's value decides alone when it is set; the environment's otherwise.
    #[test]
    fn the_queue_wait_and_total_tunables_read_the_entry_then_the_environment() {
        let of = |entry: Value, vars: &[(&str, &str)]| McpServerConfig::from_entry("s", &entry, &env(vars)).unwrap();
        let base = || json!({"command": "c"});
        let with = |extra: Value| {
            let mut entry = base();
            entry.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            entry
        };
        // MIXDOG_MCP_MAX_QUEUE
        assert_eq!(of(base(), &[]).max_queue, 256);
        assert_eq!(of(base(), &[("MIXDOG_MCP_MAX_QUEUE", "12")]).max_queue, 12);
        assert_eq!(of(with(json!({"maxQueue": 4})), &[("MIXDOG_MCP_MAX_QUEUE", "12")]).max_queue, 4);
        assert_eq!(of(with(json!({"max_queue": "x"})), &[("MIXDOG_MCP_MAX_QUEUE", "12")]).max_queue, 256, "`??` keeps the entry's unusable value");
        assert_eq!(of(base(), &[("MIXDOG_MCP_MAX_QUEUE", "0")]).max_queue, 256);
        assert_eq!(of(base(), &[("MIXDOG_MCP_MAX_QUEUE", "7.9")]).max_queue, 7, "floored");
        // MIXDOG_MCP_WAIT_TIMEOUT_MS
        assert_eq!(of(base(), &[]).wait_timeout, Duration::from_secs(30));
        assert_eq!(of(base(), &[("MIXDOG_MCP_WAIT_TIMEOUT_MS", "1500")]).wait_timeout, Duration::from_millis(1500));
        assert_eq!(of(with(json!({"wait_timeout_ms": 250})), &[("MIXDOG_MCP_WAIT_TIMEOUT_MS", "1500")]).wait_timeout, Duration::from_millis(250));
        assert_eq!(of(base(), &[("MIXDOG_MCP_WAIT_TIMEOUT_MS", "off")]).wait_timeout, Duration::from_secs(30));
        // MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS
        let half_hour = Some(Duration::from_secs(30 * 60));
        assert_eq!(of(base(), &[]).max_total_timeout, half_hour);
        assert_eq!(of(base(), &[("MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS", "600000")]).max_total_timeout, Some(Duration::from_secs(600)));
        assert_eq!(of(with(json!({"maxTotalTimeoutMs": 900000})), &[("MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS", "600000")]).max_total_timeout, Some(Duration::from_secs(900)));
        for off in ["0", "off", "NONE", "false"] {
            assert_eq!(of(base(), &[("MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS", off)]).max_total_timeout, None, "{off}");
        }
        assert_eq!(of(with(json!({"maxTotalTimeoutMs": 0})), &[]).max_total_timeout, None);
        assert_eq!(of(base(), &[("MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS", "")]).max_total_timeout, half_hour);
        assert_eq!(of(with(json!({"maxTotalTimeoutMs": false})), &[]).max_total_timeout, half_hour, "`false` is the default, not off");
        assert_eq!(of(base(), &[("MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS", "junk")]).max_total_timeout, half_hour);
        // The ceiling is never below the call timeout, and a call without a timeout has none.
        assert_eq!(of(with(json!({"timeoutMs": 5000, "maxTotalTimeoutMs": 1000})), &[]).max_total_timeout, Some(Duration::from_secs(5)));
        assert_eq!(of(with(json!({"timeoutMs": 0})), &[("MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS", "600000")]).max_total_timeout, None);
    }

    /// `createMcpClient` (mcp/client.mjs:1570-1571): the root a server's client advertises.
    #[test]
    fn the_advertised_root_is_the_project_root_then_the_cwd_and_a_plugin_server_follows_its_scope() {
        let of = |entry: Value| McpServerConfig::from_entry("s", &entry, &Env::new()).unwrap();
        let plain = of(json!({"command": "c"}));
        assert_eq!((plain.roots_follow_scope, plain.project_root), (false, None));
        assert_eq!(of(json!({"command": "c", "cwd": " /work "})).project_root.as_deref(), Some("/work"));
        assert_eq!(of(json!({"command": "c", "cwd": "/work", "_mixdogProjectRoot": "/project"})).project_root.as_deref(), Some("/project"));
        assert!(of(json!({"command": "c", "_mixdogRootsFollowScope": true})).roots_follow_scope);
    }

    /// `mcpLog`: quiet for any non-empty `MIXDOG_QUIET_MCP_LOG`.
    #[test]
    fn the_client_log_is_quiet_while_the_variable_is_set() {
        use std::ffi::OsStr;
        assert!(!quiet(None));
        assert!(!quiet(Some(OsStr::new(""))));
        assert!(quiet(Some(OsStr::new("1"))));
        assert!(quiet(Some(OsStr::new("0"))), "any non-empty value, as `process.env.X` is truthy");
    }

    #[test]
    fn timeouts_default_and_disable() {
        let cfg = McpServerConfig::from_entry("s", &json!({"command": "c"}), &Env::new()).unwrap();
        assert_eq!(cfg.call_timeout, Some(DEFAULT_CALL_TIMEOUT));
        let cfg = McpServerConfig::from_entry("s", &json!({"command": "c", "timeoutMs": 0}), &Env::new()).unwrap();
        assert_eq!(cfg.call_timeout, None);
        let cfg = McpServerConfig::from_entry("s", &json!({"command": "c", "startup_timeout_sec": 5}), &Env::new()).unwrap();
        assert_eq!(cfg.startup_timeout, Some(Duration::from_secs(5)));
    }

    /// `resolveMcpStartupTimeoutMs` (`client-config.mjs`), source by source.
    #[test]
    fn the_startup_budget_is_the_first_source_that_is_set_and_zero_or_off_in_it_disables_it() {
        let of = |entry: Value, env: &[(&str, &str)]| {
            let env: Env = env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
            let mut entry = entry;
            entry["command"] = json!("c");
            McpServerConfig::from_entry("s", &entry, &env).unwrap().startup_timeout
        };
        let global = [("MIXDOG_MCP_STARTUP_TIMEOUT_MS", "1500")];
        assert_eq!(of(json!({}), &[]), Some(DEFAULT_STARTUP_TIMEOUT));
        assert_eq!(of(json!({}), &global), Some(Duration::from_millis(1500)));
        assert_eq!(of(json!({}), &[("MIXDOG_MCP_STARTUP_TIMEOUT_MS", "off")]), None);
        assert_eq!(of(json!({"startupTimeoutMs": 0}), &global), None);
        assert_eq!(of(json!({"startup_timeout_sec": "off"}), &global), None);
        assert_eq!(of(json!({"startupTimeoutSec": 0.5}), &global), Some(Duration::from_millis(500)));
        assert_eq!(of(json!({"startupTimeoutMs": 0.4}), &global), None, "it rounds to no millisecond, which disables it");
        assert_eq!(of(json!({"startupTimeoutMs": 0.5}), &global), Some(Duration::from_millis(1)));
        assert_eq!(of(json!({"startupTimeoutMs": 250, "startupTimeoutSec": 9}), &global), Some(Duration::from_millis(250)));
        assert_eq!(of(json!({"startupTimeoutMs": "", "startupTimeoutSec": 2}), &global), Some(Duration::from_secs(2)));
        // The source that is set decides alone: an unusable value in it is the default, not the next source.
        assert_eq!(of(json!({"startupTimeoutMs": "soon", "startupTimeoutSec": 2}), &global), Some(DEFAULT_STARTUP_TIMEOUT));
        assert_eq!(of(json!({"startupTimeoutMs": -5}), &global), Some(DEFAULT_STARTUP_TIMEOUT));
        assert_eq!(of(json!({"startupTimeoutMs": false}), &global), Some(DEFAULT_STARTUP_TIMEOUT));
    }

    #[test]
    fn bearer_and_env_headers_resolve() {
        let e = env(&[("TOK", "abc"), ("H", "hv")]);
        let cfg = McpServerConfig::from_entry(
            "s",
            &json!({"url": "https://x", "bearer_token_env_var": "TOK", "env_http_headers": {"X-H": "H"}, "headers": {"A": "b"}}),
            &e,
        )
        .unwrap();
        let TransportConfig::Http { headers, .. } = cfg.transport else { panic!() };
        assert_eq!(headers.get("Authorization").map(String::as_str), Some("Bearer abc"));
        assert_eq!(headers.get("X-H").map(String::as_str), Some("hv"));
        assert_eq!(headers.get("A").map(String::as_str), Some("b"));
    }
}