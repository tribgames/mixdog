//! `mixdog-relay verify-release`: the non-mutating post-deploy probe (`deploy/verify-release.mjs`). No device is registered and
//! no pairing credential is read: the WebSocket checks exercise the public upgrade route and require its origin and pairing
//! gates to stay shut.
//!
//! Flags (`--name=value` only): `--origin`, `--expected-index`, `--expected-release`, `--address`. One JSON line on stdout and
//! exit 0 when the release verifies; `[deploy] verification failed: <reason>` on stderr and exit 1 otherwise.

use std::collections::HashMap;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use mixdog_rt::time::Instant;
use reqwest::redirect::Policy;
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use url::{Host, Url};

/// A response body above this is a failure.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
/// An origin no real client sends: the relay must refuse its upgrade with 403.
const FOREIGN_ORIGIN: &str = "https://deployment-probe.invalid";
/// The close code a phone without a per-browser credential is sent: the pairing gate is shut.
const PAIRING_GATE_CLOSE: u16 = 4005;
/// What a close without a status code reports, and what a connection lost without a close frame reports.
const CLOSE_NO_STATUS: u16 = 1005;
const CLOSE_ABNORMAL: u16 = 1006;

/// What the probe checks and how it reaches the relay.
#[derive(Clone, Debug)]
pub struct Options {
    /// `http(s)://host[:port]`, no credentials, path, query or fragment.
    pub origin: String,
    /// Lower-case hex SHA-256 of the deployed `index.html`.
    pub expected_index: String,
    /// A release id that must be served side by side with its digest; empty for none.
    pub expected_release: String,
    /// Only `127.0.0.1` may replace DNS; TLS still validates the public host name. Empty for none.
    pub address: String,
    /// The limit of one HTTP request and of one WebSocket probe.
    pub timeout: Duration,
    /// How long a refused connection is retried while the relay starts.
    pub startup: Duration,
    /// DER certificates trusted besides the web roots (a deployment behind a private CA).
    pub extra_roots: Vec<Vec<u8>>,
}

impl Options {
    pub fn new(origin: &str, expected_index: &str) -> Self {
        Self {
            origin: origin.to_owned(),
            expected_index: expected_index.to_owned(),
            expected_release: String::new(),
            address: String::new(),
            timeout: Duration::from_millis(5000),
            startup: Duration::from_millis(15000),
            extra_roots: Vec::new(),
        }
    }
}

/// What a verified deployment reports.
#[derive(Clone, Debug, PartialEq)]
pub struct Verified {
    pub index_sha256: String,
    /// `assets` exactly as `/readyz` reported it.
    pub assets: Value,
    pub releases: usize,
}

impl Verified {
    /// The one stdout line: `JSON.stringify` of the result object, keys in the script's order.
    pub fn to_line(&self) -> String {
        let mut line = serde_json::Map::new();
        line.insert("status".to_owned(), Value::from("verified"));
        line.insert("indexSha256".to_owned(), Value::from(self.index_sha256.as_str()));
        line.insert("assets".to_owned(), self.assets.clone());
        line.insert("releases".to_owned(), Value::from(self.releases));
        line.insert("websocket".to_owned(), Value::from("gated"));
        crate::js::wire(&Value::Object(line))
    }
}

/// A failed probe: the reason the deploy log shows, and whether it was a refused connection (the only startup race).
#[derive(Debug)]
pub struct ProbeError {
    message: String,
    refused: bool,
}

impl ProbeError {
    fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), refused: false }
    }
}

impl fmt::Display for ProbeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn parse_origin(origin: &str) -> Result<Url, ProbeError> {
    let base = Url::parse(origin).map_err(|_| ProbeError::new("Invalid URL"))?;
    let plain = matches!(base.scheme(), "http" | "https")
        && base.username().is_empty()
        && base.password().is_none_or(str::is_empty)
        && base.path() == "/"
        && base.query().is_none_or(str::is_empty)
        && base.fragment().is_none_or(str::is_empty);
    if plain { Ok(base) } else { Err(ProbeError::new("Deployment probe requires an HTTP(S) origin without credentials.")) }
}

