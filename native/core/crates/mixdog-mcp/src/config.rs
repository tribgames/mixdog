//! Interpreting one MCP server entry (T §4): transport kind, `${VAR}` expansion, stdio
//! environment, HTTP headers, URL policy and the per-server numbers. Every number the Node
//! client fixed in code is a field here, defaulting to the old value.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::approval::ActionKind;
use mixdog_js::js_trim;
use mixdog_js::string_to_number;
use mixdog_js::to_number;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
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
        /// The `stderr` option of the child (`pipe` by default; `ignore` leaves no pipe).
        stderr: String,
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
    /// `autoDetect`: Streamable HTTP to the loopback port a local service advertises.
    AutoDetect(AutoDetectTarget),
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
pub struct McpAccountConfig {
    pub id: String,
    pub email: String,
    pub server: McpServerConfig,
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
    pub accounts: Vec<McpAccountConfig>,
}

fn quiet(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

/// One `daemon.log` line about a server's connection (the route of the core's other daemon-log lines, not `tracing` alone).
/// Names and ids only: any word with an `@` (a mail address) is replaced. A record is one line: white space runs, newlines of a
/// stderr tail included, become one space (`oneLine`, as the core's other daemon-log writers do).
pub(crate) fn daemon_line(line: &str) {
    if let Some(log) = daemon_log() {
        log.line(line);
    }
}

/// Lines waiting for a [`LogQueue`]'s writer; a line beyond this is dropped rather than wait.
const LOG_QUEUE_LINES: usize = 1024;

/// Log lines written on a thread of their own. [`line`](Self::line) never waits for the writer (a full queue drops the line),
/// so a sink that blocks holds up no caller: no pipe reader, connect or close. The thread ends when the queue is dropped.
pub struct LogQueue(std::sync::mpsc::SyncSender<String>);

impl LogQueue {
    /// The queue and its writer thread; `None` when the thread cannot be started.
    pub fn start(write: impl Fn(&str) + Send + 'static) -> Option<Arc<Self>> {
        let (queue, lines) = std::sync::mpsc::sync_channel::<String>(LOG_QUEUE_LINES);
        std::thread::Builder::new().name("mcp-log".to_owned()).spawn(move || lines.into_iter().for_each(|line| write(&line))).ok()?;
        Some(Arc::new(Self(queue)))
    }

    /// Queues `line` as one record without mail addresses (see [`daemon_line`]).
    pub fn line(&self, line: &str) {
        let _ = self.0.try_send(one_line_redacted(line));
    }
}

/// The queue of the daemon log (the process's Node stderr sink).
pub fn daemon_log() -> Option<Arc<LogQueue>> {
    static QUEUE: std::sync::LazyLock<Option<Arc<LogQueue>>> = std::sync::LazyLock::new(|| LogQueue::start(|line: &str| mixdog_rt::node_stderr!("{}", line)));
    QUEUE.clone()
}

fn one_line_redacted(line: &str) -> String {
    line.split(mixdog_js::is_js_space)
        .filter(|word| !word.is_empty())
        .map(|word| if word.contains('@') { "<address>" } else { word })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod daemon_line_tests {
    #[test]
    fn a_diagnostic_with_a_stderr_tail_is_one_line_without_an_address() {
        let line = super::one_line_redacted("[mcp-server] name=gmail connect failed: boom\r\nstderr tail:\n  user@example.com refused\n");
        assert_eq!(line, "[mcp-server] name=gmail connect failed: boom stderr tail: <address> refused");
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
    #[error("Unknown autoDetect target: \"{0}\"")]
    UnknownAutoDetect(String),
    #[error("autoDetect server \"{0}\": live service advert missing")]
    AutoDetectAdvertMissing(String),
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

/// `AUTO_DETECT_PORTS`: the services an `autoDetect` entry names, with their advert and endpoint.
const AUTO_DETECT_PORTS: [(&str, &str, &str); 1] = [("mixdog-memory", "memory", "/mcp")];

/// The service advert an `autoDetect` server connects through (`autoDetectAdvert`), with the identity it had when it was
/// read: a connect it refuses distrusts exactly this advert ([`mark_service_unreachable`]).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AutoDetectAdvert {
    pub service: &'static str,
    pub port: u16,
    /// `updatedAt` and `pid`: a service restarted on the same port re-stamps them.
    updated_at: i64,
    pid: Option<i64>,
}

/// `_DISTRUST_TTL_MS`: a distrusted advert is trusted again after this, restarted or not.
const DISTRUST_TTL: Duration = Duration::from_secs(30);

/// `_unreachablePorts`: per service, the advert a refused connect proved dead and when.
static UNREACHABLE: std::sync::LazyLock<std::sync::Mutex<HashMap<&'static str, (AutoDetectAdvert, std::time::Instant)>>> =
    std::sync::LazyLock::new(Default::default);

/// `markServiceUnreachable`: `advert` refused a connection (nothing listens: a pid-live advert of a recycled pid), so it
/// is not used again until its service re-advertises or the distrust ages out.
pub fn mark_service_unreachable(advert: &AutoDetectAdvert) {
    UNREACHABLE.lock().unwrap_or_else(|e| e.into_inner()).insert(advert.service, (advert.clone(), std::time::Instant::now()));
}

/// `isConnRefuseError` on the system error code of a failure: only "nothing is listening / the socket died" distrusts an
/// advert, never a timeout or an HTTP answer.
pub fn connection_refused(code: &str) -> bool {
    matches!(code, "ECONNREFUSED" | "ECONNRESET" | "ENOTFOUND" | "EHOSTUNREACH" | "ENETUNREACH")
}

/// `readLiveServiceAdvert`'s distrust check: `advert` is the one a refused connect marked, and its service has neither
/// re-advertised since nor outlived the distrust.
fn distrusted(advert: &AutoDetectAdvert) -> bool {
    let mut all = UNREACHABLE.lock().unwrap_or_else(|e| e.into_inner());
    let Some((marked, at)) = all.get(advert.service) else { return false };
    if marked.port != advert.port {
        return false;
    }
    let restarted = advert.updated_at > marked.updated_at || advert.pid != marked.pid;
    if restarted || at.elapsed() > DISTRUST_TTL {
        all.remove(advert.service);
        return false;
    }
    true
}

/// `isPidAlive`: a positive integer pid of a running process.
fn live_pid(pid: &Value) -> bool {
    let pid = to_number(pid);
    pid.fract() == 0.0 && pid > 0.0 && pid <= f64::from(i32::MAX) && mixdog_statefile::process_exists(pid as u32)
}

/// `resolveRuntimeRoot`: `MIXDOG_RUNTIME_ROOT`, else the default root under the temporary folder, chosen once for the
/// process (`cachedDefaultRoot`).
fn runtime_root(env: &Env) -> std::path::PathBuf {
    static DEFAULT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    match env.get("MIXDOG_RUNTIME_ROOT").map(|root| root.trim()).filter(|root| !root.is_empty()) {
        Some(root) => std::path::PathBuf::from(root),
        None => DEFAULT.get_or_init(|| default_runtime_root(&std::env::temp_dir())).clone(),
    }
}

#[cfg(windows)]
fn default_runtime_root(tmp: &std::path::Path) -> std::path::PathBuf {
    tmp.join("mixdog")
}

/// The per-user `mixdog-<uid>`, unless the legacy shared `mixdog` is this user's private root with a live daemon in it.
#[cfg(unix)]
fn default_runtime_root(tmp: &std::path::Path) -> std::path::PathBuf {
    // SAFETY: `getuid` has no preconditions and cannot fail.
    let uid = unsafe { libc::getuid() };
    let legacy = tmp.join("mixdog");
    if live_legacy_root(&legacy, uid) { legacy } else { tmp.join(format!("mixdog-{uid}")) }
}

/// `lstatSync(path)`: the entry itself, a link not followed.
#[cfg(unix)]
fn lstat(path: &std::path::Path) -> Option<libc::stat> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: an all-zero `stat` is a valid value of the plain C struct.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `stat` is a valid out-parameter and `path` a NUL-terminated string that outlives the call.
    (unsafe { libc::lstat(path.as_ptr(), &mut stat) } == 0).then_some(stat)
}

/// `safeLiveLegacyRoot`: a real directory owned by `uid` and writable by no one else, whose `daemon.json` is a real file
/// owned by `uid`, private to it, naming a live pid.
#[cfg(unix)]
fn live_legacy_root(root: &std::path::Path, uid: u32) -> bool {
    let owned =
        |stat: &libc::stat, kind: libc::mode_t, open: libc::mode_t| (stat.st_mode & libc::S_IFMT) == kind && stat.st_uid == uid && (stat.st_mode & open) == 0;
    let discovery = root.join("daemon.json");
    if !lstat(root).is_some_and(|dir| owned(&dir, libc::S_IFDIR, 0o022)) || !lstat(&discovery).is_some_and(|file| owned(&file, libc::S_IFREG, 0o077)) {
        return false;
    }
    let Some(bytes) = mixdog_statefile::read_content(&discovery).ok().flatten() else { return false };
    serde_json::from_slice::<Value>(&bytes).ok().and_then(|daemon| daemon.get("pid").cloned()).is_some_and(|pid| live_pid(&pid))
}

/// The `autoDetect` target an entry names, as any message or status shows it: credential shapes typed there are scrubbed.
pub fn auto_detect_target(entry: &Value) -> String {
    scrub(&value_to_string(&entry["autoDetect"]), &[])
}

/// The service an `autoDetect` entry connects to (`AUTO_DETECT_PORTS`), under the runtime root it advertises in.
fn auto_detect_transport(entry: &Value, env: &Env) -> Result<TransportConfig, ConfigError> {
    let target = auto_detect_target(entry);
    let Some((_, service, endpoint)) = AUTO_DETECT_PORTS.iter().find(|(key, _, _)| *key == target) else {
        return Err(ConfigError::UnknownAutoDetect(target));
    };
    Ok(TransportConfig::AutoDetect(AutoDetectTarget { root: runtime_root(env), service, endpoint }))
}

/// An `autoDetect` server's service, whose advert is read at each connect (`createMcpTransport`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct AutoDetectTarget {
    pub root: std::path::PathBuf,
    pub service: &'static str,
    pub endpoint: &'static str,
}

impl AutoDetectTarget {
    /// `resolveAutoDetectUrl`: the loopback URL of the live service advert `<runtime root>/discovery/<service>.json`
    /// (`readServicePort` without `requirePid`: an advert whose pid is set must name a live process), and the advert.
    pub fn resolve(&self, name: &str) -> Result<(Url, AutoDetectAdvert), ConfigError> {
        let missing = || ConfigError::AutoDetectAdvertMissing(name.to_owned());
        let path = self.root.join("discovery").join(format!("{}.json", self.service));
        let bytes = mixdog_statefile::read_content(&path).ok().flatten().ok_or_else(missing)?;
        let raw: Value = serde_json::from_slice(&bytes).map_err(|_| missing())?;
        let port = raw.get("port").map(to_number).filter(|p| p.fract() == 0.0 && *p > 0.0 && *p < 65536.0).ok_or_else(missing)?;
        let identity = |value: &Value| {
            let number = to_number(value);
            if number.is_finite() { number as i64 } else { 0 }
        };
        let advert = AutoDetectAdvert {
            service: self.service,
            port: port as u16,
            updated_at: raw.get("updatedAt").map_or(0, identity),
            pid: raw.get("pid").filter(|p| !p.is_null()).map(identity),
        };
        if distrusted(&advert) {
            return Err(missing());
        }
        if let Some(pid) = raw.get("pid").filter(|p| !p.is_null())
            && !live_pid(pid)
        {
            return Err(missing());
        }
        let url = Url::parse(&format!("http://127.0.0.1:{}{}", advert.port, self.endpoint)).map_err(|_| missing())?;
        Ok((url, advert))
    }
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
    let name_len = body.char_indices().take_while(|(i, c)| c.is_ascii_alphabetic() || *c == '_' || (*i > 0 && c.is_ascii_digit())).count();
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
    if cfg!(windows) { env.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()) } else { env.get(name).map(String::as_str) }
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
    let explicit: Vec<(String, String)> = string_map(entry.get("env")).into_iter().map(|(k, v)| (k, expand_env(&v, env, missing))).collect();
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
                if let Some((actual, value)) = env.iter().find(|(k, _)| if cfg!(windows) { k.eq_ignore_ascii_case(&key) } else { **k == key }) {
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
        if let Some(value) = env_lookup(env, &env_name).filter(|v| !v.is_empty()) {
            headers.insert(header, value.to_owned());
        }
    }
    if let Some(name) = entry.get("bearer_token_env_var").and_then(Value::as_str)
        && let Some(value) = env_lookup(env, js_trim(name)).filter(|v| !v.is_empty())
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
    entry.get("bearer_token_env_var").and_then(Value::as_str).is_some_and(|name| !js_trim(name).is_empty())
        || configured("headers")
        || configured("env_http_headers")
}

