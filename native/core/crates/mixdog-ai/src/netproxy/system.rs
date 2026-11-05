//! The OS proxy for Mixdog's own network stack, decided per origin
//! (`runtime/shared/llm/system-proxy.mjs`).
//!
//! While a desktop app is attached ([`SystemProxy::attach_resolver`]), each
//! origin is routed by Chromium's answer for it (PAC, WPAD, OS exceptions and
//! DIRECT alike), asked once per origin, cached, and bounded: a lookup that
//! fails or is slow goes DIRECT. Without one the fallback decision applies: the
//! OS static proxy with its exact bypass rules, or DIRECT.
//!
//! A proxy that came from the OS is Mixdog's private state, never environment.
//! The user's proxy variables keep their usual behaviour and win outright.
//!
//! Windows discovery reads the registry once at startup. The proxy is used only
//! when the registry answer is exactly representable: a PAC script, SOCKS-only
//! entries and exceptions that have no exact rule leave routing untouched. Any
//! read failure means no system proxy.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the registry read is a bounded child process run on a blocking thread"
)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use serde_json::Value;
use serde_json::json;
use url::Url;

use super::hosts::canonical_host;
use super::hosts::is_ip;
use super::hosts::is_local_host;
use super::hosts::normalize_host;
use super::route::EnvLookup;

/// The handoff to a Mixdog process this one starts: JSON `{ proxy, bypass }`,
/// `proxy` null for "decided: direct". Consumed (and removed from the env) by
/// the receiver at startup.
pub const HANDOFF_VAR: &str = "MIXDOG_SYSTEM_PROXY_HANDOFF";

const INTERNET_SETTINGS_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";
const USER_PROXY_VARS: [&str; 7] = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NODE_USE_ENV_PROXY",
];
const RESOLVE_TIMEOUT: Duration = Duration::from_millis(3_000);
const ROUTE_TTL: Duration = Duration::from_millis(5 * 60_000);
/// A failed lookup is asked again sooner, but not on every request of a burst.
const FAILED_ROUTE_TTL: Duration = Duration::from_millis(30_000);
const REG_QUERY_TIMEOUT: Duration = Duration::from_millis(2_000);

/// `{ proxy }`: a proxy URL, or `None` for DIRECT.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct SystemRoute {
    pub proxy: Option<String>,
}

/// Chromium's proxy answer for one origin, as the desktop app's resolver gives it.
#[async_trait]
pub trait SystemProxyResolver: Send + Sync {
    /// Text such as `PROXY 127.0.0.1:7890; SOCKS5 127.0.0.1:7891; DIRECT`.
    async fn resolve(&self, origin: &str) -> Result<String, String>;
}

/// Raw registry values as `reg query` prints them; `None` when absent.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct RegistryValues {
    pub proxy_enable: Option<String>,
    pub proxy_server: Option<String>,
    pub proxy_override: Option<String>,
    pub auto_config_url: Option<String>,
}

#[async_trait]
pub trait RegistryReader: Send + Sync {
    /// The Internet Settings values, or `None` when the key cannot be read.
    async fn read(&self) -> Option<RegistryValues>;
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ProxyPair {
    pub https: String,
    pub http: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct Bypass {
    pub hosts: Vec<String>,
    pub suffixes: Vec<String>,
}

/// The fallback decision: `{ proxy, bypass }`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Decision {
    pub proxy: Option<ProxyPair>,
    pub bypass: Bypass,
}

impl Decision {
    fn direct() -> Self {
        Decision { proxy: None, bypass: Bypass::default() }
    }

