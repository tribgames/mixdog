//! Live client versions, as Node discovers them.
//!
//! Four dialects gate on the version of the client that talks to them. Node learns it from the
//! network, keeps the last answer on disk and never goes below its pinned floor:
//!
//! - Codex (`codex-client-meta.mjs`) and Grok (`grok-client-version.mjs`): the npm registry's
//!   `latest` of `@openai/codex` / `@xai-official/grok`, 24 h while it answers and 10 min after a
//!   failure, one request in flight, 4 s; Grok also learns a minimum a 426 body states.
//! - Cursor (`cursor-client-version.mjs`): the build id the installer script embeds, same
//!   schedule, never an older build than the floor.
//! - Antigravity (`antigravity-oauth-tokens.mjs`): the update manifest, 5 s, resolved once per
//!   process; a failure is not retried for 10 min.
//!
//! The last answer of each lives in `client-versions.json` of the plugin data directory, and
//! `MIXDOG_DISABLE_LIVE_CLI_VERSIONS=1` turns every lookup (and the file) off. A send warms its
//! dialect's version before it goes out ([`ClientVersions::warm`]); what it then puts on the wire
//! is read at request time ([`Live`]), so a version learned later reaches the next request.

use crate::transport::deadlines::NODE_DISPATCHER;
use std::cmp::Ordering;
use std::convert::Infallible;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::WireRequest;
use regex::Regex;
use serde_json::Value;

use crate::oauth::CredentialIo;
use crate::providers::google::auth::antigravity::VERSION_FALLBACK as ANTIGRAVITY_VERSION_FALLBACK;
use crate::providers::google::auth::antigravity::VERSION_MANIFEST_URL as ANTIGRAVITY_MANIFEST_URL;
use crate::registry::keys::Environment;
use crate::transport::http::HttpSend;

/// `CODEX_CLIENT_VERSION_FLOOR`: the version when no live answer is known.
pub const CODEX_CLIENT_VERSION_FLOOR: &str = "0.166.0";
pub const CODEX_NPM_PACKAGE: &str = "@openai/codex";
/// `GROK_CLI_VERSION_FLOOR`.
pub const GROK_CLIENT_VERSION_FLOOR: &str = "1.0.70";
pub const GROK_NPM_PACKAGE: &str = "@xai-official/grok";
/// `CURSOR_CLIENT_VERSION_FLOOR`.
pub const CURSOR_CLIENT_VERSION_FLOOR: &str = "cli-2026.10.22-27dcf5f";
pub const CURSOR_INSTALL_URL: &str = "https://cursor.com/install";
pub const LAST_KNOWN_FILE: &str = "client-versions.json";

const DEFAULT_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const FAILURE_TTL: Duration = Duration::from_secs(10 * 60);
const TIMEOUT: Duration = Duration::from_secs(4);
const ANTIGRAVITY_TIMEOUT: Duration = Duration::from_secs(5);
const ANTIGRAVITY_RETRY_AFTER: Duration = Duration::from_secs(10 * 60);
const LAST_KNOWN_SCHEMA: i64 = 1;

/// A version read when a request is built, not when its adapter was.
#[derive(Clone)]
pub struct Live(Arc<dyn Fn() -> String + Send + Sync>);

impl Live {
    pub fn new(read: impl Fn() -> String + Send + Sync + 'static) -> Self {
        Self(Arc::new(read))
    }

    pub fn get(&self) -> String {
        (self.0)()
    }
}

impl From<String> for Live {
    fn from(value: String) -> Self {
        Self::new(move || value.clone())
    }
}

impl From<&str> for Live {
    fn from(value: &str) -> Self {
        value.to_owned().into()
    }
}

impl fmt::Debug for Live {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Live({:?})", self.get())
    }
}

impl PartialEq for Live {
    fn eq(&self, other: &Self) -> bool {
        self.get() == other.get()
    }
}

impl Eq for Live {}

fn lock<T>(state: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    state.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Epoch milliseconds (`Date.now()`).
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64))
}

