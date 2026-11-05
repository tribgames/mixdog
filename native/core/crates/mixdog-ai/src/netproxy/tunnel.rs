//! Raw-socket paths under the network proxy policy (`proxy-tunnel.mjs`). The
//! WebSocket opens its own socket, so it asks the same decision and, when it
//! names a proxy, tunnels through it with HTTP CONNECT (http proxies) or
//! SOCKS5. A proxy that cannot be reached or refuses the tunnel is an error;
//! there is no direct fallback.

use std::io;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::OnceLock;
use std::task::Context;
use std::task::Poll;
use std::time::Duration;

use base64::Engine;
use mixdog_core_api::domain::keepalive::TcpKeepalive;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::io::ReadBuf;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use url::Url;

use super::hosts::decode_uri_component;
use super::setting::proxy_display;
use crate::transport::tcp;

/// How long a proxy may take to answer a CONNECT.
const TUNNEL_TIMEOUT: Duration = Duration::from_millis(30_000);
const MAX_HEAD: usize = 16 * 1024;

/// A socket to a tunnel's far end, or to a proxy's: plain, or TLS to an
/// `https:` proxy. One type, so the callers need no generics.
pub enum Conn {
    Tcp(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl AsyncRead for Conn {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Tcp(stream) => Pin::new(stream).poll_read(cx, buf),
            Conn::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Conn {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Conn::Tcp(stream) => Pin::new(stream).poll_write(cx, buf),
            Conn::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Tcp(stream) => Pin::new(stream).poll_flush(cx),
            Conn::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Conn::Tcp(stream) => Pin::new(stream).poll_shutdown(cx),
            Conn::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

#[derive(Debug)]
pub enum TunnelError {
    Dns,
    /// The proxy could not be reached.
    Connect(io::Error),
    /// The proxy answered, and did not agree to the tunnel. `code` is the code
    /// undici's fetch path reports; the raw-socket path reports `EPROXY`.
    Refused { message: String, status: Option<u16>, code: String },
    /// The proxy dropped the connection or broke the protocol mid-handshake
    /// (undici's `ProxyConnectionError`).
    Dropped(io::Error),
    /// The TLS handshake with an `https:` proxy failed.
    Tls(TlsFailure),
    Io(io::Error),
    TimedOut,
}

/// Why a TLS handshake failed: the I/O error under it, or rustls' own verdict.
#[derive(Debug)]
pub struct TlsFailure {
    pub error: io::Error,
}

impl TlsFailure {
    /// The certificate verdict, when the handshake failed on one.
    pub fn certificate(&self) -> Option<&rustls::CertificateError> {
        let tls = self.error.get_ref()?.downcast_ref::<rustls::Error>()?;
        match tls {
            rustls::Error::InvalidCertificate(error) => Some(error),
            _ => None,
        }
    }
}

impl TunnelError {
    /// The `code` of the failure on the raw-socket paths (`openProxyTunnel`):
    /// `EPROXY` for an HTTP proxy that refused, undici's own for SOCKS5.
    pub fn socket_code(&self) -> Option<&str> {
        match self {
            TunnelError::Refused { code, status: None, .. } => Some(code),
            TunnelError::Refused { status: Some(_), .. } => Some("EPROXY"),
            _ => None,
        }
    }
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TunnelError::Dns => f.write_str("The proxy host could not be resolved"),
            TunnelError::Connect(error) | TunnelError::Io(error) | TunnelError::Dropped(error) => error.fmt(f),
            TunnelError::Refused { message, .. } => f.write_str(message),
            TunnelError::Tls(failure) => failure.error.fmt(f),
            TunnelError::TimedOut => f.write_str("The proxy did not answer the tunnel request in time"),
        }
    }
}

impl std::error::Error for TunnelError {}

/// The TLS client configuration: the platform's root certificates.
pub fn tls_config() -> Result<Arc<rustls::ClientConfig>, io::Error> {
    static CONFIG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    let built = CONFIG.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        let loaded = rustls_native_certs::load_native_certs();
        let (added, _) = roots.add_parsable_certificates(loaded.certs);
        if added == 0 {
            return Err("no native root CA certificates found".to_owned());
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| error.to_string())?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Arc::new(config))
    });
    built.clone().map_err(io::Error::other)
}