    fn to_value(&self) -> Value {
        match &self.proxy {
            None => json!({ "proxy": null }),
            Some(pair) => {
                let mut proxy = serde_json::Map::new();
                proxy.insert("https".into(), json!(pair.https));
                if let Some(http) = &pair.http {
                    proxy.insert("http".into(), json!(http));
                }
                json!({ "proxy": proxy, "bypass": { "hosts": self.bypass.hosts, "suffixes": self.bypass.suffixes } })
            }
        }
    }
}

static ROW: OnceLock<JsRegex> = OnceLock::new();
static ADDRESS: OnceLock<JsRegex> = OnceLock::new();
static WILDCARD4: OnceLock<JsRegex> = OnceLock::new();
static WILDCARD_HOST: OnceLock<JsRegex> = OnceLock::new();
static PLAIN_HOST: OnceLock<JsRegex> = OnceLock::new();
static DIGITS_DOTS: OnceLock<JsRegex> = OnceLock::new();
static ENABLED: OnceLock<JsRegex> = OnceLock::new();

fn regex(slot: &'static OnceLock<JsRegex>, source: &str, flags: &str) -> &'static JsRegex {
    slot.get_or_init(|| JsRegex::new_static(source, flags))
}

/// The rows of `reg query` output as a name → data map (names lower-cased).
pub fn parse_registry_output(out: &str) -> HashMap<String, String> {
    let row = regex(&ROW, r"^ {4}(\S.*?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$", "");
    let mut values = HashMap::new();
    for line in out.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(caps) = row.captures(line) {
            let name = caps.get(1).unwrap_or_default().to_lowercase();
            values.insert(name, js_trim(caps.get(3).unwrap_or_default()).to_owned());
        }
    }
    values
}

pub fn registry_values(settings: &HashMap<String, String>) -> RegistryValues {
    RegistryValues {
        proxy_enable: settings.get("proxyenable").cloned(),
        proxy_server: settings.get("proxyserver").cloned(),
        proxy_override: settings.get("proxyoverride").cloned(),
        auto_config_url: settings.get("autoconfigurl").cloned(),
    }
}

fn proxy_url(address: &str) -> Option<String> {
    let pattern = r"^(https?:\/\/)?((?:[a-z0-9_-]+\.)*[a-z0-9_-]+|\[[0-9a-f:]+\]):(\d{1,5})$";
    let caps = regex(&ADDRESS, pattern, "i").captures(js_trim(address))?;
    let port = caps.get(3).unwrap_or_default();
    if port.parse::<u32>().ok()? > 65535 {
        return None;
    }
    let scheme = caps.get(1).map_or_else(|| "http://".to_owned(), str::to_lowercase);
    Some(format!("{scheme}{}:{port}", caps.get(2).unwrap_or_default()))
}

/// `ProxyServer` is a bare `host:port` (every scheme) or `scheme=host:port;...`.
/// HTTPS is required: Mixdog's traffic is https, and an http-only entry does not
/// say how it goes. The error is the reason.
pub fn parse_proxy_server(value: &str) -> Result<ProxyPair, String> {
    let text = js_trim(value);
    if text.is_empty() {
        return Err("no proxy server".into());
    }
    if !text.contains('=') {
        return match proxy_url(text) {
            Some(url) => Ok(ProxyPair { https: url.clone(), http: Some(url) }),
            None => Err("unsupported proxy server".into()),
        };
    }
    let mut entries: Vec<(String, String)> = Vec::new();
    for part in text.split(';') {
        if js_trim(part).is_empty() {
            continue;
        }
        match part.find('=') {
            Some(eq) if eq > 0 => {
                let key = js_trim(&part[..eq]).to_lowercase();
                let data = js_trim(&part[eq + 1..]).to_owned();
                entries.retain(|(existing, _)| *existing != key);
                entries.push((key, data));
            }
            _ => return Err("unsupported proxy server".into()),
        }
    }
    let entry = |name: &str| entries.iter().find(|(key, _)| key == name).map(|(_, data)| data.as_str());
    let https = entry("https").and_then(proxy_url);
    let http = entry("http").and_then(proxy_url);
    if entry("https").is_some() && https.is_none() || entry("http").is_some() && http.is_none() {
        return Err("unsupported proxy server".into());
    }
    match https {
        Some(https) => Ok(ProxyPair { https, http }),
        None => Err("no HTTPS proxy (HTTP-only, SOCKS-only or other entries)".into()),
    }
}

fn ipv4_wildcard(entry: &str) -> Option<(String, String)> {
    let caps = regex(&WILDCARD4, r"^(\d{1,3}(?:\.\d{1,3}){0,2})\.\*$", "").captures(entry)?;
    let octets: Vec<u32> = caps.get(1)?.split('.').map(|octet| octet.parse().unwrap_or(0)).collect();
    if octets.iter().any(|octet| *octet > 255) {
        return None;
    }
    let pad = |fill: u32| {
        let mut all = octets.clone();
        all.resize(4, fill);
        all.iter().map(u32::to_string).collect::<Vec<_>>().join(".")
    };
    Some((pad(0), pad(255)))
}

/// `ProxyOverride` as bypass rules (exact hosts and IP literals; `*.domain` as
/// the bare domain, subdomains only), or `None` when any entry has no exact rule.
pub fn translate_proxy_override(value: &str) -> Option<Bypass> {
    let mut bypass = Bypass::default();
    for raw in value.split(';') {
        let entry = js_trim(raw).to_lowercase();
        if entry.is_empty() || entry == "<local>" {
            continue;
        }
        let bare = entry.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(&entry);
        if is_ip(bare) != 0 {
            bypass.hosts.push(canonical_host(bare));
            continue;
        }
        if let Some((start, end)) = ipv4_wildcard(&entry) {
            if is_local_host(&start) && is_local_host(&end) {
                continue;
            }
            return None;
        }
        if let Some(caps) = regex(&WILDCARD_HOST, r"^\*\.((?:[a-z0-9_-]+\.)*[a-z0-9_-]+)$", "").captures(&entry) {
            bypass.suffixes.push(caps.get(1).unwrap_or_default().to_owned());
        } else if regex(&PLAIN_HOST, r"^(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$", "").is_match(&entry)
            && !regex(&DIGITS_DOTS, r"^[\d.]+$", "").is_match(&entry)
        {
            bypass.hosts.push(entry);
        } else {
            return None;
        }
    }
    Some(bypass)
}

/// Why the system proxy is not used; `silent` marks the user's plain "no proxy".
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NotUsed {
    pub reason: String,
    pub silent: bool,
}

/// The decision for registry `values`, or why the system proxy must not be used.
pub fn system_proxy_from_registry(values: Option<&RegistryValues>) -> Result<Decision, NotUsed> {
    let skip = |reason: &str, silent: bool| NotUsed { reason: reason.to_owned(), silent };
    let Some(values) = values else { return Err(skip("registry unreadable", true)) };
    let enabled = regex(&ENABLED, r"^(0x)?0*1$", "i").is_match(js_trim(values.proxy_enable.as_deref().unwrap_or("")));
    let server = values.proxy_server.as_deref().filter(|server| !server.is_empty());
    let Some(server) = server.filter(|_| enabled) else { return Err(skip("disabled", true)) };
    if values.auto_config_url.as_deref().is_some_and(|url| !url.is_empty()) {
        return Err(skip("a PAC script is configured", false));
    }
    let pair = parse_proxy_server(server).map_err(|reason| skip(&reason, false))?;
    let bypass = translate_proxy_override(values.proxy_override.as_deref().unwrap_or(""))
        .ok_or_else(|| skip("proxy exceptions cannot be translated exactly", false))?;
    Ok(Decision { proxy: Some(pair), bypass })
}

/// `value` when it is an http(s) proxy URL a client can be built from.
fn usable_proxy_url(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    let url = Url::parse(text).ok()?;
    super::hosts::decode_uri_component(url.username())?;
    super::hosts::decode_uri_component(url.password().unwrap_or(""))?;
    let scheme_ok = matches!(url.scheme(), "http" | "https");
    (scheme_ok && url.host_str().is_some_and(|host| !host.is_empty())).then(|| text.to_owned())
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

enum Handoff {
    Absent,
    Invalid,
    Decision(Decision),
}

fn parse_handoff(text: Option<&str>) -> Handoff {
    let Some(text) = text else { return Handoff::Absent };
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(text) else { return Handoff::Invalid };
    let Some(proxy) = root.get("proxy") else { return Handoff::Invalid };
    if proxy.is_null() {
        return Handoff::Decision(Decision::direct());
    }
    let https = usable_proxy_url(proxy.get("https").unwrap_or(&Value::Null));
    let http = proxy.get("http").map(usable_proxy_url);
    match (https, http) {
        (Some(https), None) => Handoff::Decision(decision_of(https, None, root.get("bypass"))),
        (Some(https), Some(Some(http))) => Handoff::Decision(decision_of(https, Some(http), root.get("bypass"))),
        _ => Handoff::Invalid,
    }
}

fn decision_of(https: String, http: Option<String>, bypass: Option<&Value>) -> Decision {
    Decision {
        proxy: Some(ProxyPair { https, http }),
        bypass: Bypass {
            hosts: string_list(bypass.and_then(|b| b.get("hosts"))),
            suffixes: string_list(bypass.and_then(|b| b.get("suffixes"))),
        },
    }
}

/// What Chromium's answer for one URL says: its first HTTP(S) proxy, and
/// whether SOCKS entries were skipped on the way.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ChromiumRoute {
    pub proxy: Option<String>,
    pub socks: bool,
}

/// Chromium's proxy answer read in fallback order: the first HTTP(S) proxy
/// wins and DIRECT ends the list; SOCKS entries are skipped (fetch here cannot
/// use them, so that origin goes direct).
pub fn route_from_chromium(answer: &str) -> ChromiumRoute {
    let mut socks = false;
    for entry in answer.split(';') {
        let mut words = js_trim(entry).split(is_js_space).filter(|word| !word.is_empty());
        let kind = words.next().unwrap_or_default().to_uppercase();
        let host_port = words.next().unwrap_or_default();
        if kind == "DIRECT" {
            break;
        }
        if kind.starts_with("SOCKS") {
            socks = true;
            continue;
        }
        if kind == "PROXY" || kind == "HTTPS" {
            let scheme = if kind == "HTTPS" { "https" } else { "http" };
            if let Some(url) = proxy_url(&format!("{scheme}://{host_port}")) {
                return ChromiumRoute { proxy: Some(url), socks: false };
            }
        }
    }
    ChromiumRoute { proxy: None, socks }
}

type LogSink = Arc<dyn Fn(&str) + Send + Sync>;
type Lookup = Shared<BoxFuture<'static, SystemRoute>>;

struct Resolvers {
    id: u64,
    resolver: Arc<dyn SystemProxyResolver>,
}

#[derive(Default)]
struct State {
    /// The fallback decision this process holds, or `None` when it made none.
    active: Option<Decision>,
    /// This process's router is installable (no user variable decides).
    install_routing: bool,
    routing_installed: bool,
    /// The policy asks this module for the OS route (`adoptPrivateProxy`).
    registered: bool,
    resolvers: Vec<Resolvers>,
    routes: HashMap<String, (SystemRoute, Instant)>,
    lookups: HashMap<String, (u64, Lookup)>,
    next_id: u64,
    socks_reported: bool,
    failure_reported: bool,
}

struct Inner {
    state: Mutex<State>,
    log: LogSink,
}

impl Inner {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn reset_routes(state: &mut State) {
        state.routes.clear();
        state.lookups.clear();
    }