fn is_loopback(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost") || host == "::1" || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

/// Validates an HTTP/SSE/WebSocket URL: no credentials; TLS except for loopback.
pub fn normalize_url(raw: &str, websocket: bool) -> Result<Url, ConfigError> {
    let mut url = Url::parse(js_trim(raw)).map_err(|_| ConfigError::InvalidUrl)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigError::UrlCredentials);
    }
    let loopback = url.host_str().is_some_and(is_loopback);
    let scheme = url.scheme();
    let encrypted = if websocket { matches!(scheme, "wss" | "https") } else { scheme == "https" };
    let local_plaintext = loopback && if websocket { matches!(scheme, "ws" | "http") } else { scheme == "http" };
    if !encrypted && !local_plaintext {
        return Err(if websocket { ConfigError::InsecureWebSocketUrl } else { ConfigError::InsecureUrl });
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
    let set = |a: &str, b: &str| entry.get(a).filter(|v| !v.is_null()).or_else(|| entry.get(b)).filter(|v| !v.is_null() && v.as_str() != Some("")).cloned();
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
    keys.iter().find_map(|key| entry.get(*key).filter(|v| !v.is_null()).cloned()).or_else(|| env.get(name).map(|text| Value::String(text.clone())))
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
    value.and_then(number_or_off).flatten().and_then(|n| usize::try_from(n).ok())
}