/// TLS to `host` over `stream` (the handshake of an `https:` proxy, or of a
/// target inside a tunnel).
pub async fn tls_connect<S: AsyncRead + AsyncWrite + Unpin>(stream: S, host: &str) -> Result<TlsStream<S>, TlsFailure> {
    let config = tls_config().map_err(|error| TlsFailure { error })?;
    let name = rustls::pki_types::ServerName::try_from(host.to_owned())
        .map_err(|error| TlsFailure { error: io::Error::new(io::ErrorKind::InvalidInput, error) })?;
    tokio_rustls::TlsConnector::from(config).connect(name, stream).await.map_err(|error| TlsFailure { error })
}

fn authority(host: &str, port: u16) -> String {
    if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

fn credentials(url: &Url) -> Option<(String, String)> {
    if url.username().is_empty() {
        return None;
    }
    let user = decode_uri_component(url.username()).unwrap_or_default();
    let password = decode_uri_component(url.password().unwrap_or("")).unwrap_or_default();
    Some((user, password))
}


/// A socket tunneled through `proxy_url` to `host:port` (the proxy resolves
/// `host`). `host` has no brackets. An `https:` proxy is reached over TLS.
pub async fn open_proxy_tunnel(
    proxy_url: &str,
    host: &str,
    port: u16,
    keepalive: &TcpKeepalive,
) -> Result<Conn, TunnelError> {
    let proxy = Url::parse(proxy_url).map_err(|_| TunnelError::Dns)?;
    let default_port = match proxy.scheme() {
        "socks5" => 1080,
        "https" => 443,
        _ => 80,
    };
    let proxy_host = proxy.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_owned();
    let proxy_port = proxy.port().unwrap_or(default_port);
    let addrs = tokio::net::lookup_host((proxy_host.as_str(), proxy_port)).await.map_err(|_| TunnelError::Dns)?;
    let mut failure = None;
    let mut stream = None;
    for addr in addrs {
        match tcp::connect(addr, keepalive).await {
            Ok(connected) => {
                stream = Some(connected);
                break;
            }
            Err(error) => failure = Some(error),
        }
    }
    let stream = match stream {
        Some(stream) => stream,
        None => return Err(failure.map_or(TunnelError::Dns, TunnelError::Connect)),
    };
    let handshake = async {
        let mut conn = if proxy.scheme() == "https" {
            Conn::Tls(Box::new(tls_connect(stream, &proxy_host).await.map_err(TunnelError::Tls)?))
        } else {
            Conn::Tcp(stream)
        };
        if proxy.scheme() == "socks5" {
            socks5(&mut conn, &proxy, proxy_url, host, port).await?;
        } else {
            connect_request(&mut conn, &proxy, proxy_url, host, port).await?;
        }
        Ok::<_, TunnelError>(conn)
    };
    tokio::time::timeout(TUNNEL_TIMEOUT, handshake).await.map_err(|_| TunnelError::TimedOut)?
}

async fn connect_request(
    stream: &mut Conn,
    proxy: &Url,
    proxy_url: &str,
    host: &str,
    port: u16,
) -> Result<(), TunnelError> {
    let target = authority(host, port);
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nhost: {target}\r\n");
    if let Some((user, password)) = credentials(proxy) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        request.push_str(&format!("proxy-authorization: Basic {encoded}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await.map_err(TunnelError::Dropped)?;
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= MAX_HEAD {
            return Err(refused(proxy_url, &target, None));
        }
        let byte = stream.read_u8().await.map_err(TunnelError::Dropped)?;
        head.push(byte);
    }
    let status = String::from_utf8_lossy(&head)
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1).map(str::to_owned))
        .and_then(|code| code.parse::<u16>().ok());
    if status == Some(200) { Ok(()) } else { Err(refused(proxy_url, &target, status)) }
}

fn refused(proxy_url: &str, target: &str, status: Option<u16>) -> TunnelError {
    let code = status.map_or_else(|| "no status".to_owned(), |status| format!("HTTP {status}"));
    TunnelError::Refused {
        message: format!("The proxy {} refused the tunnel to {target} ({code})", proxy_display(proxy_url)),
        status,
        // undici's fetch path: `Proxy response (n) !== 200 when HTTP Tunneling`.
        code: "UND_ERR_ABORTED".to_owned(),
    }
}