    fn report_lookup(&self, found: Option<&ChromiumRoute>) {
        let line = {
            let mut state = self.state();
            match found {
                None if !state.failure_reported => {
                    state.failure_reported = true;
                    Some("[mixdog] system proxy lookup failed or timed out; connecting directly")
                }
                Some(found) if found.socks && found.proxy.is_none() && !state.socks_reported => {
                    state.socks_reported = true;
                    Some("[mixdog] system proxy is SOCKS only for a host; connecting to it directly")
                }
                _ => None,
            }
        };
        if let Some(line) = line {
            (self.log)(line);
        }
    }
}

/// The OS proxy decision of this process and the per-origin routes it gives.
#[derive(Clone)]
pub struct SystemProxy {
    inner: Arc<Inner>,
}

impl Default for SystemProxy {
    fn default() -> Self {
        Self::new(Arc::new(|line| tracing::warn!("{line}")))
    }
}

impl SystemProxy {
    /// `log` receives each diagnostic line (never a URL, answer or credential).
    pub fn new(log: LogSink) -> Self {
        Self { inner: Arc::new(Inner { state: Mutex::new(State::default()), log }) }
    }

    /// Whether the policy asks this module for the OS route (`_systemRoute` is set).
    pub fn registered(&self) -> bool {
        self.inner.state().registered
    }

