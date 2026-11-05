//! The pure routing decision (`decideProxyRoute` in `proxy-policy.mjs`): the
//! one question every outbound provider path asks for the destination it is
//! about to open.
//!
//!   system  the user's proxy variables (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY,
//!           NO_PROXY; `NO_PROXY=*` forces direct), otherwise the OS proxy.
//!           Local and LAN hosts are always direct.
//!   manual  `url` for everything except `exceptions`. A proxy that fails is a
//!           failure: there is no direct fallback.
//!   off     direct, ignoring the OS proxy and every proxy variable.

use mixdog_js::js_trim;
use serde_json::Value;
use url::Url;

use super::hosts::is_local_host;
use super::setting::Mode;
use super::setting::NetworkProxySetting;
use super::setting::PROXY_SCHEMES;
use super::setting::exceptions_cover;
use super::setting::parse_proxy_url;
use super::system::SystemProxy;

/// A manual proxy that has no usable address, or a setting that was never
/// readable: every connection fails with this, never goes direct.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ProxyConfigError {
    pub message: String,
}

impl ProxyConfigError {
    pub const CODE: &'static str = "MIXDOG_PROXY_CONFIG";

    pub fn new(message: &str) -> Self {
        Self { message: message.to_owned() }
    }
}

impl std::fmt::Display for ProxyConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProxyConfigError {}

/// Why no route could be decided.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum RouteError {
    Config(ProxyConfigError),
    /// The target is not a URL (`new URL` throws).
    InvalidTarget(String),
}

impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RouteError::Config(error) => error.fmt(f),
            RouteError::InvalidTarget(target) => write!(f, "Invalid URL: {target}"),
        }
    }
}

impl std::error::Error for RouteError {}

impl From<ProxyConfigError> for RouteError {
    fn from(error: ProxyConfigError) -> Self {
        RouteError::Config(error)
    }
}

/// `{ proxy, via }`: `proxy` a proxy URL or `None` for direct, `via` one of
/// off, manual, env, system, direct.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Route {
    pub proxy: Option<String>,
    pub via: &'static str,
    pub env_var: Option<&'static str>,
}

impl Route {
    pub fn direct(via: &'static str) -> Self {
        Route { proxy: None, via, env_var: None }
    }
}

/// Reads one environment variable.
pub trait EnvLookup: Send + Sync {
    fn get(&self, name: &str) -> Option<String>;
}

/// The process environment.
pub struct ProcessEnv;

impl EnvLookup for ProcessEnv {
    fn get(&self, name: &str) -> Option<String> {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    }
}

/// `env[name] ?? env[name.toLowerCase()]`, trimmed; empty when not a string or blank.
pub(crate) fn env_value(env: &dyn EnvLookup, name: &str) -> String {
    let value = env.get(name).or_else(|| env.get(&name.to_lowercase()));
    value.map(|value| js_trim(&value).to_owned()).unwrap_or_default()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Http,
    Https,
    Wss,
}

/// The proxy variable that applies to a request kind: its name and URL.
/// `ALL_PROXY` must be http(s).
pub(crate) fn env_proxy_for(kind: Kind, env: &dyn EnvLookup) -> Option<(&'static str, String)> {
    let names: &[&'static str] = match kind {
        Kind::Http => &["HTTP_PROXY", "ALL_PROXY"],
        Kind::Https => &["HTTPS_PROXY", "ALL_PROXY"],
        Kind::Wss => &["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"],
    };
    names.iter().find_map(|name| {
        let schemes: &[&str] = if *name == "ALL_PROXY" { &["http:", "https:"] } else { &PROXY_SCHEMES };
        parse_proxy_url(&Value::String(env_value(env, name)), schemes, true).ok().map(|url| (*name, url))
    })
}

/// The names of the proxy variables set in `env`, for describing what `off` ignores.
pub fn proxy_variables_set(env: &dyn EnvLookup) -> Vec<&'static str> {
    ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"].into_iter().filter(|name| !env_value(env, name).is_empty()).collect()
}

/// `target` as an http(s) URL plus its request kind (ws and wss follow their
/// http equivalents). `Ok(None)` for a scheme that has no proxy route.
fn request_of(target: &str) -> Result<Option<(Url, Kind)>, RouteError> {
    let mut url = Url::parse(target).map_err(|_| RouteError::InvalidTarget(target.to_owned()))?;
    let kind = match url.scheme() {
        "https" => Kind::Https,
        "wss" => Kind::Wss,
        "http" | "ws" => Kind::Http,
        _ => return Ok(None),
    };
    if matches!(url.scheme(), "ws" | "wss") {
        let scheme = if kind == Kind::Wss { "https" } else { "http" };
        url.set_scheme(scheme).map_err(|()| RouteError::InvalidTarget(target.to_owned()))?;
    }
    Ok(Some((url, kind)))
}

/// The route for `target`. `system` is the OS route, when this process has one.
/// A manual proxy without an address is a [`ProxyConfigError`].
pub async fn decide_proxy_route(
    target: &str,
    setting: &NetworkProxySetting,
    env: &dyn EnvLookup,
    system: Option<&SystemProxy>,
) -> Result<Route, RouteError> {
    if setting.mode == Mode::Off {
        return Ok(Route::direct("off"));
    }
    let Some((url, kind)) = request_of(target)? else { return Ok(Route::direct("direct")) };
    if setting.mode == Mode::Manual {
        if setting.url.is_empty() {
            return Err(ProxyConfigError::new("The network proxy is set to manual but has no address.").into());
        }
        return Ok(if exceptions_cover(&setting.exceptions, &url) {
            Route::direct("direct")
        } else {
            Route { proxy: Some(setting.url.clone()), via: "manual", env_var: None }
        });
    }
    let no_proxy = env_value(env, "NO_PROXY");
    if no_proxy == "*" || is_local_host(url.host_str().unwrap_or_default()) {
        return Ok(Route::direct("direct"));
    }
    if let Some((name, proxy)) = env_proxy_for(kind, env) {
        return Ok(if exceptions_cover(&no_proxy, &url) {
            Route::direct("direct")
        } else {
            Route { proxy: Some(proxy), via: "env", env_var: Some(name) }
        });
    }
    let Some(system) = system else { return Ok(Route::direct("direct")) };
    let answer = system.route(&url.origin().ascii_serialization()).await;
    Ok(match answer.proxy {
        Some(proxy) => Route { proxy: Some(proxy), via: "system", env_var: None },
        None => Route::direct("direct"),
    })
}