async fn socks5(stream: &mut Conn, proxy: &Url, proxy_url: &str, host: &str, port: u16) -> Result<(), TunnelError> {
    let target = authority(host, port);
    let denied = |reason: &str, code: String| TunnelError::Refused {
        message: format!("The proxy {} refused the tunnel to {target} ({reason})", proxy_display(proxy_url)),
        status: None,
        code,
    };
    let login = credentials(proxy);
    let methods: &[u8] = if login.is_some() { &[0x00, 0x02] } else { &[0x00] };
    let mut greeting = vec![0x05, methods.len() as u8];
    greeting.extend_from_slice(methods);
    stream.write_all(&greeting).await.map_err(TunnelError::Dropped)?;
    let mut chosen = [0u8; 2];
    stream.read_exact(&mut chosen).await.map_err(TunnelError::Dropped)?;
    if chosen[0] != 0x05 {
        return Err(denied("not a SOCKS5 proxy", "UND_ERR_SOCKS5_VERSION".into()));
    }
    match (chosen[1], &login) {
        (0x00, _) => {}
        (0x02, Some((user, password))) => {
            let (user, password) = (user.as_bytes(), password.as_bytes());
            if user.len() > 255 || password.len() > 255 {
                return Err(denied("credentials too long", "UND_ERR_INVALID_ARG".into()));
            }
            let mut auth = vec![0x01, user.len() as u8];
            auth.extend_from_slice(user);
            auth.push(password.len() as u8);
            auth.extend_from_slice(password);
            stream.write_all(&auth).await.map_err(TunnelError::Dropped)?;
            let mut verdict = [0u8; 2];
            stream.read_exact(&mut verdict).await.map_err(TunnelError::Dropped)?;
            if verdict[0] != 0x01 {
                return Err(denied("authentication failed", "UND_ERR_SOCKS5_AUTH_VERSION".into()));
            }
            if verdict[1] != 0x00 {
                return Err(denied("authentication failed", "UND_ERR_SOCKS5_AUTH_FAILED".into()));
            }
        }
        (0xff, _) => return Err(denied("no acceptable authentication method", "UND_ERR_SOCKS5_AUTH_REJECTED".into())),
        _ => return Err(denied("unsupported authentication method", "UND_ERR_SOCKS5_AUTH_METHOD".into())),
    }
    let mut request = vec![0x05, 0x01, 0x00];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            request.push(0x01);
            request.extend_from_slice(&address.octets());
        }
        Ok(IpAddr::V6(address)) => {
            request.push(0x04);
            request.extend_from_slice(&address.octets());
        }
        Err(_) => {
            let name = host.as_bytes();
            if name.len() > 255 {
                return Err(denied("host name too long", "UND_ERR_INVALID_ARG".into()));
            }
            request.push(0x03);
            request.push(name.len() as u8);
            request.extend_from_slice(name);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.map_err(TunnelError::Dropped)?;
    let mut reply = [0u8; 4];
    stream.read_exact(&mut reply).await.map_err(TunnelError::Dropped)?;
    if reply[0] != 0x05 {
        return Err(denied("not a SOCKS5 reply", "UND_ERR_SOCKS5_REPLY_VERSION".into()));
    }
    if reply[1] != 0x00 {
        return Err(denied(&format!("SOCKS5 reply {}", reply[1]), format!("UND_ERR_SOCKS5_REPLY_{}", reply[1])));
    }
    let bound = match reply[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => usize::from(stream.read_u8().await.map_err(TunnelError::Dropped)?),
        _ => return Err(denied("unknown address type", "UND_ERR_SOCKS5_ADDR_TYPE".into())),
    };
    let mut rest = vec![0u8; bound + 2];
    stream.read_exact(&mut rest).await.map_err(TunnelError::Dropped)?;
    Ok(())
}

/// The code Node's TLS reports for a failed handshake. rustls names the verdict
/// without OpenSSL's distinctions, so an unknown issuer is reported as the
/// chain failing to verify; anything else has no stable name.
pub fn tls_code(failure: &TlsFailure) -> &'static str {
    use rustls::CertificateError as C;
    match failure.certificate() {
        Some(C::Expired | C::ExpiredContext { .. }) => "CERT_HAS_EXPIRED",
        Some(C::NotValidYet | C::NotValidYetContext { .. }) => "CERT_NOT_YET_VALID",
        Some(C::Revoked) => "CERT_REVOKED",
        Some(C::NotValidForName | C::NotValidForNameContext { .. }) => "ERR_TLS_CERT_ALTNAME_INVALID",
        Some(C::UnknownIssuer) => "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        _ => "UNKNOWN",
    }
}