fn transport_of(kind: TransportKind, entry: &Value, env: &Env, missing: &mut Vec<String>) -> Result<TransportConfig, ConfigError> {
    Ok(match kind {
        TransportKind::Stdio => {
            let command = entry.get("command").and_then(Value::as_str).map(str::trim).filter(|c| !c.is_empty()).ok_or(ConfigError::MissingCommand)?;
            let args = entry
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|v| expand_env(v.as_str().unwrap_or_default(), env, missing)).collect())
                .unwrap_or_default();
            TransportConfig::Stdio {
                command: expand_env(command, env, missing),
                args,
                env: stdio_environment(entry, env, missing),
                cwd: entry.get("cwd").and_then(Value::as_str).map(|c| expand_env(c, env, missing)),
                stderr: entry.get("stderr").and_then(Value::as_str).unwrap_or("pipe").to_owned(),
            }
        }
        TransportKind::Http | TransportKind::Sse | TransportKind::WebSocket => {
            let label = match kind {
                TransportKind::Http => "http",
                TransportKind::Sse => "sse",
                _ => "ws",
            };
            let raw = entry.get("url").and_then(Value::as_str).filter(|u| !js_trim(u).is_empty()).ok_or(ConfigError::MissingUrl(label))?;
            let url = normalize_url(&expand_env(raw, env, missing), kind == TransportKind::WebSocket)?;
            let headers = http_headers(entry, env, missing);
            match kind {
                TransportKind::Http => TransportConfig::Http { url, headers },
                TransportKind::Sse => TransportConfig::Sse { url, headers },
                _ => TransportConfig::WebSocket { url, headers },
            }
        }
    })
}

