//! The SMTP half of the check, as nodemailer 10.1.7 runs `transport.verify()` for
//! `createTransport({host, port, secure, auth})`: greeting, EHLO (HELO when refused), the
//! login, QUIT. A server that advertises no AUTH is not asked to log in, and the check passes.
//! Every transport failure is reported under the code nodemailer gives it (`ESOCKET`, `EDNS`,
//! `ETIMEDOUT`, `ECONNECTION`), which is what the classifier reads.

use std::sync::LazyLock;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use tokio::time::{Instant, timeout};

use super::Leg;
use super::wire::{Failure, Wire, connect};

const MAX_RESPONSE: usize = 1024 * 1024;

static AUTH_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[ -]AUTH\b").expect("a fixed pattern"));
static FAILURE_REPLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[45]\d{2}[ -]").expect("a fixed pattern"));

/// A server reply as nodemailer holds it: the reply's lines joined with a line feed.
async fn reply(wire: &mut Wire) -> Result<String, Failure> {
    let mut lines: Vec<String> = Vec::new();
    loop {
        let Some(raw) = wire.line().await? else { return Err(closed(wire.pending())) };
        // Reply text has no defined charset: UTF-8 when it is, else the bytes as they are.
        let line = String::from_utf8(raw).unwrap_or_else(|error| error.into_bytes().into_iter().map(char::from).collect());
        if lines.is_empty() && line.trim().is_empty() {
            continue;
        }
        let continues = line.split_once('-').is_some_and(|(digits, _)| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()));
        lines.push(line);
        if !continues {
            return Ok(lines.join("\n"));
        }
    }
}

/// The server ended the connection; an unterminated failure reply still in the buffer is
/// reported as its reply.
fn closed(pending: &[u8]) -> Failure {
    let text = String::from_utf8_lossy(pending);
    let text = mixdog_js::js_trim(&text);
    Failure::smtp("Connection closed unexpectedly", "ECONNECTION", Some(text).filter(|t| FAILURE_REPLY.is_match(t)))
}

/// A connect or handshake failure as nodemailer's `_onError` names it.
fn socket_failure(failure: Failure) -> Failure {
    match failure.code.as_str() {
        "ETIMEDOUT" => failure,
        "ENOTFOUND" => Failure::new("EDNS", failure.message),
        _ => Failure::new("ESOCKET", failure.message),
    }
}

/// `_getHostname()` as nodemailer falls back to when no `name` is given.
pub fn default_hello_name() -> String {
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
    // A name that is not fully qualified is not sent; an IPv4 address is bracketed.
    if !host.contains('.') {
        return "[127.0.0.1]".to_owned();
    }
    let parts: Vec<&str> = host.split('.').collect();
    let is_ipv4 = parts.len() == 4 && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    if is_ipv4 { format!("[{host}]") } else { host }
}

/// The mechanisms of the EHLO reply, in nodemailer's order of preference (CRAM-MD5 is not
/// among them: Gmail does not offer it, and it is the one mechanism this check does not speak).
fn mechanisms(ehlo: &str) -> Vec<&'static str> {
    let mut offered: Vec<String> = Vec::new();
    for line in ehlo.split('\n').map(|line| line.trim_end_matches('\r')).skip(1) {
        let line = line.trim_start_matches(|c: char| c.is_ascii_digit());
        let line = mixdog_js::js_trim(line.strip_prefix([' ', '-']).unwrap_or(line));
        if line.len() > 4 && line[..4].eq_ignore_ascii_case("AUTH") && line[4..].starts_with(|c: char| c.is_whitespace() || c == '=') {
            offered.extend(line[5..].split(|c: char| c.is_whitespace() || c == '=').filter(|m| !m.is_empty()).map(str::to_ascii_uppercase));
        }
    }
    ["PLAIN", "LOGIN"].into_iter().filter(|m| offered.iter().any(|o| o == m)).collect()
}

