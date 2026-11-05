//! What the network proxy setting does right now (`proxy-diagnostics.mjs`): the
//! route it gives a destination (for the Settings row's description) and a
//! connection check through it. Both go through the same policy the provider
//! paths use.

use std::io;
use std::time::Duration;
use std::time::Instant;

use mixdog_js::js_trim;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use url::Url;

use super::NetworkProxy;
use super::clients::ClientError;
use super::clients::RoutedClients;
use super::route::ProxyConfigError;
use super::route::RouteError;
use super::route::proxy_variables_set;
use super::setting::NetworkProxySetting;
use super::setting::proxy_display;
use super::tunnel::TlsFailure;
use super::tunnel::TunnelError;
use super::tunnel::open_proxy_tunnel;
use super::tunnel::tls_code;
use super::tunnel::tls_connect;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;

/// Where the check goes when the main route has no endpoint of its own.
pub const DEFAULT_CHECK_ORIGIN: &str = "https://api.openai.com";
const CHECK_TIMEOUT: Duration = Duration::from_millis(10_000);

const FIRST_PARTY_ORIGINS: [(&str, &str); 6] = [
    ("anthropic", "https://api.anthropic.com"),
    ("openai", "https://api.openai.com"),
    ("gemini", "https://generativelanguage.googleapis.com"),
    ("grok", "https://api.x.ai"),
    ("xai", "https://api.x.ai"),
    ("cursor", "https://api2.cursor.sh"),
];

/// The preset table of the OpenAI-compatible providers (`OPENAI_COMPAT_PRESETS`).
const PRESET_BASE_URLS: [(&str, &str); 3] = [
    ("deepseek", "https://api.deepseek.com"),
    ("xai", "https://api.x.ai/v1"),
    ("openrouter", "https://openrouter.ai/api/v1"),
];

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The origin to check for the main route's `provider`: its configured
/// `baseURL`, else the preset's, else its vendor's API; api.openai.com when
/// there is no provider. `providers` is the agent config's `providers` map.
pub fn provider_check_origin(provider: &Value, providers: &Value) -> String {
    let name = provider.as_str().unwrap_or("");
    let configured = providers
        .get(name)
        .and_then(|entry| entry.get("baseURL"))
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| PRESET_BASE_URLS.iter().find(|(id, _)| *id == name).map(|(_, url)| json!(url)));
    let vendor = FIRST_PARTY_ORIGINS.iter().find(|(prefix, _)| name.starts_with(prefix)).map(|(_, origin)| *origin);
    // `configured || vendor || DEFAULT`, then `new URL` stringifies what it is given.
    let chosen = match configured.filter(is_truthy) {
        Some(value) => mixdog_js::value_to_string(&value),
        None => vendor.unwrap_or(DEFAULT_CHECK_ORIGIN).to_owned(),
    };
    match Url::parse(&chosen) {
        Ok(url) => url.origin().ascii_serialization(),
        Err(_) => DEFAULT_CHECK_ORIGIN.to_owned(),
    }
}

fn platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "other"
    }
}

/// The effective route of `origin` under `setting`, as facts for the UI:
/// `{ via, proxy, envVar, ignored: { system, env }, noProxyAll, platform, error }`.
/// `via` is off, manual, env, system or direct; `proxy` is `host:port` without
/// credentials. Under `off`, `ignored` names what exists and is not followed.
pub async fn explain_proxy_route(policy: &NetworkProxy, origin: &str, setting: &NetworkProxySetting) -> Result<Value, RouteError> {
    let env = policy.env();
    let no_proxy = env.get("NO_PROXY").or_else(|| env.get("no_proxy")).unwrap_or_default();
    let mut facts = Map::new();
    let (via, proxy, env_var, error) = match policy.route_with(origin, setting).await {
        Ok(route) => (
            route.via,
            route.proxy.as_deref().map_or(Value::Null, |url| json!(proxy_display(url))),
            route.env_var.map_or(Value::Null, |name| json!(name)),
            Value::Null,
        ),
        Err(RouteError::Config(_)) => ("manual", Value::Null, Value::Null, json!("no-address")),
        Err(other) => return Err(other),
    };
    let mut ignored = Map::new();
    let (mut ignored_system, mut ignored_env) = (false, Vec::new());
    if setting.mode.as_str() == "off" {
        ignored_env = proxy_variables_set(env);
        ignored_system = policy.os_proxy_route(origin).await.proxy.is_some();
    }
    ignored.insert("system".into(), json!(ignored_system));
    ignored.insert("env".into(), json!(ignored_env));
    facts.insert("via".into(), json!(via));
    facts.insert("proxy".into(), proxy);
    facts.insert("envVar".into(), env_var);
    facts.insert("ignored".into(), Value::Object(ignored));
    facts.insert("noProxyAll".into(), json!(setting.mode.as_str() == "system" && js_trim(&no_proxy) == "*"));
    facts.insert("platform".into(), json!(platform_name()));
    facts.insert("error".into(), error);
    Ok(Value::Object(facts))
}