fn missing_env_warnings(entry: &Value, missing: Vec<String>) -> Result<Vec<String>, ConfigError> {
    if missing.is_empty() {
        return Ok(Vec::new());
    }
    let mut names: Vec<String> = Vec::new();
    for name in missing {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    if entry.get("_mixdogStrictEnv").and_then(Value::as_bool) == Some(true) {
        return Err(ConfigError::MissingEnv(names));
    }
    Ok(vec![ConfigError::MissingEnv(names).to_string()])
}

impl McpServerConfig {
    /// Builds a config from a JSON entry. `env` is the process environment (plus
    /// `MIXDOG_MCP_*` overrides, read from it like any other variable).
    pub fn from_entry(name: &str, entry: &Value, env: &Env) -> Result<Self, ConfigError> {
        if !entry.is_object() {
            return Err(ConfigError::NotAnObject);
        }
        let auto = truthy(entry.get("autoDetect"));
        let kind = if auto { TransportKind::Http } else { transport_kind(entry)? };
        let mut missing = Vec::new();
        let transport = if auto { auto_detect_transport(entry, env)? } else { transport_of(kind, entry, env, &mut missing)? };
        let connector = entry.get("connector").and_then(Value::as_str).filter(|id| crate::connectors::connector(id).is_some()).map(str::to_owned);
        let stored_accounts = crate::connector_model::accounts_of(entry);
        // `createMcpTransport`: an http/sse server whose accounts are all switched off is neither connected nor routed to.
        let all_disabled = !auto
            && matches!(kind, TransportKind::Http | TransportKind::Sse)
            && !stored_accounts.is_empty()
            && !stored_accounts.iter().any(crate::connector_model::account_enabled);
        let accounts = stored_accounts
            .into_iter()
            .filter(crate::connector_model::account_enabled)
            .map(|account| {
                let own = crate::connector_model::account_server(entry, &account);
                Ok(McpAccountConfig {
                    id: account["id"].as_str().unwrap_or_default().to_owned(),
                    email: crate::connector_model::gmail_app_password_account(&own),
                    server: Self::from_entry(account["name"].as_str().unwrap_or_default(), &own, env)?,
                })
            })
            .collect::<Result<Vec<_>, ConfigError>>()?;
        let oauth = match &transport {
            TransportConfig::Http { url, .. } | TransportConfig::Sse { url, .. } if accounts.is_empty() && !auto && !has_configured_auth(entry) => {
                Some(crate::connectors::oauth_binding(name, entry, url, connector.as_deref()))
            }
            _ => None,
        };
        let warnings = missing_env_warnings(entry, missing)?;
        let call_timeout = duration_ms(entry, &["timeoutMs", "timeout_ms", "callTimeoutMs", "call_timeout_ms"], &[])
            .or_else(|| env.get("MIXDOG_MCP_CALL_TIMEOUT_MS").and_then(|v| number_or_off(&Value::String(v.clone()))).map(|p| p.map(Duration::from_millis)))
            .unwrap_or(Some(DEFAULT_CALL_TIMEOUT));
        let startup_timeout = startup_timeout(entry, env);
        let max_concurrency = positive(entry.get("maxConcurrency").or_else(|| entry.get("max_concurrency")))
            .or_else(|| env.get("MIXDOG_MCP_MAX_INFLIGHT").and_then(|v| positive(Some(&Value::String(v.clone())))));
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
            blocked: all_disabled.then(|| format!("Every account of \"{name}\" is disabled")),
            accounts,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
            outbound_kinds: string_map(entry.get("outbound")).into_iter().filter_map(|(tool, kind)| Some((tool, parse_action_kind(&kind)?))).collect(),
            connector,
            oauth,
            plugin_id: entry.pointer("/_mixdogPlugin/id").and_then(Value::as_str).map(js_trim).filter(|id| !id.is_empty()).map(str::to_owned),
        })
    }

    /// Header values, URL query values and, for a stdio server, the values of its environment variables named as
    /// credentials: what must never reach a model-visible message or a log.
    pub fn secret_values(&self) -> Vec<String> {
        static CREDENTIAL_NAME: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"(?i)auth|cookie|token|secret|pass(word|wd)?|api[-_]?key|private[-_]?key|signature|credential|session|(^|[-_])key$")
                .expect("a valid pattern")
        });
        let mut out = Vec::new();
        match &self.transport {
            TransportConfig::Http { url, headers } | TransportConfig::Sse { url, headers } | TransportConfig::WebSocket { url, headers } => {
                out.extend(headers.values().filter(|v| utf16_len(v) >= 4).cloned());
                out.extend(url.query_pairs().map(|(_, v)| v.into_owned()).filter(|v| utf16_len(v) >= 4));
            }
            // Every value of a credential-named variable, however short: it is the server's own secret, not a URL part.
            TransportConfig::Stdio { env, .. } => {
                out.extend(env.iter().filter(|(name, value)| CREDENTIAL_NAME.is_match(name) && !value.is_empty()).map(|(_, value)| value.clone()));
            }
            TransportConfig::AutoDetect(_) => {}
        }
        out
    }
}

