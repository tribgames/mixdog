//! The SMTP submission client. Port 465 is implicit TLS; any other port connects in plain text and requires STARTTLS, which is
//! sent whether or not the server advertised it (a refusal is `ETLS`). The certificate is verified against the webpki roots.
//! Connection, greeting, socket and DNS timeouts are one value: the connection deadline covers the DNS lookup, every address
//! tried, the greeting and the STARTTLS upgrade, and the socket timeout is the longest the connection may be silent.

use std::fmt;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, STANDARD};
use hmac::{Hmac, Mac};
use md5::Md5;
use mixdog_rt::time::{Instant, timeout, timeout_at};
use rand::seq::SliceRandom;
use rustls::pki_types::ServerName;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpStream, lookup_host};
use tokio_rustls::TlsConnector;

use super::mime::{self, Built, Message};
use crate::js;

/// Longest a single server reply may grow while it is still being received.
const MAX_REPLY_BYTES: usize = 1024 * 1024;

/// How often a server that keeps answering `334` to an empty line is asked again.
const MAX_AUTH_CONTINUATIONS: usize = 8;

/// nodemailer's `error.code` vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MailCode {
    /// A connection, greeting, TLS-upgrade or socket timeout.
    Timeout,
    /// The server ended or refused the session.
    Connection,
    /// A socket or TLS handshake error.
    Socket,
    /// The host name did not resolve.
    Dns,
    Auth,
    Envelope,
    Message,
    Tls,
    Protocol,
}

impl MailCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "ETIMEDOUT",
            Self::Connection => "ECONNECTION",
            Self::Socket => "ESOCKET",
            Self::Dns => "EDNS",
            Self::Auth => "EAUTH",
            Self::Envelope => "EENVELOPE",
            Self::Message => "EMESSAGE",
            Self::Tls => "ETLS",
            Self::Protocol => "EPROTOCOL",
        }
    }
}

/// A failed send: nodemailer's error with its `code`, `response`, `responseCode` and `command`.
#[derive(Debug, Clone)]
pub struct MailError {
    pub code: MailCode,
    pub message: String,
    pub response: Option<String>,
    pub response_code: Option<u16>,
    pub command: Option<&'static str>,
}

impl MailError {
    fn new(code: MailCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), response: None, response_code: None, command: None }
    }

    /// `_formatError(message, type, response, command)`: the response is appended to the message.
    fn failed(code: MailCode, message: &str, response: &str, command: &'static str) -> Self {
        let response_code = response.bytes().take_while(u8::is_ascii_digit).count();
        Self {
            code,
            message: format!("{message}: {response}"),
            response: Some(response.to_owned()),
            response_code: response[..response_code].parse().ok(),
            command: Some(command),
        }
    }

    fn api(code: MailCode, message: impl Into<String>) -> Self {
        Self { command: Some("API"), ..Self::new(code, message) }
    }

    fn timed_out(message: &str) -> Self {
        Self { command: Some("CONN"), ..Self::new(MailCode::Timeout, message) }
    }
}

impl fmt::Display for MailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