/// `/^\d+\.\d+\.\d+$/`.
pub fn is_semver(text: &str) -> bool {
    let mut parts = text.split('.');
    let digits = |part: Option<&str>| part.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    digits(parts.next()) && digits(parts.next()) && digits(parts.next()) && parts.next().is_none()
}

/// `compareSemver`: component-wise `Number` difference.
fn compare_semver(a: &str, b: &str) -> Ordering {
    let number = |part: &str| part.parse::<f64>().unwrap_or(f64::NAN);
    for (x, y) in a.split('.').zip(b.split('.')) {
        let (x, y) = (number(x), number(y));
        if x != y {
            return x.partial_cmp(&y).unwrap_or(Ordering::Equal);
        }
    }
    Ordering::Equal
}

/// `maxSemver`: the highest valid x.y.z among the candidates (invalid and empty ignored).
pub fn max_semver(candidates: &[Option<&str>]) -> Option<String> {
    let mut best: Option<String> = None;
    for candidate in candidates {
        let text = mixdog_js::js_trim(candidate.unwrap_or_default()).to_owned();
        if is_semver(&text) && best.as_deref().is_none_or(|b| compare_semver(&text, b) == Ordering::Greater) {
            best = Some(text);
        }
    }
    best
}

fn live_lookup_disabled(env: &dyn Environment) -> bool {
    env.var("MIXDOG_DISABLE_LIVE_CLI_VERSIONS").as_deref() == Some("1")
}

/// `/^[\w.+-]{1,64}$/`.
fn valid_remembered(value: &str) -> bool {
    (1..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
}

/// `client-version-store.mjs`: the last live version each client saw, one key per client.
#[derive(Clone)]
pub struct LastKnown {
    path: PathBuf,
    io: CredentialIo,
    env: Arc<dyn Environment>,
    now: Clock,
}

fn read_remembered(path: &std::path::Path, key: &str) -> Option<String> {
    let raw: Value = serde_json::from_slice(&mixdog_statefile::read_content(path).ok()??).ok()?;
    if raw.get("version").and_then(Value::as_i64) != Some(LAST_KNOWN_SCHEMA) {
        return None;
    }
    let value = raw.get("entries")?.get(key)?.get("value")?.as_str()?;
    valid_remembered(value).then(|| value.to_owned())
}

impl LastKnown {
    /// `data_dir` is the plugin data directory.
    pub fn new(data_dir: PathBuf, io: CredentialIo, env: Arc<dyn Environment>, now: Clock) -> Self {
        Self { path: data_dir.join(LAST_KNOWN_FILE), io, env, now }
    }

    /// `readLastKnownVersion`.
    pub async fn read(&self, key: &str) -> Option<String> {
        if live_lookup_disabled(self.env.as_ref()) {
            return None;
        }
        let (path, key) = (self.path.clone(), key.to_owned());
        self.io.read_job(move |_| Ok(read_remembered(&path, &key))).await.ok().flatten()
    }

    /// `rememberLastKnownVersion`: `None` forgets the key. Best-effort: a read-only data
    /// directory must not break the lookup.
    pub async fn remember(&self, key: &str, value: Option<&str>) {
        if live_lookup_disabled(self.env.as_ref()) || value.is_some_and(|v| !valid_remembered(v)) {
            return;
        }
        let (path, key, value, fetched_at) = (self.path.clone(), key.to_owned(), value.map(str::to_owned), (self.now)());
        let _ = self
            .io
            .write_job(move |lane| {
                let opts = mixdog_statefile::Opts { lock: true, ..mixdog_statefile::Opts::default() };
                let mutate = |current: Option<Value>| -> Result<Option<Value>, Infallible> {
                    let mut entries = match current {
                        Some(doc) if doc.get("version").and_then(Value::as_i64) == Some(LAST_KNOWN_SCHEMA) => {
                            doc.get("entries").and_then(Value::as_object).cloned().unwrap_or_default()
                        }
                        _ => serde_json::Map::new(),
                    };
                    let held = entries.get(&key).and_then(|e| e.get("value")).and_then(Value::as_str);
                    if held == value.as_deref() {
                        return Ok(None);
                    }
                    match &value {
                        None => {
                            entries.shift_remove(&key);
                        }
                        Some(v) => {
                            entries.insert(key.clone(), serde_json::json!({ "value": v, "fetchedAt": fetched_at }));
                        }
                    }
                    Ok(Some(serde_json::json!({ "version": LAST_KNOWN_SCHEMA, "entries": entries })))
                };
                let _ = mixdog_statefile::update_json(lane, &path, mutate, &opts);
                Ok(())
            })
            .await;
    }
}

/// One GET of `url`, whole body as text; `None` when offline, slow or not a success.
async fn fetch_text(http: &dyn HttpSend, url: &str, headers: &[(String, String)], deadline: Duration) -> Option<String> {
    let request = WireRequest {
        transport: TransportKind::Http1,
        method: "GET".into(),
        url: url.to_owned(),
        headers: headers.to_vec(),
        body: Vec::new(),
    };
    let exchange = async {
        let response = http.send(request, NODE_DISPATCHER).await.ok()?;
        if !response.is_success() {
            return None;
        }
        let read = response.read_all().await.ok()?;
        Some(String::from_utf8_lossy(&read.body).into_owned())
    };
    tokio::time::timeout(deadline, exchange).await.ok().flatten()
}

/// `parseNpmLatest`: the registry document's `version`, when it is x.y.z.
pub fn parse_npm_latest(body: &str) -> Option<String> {
    let version = serde_json::from_str::<Value>(body).ok()?.get("version").cloned().unwrap_or(Value::Null);
    // `String(version || '')`
    let falsy = match &version {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        _ => false,
    };
    let text = if falsy { String::new() } else { mixdog_js::js_trim(&mixdog_js::value_to_string(&version)).to_owned() };
    is_semver(&text).then_some(text)
}

static CURSOR_BUILD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"downloads\.cursor\.com/lab/([0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]{6,40})/").expect("static pattern"));
static CURSOR_BUILD_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^cli-([0-9]{4}\.[0-9]{2}\.[0-9]{2})-[0-9a-f]+$").expect("static pattern"));
static ANTIGRAVITY_MANIFEST_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$"#).expect("static pattern")
});
static GROK_MINIMUM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:minimum|required|at least|>=|newer than|upgrade to)[^0-9]{0,40}?([0-9]+\.[0-9]+\.[0-9]+)").expect("static pattern")
});