/// `text` with every one of `secrets` replaced by `[redacted]`, and the credential shapes of a URL (user info, secret query
/// parameters) whoever wrote them (`scrubMcpConnectionMessage`).
///
/// A secret of [`EMBEDDED_SECRET_CHARS`] or more is replaced wherever it occurs. A shorter one is replaced only where it
/// stands as a whole value ([`stands_whole`]): `pw` in `password=pw` or `login pw failed`, never in `pwned`, and a `2`
/// never in `-32000` or `2.0`.
pub fn scrub(text: &str, secrets: &[String]) -> String {
    redact(text, 0, text.len(), &secret_ranges(text, secrets))
}

/// Secrets at least this long are redacted inside any text; shorter ones only as a whole value.
const EMBEDDED_SECRET_CHARS: usize = 8;

/// The byte ranges of `text` that [`scrub`] replaces, found in `text` as written, sorted and merged where they overlap:
/// every occurrence of a secret (a short one only as a whole value), the user info of a URI of any scheme, and the value of
/// a credential-named query parameter. The end of `text` is taken as the end of a value: for text that may continue, a
/// short secret at its very end is in a range until what follows shows otherwise, so nothing of it is let out undecided.
pub(crate) fn secret_ranges(text: &str, secrets: &[String]) -> Vec<std::ops::Range<usize>> {
    static USERINFO: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\b[a-z][a-z0-9+.-]*://([^/\s@]+)@").expect("a valid pattern"));
    static QUERY: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r#"(?i)[?&](?:access_token|api[_-]?key|auth|secret|signature|token)=([^&\s'"]+)"#).expect("a valid pattern")
    });
    let mut ranges = Vec::new();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        let whole = secret.chars().count() < EMBEDDED_SECRET_CHARS;
        let mut from = 0;
        while let Some(found) = text[from..].find(secret.as_str()) {
            let (at, end) = (from + found, from + found + secret.len());
            if !whole || stands_whole(text, at, end) {
                ranges.push(at..end);
            }
            from = at + text[at..].chars().next().map_or(1, char::len_utf8);
        }
    }
    for pattern in [&*USERINFO, &*QUERY] {
        ranges.extend(pattern.captures_iter(text).filter_map(|c| c.get(1)).map(|m| m.range()));
    }
    ranges.sort_by_key(|r| r.start);
    let mut merged: Vec<std::ops::Range<usize>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.start < last.end => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    merged
}