async fn authenticate(wire: &mut Wire, method: &str, email: &str, password: &str) -> Result<(), Failure> {
    let invalid_login = |response: &str| Failure::smtp("Invalid login", "EAUTH", Some(response));
    let mut answer = if method == "LOGIN" {
        wire.send(b"AUTH LOGIN\r\n").await?;
        let first = reply(wire).await?;
        if !first.starts_with("334 ") && !first.starts_with("334-") {
            return Err(Failure::smtp("Invalid login sequence while waiting for \"334 VXNlcm5hbWU6\"", "EAUTH", Some(&first)));
        }
        wire.send(format!("{}\r\n", STANDARD.encode(email)).as_bytes()).await?;
        let second = reply(wire).await?;
        if !second.starts_with("334 ") && !second.starts_with("334-") {
            return Err(Failure::smtp("Invalid login sequence while waiting for \"334 UGFzc3dvcmQ6\"", "EAUTH", Some(&second)));
        }
        wire.send(format!("{}\r\n", STANDARD.encode(password)).as_bytes()).await?;
        reply(wire).await?
    } else {
        // The authorization identity is left out: it confuses some servers.
        wire.send(format!("AUTH PLAIN {}\r\n", STANDARD.encode(format!("\0{email}\0{password}"))).as_bytes()).await?;
        reply(wire).await?
    };
    // A 334 asks for more; an empty line is the answer, and the reply to it is final.
    if answer.starts_with("334") {
        wire.send(b"\r\n").await?;
        answer = reply(wire).await?;
    }
    if answer.starts_with('2') { Ok(()) } else { Err(invalid_login(&answer)) }
}

pub async fn verify(leg: &Leg<'_>, name: &str, email: &str, password: &str) -> Result<(), Failure> {
    let deadline = Instant::now() + leg.timeouts.connection;
    let io = connect(leg.target, leg.tls, deadline, "ETIMEDOUT", "Connection timeout").await.map_err(socket_failure)?;
    let mut wire = Wire::new(io, leg.timeouts.socket, ("ETIMEDOUT", "Timeout"), Some("ESOCKET"), MAX_RESPONSE);

    // Greeting time is cut short by what is left of the connection timeout.
    let setup = leg.timeouts.greeting.min(deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1)));
    let greeting = timeout(setup, reply(&mut wire)).await.map_err(|_| Failure::new("ETIMEDOUT", "Greeting never received"))??;
    if !greeting.starts_with("220") {
        return Err(Failure::smtp(&format!("Invalid greeting. response={greeting}"), "EPROTOCOL", Some(&greeting)));
    }

    wire.send(format!("EHLO {name}\r\n").as_bytes()).await?;
    let ehlo = reply(&mut wire).await?;
    if ehlo.starts_with("421") {
        return Err(Failure::smtp(&format!("Server terminates connection. response={ehlo}"), "ECONNECTION", Some(&ehlo)));
    }
    let (allows_auth, supported) = if ehlo.starts_with('2') {
        (AUTH_WORD.is_match(&ehlo), mechanisms(&ehlo))
    } else {
        wire.send(format!("HELO {name}\r\n").as_bytes()).await?;
        let helo = reply(&mut wire).await?;
        if !helo.starts_with('2') {
            return Err(Failure::smtp(&format!("Invalid HELO. response={helo}"), "EPROTOCOL", Some(&helo)));
        }
        // Assume authentication is enabled; a HELO server rarely says.
        (true, Vec::new())
    };

    if allows_auth {
        let method = supported.first().copied().unwrap_or("PLAIN");
        if email.is_empty() || password.is_empty() {
            return Err(Failure::smtp(&format!("Missing credentials for \"{method}\""), "EAUTH", None));
        }
        authenticate(&mut wire, method, email, password).await?;
    }
    // The check is over once QUIT is sent; the 221 is not waited for.
    wire.send(b"QUIT\r\n").await?;
    Ok(())
}