/// `parseCursorInstallBuild`: the `cli-<build>` the installer script names.
pub fn parse_cursor_install_build(body: &str) -> Option<String> {
    CURSOR_BUILD.captures(body).map(|m| format!("cli-{}", &m[1]))
}

/// `parseAntigravityManifestVersion`: the first `version:` line of an electron-builder manifest.
pub fn parse_antigravity_manifest_version(text: &str) -> Option<String> {
    for line in text.split('\n') {
        let Some(m) = ANTIGRAVITY_MANIFEST_LINE.captures(line.strip_suffix('\r').unwrap_or(line)) else { continue };
        let version = mixdog_js::js_trim(m.get(1).or(m.get(2)).or(m.get(3)).map_or("", |g| g.as_str()));
        return is_semver(version).then(|| version.to_owned());
    }
    None
}

/// `cursorBuildNewer`: a build replaces another unless it is dated earlier or unparseable.
pub fn cursor_build_newer(next: &str, current: &str) -> bool {
    let date = |id: &str| CURSOR_BUILD_DATE.captures(id).map(|m| m[1].to_owned());
    match (date(next), date(current)) {
        (Some(n), Some(c)) => next != current && n >= c,
        _ => false,
    }
}

#[derive(Default)]
struct RemoteState {
    value: Option<String>,
    expires_at: u64,
    last_known_loaded: bool,
    flight: Option<Shared<BoxFuture<'static, ()>>>,
}

/// `createRemoteVersionSource`: one URL, parsed to a version, cached for a day.
pub struct RemoteVersion {
    http: Arc<dyn HttpSend>,
    url: String,
    parse: fn(&str) -> Option<String>,
    persist_key: &'static str,
    store: LastKnown,
    env: Arc<dyn Environment>,
    now: Clock,
    state: Mutex<RemoteState>,
}

