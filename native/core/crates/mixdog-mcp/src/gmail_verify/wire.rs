//! The TLS socket both legs of the check share: the connection deadline, the idle timeout, line
//! reading, and the DEFLATE layer IMAP can switch on (RFC 4978). Failures carry the fields
//! `gmail-app-password.mjs` classifies on (`code`, `response`, `responseText`, `message`,
//! `responseCode`, `authenticationFailed`), so the classifier reads them as it reads
//! imapflow's and nodemailer's errors.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress};
use rustls::ClientConfig;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use mixdog_rt::time::{Instant, timeout, timeout_at};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

/// `TIMEOUTS` in `gmail-app-password.mjs`.
#[derive(Clone, Copy, Debug)]
pub struct Timeouts {
    pub connection: Duration,
    pub greeting: Duration,
    pub socket: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connection: Duration::from_millis(20_000),
            greeting: Duration::from_millis(15_000),
            socket: Duration::from_millis(60_000),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

impl Target {
    pub fn new(host: &str, port: u16) -> Self {
        Self { host: host.to_owned(), port }
    }
}

/// An IMAP or SMTP failure as the classifier sees it.
#[derive(Clone, Debug, Default)]
pub struct Failure {
    pub code: String,
    pub response: Option<String>,
    pub response_text: Option<String>,
    pub message: String,
    pub response_code: Option<u32>,
    pub authentication_failed: bool,
}

impl Failure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into(), ..Self::default() }
    }

    /// nodemailer's `_formatError`: the server's reply is appended to the message and its
    /// leading digits become the response code.
    pub fn smtp(message: &str, code: &str, response: Option<&str>) -> Self {
        let mut failure = Self::new(code, message);
        if let Some(response) = response.filter(|r| !r.is_empty()) {
            failure.message = format!("{message}: {response}");
            failure.response = Some(response.to_owned());
            let digits: String = response.chars().take_while(char::is_ascii_digit).collect();
            failure.response_code = digits.parse().ok().filter(|n| *n != 0);
        }
        failure
    }
}

/// The error the OS would have named: Node's `err.code` for a failed socket.
pub fn io_failure(error: &io::Error) -> Failure {
    use io::ErrorKind as K;
    let code = match error.kind() {
        K::ConnectionRefused => "ECONNREFUSED",
        K::ConnectionReset => "ECONNRESET",
        K::ConnectionAborted => "ECONNABORTED",
        K::BrokenPipe => "EPIPE",
        K::TimedOut => "ETIMEDOUT",
        K::HostUnreachable => "EHOSTUNREACH",
        K::NetworkUnreachable => "ENETUNREACH",
        _ => "",
    };
    Failure::new(code, error.to_string())
}

/// A TLS handshake that failed on the certificate, in the words and codes of Node's OpenSSL.
fn tls_failure(error: &io::Error) -> Failure {
    use rustls::CertificateError as C;
    let verdict = error.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>());
    let Some(rustls::Error::InvalidCertificate(certificate)) = verdict else {
        return io_failure(error);
    };
    let (code, message) = match certificate {
        C::Expired | C::ExpiredContext { .. } => ("CERT_HAS_EXPIRED", "certificate has expired"),
        C::NotValidYet | C::NotValidYetContext { .. } => ("CERT_NOT_YET_VALID", "certificate is not yet valid"),
        C::UnknownIssuer => ("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"),
        C::NotValidForName | C::NotValidForNameContext { .. } => {
            ("ERR_TLS_CERT_ALTNAME_INVALID", "Hostname/IP does not match certificate's altnames")
        }
        C::Revoked => ("CERT_REVOKED", "certificate revoked"),
        _ => return Failure::new("", error.to_string()),
    };
    Failure::new(code, message)
}

/// Resolves, connects and handshakes within `deadline`; past it the failure is `timeout_code`.
/// Addresses are tried in the order the resolver gives them.
pub async fn connect(
    target: &Target,
    tls: &Arc<ClientConfig>,
    deadline: Instant,
    timeout_code: &str,
    timeout_message: &str,
) -> Result<TlsStream<TcpStream>, Failure> {
    let work = async {
        let resolved = tokio::net::lookup_host((target.host.as_str(), target.port)).await;
        let addresses = resolved
            .map(Iterator::collect::<Vec<_>>)
            .ok()
            .filter(|found| !found.is_empty())
            .ok_or_else(|| Failure::new("ENOTFOUND", format!("getaddrinfo ENOTFOUND {}", target.host)))?;
        let mut last = None;
        let mut tcp = None;
        for address in addresses {
            match TcpStream::connect(address).await {
                Ok(stream) => {
                    tcp = Some(stream);
                    break;
                }
                Err(error) => last = Some(io_failure(&error)),
            }
        }
        let tcp = tcp.ok_or_else(|| last.unwrap_or_default())?;
        let name = ServerName::try_from(target.host.clone())
            .map_err(|error| Failure::new("ERR_INVALID_ARG_VALUE", error.to_string()))?;
        TlsConnector::from(tls.clone()).connect(name, tcp).await.map_err(|error| tls_failure(&error))
    };
    match timeout_at(deadline, work).await {
        Ok(done) => done,
        Err(_) => Err(Failure::new(timeout_code, timeout_message)),
    }
}

