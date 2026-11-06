//! What the network proxy setting does right now (`proxy-diagnostics.mjs`): the
//! route it gives a destination (for the Settings row's description) and a
//! connection check through it. Both go through the same policy the provider
//! paths use.

use std::io;
use std::time::Duration;

use mixdog_js::js_trim;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use bytes::Bytes;
use futures::future::Either;
use http_body_util::Empty;
use hyper_util::rt::TokioIo;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use url::Position;
use url::Url;

use super::NetworkProxy;
use super::clients::RoutedClients;
use super::route::ProxyConfigError;
use super::route::RouteError;
use super::route::proxy_variables_set;
use super::setting::NetworkProxySetting;
use super::setting::proxy_display;
use super::tunnel::TunnelError;
use super::tunnel::Conn;
use super::tunnel::connect_proxy;
use super::tunnel::dial;
use super::tunnel::open_proxy_tunnel;
use super::tunnel::proxy_authorization;
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

/// Connect to `origin` through the current policy: any HTTP answer, whatever
/// its status, shows the route works. `{ ok, ms, origin, status, route }`, or
/// `{ ok: false, ms, origin, code, route }`: the failure is the proxy's or the
/// network's, never retried directly. One deadline covers the whole check, as
/// Node's single timed fetch does.
pub async fn check_proxy_connection(
    clients: &RoutedClients,
    origin: &str,
    setting: &NetworkProxySetting,
) -> Result<Value, RouteError> {
    let route = explain_proxy_route(clients.policy(), origin, setting).await?;
    let started = tokio::time::Instant::now();
    let outcome = match tokio::time::timeout(CHECK_TIMEOUT, head_request(clients.policy(), origin, setting)).await {
        Ok(outcome) => outcome,
        Err(_) => Err("ETIMEDOUT".to_owned()),
    };
    let mut out = Map::new();
    out.insert("ok".into(), json!(outcome.is_ok()));
    out.insert("ms".into(), json!((started.elapsed().as_secs_f64() * 1000.0).round() as u64));
    out.insert("origin".into(), json!(origin));
    match outcome {
        Ok(status) => out.insert("status".into(), json!(status)),
        Err(code) => out.insert("code".into(), json!(code)),
    };
    out.insert("route".into(), route);
    Ok(Value::Object(out))
}

/// The one request of the check, over the one connection our own tunnel opens,
/// so every failure on the way is the typed error of that connection.
async fn head_request(policy: &NetworkProxy, origin: &str, setting: &NetworkProxySetting) -> Result<u16, String> {
    let route = policy.route_with(origin, setting).await.map_err(|error| match error {
        RouteError::Config(_) => ProxyConfigError::CODE.to_owned(),
        RouteError::InvalidTarget(_) => "UNKNOWN".to_owned(),
    })?;
    let url = Url::parse(origin).map_err(|_| "UNKNOWN".to_owned())?;
    let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']).to_owned();
    let port = url.port_or_known_default().unwrap_or(443);
    let https = url.scheme() == "https";
    let keepalive = &KeepaliveSchedule::SPEC.tcp;
    let proxy = route.proxy.as_deref();
    // A SOCKS5 proxy tunnels every request, an HTTP proxy only an https one: an
    // http request is handed to it to forward.
    let forwarded = proxy.is_some_and(|proxy| !https && !proxy.starts_with("socks5:"));
    let conn = match proxy {
        Some(proxy) if forwarded => connect_proxy(proxy, keepalive).await,
        Some(proxy) => open_proxy_tunnel(proxy, &host, port, keepalive).await,
        None => dial(&host, port, keepalive).await.map(Conn::Tcp),
    }
    .map_err(|error| tunnel_error_code(&error, proxy.unwrap_or_default()))?;
    let status = if https {
        let tls = tls_connect(conn, &host).await.map_err(|failure| tls_code(&failure).to_owned())?;
        send_head(tls, &url, None).await?
    } else {
        let credentials = if forwarded { proxy.and_then(proxy_authorization) } else { None };
        send_head(conn, &url, forwarded.then_some(credentials)).await?
    };
    // An http request through a proxy that wants credentials: undici refuses it as an invalid argument.
    if status == 407 && forwarded { Err("UND_ERR_INVALID_ARG".into()) } else { Ok(status) }
}

/// A HEAD for `url` over `stream`. `forwarded` is `Some` when the stream is a
/// proxy's, which gets the absolute URL and the proxy credentials, if any.
async fn send_head<S: AsyncRead + AsyncWrite + Unpin>(
    stream: S,
    url: &Url,
    forwarded: Option<Option<String>>,
) -> Result<u16, String> {
    let (mut sender, connection) = hyper::client::conn::http1::handshake::<_, Empty<Bytes>>(TokioIo::new(stream))
        .await
        .map_err(|error| hyper_code(&error))?;
    let target = if forwarded.is_some() { url.as_str() } else { "/" };
    let mut request =
        hyper::Request::builder().method("HEAD").uri(target).header("host", &url[Position::BeforeHost..Position::AfterPort]);
    if let Some(Some(credentials)) = forwarded {
        request = request.header("proxy-authorization", credentials);
    }
    let request = request.body(Empty::new()).map_err(|_| "UNKNOWN".to_owned())?;
    let exchange = sender.send_request(request);
    futures::pin_mut!(exchange, connection);
    match futures::future::select(exchange, connection).await {
        Either::Left((response, _)) => response.map(|response| response.status().as_u16()).map_err(|error| hyper_code(&error)),
        Either::Right((Err(error), _)) => Err(hyper_code(&error)),
        // The peer answered and closed: the connection ends in the poll that hands the answer over.
        Either::Right((Ok(()), exchange)) => {
            exchange.await.map(|response| response.status().as_u16()).map_err(|error| hyper_code(&error))
        }
    }
}

/// The first typed code in a hyper failure's cause chain; a connection the peer
/// closed is undici's socket error.
fn hyper_code(error: &hyper::Error) -> String {
    let mut cursor: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(current) = cursor {
        if let Some(code) = current.downcast_ref::<io::Error>().and_then(io_code) {
            return code.to_owned();
        }
        cursor = current.source();
    }
    if error.is_incomplete_message() || error.is_closed() { "UND_ERR_SOCKET" } else { "UNKNOWN" }.to_owned()
}

/// The code undici's fetch path gives a failed connection to the proxy or through its tunnel.
fn tunnel_error_code(error: &TunnelError, proxy: &str) -> String {
    match error {
        TunnelError::Refused { code, .. } => code.clone(),
        TunnelError::Dropped(_) if proxy.starts_with("socks5:") => "UND_ERR_SOCKET".into(),
        TunnelError::Dropped(_) => "UND_ERR_PRX_CONN".into(),
        TunnelError::Tls(failure) => match failure.certificate() {
            Some(rustls::CertificateError::NotValidForName | rustls::CertificateError::NotValidForNameContext { .. }) => {
                "UND_ERR_PRX_TLS".to_owned()
            }
            _ => tls_code(failure).to_owned(),
        },
        TunnelError::TimedOut => "UND_ERR_HEADERS_TIMEOUT".into(),
        TunnelError::Dns => "ENOTFOUND".into(),
        TunnelError::Connect(error) | TunnelError::Io(error) => io_code(error).unwrap_or("UNKNOWN").to_owned(),
    }
}