impl RemoteVersion {
    fn new(
        http: Arc<dyn HttpSend>,
        url: String,
        parse: fn(&str) -> Option<String>,
        persist_key: &'static str,
        store: LastKnown,
        env: Arc<dyn Environment>,
        now: Clock,
    ) -> Arc<Self> {
        Arc::new(Self { http, url, parse, persist_key, store, env, now, state: Mutex::new(RemoteState::default()) })
    }

    /// The cached live version (or the newest this machine has seen once [`Self::warm`] loaded it).
    pub fn sync(&self) -> Option<String> {
        lock(&self.state).value.clone()
    }

    /// Stale on purpose: the last known answers until the refresh lands, never instead of it.
    async fn load_last_known(&self) {
        {
            let mut state = lock(&self.state);
            if std::mem::replace(&mut state.last_known_loaded, true) {
                return;
            }
        }
        let remembered = self.store.read(self.persist_key).await;
        let mut state = lock(&self.state);
        if state.value.is_none() {
            state.value = remembered;
        }
    }

    /// Awaitable and never failing; bounded by the fetch timeout.
    pub async fn warm(self: &Arc<Self>) -> Option<String> {
        self.load_last_known().await;
        if (self.now)() < lock(&self.state).expires_at {
            return self.sync();
        }
        self.ensure_refresh().await
    }

    async fn ensure_refresh(self: &Arc<Self>) -> Option<String> {
        if live_lookup_disabled(self.env.as_ref()) {
            return self.sync();
        }
        let flight = lock(&self.state)
            .flight
            .get_or_insert_with(|| {
                let this = Arc::clone(self);
                async move {
                    this.refresh().await;
                    lock(&this.state).flight = None;
                }
                .boxed()
                .shared()
            })
            .clone();
        flight.await;
        self.sync()
    }

    async fn refresh(&self) {
        // Offline or slow keeps the previous value (or the caller's floor).
        let next = fetch_text(self.http.as_ref(), &self.url, &[], TIMEOUT).await.and_then(|body| (self.parse)(&body));
        if let Some(version) = &next {
            lock(&self.state).value = Some(version.clone());
            self.store.remember(self.persist_key, Some(version)).await;
        }
        let ttl = if next.is_some() { DEFAULT_TTL } else { FAILURE_TTL };
        lock(&self.state).expires_at = (self.now)() + ttl.as_millis() as u64;
    }
}

#[derive(Default)]
struct AntigravityState {
    discovered: Option<String>,
    last_known: Option<Option<String>>,
    flight: Option<Shared<BoxFuture<'static, String>>>,
    failed_at: u64,
}

/// `ensureAntigravityVersion`: the update manifest's version, resolved once per process.
pub struct AntigravityVersion {
    http: Arc<dyn HttpSend>,
    url: String,
    store: LastKnown,
    env: Arc<dyn Environment>,
    now: Clock,
    state: Mutex<AntigravityState>,
}

const ANTIGRAVITY_KEY: &str = "antigravity-hub";

impl AntigravityVersion {
    fn override_in(&self) -> String {
        self.env.var("MIXDOG_ANTIGRAVITY_VERSION").map(|v| mixdog_js::js_trim(&v).to_owned()).unwrap_or_default()
    }

    /// `antigravityVersion()`: the override, else the discovered version, else the newer of the
    /// remembered one and the pinned fallback.
    pub fn current(&self) -> String {
        let configured = self.override_in();
        if !configured.is_empty() {
            return configured;
        }
        let state = lock(&self.state);
        if let Some(found) = &state.discovered {
            return found.clone();
        }
        let remembered = state.last_known.clone().flatten();
        max_semver(&[remembered.as_deref(), Some(ANTIGRAVITY_VERSION_FALLBACK)]).unwrap_or_else(|| ANTIGRAVITY_VERSION_FALLBACK.to_owned())
    }

    async fn load_last_known(&self) {
        if lock(&self.state).last_known.is_some() {
            return;
        }
        let remembered = self.store.read(ANTIGRAVITY_KEY).await;
        lock(&self.state).last_known.get_or_insert(remembered);
    }