fn tls_config(extra_roots: &[Vec<u8>]) -> Result<Arc<rustls::ClientConfig>, String> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for der in extra_roots {
        roots.add(rustls::pki_types::CertificateDer::from(der.clone())).map_err(|error| error.to_string())?;
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// What the final EHLO reply said.
#[derive(Debug, Default)]
struct Capabilities {
    allows_auth: bool,
    /// The mechanisms in nodemailer's order of preference.
    auth: Vec<&'static str>,
    pipelining: bool,
    smtputf8: bool,
}

struct Session {
    io: Option<Box<dyn Io>>,
    buffer: Vec<u8>,
    /// The lines of the reply being received.
    lines: Vec<String>,
    /// The socket timeout: the longest the connection may be silent.
    idle: Duration,
    secure: bool,
    upgrading: bool,
    connector: TlsConnector,
    name: ServerName<'static>,
    /// The end of the connection timeout, which also bounds the greeting and the STARTTLS upgrade.
    deadline: Instant,
    timeout: Duration,
}

impl Session {
    /// `_remainingSetupTime()`: the greeting timeout, cut short by what is left of the connection timeout.
    fn setup_deadline(&self) -> Instant {
        let now = Instant::now();
        now + self.timeout.min(self.deadline.saturating_duration_since(now).max(Duration::from_millis(1)))
    }

    fn stream(&mut self) -> Result<&mut Box<dyn Io>, MailError> {
        self.io.as_mut().ok_or_else(|| MailError::new(MailCode::Connection, "Connection closed unexpectedly"))
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), MailError> {
        let idle = self.idle;
        let io = self.stream()?;
        match timeout(idle, async {
            io.write_all(bytes).await?;
            io.flush().await
        })
        .await
        {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(MailError { command: Some("CONN"), ..MailError::new(MailCode::Socket, error.to_string()) }),
            Err(_) => Err(MailError::timed_out("Timeout")),
        }
    }

    async fn command(&mut self, text: &str) -> Result<(), MailError> {
        self.write(format!("{text}\r\n").as_bytes()).await
    }

    /// Takes the next complete reply out of the buffer: `250-…` lines continue it, a line without the dash ends it.
    fn take_reply(&mut self) -> Result<Option<String>, MailError> {
        while let Some(at) = self.buffer.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.buffer.drain(..=at).collect();
            let mut line = &raw[..raw.len() - 1];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            let text = decode_reply(line);
            if self.lines.is_empty() && text.trim().is_empty() {
                continue;
            }
            let partial = is_partial_line(&text);
            self.lines.push(text);
            if !partial {
                return Ok(Some(std::mem::take(&mut self.lines).join("\n")));
            }
        }
        if self.buffer.len() + self.lines.iter().map(String::len).sum::<usize>() > MAX_REPLY_BYTES {
            self.buffer.clear();
            self.lines.clear();
            return Err(MailError { command: Some("CONN"), ..MailError::new(MailCode::Protocol, "Server response exceeds maximum allowed size") });
        }
        Ok(None)
    }

    /// The next reply. `phase` is a deadline that ends the wait before the socket timeout would, with its own message.
    async fn reply(&mut self, phase: Option<(Instant, &'static str)>) -> Result<String, MailError> {
        loop {
            if let Some(reply) = self.take_reply()? {
                return Ok(reply);
            }
            let mut limit = (Instant::now() + self.idle, "Timeout");
            if let Some((at, message)) = phase.filter(|(at, _)| *at <= limit.0) {
                limit = (at, message);
            }
            let upgrading = self.upgrading;
            let mut chunk = [0u8; 8192];
            let io = self.stream()?;
            let read = match timeout_at(limit.0, io.read(&mut chunk)).await {
                Err(_) => return Err(MailError::timed_out(limit.1)),
                // A TLS peer that closes without close_notify is a closed connection, as it is to nodemailer.
                Ok(Err(error)) if error.kind() == io::ErrorKind::UnexpectedEof => 0,
                Ok(Err(error)) => return Err(MailError { command: Some("CONN"), ..MailError::new(MailCode::Socket, error.to_string()) }),
                Ok(Ok(read)) => read,
            };
            if read == 0 {
                let code = if upgrading { MailCode::Tls } else { MailCode::Connection };
                return Err(MailError { command: Some("CONN"), ..MailError::new(code, "Connection closed unexpectedly") });
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }

    /// EHLO, then STARTTLS and EHLO again on a connection that is not secured yet; HELO when EHLO is refused.
    async fn hello(&mut self, name: &str, require_tls: bool) -> Result<Capabilities, MailError> {
        self.command(&format!("EHLO {name}")).await?;
        loop {
            let reply = self.reply(None).await?;
            if reply.starts_with("421") {
                return Err(MailError::failed(MailCode::Connection, &format!("Server terminates connection. response={reply}"), &reply, "EHLO"));
            }
            if !reply.starts_with('2') {
                if require_tls {
                    return Err(MailError::failed(
                        MailCode::Connection,
                        &format!("EHLO failed but HELO does not support required STARTTLS. response={reply}"),
                        &reply,
                        "EHLO",
                    ));
                }
                self.command(&format!("HELO {name}")).await?;
                let reply = self.reply(None).await?;
                if !reply.starts_with('2') {
                    return Err(MailError::failed(MailCode::Protocol, &format!("Invalid HELO. response={reply}"), &reply, "HELO"));
                }
                // Assume authentication is on: most probably it is not.
                return Ok(Capabilities { allows_auth: true, ..Capabilities::default() });
            }
            if !self.secure && (has_keyword(&reply, "STARTTLS") || require_tls) {
                self.command("STARTTLS").await?;
                let answer = self.reply(None).await?;
                if !answer.starts_with('2') {
                    return Err(MailError::failed(MailCode::Tls, "Error upgrading connection with STARTTLS", &answer, "STARTTLS"));
                }
                self.upgrade().await?;
                self.command(&format!("EHLO {name}")).await?;
                continue;
            }
            return Ok(parse_capabilities(&reply));
        }
    }

    /// `_upgradeConnection`: what arrived in plain text is dropped, then the TLS handshake runs under the setup timer.
    async fn upgrade(&mut self) -> Result<(), MailError> {
        self.buffer.clear();
        self.lines.clear();
        let plain = self.io.take().ok_or_else(|| MailError::new(MailCode::Connection, "Connection closed unexpectedly"))?;
        self.upgrading = true;
        let outcome = timeout_at(self.setup_deadline(), self.connector.connect(self.name.clone(), plain)).await;
        self.upgrading = false;
        match outcome {
            Ok(Ok(stream)) => {
                self.io = Some(Box::new(stream));
                self.secure = true;
                Ok(())
            }
            Ok(Err(error)) if error.kind() == io::ErrorKind::UnexpectedEof => {
                Err(MailError { command: Some("CONN"), ..MailError::new(MailCode::Tls, "Connection closed unexpectedly") })
            }
            Ok(Err(error)) => Err(MailError { command: Some("CONN"), ..MailError::new(MailCode::Socket, error.to_string()) }),
            Err(_) => Err(MailError::timed_out("TLS handshake timed out")),
        }
    }

    /// `login`: the first of PLAIN, LOGIN and CRAM-MD5 the server offers, PLAIN when it names none of them.
    async fn login(&mut self, capabilities: &Capabilities, user: &str, pass: &str) -> Result<(), MailError> {
        let method = capabilities.auth.first().copied().unwrap_or("PLAIN");
        if user.is_empty() || pass.is_empty() {
            return Err(MailError::api(MailCode::Auth, format!("Missing credentials for \"{method}\"")));
        }
        match method {
            "LOGIN" => self.login_prompted(user, pass).await,
            "CRAM-MD5" => self.login_cram_md5(user, pass).await,
            _ => self.login_plain(user, pass).await,
        }
    }

    async fn login_prompted(&mut self, user: &str, pass: &str) -> Result<(), MailError> {
        self.command("AUTH LOGIN").await?;
        let reply = self.reply(None).await?;
        if !is_continuation(&reply) {
            return Err(MailError::failed(MailCode::Auth, "Invalid login sequence while waiting for \"334 VXNlcm5hbWU6\"", &reply, "AUTH LOGIN"));
        }
        self.command(&STANDARD.encode(user)).await?;
        let reply = self.reply(None).await?;
        if !is_continuation(&reply) {
            return Err(MailError::failed(MailCode::Auth, "Invalid login sequence while waiting for \"334 UGFzc3dvcmQ6\"", &reply, "AUTH LOGIN"));
        }
        self.command(&STANDARD.encode(pass)).await?;
        let reply = self.reply(None).await?;
        self.auth_complete(reply, "AUTH LOGIN").await
    }

    async fn login_cram_md5(&mut self, user: &str, pass: &str) -> Result<(), MailError> {
        self.command("AUTH CRAM-MD5").await?;
        let reply = self.reply(None).await?;
        let Some(challenge) = cram_challenge(&reply) else {
            return Err(MailError::failed(MailCode::Auth, "Invalid login sequence while waiting for server challenge string", &reply, "AUTH CRAM-MD5"));
        };
        let lenient = GeneralPurpose::new(&alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent));
        let decoded: Vec<u8> = lenient.decode(challenge.trim()).unwrap_or_default().into_iter().map(|b| b & 0x7f).collect();
        let mut mac = Hmac::<Md5>::new_from_slice(pass.as_bytes()).map_err(|error| MailError::api(MailCode::Auth, error.to_string()))?;
        mac.update(&decoded);
        let digest: String = mac.finalize().into_bytes().iter().map(|byte| format!("{byte:02x}")).collect();
        self.command(&STANDARD.encode(format!("{user} {digest}"))).await?;
        let reply = self.reply(None).await?;
        let accepted = reply.strip_prefix("235").is_some_and(|rest| rest.starts_with(char::is_whitespace));
        if accepted { Ok(()) } else { Err(MailError::failed(MailCode::Auth, "Invalid login sequence while waiting for \"235\"", &reply, "AUTH CRAM-MD5")) }
    }

    async fn login_plain(&mut self, user: &str, pass: &str) -> Result<(), MailError> {
        // The authorization identity is left out: it causes problems with some servers.
        self.command(&format!("AUTH PLAIN {}", STANDARD.encode(format!("\u{0}{user}\u{0}{pass}")))).await?;
        let reply = self.reply(None).await?;
        self.auth_complete(reply, "AUTH PLAIN").await
    }

    /// `_actionAUTHComplete`: a `334` is answered with an empty line, anything but 2xx is a refusal.
    async fn auth_complete(&mut self, mut reply: String, command: &'static str) -> Result<(), MailError> {
        for _ in 0..MAX_AUTH_CONTINUATIONS {
            if reply.starts_with("334") {
                self.command("").await?;
                reply = self.reply(None).await?;
                continue;
            }
            break;
        }
        if reply.starts_with('2') { Ok(()) } else { Err(MailError::failed(MailCode::Auth, "Invalid login", &reply, command)) }
    }

    /// MAIL FROM, RCPT TO, DATA and the message; commands go out together when the server pipelines.
    async fn transact(&mut self, built: &Built, capabilities: &Capabilities) -> Result<(), MailError> {
        if built.to.is_empty() {
            return Err(MailError::api(MailCode::Envelope, "No recipients defined"));
        }
        if built.from.contains(['\r', '\n', '<', '>']) {
            return Err(MailError::api(MailCode::Envelope, format!("Invalid sender {}", quote(&built.from))));
        }
        if let Some(bad) = built.to.iter().find(|to| to.is_empty() || to.contains(['\r', '\n', '<', '>'])) {
            return Err(MailError::api(MailCode::Envelope, format!("Invalid recipient {}", quote(bad))));
        }
        let non_ascii = |text: &str| text.chars().any(|c| c as u32 >= 0x80);
        let utf8 = capabilities.smtputf8 && (non_ascii(&built.from) || built.to.iter().any(|to| non_ascii(to)));
        let mail_from = format!("MAIL FROM:<{}>{}", built.from, if utf8 { " SMTPUTF8" } else { "" });
        let mut envelope = Envelope { utf8, from_non_ascii: non_ascii(&built.from), ..Envelope::default() };

        let data_reply = if capabilities.pipelining {
            self.envelope_pipelined(&mail_from, &built.to, &mut envelope).await?
        } else {
            self.envelope_sequential(&mail_from, &built.to, &mut envelope).await?
        };
        // Some servers answer 250 where 354 is expected.
        if !data_reply.starts_with(['2', '3']) {
            return Err(MailError::failed(MailCode::Envelope, "Data command failed", &data_reply, "DATA"));
        }
        self.write(&dot_stuff(&built.data)).await?;
        let reply = self.reply(None).await?;
        if reply.starts_with('2') { Ok(()) } else { Err(MailError::failed(MailCode::Message, "Message failed", &reply, "DATA")) }
    }

    async fn envelope_pipelined(&mut self, mail_from: &str, to: &[String], envelope: &mut Envelope) -> Result<String, MailError> {
        let mut batch = format!("{mail_from}\r\n");
        for to in to {
            batch.push_str(&format!("RCPT TO:<{to}>\r\n"));
        }
        batch.push_str("DATA\r\n");
        self.write(batch.as_bytes()).await?;
        let reply = self.reply(None).await?;
        envelope.mail(&reply);
        for to in to {
            let reply = self.reply(None).await?;
            envelope.recipient(to, &reply);
        }
        let data_reply = self.reply(None).await?;
        if let Some(error) = envelope.error(&data_reply, true) {
            if data_reply.starts_with('3') && envelope.mail_error.is_none() {
                // The server took DATA without a recipient: the empty message is ended so the session stays usable.
                self.command(".").await?;
                self.reply(None).await?;
            }
            return Err(error);
        }
        Ok(data_reply)
    }

    async fn envelope_sequential(&mut self, mail_from: &str, to: &[String], envelope: &mut Envelope) -> Result<String, MailError> {
        self.command(mail_from).await?;
        let reply = self.reply(None).await?;
        envelope.mail(&reply);
        if let Some(error) = envelope.mail_error.take() {
            return Err(error);
        }
        let mut last = reply;
        for to in to {
            self.command(&format!("RCPT TO:<{to}>")).await?;
            last = self.reply(None).await?;
            envelope.recipient(to, &last);
        }
        if let Some(error) = envelope.error(&last, false) {
            return Err(error);
        }
        self.command("DATA").await?;
        self.reply(None).await
    }
}

/// The replies to MAIL FROM and RCPT TO.
#[derive(Default)]
struct Envelope {
    utf8: bool,
    from_non_ascii: bool,
    mail_error: Option<MailError>,
    accepted: usize,
    rejected: Vec<MailError>,
}

fn quote(text: &str) -> String {
    js::wire(&Value::String(text.to_owned()))
}

/// A reply line is a continuation when it starts with digits and a dash.
fn is_partial_line(line: &str) -> bool {
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0 && line.as_bytes().get(digits) == Some(&b'-')
}

/// Reply text as UTF-8 when it is valid, byte for byte otherwise.
fn decode_reply(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => bytes.iter().map(|&b| b as char).collect(),
    }
}

/// `/^334[ -]/`
fn is_continuation(reply: &str) -> bool {
    reply.starts_with("334") && matches!(reply.as_bytes().get(3), Some(b' ') | Some(b'-'))
}

/// The challenge of `/^334\s+(.+)$/`.
fn cram_challenge(reply: &str) -> Option<&str> {
    let rest = reply.strip_prefix("334")?;
    let challenge = rest.trim_start_matches(char::is_whitespace);
    (challenge.len() < rest.len() && !challenge.is_empty() && !challenge.contains(['\n', '\r'])).then_some(challenge)
}

/// `/[ -]KEYWORD\b/i` anywhere in the reply.
fn has_keyword(reply: &str, keyword: &str) -> bool {
    let upper = reply.to_ascii_uppercase();
    let (text, key) = (upper.as_bytes(), keyword.as_bytes());
    if text.len() <= key.len() {
        return false;
    }
    (1..=text.len() - key.len()).any(|at| {
        text[at..at + key.len()] == *key
            && matches!(text[at - 1], b' ' | b'-')
            && text.get(at + key.len()).is_none_or(|next| !(next.is_ascii_alphanumeric() || *next == b'_'))
    })
}

/// `_parseEhloExtensions`.
fn parse_capabilities(reply: &str) -> Capabilities {
    let mut offered: Vec<String> = Vec::new();
    for line in reply.split('\n').map(|line| line.trim_end_matches('\r')).skip(1) {
        let digits = line.bytes().take_while(u8::is_ascii_digit).count();
        let line = if digits > 0 && matches!(line.as_bytes().get(digits), Some(b' ') | Some(b'-')) { &line[digits + 1..] } else { line };
        let line = js::js_trim(line);
        if line.len() > 4 && line.is_char_boundary(4) && line[..4].eq_ignore_ascii_case("AUTH") {
            let rest = &line[4..];
            if let Some(separator) = rest.chars().next().filter(|c| c.is_whitespace() || *c == '=') {
                offered
                    .extend(rest[separator.len_utf8()..].split(|c: char| c.is_whitespace() || c == '=').filter(|m| !m.is_empty()).map(str::to_ascii_uppercase));
            }
        }
    }
    Capabilities {
        allows_auth: has_keyword(reply, "AUTH"),
        auth: ["PLAIN", "LOGIN", "CRAM-MD5"].into_iter().filter(|m| offered.iter().any(|o| o == m)).collect(),
        pipelining: has_keyword(reply, "PIPELINING"),
        smtputf8: has_keyword(reply, "SMTPUTF8"),
    }
}

/// `DataStream`: bare CR and bare LF become CRLF, a dot at the start of a line is doubled and the message ends with
/// `<CR><LF>.<CR><LF>`.
fn dot_stuff(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + 16);
    let mut previous: Option<u8> = None;
    for &byte in message {
        if previous == Some(b'\r') && byte != b'\n' {
            // A bare CR becomes CRLF; a dot after it is stuffed like at the start of any other line.
            out.push(b'\n');
            if byte == b'.' {
                out.push(b'.');
            }
        } else if byte == b'\n' && previous != Some(b'\r') {
            out.push(b'\r');
        } else if byte == b'.' && (previous == Some(b'\n') || previous.is_none()) {
            out.push(b'.');
        }
        out.push(byte);
        previous = Some(byte);
    }
    out.extend_from_slice(match previous {
        Some(b'\n') => b".\r\n".as_slice(),
        Some(b'\r') => b"\n.\r\n".as_slice(),
        _ => b"\r\n.\r\n".as_slice(),
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_is_dot_stuffed_and_line_ends_are_crlf() {
        assert_eq!(dot_stuff(b"a\n.b\r\n.c"), b"a\r\n..b\r\n..c\r\n.\r\n");
        assert_eq!(dot_stuff(b"a\r.b\n"), b"a\r\n..b\r\n.\r\n");
        assert_eq!(dot_stuff(b".x\r"), b"..x\r\n.\r\n");
        assert_eq!(dot_stuff(b""), b"\r\n.\r\n");
    }

    #[test]
    fn replies_are_complete_at_the_line_without_a_dash() {
        assert!(is_partial_line("250-STARTTLS"));
        assert!(!is_partial_line("250 OK"));
        assert!(!is_partial_line("250"));
        assert!(!is_partial_line("-250"));
    }

    #[test]
    fn extensions_are_read_from_the_ehlo_reply() {
        let reply = "250-mail.example.com greets you\n250-PIPELINING\n250-AUTH LOGIN PLAIN XOAUTH2\n250-SMTPUTF8\n250 STARTTLS";
        let found = parse_capabilities(reply);
        assert!(found.allows_auth && found.pipelining && found.smtputf8);
        assert_eq!(found.auth, vec!["PLAIN", "LOGIN"]);
        assert!(has_keyword(reply, "STARTTLS"));
        assert!(!has_keyword("250-X-STARTTLSX", "STARTTLS"));
        assert_eq!(parse_capabilities("250 hello").auth, Vec::<&str>::new());
        assert_eq!(parse_capabilities("250-hi\n250 AUTH=CRAM-MD5").auth, vec!["CRAM-MD5"]);
    }

    #[test]
    fn a_cram_challenge_needs_whitespace_and_one_line() {
        assert_eq!(cram_challenge("334 PGZvbz4="), Some("PGZvbz4="));
        assert_eq!(cram_challenge("334"), None);
        assert_eq!(cram_challenge("334PGZvbz4="), None);
        assert_eq!(cram_challenge("334 a\nb"), None);
    }

    #[test]
    fn the_error_carries_the_response_code_and_the_nodemailer_code() {
        let error = MailError::failed(MailCode::Auth, "Invalid login", "535 5.7.8 bad credentials", "AUTH PLAIN");
        assert_eq!(error.code.as_str(), "EAUTH");
        assert_eq!(error.response_code, Some(535));
        assert_eq!(error.message, "Invalid login: 535 5.7.8 bad credentials");
    }

    #[test]
    fn the_hello_name_is_a_fully_qualified_name_or_the_loopback_literal() {
        let name = hello_name();
        assert!(name == "[127.0.0.1]" || name.contains('.') || name.starts_with('['), "{name}");
    }
}

/// The server and the credentials; the timeout is applied to the four timeouts of `createTransport`.
#[derive(Clone)]
pub struct MailConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    pub timeout: Duration,
    /// Implicit TLS: the connection is encrypted from its first byte. Otherwise the session starts in plain text and
    /// STARTTLS is required. `new` sets it for port 465 only (`secure: config.port === 465`); the field is public so a
    /// test can run both ways on an ephemeral port.
    pub secure: bool,
}
impl MailConfig {
    /// `FEEDBACK_DEFAULTS.smtpTimeoutMs`.
    pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

    pub fn new(host: impl Into<String>, port: u16, user: impl Into<String>, pass: impl Into<String>) -> Self {
        Self { host: host.into(), port, user: user.into(), pass: pass.into(), timeout: Self::DEFAULT_TIMEOUT, secure: port == 465 }
    }
}
impl fmt::Debug for MailConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MailConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("pass", &"<redacted>")
            .field("timeout", &self.timeout)
            .field("secure", &self.secure)
            .finish()
    }
}
impl std::error::Error for MailError {}
/// `transport.sendMail(message)` with the relay's transport options.
pub async fn send(config: &MailConfig, message: &Message) -> Result<(), MailError> {
    static TLS: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    let tls = TLS.get_or_init(|| tls_config(&[])).clone().map_err(|error| MailError::new(MailCode::Socket, error))?;
    run(config, message, tls).await
}
/// [`send`] trusting the given DER certificates besides the webpki roots: the fake servers of the tests.
#[cfg(any(test, feature = "test-support"))]
pub async fn send_trusting(config: &MailConfig, message: &Message, roots: &[Vec<u8>]) -> Result<(), MailError> {
    let tls = tls_config(roots).map_err(|error| MailError::new(MailCode::Socket, error))?;
    run(config, message, tls).await
}
async fn run(config: &MailConfig, message: &Message, tls: Arc<rustls::ClientConfig>) -> Result<(), MailError> {
    let built = mime::build(message);
    let deadline = Instant::now() + config.timeout;
    let name = ServerName::try_from(config.host.clone()).map_err(|_| MailError::new(MailCode::Dns, format!("Invalid host name {}", config.host)))?;
    let connector = TlsConnector::from(tls);
    let secure = config.secure;

    let tcp = connect_tcp(config, deadline).await?;
    let io: Box<dyn Io> = if secure {
        match timeout_at(deadline, connector.connect(name.clone(), tcp)).await {
            Ok(Ok(stream)) => Box::new(stream),
            Ok(Err(error)) => return Err(MailError { command: Some("CONN"), ..MailError::new(MailCode::Socket, error.to_string()) }),
            Err(_) => return Err(MailError::timed_out("Connection timeout")),
        }
    } else {
        Box::new(tcp)
    };
    let mut session = Session {
        io: Some(io),
        buffer: Vec::new(),
        lines: Vec::new(),
        idle: config.timeout,
        secure,
        upgrading: false,
        connector,
        name,
        deadline,
        timeout: config.timeout,
    };

    let greeting = session.reply(Some((session.setup_deadline(), "Greeting never received"))).await?;
    if !greeting.starts_with("220") {
        return Err(MailError::failed(MailCode::Protocol, &format!("Invalid greeting. response={greeting}"), &greeting, "CONN"));
    }
    let capabilities = session.hello(&hello_name(), !secure).await?;
    if capabilities.allows_auth {
        session.login(&capabilities, &config.user, &config.pass).await?;
    }
    session.transact(&built, &capabilities).await?;
    // nodemailer closes the socket; the server is told so with QUIT, best effort.
    let _ = timeout(Duration::from_millis(500), session.command("QUIT")).await;
    Ok(())
}
/// `_getHostname()`: the machine name when it is fully qualified, otherwise `[127.0.0.1]`.
fn hello_name() -> String {
    #[cfg(unix)]
    let host = {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is valid for its length; the name is truncated, not overrun.
        let status = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
        if status == 0 { String::from_utf8_lossy(&buffer[..end]).into_owned() } else { String::new() }
    };
    #[cfg(windows)]
    let host = std::env::var("COMPUTERNAME").unwrap_or_default();
    if !host.contains('.') {
        return "[127.0.0.1]".to_owned();
    }
    let parts: Vec<&str> = host.split('.').collect();
    let is_ipv4 = parts.len() == 4 && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    if is_ipv4 { format!("[{host}]") } else { host }
}
/// The DNS lookup and the addresses in turn, all inside the connection deadline: IPv6 first, each family shuffled; a family that
/// is the only one gets its share of what is left, a mixed list moves on after a quarter of a second.
async fn connect_tcp(config: &MailConfig, deadline: Instant) -> Result<TcpStream, MailError> {
    let dns_limit = config.timeout.min(deadline.saturating_duration_since(Instant::now()));
    let resolved = match timeout(dns_limit, lookup_host((config.host.as_str(), config.port))).await {
        Ok(Ok(addresses)) => addresses.collect::<Vec<SocketAddr>>(),
        Ok(Err(error)) => return Err(MailError { command: Some("CONN"), ..MailError::new(MailCode::Dns, error.to_string()) }),
        Err(_) => return Err(MailError { command: Some("CONN"), ..MailError::new(MailCode::Dns, "DNS lookup timed out") }),
    };
    let (mut v6, mut v4): (Vec<SocketAddr>, Vec<SocketAddr>) = resolved.into_iter().partition(SocketAddr::is_ipv6);
    if v6.is_empty() && v4.is_empty() {
        return Err(MailError { command: Some("CONN"), ..MailError::new(MailCode::Dns, format!("No address found for {}", config.host)) });
    }
    let mixed = !v6.is_empty() && !v4.is_empty();
    v6.shuffle(&mut rand::rng());
    v4.shuffle(&mut rand::rng());
    let ordered: Vec<SocketAddr> = v6.into_iter().chain(v4).collect();
    let total = ordered.len();
    let mut last: Option<io::Error> = None;
    for (index, address) in ordered.into_iter().enumerate() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let attempt = if index + 1 == total {
            remaining
        } else if mixed {
            Duration::from_millis(250).min(remaining)
        } else {
            (remaining / (total - index) as u32).max(Duration::from_millis(10)).min(remaining)
        };
        match timeout(attempt, TcpStream::connect(address)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(error)) => last = Some(error),
            Err(_) => last = None,
        }
    }
    Err(match last {
        Some(error) => MailError { command: Some("CONN"), ..MailError::new(MailCode::Socket, error.to_string()) },
        None => MailError::timed_out("Connection timeout"),
    })
}
impl Envelope {
    fn mail(&mut self, reply: &str) {
        if !reply.starts_with('2') {
            let message = if self.utf8 && reply.starts_with("550 ") && self.from_non_ascii {
                "Internationalized mailbox name not allowed"
            } else {
                "Mail command failed"
            };
            self.mail_error = Some(MailError::failed(MailCode::Envelope, message, reply, "MAIL FROM"));
        }
    }