    /// The fallback decision's route for `origin`: its proxy for the scheme unless the host is excepted.
    fn fallback_route(&self, origin: &str) -> SystemRoute {
        let state = self.inner.state();
        let Some(proxy) = state.active.as_ref().and_then(|active| active.proxy.as_ref().map(|p| (p, &active.bypass))) else {
            return SystemRoute::default();
        };
        let Ok(url) = Url::parse(origin) else { return SystemRoute::default() };
        let host = normalize_host(url.host_str().unwrap_or_default());
        let (pair, bypass) = proxy;
        if bypass.hosts.contains(&host) || bypass.suffixes.iter().any(|suffix| host.ends_with(&format!(".{suffix}"))) {
            return SystemRoute::default();
        }
        let chosen = if url.scheme() == "https" { Some(pair.https.clone()) } else { pair.http.clone() };
        SystemRoute { proxy: chosen }
    }

    /// The route for `origin` (`scheme://host[:port]`): from the attached
    /// resolver's cached answer or one lookup per origin at a time; from the
    /// fallback decision when none is attached.
    pub async fn route(&self, origin: &str) -> SystemRoute {
        let lookup = {
            let mut state = self.inner.state();
            let Some(entry) = state.resolvers.last() else {
                drop(state);
                return self.fallback_route(origin);
            };
            let resolver = Arc::clone(&entry.resolver);
            if let Some((route, expires)) = state.routes.get(origin) {
                if *expires > Instant::now() {
                    return route.clone();
                }
            }
            match state.lookups.get(origin) {
                Some((_, pending)) => pending.clone(),
                None => {
                    state.next_id += 1;
                    let id = state.next_id;
                    let pending = Self::lookup(Arc::clone(&self.inner), origin.to_owned(), resolver, id);
                    state.lookups.insert(origin.to_owned(), (id, pending.clone()));
                    pending
                }
            }
        };
        lookup.await
    }