/// The error code of a failed exchange, as the Node fetch failure chain names it.
fn failure_code(error: &ClientError) -> &'static str {
    match error {
        ClientError::Route(RouteError::Config(_)) => ProxyConfigError::CODE,
        ClientError::Route(RouteError::InvalidTarget(_)) | ClientError::Build(_) => "UNKNOWN",
    }
}

fn io_code(error: &io::Error) -> Option<&'static str> {
    use io::ErrorKind as K;
    Some(match error.kind() {
        K::ConnectionRefused => "ECONNREFUSED",
        K::ConnectionReset => "ECONNRESET",
        K::ConnectionAborted => "ECONNABORTED",
        K::TimedOut => "ETIMEDOUT",
        K::HostUnreachable => "EHOSTUNREACH",
        K::NetworkUnreachable => "ENETUNREACH",
        K::AddrNotAvailable => "EADDRNOTAVAIL",
        K::BrokenPipe => "EPIPE",
        _ => return None,
    })
}

/// The first typed code in a `reqwest` failure's cause chain; a timeout is ETIMEDOUT.
fn reqwest_code(error: &reqwest::Error) -> &'static str {
    let mut cursor: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = cursor {
        if let Some(code) = current.downcast_ref::<io::Error>().and_then(io_code) {
            return code;
        }
        cursor = current.source();
    }
    if error.is_timeout() { "ETIMEDOUT" } else { "UNKNOWN" }
}

/// The host a failed lookup would name: the proxy when routed through one,
/// else the origin's own host. `None` for an IP literal.
async fn lookup_failed(target_host: &str, port: u16) -> bool {
    if target_host.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    tokio::net::lookup_host((target_host, port)).await.is_err()
}