    /// Resolves the version. A failed lookup keeps the pinned fallback and is not retried for a
    /// while, so an unreachable manifest host never delays every request.
    pub async fn ensure(self: &Arc<Self>) -> String {
        if !self.override_in().is_empty() {
            return self.current();
        }
        self.load_last_known().await;
        let flight = {
            let mut state = lock(&self.state);
            if state.discovered.is_some() {
                drop(state);
                return self.current();
            }
            if state.flight.is_none() {
                if (self.now)().saturating_sub(state.failed_at) < ANTIGRAVITY_RETRY_AFTER.as_millis() as u64 {
                    drop(state);
                    return self.current();
                }
                let this = Arc::clone(self);
                state.flight = Some(async move { this.discover().await }.boxed().shared());
            }
            state.flight.clone()
        };
        match flight {
            Some(flight) => flight.await,
            None => self.current(),
        }
    }

    async fn discover(&self) -> String {
        let headers = [("Cache-Control".to_owned(), "no-cache".to_owned()), ("User-Agent".to_owned(), "electron-builder".to_owned())];
        let found = fetch_text(self.http.as_ref(), &self.url, &headers, ANTIGRAVITY_TIMEOUT)
            .await
            .and_then(|text| parse_antigravity_manifest_version(&text));
        if let Some(version) = &found {
            lock(&self.state).discovered = Some(version.clone());
            self.store.remember(ANTIGRAVITY_KEY, Some(version)).await;
        }
        {
            let mut state = lock(&self.state);
            if state.discovered.is_none() {
                state.failed_at = (self.now)();
            }
            state.flight = None;
        }
        self.current()
    }
}

/// The dialects that gate on a client version.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dialect {
    Codex,
    Grok,
    Cursor,
    Antigravity,
}

impl Dialect {
    /// The provider whose sends carry the dialect's version.
    pub fn of_provider(provider: &str) -> Option<Self> {
        match provider {
            "openai-oauth" => Some(Self::Codex),
            "grok-oauth" => Some(Self::Grok),
            "cursor-oauth" | "cursor-api" => Some(Self::Cursor),
            "antigravity-oauth" => Some(Self::Antigravity),
            _ => None,
        }
    }
}

/// Everything a process knows of the client versions its dialects present.
pub struct ClientVersions {
    codex: Arc<RemoteVersion>,
    grok: Arc<RemoteVersion>,
    cursor: Arc<RemoteVersion>,
    antigravity: Arc<AntigravityVersion>,
    /// `MIXDOG_GROK_CLIENT_VERSION` / `MIXDOG_CURSOR_CLIENT_VERSION`, read once as Node does.
    grok_env: String,
    cursor_env: String,
    /// A minimum a 426 body stated (`learned`).
    learned: Mutex<Option<String>>,
}

impl ClientVersions {
    /// `data_dir` is the plugin data directory; `http` the process's routed link.
    pub fn new(http: Arc<dyn HttpSend>, data_dir: PathBuf, io: CredentialIo, env: Arc<dyn Environment>) -> Arc<Self> {
        Self::with_clock(http, data_dir, io, env, system_clock())
    }