fn tls_config(extra: &[Vec<u8>]) -> Arc<ClientConfig> {
    let mut roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for der in extra {
        // A certificate rustls cannot parse is not a trust anchor; the handshake then fails with its own reason.
        let _ = roots.add(CertificateDer::from(der.clone()));
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

trait Wire: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Wire for T {}

/// `Number(value)` as JavaScript converts a parsed JSON value (an array through its `join(',')` string).
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => mixdog_js::string_to_number(text),
        Value::Array(items) => match items.as_slice() {
            [] | [Value::Null] => 0.0,
            [Value::String(_) | Value::Number(_) | Value::Array(_)] => to_number(&items[0]),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// `value > 0` as JavaScript evaluates it for what `/readyz` reports; an absent value is `undefined`, which is not.
fn positive(value: Option<&Value>) -> bool {
    value.is_some_and(|value| to_number(value) > 0.0)
}

/// `--name=value` arguments; a later flag of the same name wins. The first argument of another shape is returned as the error.
fn parse_flags(args: &[String]) -> Result<HashMap<&str, &str>, &str> {
    let mut flags = HashMap::new();
    for arg in args {
        match arg.strip_prefix("--").and_then(|rest| rest.split_once('=')) {
            Some((name, value)) if !name.is_empty() => {
                flags.insert(name, value);
            }
            _ => return Err(arg),
        }
    }
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn flags_are_name_equals_value_and_the_last_of_a_name_wins() {
        let list = args(&["--origin=https://a", "--address=", "--origin=https://b?x=1", "--other=ignored"]);
        let flags = parse_flags(&list).unwrap();
        assert_eq!(flags["origin"], "https://b?x=1");
        assert_eq!(flags["address"], "");
        assert_eq!(flags["other"], "ignored");
    }

    #[test]
    fn an_argument_of_another_shape_is_named() {
        for bad in ["origin=x", "--origin", "--=x", "-origin=x", ""] {
            let list = args(&["--ok=1", bad]);
            assert_eq!(parse_flags(&list).unwrap_err(), bad);
        }
    }

    #[test]
    fn the_hex_digest_is_64_lower_case_characters() {
        assert!(is_hex64(&"0f".repeat(32)));
        assert!(!is_hex64(&"0F".repeat(32)));
        assert!(!is_hex64(&"0f".repeat(31)));
        assert!(!is_hex64(&"0g".repeat(32)));
    }

    #[test]
    fn assets_are_positive_as_javascript_compares_them_with_zero() {
        for value in [json!(8), json!(0.5), json!("3"), json!(" 0x10 "), json!("Infinity"), json!(true), json!([2]), json!(["4"])] {
            assert!(positive(Some(&value)), "{value}");
        }
        for value in [json!(0), json!(-1), json!(""), json!("3a"), json!(null), json!(false), json!([]), json!([1, 2]), json!([true]), json!({})] {
            assert!(!positive(Some(&value)), "{value}");
        }
        assert!(!positive(None));
    }

    #[test]
    fn the_result_line_is_the_json_of_the_result_object() {
        let verified = Verified { index_sha256: "a".repeat(64), assets: json!("3"), releases: 0 };
        let expected = format!(r#"{{"status":"verified","indexSha256":"{}","assets":"3","releases":0,"websocket":"gated"}}"#, "a".repeat(64));
        assert_eq!(verified.to_line(), expected);
    }
}


impl std::error::Error for ProbeError {}
fn refused_in(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if error.downcast_ref::<std::io::Error>().is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused) {
            return true;
        }
        current = error.source();
    }
    false
}
fn chain_message(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut current = error.source();
    while let Some(source) = current {
        text.push_str(": ");
        text.push_str(&source.to_string());
        current = source.source();
    }
    text
}
fn transport_error(error: &(dyn std::error::Error + 'static)) -> ProbeError {
    ProbeError { refused: refused_in(error), message: chain_message(error) }
}
/// One GET of `path` on the origin, parsed as JSON. Redirects are failures, the body is capped and the whole exchange is
/// timed.
async fn read_json(base: &Url, path: &str, options: &Options, address: Option<Ipv4Addr>) -> Result<Value, ProbeError> {
    let url = base.join(path).map_err(|_| ProbeError::new("Invalid URL"))?;
    let mut builder = reqwest::Client::builder().redirect(Policy::none()).no_proxy();
    for der in &options.extra_roots {
        if let Ok(certificate) = reqwest::Certificate::from_der(der) {
            builder = builder.add_root_certificate(certificate);
        }
    }
    if let (Some(address), Some(host)) = (address, url.host_str()) {
        // reqwest takes the port from the URL and ignores the one of the override.
        builder = builder.resolve(host, SocketAddr::new(IpAddr::V4(address), 0));
    }
    let client = builder.build().map_err(|error| transport_error(&error))?;
    let exchange = async {
        let mut response = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| transport_error(&error))?;
        // The whole body is read (and capped) before the status is judged, as the script did.
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|error| transport_error(&error))? {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(ProbeError::new("Deployment probe response exceeds limit."));
            }
            body.extend_from_slice(&chunk);
        }
        if response.status().as_u16() != 200 {
            return Err(ProbeError::new(format!("{} returned HTTP {}.", url.path(), response.status().as_u16())));
        }
        crate::js::parse_bytes(&body).map_err(|_| ProbeError::new(format!("{} returned invalid JSON.", url.path())))
    };
    match mixdog_rt::time::timeout(options.timeout, exchange).await {
        Ok(result) => result,
        Err(_) => Err(ProbeError::new("Deployment HTTP probe timed out.")),
    }
}
/// A TCP connection to the origin (to `address` when it overrides DNS), with TLS validated against the public host name for
/// https.
async fn dial(base: &Url, options: &Options, address: Option<Ipv4Addr>) -> Result<Box<dyn Wire>, ProbeError> {
    let port = base.port_or_known_default().unwrap_or(80);
    let host = base.host().ok_or_else(|| ProbeError::new("Invalid URL"))?;
    let tcp = match (address, &host) {
        (Some(address), _) => TcpStream::connect((address, port)).await,
        (None, Host::Domain(name)) => TcpStream::connect((name.to_string(), port)).await,
        (None, Host::Ipv4(ip)) => TcpStream::connect((*ip, port)).await,
        (None, Host::Ipv6(ip)) => TcpStream::connect((*ip, port)).await,
    }
    .map_err(|error| transport_error(&error))?;
    if base.scheme() != "https" {
        return Ok(Box::new(tcp));
    }
    let name = match &host {
        Host::Domain(name) => ServerName::try_from(name.to_string()).map_err(|_| ProbeError::new("Invalid URL"))?,
        Host::Ipv4(ip) => ServerName::IpAddress(IpAddr::V4(*ip).into()),
        Host::Ipv6(ip) => ServerName::IpAddress(IpAddr::V6(*ip).into()),
    };
    let tls = TlsConnector::from(tls_config(&options.extra_roots))
        .connect(name, tcp)
        .await
        .map_err(|error| transport_error(&error))?;
    Ok(Box::new(tls))
}
/// One `/ws` upgrade. With the origin of the deployment the relay must accept and close with 4005; with a foreign origin it
/// must refuse the upgrade with 403.
async fn check_websocket(
    base: &Url,
    options: &Options,
    address: Option<Ipv4Addr>,
    foreign_origin: bool,
) -> Result<(), ProbeError> {
    let probe = async {
        let mut url = base.join("/ws").map_err(|_| ProbeError::new("Invalid URL"))?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme).map_err(|()| ProbeError::new("Invalid URL"))?;
        let origin = if foreign_origin { FOREIGN_ORIGIN.to_owned() } else { base.origin().ascii_serialization() };
        let mut request = url.as_str().into_client_request().map_err(|error| ProbeError::new(error.to_string()))?;
        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_str(&origin).map_err(|_| ProbeError::new("Invalid URL"))?);
        let stream = dial(base, options, address).await?;
        let mut socket = match tokio_tungstenite::client_async(request, stream).await {
            Ok((socket, _)) => socket,
            Err(WsError::Http(response)) => {
                let status = response.status().as_u16();
                return if foreign_origin && status == 403 {
                    Ok(())
                } else {
                    Err(ProbeError::new(format!("WebSocket upgrade returned HTTP {status}.")))
                };
            }
            Err(WsError::Io(error)) => return Err(transport_error(&error)),
            Err(error) => return Err(ProbeError::new(error.to_string())),
        };
        if foreign_origin {
            return Err(ProbeError::new("WebSocket accepted a foreign origin."));
        }
        let code = loop {
            match socket.next().await {
                Some(Ok(Message::Close(frame))) => break frame.map_or(CLOSE_NO_STATUS, |frame| u16::from(frame.code)),
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break CLOSE_ABNORMAL,
            }
        };
        if code == PAIRING_GATE_CLOSE {
            Ok(())
        } else {
            Err(ProbeError::new(format!("WebSocket pairing gate returned close {code}.")))
        }
    };
    match mixdog_rt::time::timeout(options.timeout, probe).await {
        Ok(result) => result,
        Err(_) => Err(ProbeError::new("Deployment WebSocket probe timed out.")),
    }
}
/// Runs every check of a deployment: liveness (waiting out a refused connection for the startup window), readiness and
/// release identity, then the two WebSocket gates.
pub async fn verify_release(options: &Options) -> Result<Verified, ProbeError> {
    let base = parse_origin(&options.origin)?;
    if !is_hex64(&options.expected_index) {
        return Err(ProbeError::new("Expected renderer digest is required."));
    }
    let address = if options.address.is_empty() {
        None
    } else if options.address == "127.0.0.1" {
        Some(Ipv4Addr::LOCALHOST)
    } else {
        return Err(ProbeError::new("Only loopback may override deployment DNS."));
    };
    let deadline = Instant::now() + options.startup;
    let health = loop {
        match read_json(&base, "/healthz", options, address).await {
            Ok(health) => break health,
            // Only an unbound listener is a startup race. TLS, HTTP and content failures are real failures and must reach
            // rollback immediately.
            Err(error) if error.refused && Instant::now() < deadline => {
                let wait = deadline.saturating_duration_since(Instant::now()).min(Duration::from_millis(250));
                mixdog_rt::time::sleep(wait).await;
            }
            Err(error) => return Err(error),
        }
    };
    if health.get("status").and_then(Value::as_str) != Some("ok") {
        return Err(ProbeError::new("Relay liveness check failed."));
    }
    let ready = read_json(&base, "/readyz", options, address).await?;
    let index = ready.get("indexSha256").and_then(Value::as_str);
    let version = ready.get("version").and_then(Value::as_str);
    if ready.get("status").and_then(Value::as_str) != Some("ready")
        || index != Some(options.expected_index.as_str())
        || !version.is_some_and(is_hex64)
        || !positive(ready.get("assets"))
    {
        return Err(ProbeError::new("Renderer readiness or deployed release identity does not match."));
    }
    let releases = ready.get("releases").and_then(Value::as_array);
    // /readyz inspects every retained release; the one this deploy added must be among them with the digest that was uploaded.
    if !options.expected_release.is_empty()
        && !releases.is_some_and(|list| {
            list.iter().any(|release| {
                release.get("id").and_then(Value::as_str) == Some(options.expected_release.as_str())
                    && release.get("indexSha256").and_then(Value::as_str) == Some(options.expected_index.as_str())
            })
        })
    {
        return Err(ProbeError::new("Added renderer release is not served side by side."));
    }
    check_websocket(&base, options, address, false).await?;
    check_websocket(&base, options, address, true).await?;
    Ok(Verified {
        index_sha256: options.expected_index.clone(),
        assets: ready.get("assets").cloned().unwrap_or(Value::Null),
        releases: releases.map_or(0, Vec::len),
    })
}
/// The subcommand: the arguments after `verify-release`.
pub fn main(args: &[String]) -> ExitCode {
    let flags = match parse_flags(args) {
        Ok(flags) => flags,
        Err(arg) => {
            eprintln!("Invalid verification argument: {arg}");
            return ExitCode::from(1);
        }
    };
    let flag = |name: &str| flags.get(name).copied().unwrap_or_default();
    let mut options = Options::new(flag("origin"), flag("expected-index"));
    options.expected_release = flag("expected-release").to_owned();
    options.address = flag("address").to_owned();
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("[deploy] verification failed: {error}");
            return ExitCode::from(1);
        }
    };
    match runtime.block_on(verify_release(&options)) {
        Ok(verified) => {
            println!("{}", verified.to_line());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("[deploy] verification failed: {error}");
            ExitCode::from(1)
        }
    }
}