    fn recipient(&mut self, to: &str, reply: &str) {
        if reply.starts_with('2') {
            self.accepted += 1;
        } else {
            let message = if self.utf8 && reply.starts_with("553 ") && to.chars().any(|c| c as u32 >= 0x80) {
                "Internationalized mailbox name not allowed"
            } else {
                "Recipient command failed"
            };
            self.rejected.push(MailError::failed(MailCode::Envelope, message, reply, "RCPT TO"));
        }
    }

    /// `_envelopeError`: how the envelope went once every reply is in; `None` when DATA can go ahead.
    fn error(&self, reply: &str, pipelined: bool) -> Option<MailError> {
        if let Some(error) = &self.mail_error {
            return Some(error.clone());
        }
        if self.accepted > 0 {
            return None;
        }
        // A temporary rejection is reported when there is one: the last reply would mark the whole message as permanently failed.
        let deferred = self.rejected.iter().find(|e| e.response_code.is_some_and(|code| code < 500));
        let response = deferred
            .and_then(|e| e.response.as_deref())
            .or(if pipelined { self.rejected.last().and_then(|e| e.response.as_deref()) } else { None })
            .unwrap_or(reply);
        Some(MailError::failed(MailCode::Envelope, "Can't send mail - all recipients were rejected", response, "RCPT TO"))
    }
}