/// Connect to `origin` through the current policy: any HTTP answer, whatever
/// its status, shows the route works. `{ ok, ms, origin, status, route }`, or
/// `{ ok: false, ms, origin, code, route }`: the failure is the proxy's or the
/// network's, never retried directly.
pub async fn check_proxy_connection(
    clients: &RoutedClients,
    origin: &str,
    setting: &NetworkProxySetting,
) -> Result<Value, RouteError> {
    let policy = clients.policy();
    let route = explain_proxy_route(policy, origin, setting).await?;
    let started = Instant::now();
    let finish = |outcome: Result<u16, String>| {
        let mut out = Map::new();
        out.insert("ok".into(), json!(outcome.is_ok()));
        out.insert("ms".into(), json!((started.elapsed().as_secs_f64() * 1000.0).round() as u64));
        out.insert("origin".into(), json!(origin));
        match outcome {
            Ok(status) => out.insert("status".into(), json!(status)),
            Err(code) => out.insert("code".into(), json!(code)),
        };
        out.insert("route".into(), route.clone());
        Value::Object(out)
    };
    let client = match clients.client_for(origin).await {
        Ok(client) => client,
        Err(error) => return Ok(finish(Err(failure_code(&error).to_owned()))),
    };
    let decided = policy.route_with(origin, setting).await.ok();
    let proxy = decided.as_ref().and_then(|route| route.proxy.as_deref());
    let target = Url::parse(origin).ok().map(|url| {
        (
            url.host_str().unwrap_or_default().trim_matches(['[', ']']).to_owned(),
            url.port_or_known_default().unwrap_or(443),
            url.scheme() == "https",
        )
    });
    let proxy_url = proxy.and_then(|url| Url::parse(url).ok());
    let dial_host = match &proxy_url {
        Some(url) => Some((url.host_str().unwrap_or_default().trim_matches(['[', ']']).to_owned(), url.port().unwrap_or(80))),
        None => target.as_ref().map(|(host, port, _)| (host.clone(), *port)),
    };
    if let Some((host, port)) = dial_host {
        if lookup_failed(&host, port).await {
            return Ok(finish(Err("ENOTFOUND".into())));
        }
    }
    if let (Some((host, port, https)), Some(proxy)) = (&target, proxy) {
        // A SOCKS5 proxy tunnels every request, an HTTP proxy only an https one
        // (an http request is forwarded to it): the tunnel is where a refusal is
        // typed.
        let tunnels = *https || proxy.starts_with("socks5:");
        if tunnels {
            match open_proxy_tunnel(proxy, host, *port, &KeepaliveSchedule::SPEC.tcp).await {
                Ok(conn) => {
                    if *https {
                        if let Err(failure) = tls_connect(conn, host).await {
                            return Ok(finish(Err(tls_failure_code(&failure))));
                        }
                    }
                }
                Err(error) => {
                    if let Some(code) = tunnel_failure_code(&error, proxy) {
                        return Ok(finish(Err(code)));
                    }
                }
            }
        }
    } else if let Some((host, port, true)) = &target {
        // Direct to an https origin: a certificate the platform does not trust
        // is the origin's failure to name.
        if let Ok(mut addrs) = tokio::net::lookup_host((host.as_str(), *port)).await {
            if let Some(addr) = addrs.next() {
                if let Ok(stream) = tokio::net::TcpStream::connect(addr).await {
                    if let Err(failure) = tls_connect(stream, host).await {
                        if tls_code(&failure) != "UNKNOWN" {
                            return Ok(finish(Err(tls_code(&failure).to_owned())));
                        }
                    }
                }
            }
        }
    }
    let sent = client.head(origin).timeout(CHECK_TIMEOUT).send().await;
    Ok(match sent {
        // An http request through a proxy that wants credentials: undici refuses it as an invalid argument.
        Ok(response) if response.status().as_u16() == 407 && proxy.is_some() && target.as_ref().is_some_and(|t| !t.2) => {
            finish(Err("UND_ERR_INVALID_ARG".into()))
        }
        Ok(response) => finish(Ok(response.status().as_u16())),
        Err(error) => finish(Err(reqwest_code(&error).to_owned())),
    })
}

/// Node's code for a TLS failure reaching the proxy or the origin.
fn tls_failure_code(failure: &TlsFailure) -> String {
    tls_code(failure).to_owned()
}

/// The code undici's fetch path gives a failed tunnel; `None` where the plain
/// request reports the failure better (the proxy could not be reached).
fn tunnel_failure_code(error: &TunnelError, proxy: &str) -> Option<String> {
    match error {
        TunnelError::Refused { code, .. } => Some(code.clone()),
        TunnelError::Dropped(_) if proxy.starts_with("socks5:") => Some("UND_ERR_SOCKET".into()),
        TunnelError::Dropped(_) => Some("UND_ERR_PRX_CONN".into()),
        TunnelError::Tls(failure) => Some(match failure.certificate() {
            Some(rustls::CertificateError::NotValidForName | rustls::CertificateError::NotValidForNameContext { .. }) => {
                "UND_ERR_PRX_TLS".to_owned()
            }
            _ => tls_code(failure).to_owned(),
        }),
        TunnelError::TimedOut => Some("UND_ERR_HEADERS_TIMEOUT".into()),
        TunnelError::Dns | TunnelError::Connect(_) | TunnelError::Io(_) => None,
    }
}