    fn lookup(inner: Arc<Inner>, origin: String, resolver: Arc<dyn SystemProxyResolver>, id: u64) -> Lookup {
        async move {
            let answered = tokio::time::timeout(RESOLVE_TIMEOUT, resolver.resolve(&origin)).await;
            let found = match answered {
                Ok(Ok(answer)) => Some(route_from_chromium(&answer)),
                _ => None,
            };
            let route = found.as_ref().map_or_else(SystemRoute::default, |f| SystemRoute { proxy: f.proxy.clone() });
            {
                let mut state = inner.state();
                // Not ours any more when the resolver changed meanwhile: not cached.
                if state.lookups.get(&origin).is_some_and(|(current, _)| *current == id) {
                    state.lookups.remove(&origin);
                    let ttl = if found.is_some() { ROUTE_TTL } else { FAILED_ROUTE_TTL };
                    state.routes.insert(origin.clone(), (route.clone(), Instant::now() + ttl));
                }
            }
            inner.report_lookup(found.as_ref());
            route
        }
        .boxed()
        .shared()
    }

    fn ensure_routing(&self) -> bool {
        let mut state = self.inner.state();
        if state.routing_installed {
            return true;
        }
        state.registered = true;
        state.routing_installed = true;
        true
    }

    /// Settles this process's fallback system-proxy decision. A `handoff` from
    /// the launching Mixdog process (the caller removes the variable from its
    /// environment) is the decision; without one, Windows reads the registry.
    /// Nothing happens when the user set a proxy variable or
    /// `MIXDOG_SYSTEM_PROXY=0`. Returns true when a proxy was applied.
    pub async fn adopt(
        &self,
        env: &dyn EnvLookup,
        handoff: Option<&str>,
        windows: bool,
        reader: &dyn RegistryReader,
    ) -> bool {
        let handoff = parse_handoff(handoff);
        {
            let mut state = self.inner.state();
            state.active = None;
            state.install_routing = false;
            state.routing_installed = false;
            state.resolvers.clear();
            Inner::reset_routes(&mut state);
            if env.get("MIXDOG_SYSTEM_PROXY").as_deref() == Some("0")
                || USER_PROXY_VARS.iter().any(|name| env.get(name).is_some())
            {
                return false;
            }
            state.install_routing = true;
            if matches!(handoff, Handoff::Invalid) {
                drop(state);
                (self.inner.log)("[mixdog] system proxy not used: invalid handoff");
                self.inner.state().active = Some(Decision::direct());
                return false;
            }
        }
        match handoff {
            Handoff::Decision(decision) => self.finish_adoption(Some(decision)),
            Handoff::Absent if windows => {
                let found = system_proxy_from_registry(reader.read().await.as_ref());
                self.finish_adoption(match found {
                    Ok(decision) => Some(decision),
                    Err(skipped) => {
                        if !skipped.silent {
                            (self.inner.log)(&format!("[mixdog] system proxy not used: {}", skipped.reason));
                        }
                        Some(Decision::direct())
                    }
                })
            }
            _ => self.finish_adoption(None),
        }
    }