/// `text[from..to]` with each part of it inside one of `ranges` (sorted, disjoint) replaced by `[redacted]`.
pub(crate) fn redact(text: &str, from: usize, to: usize, ranges: &[std::ops::Range<usize>]) -> String {
    let mut out = String::with_capacity(to - from);
    let mut copied = from;
    for range in ranges.iter().filter(|r| r.end > from && r.start < to) {
        let start = range.start.max(from);
        out.push_str(&text[copied..start]);
        out.push_str("[redacted]");
        copied = range.end.min(to);
    }
    out.push_str(&text[copied..to]);
    out
}

/// What may stand next to a value: white space, quotes, brackets and the separators of assignments, lists and URLs (the `@`
/// that ends a URL's user info included).
fn delimits(c: char) -> bool {
    c.is_whitespace() || "=:,;&?/|@'\"`()[]{}<>".contains(c)
}

/// Whether `text[at..end]` stands as a whole value: a delimiter (or the start) before it, and after it a delimiter, the
/// end, or a sentence's `.`/`!` followed by white space or the end.
fn stands_whole(text: &str, at: usize, end: usize) -> bool {
    let before = text[..at].chars().next_back().is_none_or(delimits);
    let mut next = text[end..].chars();
    let after = match next.next() {
        None => true,
        Some(c) if delimits(c) => true,
        Some('.' | '!') => next.next().is_none_or(char::is_whitespace),
        Some(_) => false,
    };
    before && after
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
        let cfg = McpServerConfig::from_entry("s", &json!({"command": "c", "env_vars": ["KEEP"], "env": {"X": "${KEEP}"}}), &e).unwrap();
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
        assert_eq!(
            of(with(json!({"maxTotalTimeoutMs": 900000})), &[("MIXDOG_MCP_MAX_TOTAL_TIMEOUT_MS", "600000")]).max_total_timeout,
            Some(Duration::from_secs(900))
        );
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

    /// `process.env` ignores case on Windows: the variable names of the bearer token and the env headers match that way there.
    #[test]
    fn env_variable_names_of_http_auth_ignore_case_only_on_windows() {
        let e = env(&[("Tok", "abc"), ("h", "hv")]);
        let cfg = McpServerConfig::from_entry("s", &json!({"url": "https://x", "bearer_token_env_var": "TOK", "env_http_headers": {"X-H": "H"}}), &e).unwrap();
        let TransportConfig::Http { headers, .. } = cfg.transport else { panic!() };
        assert_eq!(headers.get("Authorization").map(String::as_str), cfg!(windows).then_some("Bearer abc"));
        assert_eq!(headers.get("X-H").map(String::as_str), cfg!(windows).then_some("hv"));
    }

    /// The advert is read at each resolve, not once with the config: a server configured before its service started, or
    /// whose service moved to another port, finds the advert on disk now.
    #[test]
    fn an_auto_detect_entry_connects_to_the_port_advertised_now() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("discovery");
        std::fs::create_dir_all(&dir).unwrap();
        let e = env(&[("MIXDOG_RUNTIME_ROOT", root.path().to_str().unwrap())]);
        let cfg = McpServerConfig::from_entry("memory", &json!({"autoDetect": "mixdog-memory"}), &e).unwrap();
        assert!(cfg.oauth.is_none());
        let TransportConfig::AutoDetect(target) = &cfg.transport else { panic!() };
        assert_eq!(target.resolve("memory").unwrap_err(), ConfigError::AutoDetectAdvertMissing("memory".to_owned()));
        std::fs::write(dir.join("memory.json"), r#"{"port": 4321, "updatedAt": 1}"#).unwrap();
        assert_eq!(target.resolve("memory").unwrap().0.as_str(), "http://127.0.0.1:4321/mcp");
        std::fs::write(dir.join("memory.json"), r#"{"port": 4323, "updatedAt": 2}"#).unwrap();
        assert_eq!(target.resolve("memory").unwrap().0.as_str(), "http://127.0.0.1:4323/mcp");
        let unknown = McpServerConfig::from_entry("x", &json!({"autoDetect": "nope"}), &e).unwrap_err();
        assert_eq!(unknown.to_string(), "Unknown autoDetect target: \"nope\"");
    }

    /// A credential typed as the target is not repeated by the error.
    #[test]
    fn an_unknown_auto_detect_target_is_reported_scrubbed() {
        let entry = json!({"autoDetect": "https://user:hunter2@host.example/x?token=abc123"});
        let error = McpServerConfig::from_entry("x", &entry, &env(&[])).unwrap_err().to_string();
        assert_eq!(error, "Unknown autoDetect target: \"https://[redacted]@host.example/x?token=[redacted]\"");
    }

    /// The advert a refused connect marked is not trusted again until its service re-advertises (`markServiceUnreachable`).
    #[test]
    fn a_refused_advert_is_distrusted_until_its_service_re_advertises() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("discovery");
        std::fs::create_dir_all(&dir).unwrap();
        let advert = |updated: u64| std::fs::write(dir.join("memory.json"), format!(r#"{{"port": 4322, "updatedAt": {updated}}}"#)).unwrap();
        advert(1);
        let e = env(&[("MIXDOG_RUNTIME_ROOT", root.path().to_str().unwrap())]);
        let entry = json!({"autoDetect": "mixdog-memory"});
        let cfg = McpServerConfig::from_entry("memory", &entry, &e).unwrap();
        let TransportConfig::AutoDetect(target) = &cfg.transport else { panic!() };
        let (_, resolved) = target.resolve("memory").unwrap();
        assert!(connection_refused("ECONNREFUSED"));
        assert!(!connection_refused("ETIMEDOUT"));
        mark_service_unreachable(&resolved);
        assert_eq!(target.resolve("memory").unwrap_err(), ConfigError::AutoDetectAdvertMissing("memory".to_owned()));
        advert(2);
        assert_eq!(target.resolve("memory").unwrap().0.as_str(), "http://127.0.0.1:4322/mcp");
    }

    /// `resolveRuntimeRoot`: the legacy shared root is used only while it is this user's private root with a live daemon.
    #[cfg(unix)]
    #[test]
    fn the_legacy_runtime_root_is_used_while_it_is_private_and_live() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        // SAFETY: `getuid` has no preconditions and cannot fail.
        let isolated = tmp.path().join(format!("mixdog-{}", unsafe { libc::getuid() }));
        let legacy = tmp.path().join("mixdog");
        assert_eq!(default_runtime_root(tmp.path()), isolated, "no legacy root");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::set_permissions(&legacy, std::fs::Permissions::from_mode(0o700)).unwrap();
        let daemon = legacy.join("daemon.json");
        std::fs::write(&daemon, format!(r#"{{"pid": {}}}"#, std::process::id())).unwrap();
        std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(default_runtime_root(tmp.path()), legacy, "a private root with a live daemon");
        std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(default_runtime_root(tmp.path()), isolated, "a discovery file others can read");
        std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::write(&daemon, r#"{"pid": 2147483647}"#).unwrap();
        assert_eq!(default_runtime_root(tmp.path()), isolated, "a dead daemon");
    }

    /// A stdio server's credential-named variables are its secrets; its other settings are not.
    #[test]
    fn a_stdio_servers_credential_variables_are_its_secrets() {
        let entry = json!({"command": "c", "env_vars": [], "env": {"OPENAI_API_KEY": "sk-abcdef", "GITHUB_TOKEN": "ghp_123456", "PG_PASSWORD": "pw", "MODE": "production"}});
        let secrets = McpServerConfig::from_entry("s", &entry, &env(&[])).unwrap().secret_values();
        for secret in ["sk-abcdef", "ghp_123456", "pw"] {
            assert!(secrets.contains(&secret.to_owned()), "{secret:?} of every length is a secret: {secrets:?}");
        }
        assert!(!secrets.contains(&"production".to_owned()), "{secrets:?}");
    }

    #[test]
    fn an_enabled_server_whose_accounts_are_all_disabled_does_not_connect() {
        let entry = json!({"url": "https://x", "connector": "gmail", "accounts": [{"name": "a", "url": "https://a.example/mcp", "enabled": false}]});
        let cfg = McpServerConfig::from_entry("hub", &entry, &env(&[])).unwrap();
        assert_eq!(cfg.blocked.as_deref(), Some("Every account of \"hub\" is disabled"));
    }

    /// A short credential is redacted wherever it stands as a value, and ordinary text that merely holds its characters
    /// (an error code, a version, a longer word) is left as it was; a long one is redacted inside any text.
    #[test]
    fn a_short_secret_is_redacted_as_a_value_and_never_inside_other_text() {
        let secrets = ["2".to_owned(), "pw".to_owned(), "sk-live-0123456789".to_owned()];
        let untouched = "MCP error -32000: Connection closed; jsonrpc 2.0; pwned at 12:30";
        assert_eq!(scrub(untouched, &secrets), untouched);
        assert_eq!(
            scrub("password=pw; login pw failed. (pw) \"pw\" retry 2 of 3, key=xsk-live-0123456789y", &secrets),
            "password=[redacted]; login [redacted] failed. ([redacted]) \"[redacted]\" retry [redacted] of 3, key=x[redacted]y"
        );
        assert_eq!(scrub("the password is pw.", &secrets), "the password is [redacted].");
        assert_eq!(scrub("the password is pw", &secrets), "the password is [redacted]");
        // The user info of any URI scheme, and a short secret the `@` of user info ends.
        let pg = ["abc123".to_owned()];
        assert_eq!(scrub("connect postgres://user:abc123@db.example:5432/app failed", &pg), "connect postgres://[redacted]@db.example:5432/app failed");
        assert_eq!(scrub("as user:abc123@db.example", &pg), "as user:[redacted]@db.example");
        assert_eq!(scrub("mongodb+srv://u:p@cluster.example/x", &[]), "mongodb+srv://[redacted]@cluster.example/x");
    }

    #[test]
    fn credential_shaped_url_parts_are_scrubbed_from_any_text() {
        let text = scrub("fetch https://user:pw@host/p?token=abc&x=1 failed", &[]);
        assert_eq!(text, "fetch https://[redacted]@host/p?token=[redacted]&x=1 failed");
    }
}

/// `mcpLog` (mcp/client.mjs:147): the client's own log lines are dropped while `MIXDOG_QUIET_MCP_LOG` is set to
/// anything but the empty string.
pub fn log_quiet() -> bool {
    quiet(std::env::var_os("MIXDOG_QUIET_MCP_LOG").as_deref())
}
/// One line of the MCP client's log (`mcpLog`), unless it is quiet.
pub(crate) fn mcp_log(line: &str) {
    if !log_quiet() {
        tracing::warn!("{line}");
    }
}