/// Raw DEFLATE (RFC 1951) with a sync flush at the end of every write, which is what
/// `zlib.createDeflateRaw` plus imapflow's per-command flush put on the wire.
fn deflate(compress: &mut Compress, mut input: &[u8]) -> Result<Vec<u8>, Failure> {
    let mut out = Vec::with_capacity(input.len() + 64);
    loop {
        out.reserve(1024);
        let before = compress.total_in();
        compress.compress_vec(input, &mut out, FlushCompress::Sync).map_err(|e| Failure::new("ZlibError", e.to_string()))?;
        let used = usize::try_from(compress.total_in() - before).unwrap_or(input.len());
        input = &input[used..];
        if input.is_empty() && out.len() < out.capacity() {
            return Ok(out);
        }
    }
}

fn inflate(decompress: &mut Decompress, mut input: &[u8], out: &mut Vec<u8>) -> Result<(), Failure> {
    loop {
        out.reserve(8192);
        let (read_before, written_before) = (decompress.total_in(), decompress.total_out());
        decompress
            .decompress_vec(input, out, FlushDecompress::Sync)
            .map_err(|e| Failure::new("ZlibError", e.to_string()))?;
        let used = usize::try_from(decompress.total_in() - read_before).unwrap_or(input.len());
        input = &input[used..];
        let made_progress = used > 0 || decompress.total_out() > written_before;
        if (input.is_empty() && out.len() < out.capacity()) || !made_progress {
            return Ok(());
        }
    }
}

pub struct Wire {
    io: TlsStream<TcpStream>,
    idle: Duration,
    idle_failure: (&'static str, &'static str),
    /// The code every socket error is reported under, where the library names them all alike
    /// (nodemailer's `ESOCKET`); `None` keeps the OS's own.
    socket_code: Option<&'static str>,
    max_pending: usize,
    plain: Vec<u8>,
    inflate: Option<Decompress>,
    deflate: Option<Compress>,
}

impl Wire {
    /// `idle` is the socket timeout: how long a read may wait for the server before it fails
    /// as `idle_failure` (code, message).
    pub fn new(
        io: TlsStream<TcpStream>,
        idle: Duration,
        idle_failure: (&'static str, &'static str),
        socket_code: Option<&'static str>,
        max_pending: usize,
    ) -> Self {
        Self { io, idle, idle_failure, socket_code, max_pending, plain: Vec::new(), inflate: None, deflate: None }
    }

    fn socket_failure(&self, error: &io::Error) -> Failure {
        let mut failure = io_failure(error);
        if let Some(code) = self.socket_code {
            failure.code = code.to_owned();
        }
        failure
    }

    /// Bytes received and not yet taken as a line.
    pub fn pending(&self) -> &[u8] {
        &self.plain
    }

    /// Switches both directions to raw DEFLATE. Bytes already read behind the `COMPRESS` reply
    /// would have been taken as cleartext, so there must be none.
    pub fn start_compression(&mut self) {
        self.inflate = Some(Decompress::new(false));
        self.deflate = Some(Compress::new(Compression::default(), false));
    }

    pub async fn send(&mut self, bytes: &[u8]) -> Result<(), Failure> {
        let framed;
        let data = match self.deflate.as_mut() {
            Some(compress) => {
                framed = deflate(compress, bytes)?;
                &framed[..]
            }
            None => bytes,
        };
        let written = match self.io.write_all(data).await {
            Ok(()) => self.io.flush().await,
            Err(error) => Err(error),
        };
        written.map_err(|error| self.socket_failure(&error))
    }

    /// Reads more from the socket; `false` at the end of the stream. A server that closes
    /// without TLS close_notify has ended the stream as far as Node is concerned too.
    async fn fill(&mut self) -> Result<bool, Failure> {
        let mut buffer = [0u8; 16 * 1024];
        let read = match timeout(self.idle, self.io.read(&mut buffer)).await {
            Err(_) => return Err(Failure::new(self.idle_failure.0, self.idle_failure.1)),
            Ok(Err(error)) if error.kind() == io::ErrorKind::UnexpectedEof => 0,
            Ok(Err(error)) => return Err(self.socket_failure(&error)),
            Ok(Ok(read)) => read,
        };
        if read == 0 {
            return Ok(false);
        }
        match self.inflate.as_mut() {
            None => self.plain.extend_from_slice(&buffer[..read]),
            Some(decompress) => inflate(decompress, &buffer[..read], &mut self.plain)?,
        }
        Ok(true)
    }

    /// One line without its line break; `None` at the end of the stream.
    pub async fn line(&mut self) -> Result<Option<Vec<u8>>, Failure> {
        loop {
            if let Some(at) = self.plain.iter().position(|byte| *byte == b'\n') {
                let mut line: Vec<u8> = self.plain.drain(..=at).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(Some(line));
            }
            if self.plain.len() > self.max_pending {
                return Err(Failure::new("EPROTOCOL", "Server response exceeds maximum allowed size"));
            }
            if !self.fill().await? {
                return Ok(None);
            }
        }
    }

    /// Exactly `count` bytes (an IMAP literal); `None` at the end of the stream.
    pub async fn exact(&mut self, count: usize) -> Result<Option<Vec<u8>>, Failure> {
        while self.plain.len() < count {
            if !self.fill().await? {
                return Ok(None);
            }
        }
        Ok(Some(self.plain.drain(..count).collect()))
    }
}