    pub fn with_clock(http: Arc<dyn HttpSend>, data_dir: PathBuf, io: CredentialIo, env: Arc<dyn Environment>, now: Clock) -> Arc<Self> {
        let store = LastKnown::new(data_dir, io, Arc::clone(&env), Arc::clone(&now));
        let npm = |package: &str, key: &'static str| {
            RemoteVersion::new(
                Arc::clone(&http),
                format!("https://registry.npmjs.org/{package}/latest"),
                parse_npm_latest,
                key,
                store.clone(),
                Arc::clone(&env),
                Arc::clone(&now),
            )
        };
        let text = |name: &str| env.var(name).map(|v| mixdog_js::js_trim(&v).to_owned()).unwrap_or_default();
        Arc::new(Self {
            codex: npm(CODEX_NPM_PACKAGE, "codex-cli"),
            grok: npm(GROK_NPM_PACKAGE, "grok-cli"),
            cursor: RemoteVersion::new(
                Arc::clone(&http),
                CURSOR_INSTALL_URL.to_owned(),
                parse_cursor_install_build,
                "cursor-cli",
                store.clone(),
                Arc::clone(&env),
                Arc::clone(&now),
            ),
            antigravity: Arc::new(AntigravityVersion {
                http,
                url: ANTIGRAVITY_MANIFEST_URL.to_owned(),
                store: store.clone(),
                env: Arc::clone(&env),
                now,
                state: Mutex::new(AntigravityState::default()),
            }),
            grok_env: text("MIXDOG_GROK_CLIENT_VERSION"),
            cursor_env: text("MIXDOG_CURSOR_CLIENT_VERSION"),
            learned: Mutex::new(None),
        })
    }

    /// `codexClientVersionSync`: the live npm version (or the newest this machine has seen),
    /// never below the floor.
    pub fn codex(&self) -> String {
        max_semver(&[Some(CODEX_CLIENT_VERSION_FLOOR), self.codex.sync().as_deref()]).unwrap_or_else(|| CODEX_CLIENT_VERSION_FLOOR.to_owned())
    }

    /// `grokCliVersion`: the override, else the highest of the floor, a learned minimum and the
    /// live npm version.
    pub fn grok(&self) -> String {
        if !self.grok_env.is_empty() {
            return self.grok_env.clone();
        }
        let learned = lock(&self.learned).clone();
        max_semver(&[Some(GROK_CLIENT_VERSION_FLOOR), learned.as_deref(), self.grok.sync().as_deref()])
            .unwrap_or_else(|| GROK_CLIENT_VERSION_FLOOR.to_owned())
    }

    /// `cursorClientVersion`: the override, else the live build when newer than the floor.
    pub fn cursor(&self) -> String {
        if !self.cursor_env.is_empty() {
            return self.cursor_env.clone();
        }
        match self.cursor.sync() {
            Some(current) if cursor_build_newer(&current, CURSOR_CLIENT_VERSION_FLOOR) => current,
            _ => CURSOR_CLIENT_VERSION_FLOOR.to_owned(),
        }
    }

    pub fn antigravity(&self) -> String {
        self.antigravity.current()
    }

    /// Awaited before a dialect's first request (and cheap after it): `warmCodexClientVersion`,
    /// `warmGrokCliVersion`, `warmCursorClientVersion`, `ensureAntigravityVersion`.
    pub async fn warm(self: &Arc<Self>, dialect: Dialect) {
        match dialect {
            Dialect::Codex => {
                self.codex.warm().await;
            }
            Dialect::Grok if self.grok_env.is_empty() => {
                self.grok.warm().await;
            }
            Dialect::Cursor if self.cursor_env.is_empty() => {
                self.cursor.warm().await;
            }
            Dialect::Grok | Dialect::Cursor => {}
            Dialect::Antigravity => {
                self.antigravity.ensure().await;
            }
        }
    }

    /// `learnGrokRequiredVersion`: a minimum stated in a 426 body; true when it raised the version.
    pub fn learn_grok_required(&self, text: &str) -> bool {
        let Some(required) = GROK_MINIMUM.captures(text).and_then(|m| max_semver(&[Some(&m[1])])) else { return false };
        if !self.grok_env.is_empty() {
            return false;
        }
        let before = self.grok();
        if max_semver(&[Some(&before), Some(&required)]).as_deref() == Some(before.as_str()) {
            return false;
        }
        *lock(&self.learned) = Some(required);
        true
    }

    pub fn codex_live(self: &Arc<Self>) -> Live {
        let this = Arc::clone(self);
        Live::new(move || this.codex())
    }

    pub fn grok_live(self: &Arc<Self>) -> Live {
        let this = Arc::clone(self);
        Live::new(move || this.grok())
    }

    pub fn cursor_live(self: &Arc<Self>) -> Live {
        let this = Arc::clone(self);
        Live::new(move || this.cursor())
    }

    pub fn antigravity_live(self: &Arc<Self>) -> Live {
        let this = Arc::clone(self);
        Live::new(move || this.antigravity())
    }
}

#[cfg(test)]
#[path = "client_versions_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) use tests::{versions_in, Net};