    fn finish_adoption(&self, decision: Option<Decision>) -> bool {
        let has_proxy = decision.as_ref().is_some_and(|decision| decision.proxy.is_some());
        self.inner.state().active = decision;
        has_proxy && self.ensure_routing()
    }

    /// Routes this process by `resolver` until the returned handle is dropped.
    /// The newest attached resolver answers; every attach and detach drops the
    /// cached routes. A no-op when this process routes nothing.
    pub fn attach_resolver(&self, resolver: Arc<dyn SystemProxyResolver>) -> ResolverHandle {
        if !self.inner.state().install_routing || !self.ensure_routing() {
            return ResolverHandle { inner: None, id: 0 };
        }
        let mut state = self.inner.state();
        state.next_id += 1;
        let id = state.next_id;
        state.resolvers.push(Resolvers { id, resolver });
        state.failure_reported = false;
        Inner::reset_routes(&mut state);
        ResolverHandle { inner: Some(Arc::clone(&self.inner)), id }
    }

    /// npm's own proxy settings for the one Mixdog-owned npm spawn (the self-update install): the
    /// route of the registry npm uses, asked only when this process routes at all; empty for DIRECT or
    /// without a decision. For that spawn's env only, never for the process env.
    pub async fn npm_env(&self, registry: &str) -> Vec<(&'static str, String)> {
        if !self.inner.state().install_routing {
            return Vec::new();
        }
        let Ok(url) = Url::parse(registry) else { return Vec::new() };
        if is_local_host(url.host_str().unwrap_or_default()) {
            return Vec::new();
        }
        let Some(proxy) = self.route(&url.origin().ascii_serialization()).await.proxy else { return Vec::new() };
        vec![
            ("npm_config_proxy", proxy.clone()),
            ("npm_config_https_proxy", proxy),
            ("npm_config_noproxy", "localhost,127.0.0.1,::1,.local".to_owned()),
        ]
    }

    pub fn handoff_env(&self) -> Option<(&'static str, String)> {
        let state = self.inner.state();
        state.active.as_ref().map(|active| (HANDOFF_VAR, active.to_value().to_string()))
    }
}

/// An attached resolver; dropping it detaches.
pub struct ResolverHandle {
    inner: Option<Arc<Inner>>,
    id: u64,
}

impl Drop for ResolverHandle {
    fn drop(&mut self) {
        let Some(inner) = &self.inner else { return };
        let mut state = inner.state();
        let before = state.resolvers.len();
        let id = self.id;
        state.resolvers.retain(|entry| entry.id != id);
        if state.resolvers.len() != before {
            Inner::reset_routes(&mut state);
        }
    }
}

/// Reads `reg query` for the Internet Settings key (Windows).
pub struct WindowsRegistry;

fn reg_exe() -> std::path::PathBuf {
    let root = std::env::var("SystemRoot").ok().filter(|root| !root.is_empty()).unwrap_or_else(|| r"C:\Windows".into());
    std::path::Path::new(&root).join("System32").join("reg.exe")
}

fn query_registry_key(key: &str) -> Option<HashMap<String, String>> {
    use std::io::Read;
    let mut command = std::process::Command::new(reg_exe());
    command
        .args(["query", key])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let output = match rx.recv_timeout(REG_QUERY_TIMEOUT) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let status = child.wait().ok()?;
    status.success().then(|| parse_registry_output(&String::from_utf8_lossy(&output)))
}

#[async_trait]
impl RegistryReader for WindowsRegistry {
    async fn read(&self) -> Option<RegistryValues> {
        let settings = tokio::task::spawn_blocking(|| query_registry_key(INTERNET_SETTINGS_KEY)).await.ok()??;
        Some(registry_values(&settings))
    }
}
