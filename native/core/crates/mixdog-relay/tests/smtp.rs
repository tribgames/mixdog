//! The SMTP client against a scripted server: implicit TLS, STARTTLS, authentication mechanisms, pipelining, dot-stuffing, attachments, timeouts and the failure code of each step.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_relay::mail::{self, Attachment, MailCode, MailConfig, MailError, Message};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

// ---- the scripted server ----

trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

#[derive(Clone)]
enum Step {
    /// Answers with this text, lines separated by `\n`.
    Reply(String),
    /// Reads the command and never answers.
    Silent,
    /// Closes the connection instead of answering.
    Close,
}

#[derive(Clone, Copy, PartialEq)]
enum TlsMode {
    /// Encrypted from the first byte.
    Implicit,
    /// Plain text until STARTTLS.
    StartTls,
}

#[derive(Clone)]
struct Script {
    tls: TlsMode,
    advertise_starttls: bool,
    /// EHLO lines after the greeting line (`PIPELINING`, `AUTH PLAIN LOGIN`, ...).
    ehlo: Vec<String>,
    /// Replies by phase: `greeting`, `ehlo`, `ehlo2` (after STARTTLS), `starttls`, `tls` (the handshake), `helo`,
    /// `auth`, `auth_user`, `auth_pass`, `mail`, `rcpt`, `data`, `body`.
    steps: HashMap<&'static str, Step>,
    /// Reads MAIL FROM, RCPT TO and DATA before answering any of them, as a pipelining client sends them.
    batch: bool,
}

impl Script {
    fn new(tls: TlsMode) -> Self {
        Self { tls, advertise_starttls: true, ehlo: Vec::new(), steps: HashMap::new(), batch: false }
    }

    fn ehlo(mut self, lines: &[&str]) -> Self {
        self.ehlo = lines.iter().map(|line| (*line).to_owned()).collect();
        self
    }

    fn step(mut self, phase: &'static str, step: Step) -> Self {
        self.steps.insert(phase, step);
        self
    }

    fn reply(self, phase: &'static str, text: &str) -> Self {
        self.step(phase, Step::Reply(text.to_owned()))
    }
}

#[derive(Default)]
struct Seen {
    log: Mutex<Vec<String>>,
    /// The messages as received on the wire (dot-stuffed, terminator removed) and as a server stores them.
    raw: Mutex<Vec<Vec<u8>>>,
    bodies: Mutex<Vec<Vec<u8>>>,
}

struct Conn {
    io: Box<dyn Duplex>,
    buf: Vec<u8>,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|window| window == needle)
}

impl Conn {
    fn new(io: Box<dyn Duplex>) -> Self {
        Self { io, buf: Vec::new() }
    }

    async fn fill(&mut self) -> bool {
        let mut chunk = [0u8; 4096];
        match self.io.read(&mut chunk).await {
            Ok(0) | Err(_) => false,
            Ok(read) => {
                self.buf.extend_from_slice(&chunk[..read]);
                true
            }
        }
    }

    async fn line(&mut self) -> Option<String> {
        loop {
            if let Some(at) = find(&self.buf, b"\r\n") {
                let raw: Vec<u8> = self.buf.drain(..at + 2).collect();
                return Some(String::from_utf8_lossy(&raw[..at]).into_owned());
            }
            if !self.fill().await {
                return None;
            }
        }
    }

    /// The lines of text separated by `\n` as one write, each ended with CRLF.
    async fn say(&mut self, text: &str) {
        let wire = text.split('\n').map(|line| format!("{line}\r\n")).collect::<String>();
        let _ = self.io.write_all(wire.as_bytes()).await;
        let _ = self.io.flush().await;
    }

    /// The message up to the line with the single dot (also an empty message), as received and as stored.
    async fn body(&mut self) -> Option<(Vec<u8>, Vec<u8>)> {
        loop {
            if self.buf.starts_with(b".\r\n") {
                let raw: Vec<u8> = self.buf.drain(..3).collect();
                return Some((raw, Vec::new()));
            }
            if let Some(at) = find(&self.buf, b"\r\n.\r\n") {
                let raw: Vec<u8> = self.buf.drain(..at + 5).collect();
                let text = String::from_utf8_lossy(&raw[..at + 2]).into_owned();
                let stored =
                    text.split("\r\n").map(|line| line.strip_prefix('.').filter(|rest| rest.starts_with('.')).unwrap_or(line)).collect::<Vec<_>>().join("\r\n");
                return Some((raw[..at + 2].to_vec(), stored.into_bytes()));
            }
            if !self.fill().await {
                return None;
            }
        }
    }

    async fn upgrade(self, acceptor: &TlsAcceptor) -> Option<Conn> {
        acceptor.accept(self.io).await.ok().map(|stream| Conn::new(Box::new(stream)))
    }
}

/// Sends the scripted reply of a phase or the default; `None` when the script closes the connection.
async fn answer(conn: &mut Conn, script: &Script, phase: &str, default: &str) -> Option<String> {
    match script.steps.get(phase) {
        Some(Step::Silent) => std::future::pending::<Option<String>>().await,
        Some(Step::Close) => None,
        Some(Step::Reply(text)) => {
            conn.say(text).await;
            Some(text.clone())
        }
        None => {
            conn.say(default).await;
            Some(default.to_owned())
        }
    }
}

async fn data_phase(conn: &mut Conn, script: &Script, seen: &Seen) -> bool {
    let Some(sent) = answer(conn, script, "data", "354 End data with <CR><LF>.<CR><LF>").await else { return false };
    if !sent.starts_with('3') {
        return true;
    }
    let Some((raw, stored)) = conn.body().await else { return false };
    seen.raw.lock().unwrap().push(raw);
    seen.bodies.lock().unwrap().push(stored);
    answer(conn, script, "body", "250 2.0.0 Ok: queued as 4D1F").await.is_some()
}

async fn session(tcp: TcpStream, acceptor: TlsAcceptor, script: Script, seen: Arc<Seen>) {
    let mut secured = false;
    let mut conn = if script.tls == TlsMode::Implicit {
        if matches!(script.steps.get("tls"), Some(Step::Silent)) {
            std::future::pending::<()>().await;
        }
        match acceptor.accept(tcp).await {
            Ok(stream) => {
                secured = true;
                Conn::new(Box::new(stream))
            }
            Err(_) => return,
        }
    } else {
        Conn::new(Box::new(tcp))
    };
    if answer(&mut conn, &script, "greeting", "220 mail.test ESMTP ready").await.is_none() {
        return;
    }
    loop {
        let Some(line) = conn.line().await else { return };
        seen.log.lock().unwrap().push(line.clone());
        let upper = line.to_ascii_uppercase();
        let verb = upper.split(' ').next().unwrap_or("").to_owned();
        match verb.as_str() {
            "EHLO" => {
                let mut lines = vec!["mail.test greets you".to_owned()];
                if script.tls == TlsMode::StartTls && !secured && script.advertise_starttls {
                    lines.push("STARTTLS".to_owned());
                }
                lines.extend(script.ehlo.iter().cloned());
                let last = lines.len() - 1;
                let text = lines.iter().enumerate().map(|(i, l)| format!("250{}{l}", if i == last { ' ' } else { '-' })).collect::<Vec<_>>().join("\n");
                let phase = if secured && script.tls == TlsMode::StartTls { "ehlo2" } else { "ehlo" };
                if answer(&mut conn, &script, phase, &text).await.is_none() {
                    return;
                }
            }
            "HELO" => {
                if answer(&mut conn, &script, "helo", "250 mail.test").await.is_none() {
                    return;
                }
            }
            "STARTTLS" => {
                let Some(sent) = answer(&mut conn, &script, "starttls", "220 2.0.0 Ready to start TLS").await else { return };
                if !sent.starts_with('2') {
                    continue;
                }
                if matches!(script.steps.get("tls"), Some(Step::Silent)) {
                    std::future::pending::<()>().await;
                }
                conn = match conn.upgrade(&acceptor).await {
                    Some(upgraded) => upgraded,
                    None => return,
                };
                secured = true;
            }
            "AUTH" => {
                match upper.split(' ').nth(1).unwrap_or("") {
                    "LOGIN" => {
                        if answer(&mut conn, &script, "auth_user", "334 VXNlcm5hbWU6").await.is_none() {
                            return;
                        }
                        let Some(user) = conn.line().await else { return };
                        seen.log.lock().unwrap().push(user);
                        if answer(&mut conn, &script, "auth_pass", "334 UGFzc3dvcmQ6").await.is_none() {
                            return;
                        }
                        let Some(pass) = conn.line().await else { return };
                        seen.log.lock().unwrap().push(pass);
                    }
                    "CRAM-MD5" => {
                        // The challenge of RFC 2195.
                        if answer(&mut conn, &script, "auth_user", "334 PDE4OTYuNjk3MTcwOTUyQHBvc3RvZmZpY2UucmVzdG9uLm1jaS5uZXQ+").await.is_none() {
                            return;
                        }
                        let Some(response) = conn.line().await else { return };
                        seen.log.lock().unwrap().push(response);
                    }
                    _ => {}
                }
                if answer(&mut conn, &script, "auth", "235 2.7.0 Authentication successful").await.is_none() {
                    return;
                }
            }
            "MAIL" if script.batch => {
                let mut recipients = 0;
                loop {
                    let Some(next) = conn.line().await else { return };
                    seen.log.lock().unwrap().push(next.clone());
                    if next.to_ascii_uppercase().starts_with("DATA") {
                        break;
                    }
                    recipients += 1;
                }
                if answer(&mut conn, &script, "mail", "250 2.1.0 Ok").await.is_none() {
                    return;
                }
                for _ in 0..recipients {
                    if answer(&mut conn, &script, "rcpt", "250 2.1.5 Ok").await.is_none() {
                        return;
                    }
                }
                if !data_phase(&mut conn, &script, &seen).await {
                    return;
                }
            }
            "MAIL" => {
                if answer(&mut conn, &script, "mail", "250 2.1.0 Ok").await.is_none() {
                    return;
                }
            }
            "RCPT" => {
                if answer(&mut conn, &script, "rcpt", "250 2.1.5 Ok").await.is_none() {
                    return;
                }
            }
            "DATA" => {
                if !data_phase(&mut conn, &script, &seen).await {
                    return;
                }
            }
            "RSET" => conn.say("250 2.0.0 Ok").await,
            "QUIT" => {
                conn.say("221 2.0.0 Bye").await;
                return;
            }
            _ => conn.say("500 5.5.2 Error: command not recognized").await,
        }
    }
}

// ---- the fixture ----

struct Pki {
    acceptor: TlsAcceptor,
    root: Vec<u8>,
}

fn pki() -> Pki {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
    let certificate = issued.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der()));
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone()], key)
        .unwrap();
    Pki { acceptor: TlsAcceptor::from(Arc::new(config)), root: certificate.to_vec() }
}

struct Fixture {
    addr: SocketAddr,
    seen: Arc<Seen>,
    root: Vec<u8>,
    secure: bool,
}

async fn start(script: Script) -> Fixture {
    let Pki { acceptor, root } = pki();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Seen::default());
    let secure = script.tls == TlsMode::Implicit;
    let shared = seen.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            tokio::spawn(session(tcp, acceptor.clone(), script.clone(), shared.clone()));
        }
    });
    Fixture { addr, seen, root, secure }
}

fn sample() -> Message {
    Message {
        from: "bot@example.com".to_owned(),
        to: "support@mixdog.ai".to_owned(),
        reply_to: Some("user@example.org".to_owned()),
        subject: "[Mixdog feedback] bug 0f1e2d3c".to_owned(),
        text: "hello world\nsecond line".to_owned(),
        attachments: Vec::new(),
        message_id: Some("<0f1e2d3c@feedback.mixdog>".to_owned()),
    }
}

fn plain_credentials() -> String {
    format!("AUTH PLAIN {}", STANDARD.encode("\0bot@example.com\0s3cret"))
}

fn is_hello(line: &str) -> bool {
    line.strip_prefix("EHLO ").is_some_and(|name| name == "[127.0.0.1]" || name.contains('.'))
}

async fn failure(fixture: &Fixture) -> MailError {
    fixture.send(&sample()).await.expect_err("the send fails")
}

// ---- sessions that work ----

#[tokio::test]
async fn implicit_tls_sends_the_message_after_ehlo_and_auth() {
    let fixture = start(Script::new(TlsMode::Implicit).ehlo(&["AUTH PLAIN LOGIN"])).await;
    fixture.send(&sample()).await.expect("sent");
    let log = fixture.log().await;
    assert!(is_hello(&log[0]), "{log:?}");
    assert_eq!(log[1..], [plain_credentials().as_str(), "MAIL FROM:<bot@example.com>", "RCPT TO:<support@mixdog.ai>", "DATA", "QUIT"]);
    let body = String::from_utf8(fixture.seen.bodies.lock().unwrap()[0].clone()).unwrap();
    assert!(body.contains("\r\nSubject: [Mixdog feedback] bug 0f1e2d3c\r\n"), "{body}");
    assert!(body.contains("\r\nMessage-ID: <0f1e2d3c@feedback.mixdog>\r\n"));
    assert!(body.ends_with("\r\n\r\nhello world\r\nsecond line\r\n"), "{body}");
}

#[tokio::test]
async fn starttls_upgrades_and_says_ehlo_again() {
    let fixture = start(Script::new(TlsMode::StartTls).ehlo(&["AUTH PLAIN"])).await;
    fixture.send(&sample()).await.expect("sent");
    let log = fixture.log().await;
    assert!(is_hello(&log[0]) && log[1] == "STARTTLS" && log[2] == log[0], "{log:?}");
    assert_eq!(log[3..], [plain_credentials().as_str(), "MAIL FROM:<bot@example.com>", "RCPT TO:<support@mixdog.ai>", "DATA", "QUIT"]);
}

#[tokio::test]
async fn a_server_that_does_not_advertise_starttls_is_still_asked_and_a_refusal_is_etls() {
    let mut script = Script::new(TlsMode::StartTls).reply("starttls", "502 5.5.1 STARTTLS not supported");
    script.advertise_starttls = false;
    let fixture = start(script).await;
    let error = failure(&fixture).await;
    assert_eq!(error.code, MailCode::Tls);
    assert_eq!(error.code.as_str(), "ETLS");
    assert_eq!(error.response_code, Some(502));
    let log = fixture.seen.log.lock().unwrap().clone();
    assert_eq!(log.len(), 2, "{log:?}");
    assert_eq!(log[1], "STARTTLS");
}

#[tokio::test]
async fn a_server_that_offers_no_auth_is_not_asked_to_authenticate() {
    let fixture = start(Script::new(TlsMode::StartTls)).await;
    fixture.send(&sample()).await.expect("sent");
    assert!(!fixture.log().await.iter().any(|line| line.starts_with("AUTH")));
}

#[tokio::test]
async fn auth_login_answers_both_prompts() {
    let fixture = start(Script::new(TlsMode::Implicit).ehlo(&["AUTH LOGIN"])).await;
    fixture.send(&sample()).await.expect("sent");
    let log = fixture.log().await;
    assert_eq!(log[1..4], ["AUTH LOGIN".to_owned(), STANDARD.encode("bot@example.com"), STANDARD.encode("s3cret")]);
}

#[tokio::test]
async fn auth_cram_md5_answers_the_challenge_of_rfc_2195() {
    let fixture = start(Script::new(TlsMode::Implicit).ehlo(&["AUTH CRAM-MD5"])).await;
    let mut config = fixture.config();
    config.user = "tim".to_owned();
    config.pass = "tanstaaftanstaaf".to_owned();
    fixture.send_with(&config, &sample()).await.expect("sent");
    let log = fixture.log().await;
    assert_eq!(log[1], "AUTH CRAM-MD5");
    assert_eq!(log[2], "dGltIGI5MTNhNjAyYzdlZGE3YTQ5NWI0ZTZlNzMzNGQzODkw");
}

#[tokio::test]
async fn plain_is_preferred_and_a_server_naming_only_xoauth2_gets_plain() {
    let preferred = start(Script::new(TlsMode::Implicit).ehlo(&["AUTH CRAM-MD5 LOGIN PLAIN"])).await;
    preferred.send(&sample()).await.expect("sent");
    assert_eq!(preferred.log().await[1], plain_credentials());
    let oauth = start(Script::new(TlsMode::Implicit).ehlo(&["AUTH XOAUTH2"])).await;
    oauth.send(&sample()).await.expect("sent");
    assert_eq!(oauth.log().await[1], plain_credentials());
}

#[tokio::test]
async fn a_334_after_the_credentials_is_answered_with_an_empty_line() {
    let fixture = start(Script::new(TlsMode::Implicit).ehlo(&["AUTH PLAIN"]).reply("auth", "334 ")).await;
    // The server answers 334 to AUTH; the empty line the client sends next is an unknown command to it (a 500), which is
    // not a 2xx, so the login ends as a refusal.
    let error = failure(&fixture).await;
    assert_eq!(error.code, MailCode::Auth);
    assert_eq!(error.response_code, Some(500));
    let log = fixture.seen.log.lock().unwrap().clone();
    assert_eq!(log.len(), 3, "{log:?}");
    assert_eq!(log[2], "");
}

#[tokio::test]
async fn ehlo_refused_falls_back_to_helo_on_a_secure_connection_and_authenticates() {
    let fixture = start(Script::new(TlsMode::Implicit).reply("ehlo", "502 5.5.1 EHLO not implemented")).await;
    fixture.send(&sample()).await.expect("sent");
    let log = fixture.log().await;
    assert!(log[0].starts_with("EHLO ") && log[1].starts_with("HELO ") && log[2] == plain_credentials(), "{log:?}");
}

#[tokio::test]
async fn multi_line_replies_are_read_whole() {
    let fixture = start(
        Script::new(TlsMode::Implicit)
            .ehlo(&["AUTH PLAIN"])
            .reply("greeting", "220-mail.test ESMTP\n220-second line\n220 ready")
            .reply("mail", "250-2.1.0 Ok\n250 2.1.0 really ok")
            .reply("body", "250-2.0.0 queued\n250 2.0.0 as 4D1F"),
    )
    .await;
    fixture.send(&sample()).await.expect("sent");
    assert_eq!(fixture.log().await.len(), 6);
}

#[tokio::test]
async fn pipelining_sends_the_envelope_and_data_without_waiting() {
    let mut script = Script::new(TlsMode::Implicit).ehlo(&["PIPELINING", "AUTH PLAIN"]);
    script.batch = true;
    let fixture = start(script).await;
    let mut message = sample();
    message.to = "a@example.com, b@example.com".to_owned();
    // A client that waited for each reply would sit on MAIL FROM until the timeout: the server answers only after DATA.
    fixture.send(&message).await.expect("sent");
    let log = fixture.log().await;
    assert_eq!(log[2..], ["MAIL FROM:<bot@example.com>", "RCPT TO:<a@example.com>", "RCPT TO:<b@example.com>", "DATA", "QUIT"]);
}

#[tokio::test]
async fn without_pipelining_each_command_waits_for_its_reply() {
    let fixture = start(Script::new(TlsMode::Implicit).ehlo(&["AUTH PLAIN"])).await;
    let mut message = sample();
    message.to = "a@example.com, b@example.com".to_owned();
    fixture.send(&message).await.expect("sent");
    let log = fixture.log().await;
    assert_eq!(log[2..], ["MAIL FROM:<bot@example.com>", "RCPT TO:<a@example.com>", "RCPT TO:<b@example.com>", "DATA", "QUIT"]);
}

#[tokio::test]
async fn data_is_dot_stuffed_and_ends_with_a_lone_dot() {
    let fixture = start(Script::new(TlsMode::Implicit)).await;
    let mut message = sample();
    message.text = ".starts with a dot\n..two\nlast".to_owned();
    fixture.send(&message).await.expect("sent");
    let raw = fixture.seen.raw.lock().unwrap()[0].clone();
    assert!(find(&raw, b"\r\n\r\n..starts with a dot\r\n...two\r\nlast").is_some(), "{}", String::from_utf8_lossy(&raw));
    let stored = String::from_utf8(fixture.seen.bodies.lock().unwrap()[0].clone()).unwrap();
    assert!(stored.ends_with("\r\n\r\n.starts with a dot\r\n..two\r\nlast\r\n"), "{stored}");
}

#[tokio::test]
async fn a_non_ascii_sender_asks_for_smtputf8_when_the_server_offers_it() {
    let fixture = start(Script::new(TlsMode::Implicit).ehlo(&["SMTPUTF8"])).await;
    let mut message = sample();
    message.from = "\u{bd07}@example.com".to_owned();
    fixture.send(&message).await.expect("sent");
    assert!(fixture.log().await.iter().any(|line| line == "MAIL FROM:<\u{bd07}@example.com> SMTPUTF8"));
}

#[tokio::test]
async fn attachments_reach_the_server_as_a_multipart_message() {
    let fixture = start(Script::new(TlsMode::Implicit)).await;
    let mut message = sample();
    message.attachments =
        vec![Attachment { filename: "shot.png".to_owned(), content: vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10], content_type: "image/png".to_owned() }];
    fixture.send(&message).await.expect("sent");
    let body = String::from_utf8(fixture.seen.bodies.lock().unwrap()[0].clone()).unwrap();
    assert!(body.contains("Content-Type: multipart/mixed; boundary=\""), "{body}");
    assert!(body.contains("Content-Disposition: attachment; filename=shot.png\r\n\r\niVBORw0KGgo="), "{body}");
}

// ---- a silent server at each phase ----

#[tokio::test]
async fn a_silent_server_ends_every_phase_with_etimedout() {
    // (script, the message of the timeout)
    let cases: Vec<(&str, Script, &str)> = vec![
        ("greeting", Script::new(TlsMode::StartTls).step("greeting", Step::Silent), "Greeting never received"),
        ("ehlo", Script::new(TlsMode::StartTls).step("ehlo", Step::Silent), "Timeout"),
        ("starttls", Script::new(TlsMode::StartTls).step("starttls", Step::Silent), "Timeout"),
        ("tls handshake", Script::new(TlsMode::StartTls).step("tls", Step::Silent), "TLS handshake timed out"),
        ("ehlo2", Script::new(TlsMode::StartTls).step("ehlo2", Step::Silent), "Timeout"),
        ("auth", Script::new(TlsMode::StartTls).ehlo(&["AUTH PLAIN"]).step("auth", Step::Silent), "Timeout"),
        ("auth_user", Script::new(TlsMode::StartTls).ehlo(&["AUTH LOGIN"]).step("auth_user", Step::Silent), "Timeout"),
        ("mail", Script::new(TlsMode::StartTls).step("mail", Step::Silent), "Timeout"),
        ("rcpt", Script::new(TlsMode::StartTls).step("rcpt", Step::Silent), "Timeout"),
        ("data", Script::new(TlsMode::StartTls).step("data", Step::Silent), "Timeout"),
        ("body", Script::new(TlsMode::StartTls).step("body", Step::Silent), "Timeout"),
        ("implicit tls handshake", Script::new(TlsMode::Implicit).step("tls", Step::Silent), "Connection timeout"),
    ];
    for (name, script, message) in cases {
        let fixture = start(script).await;
        let mut config = fixture.config();
        config.timeout = Duration::from_millis(400);
        let error = fixture.send_with(&config, &sample()).await.expect_err(name);
        assert_eq!((error.code, error.message.as_str()), (MailCode::Timeout, message), "{name}");
        assert_eq!(error.code.as_str(), "ETIMEDOUT", "{name}");
    }
}

// ---- 4xx and 5xx at each step ----

/// (phase, reply, the code, the start of the message, the response code)
const REFUSALS: &[(&str, &str, MailCode, &str, u16)] = &[
    ("greeting", "554 5.3.2 no service here", MailCode::Protocol, "Invalid greeting", 554),
    ("greeting", "421 4.3.2 too busy", MailCode::Protocol, "Invalid greeting", 421),
    ("ehlo", "421 4.3.2 shutting down", MailCode::Connection, "Server terminates connection", 421),
    ("ehlo", "502 5.5.1 EHLO not implemented", MailCode::Connection, "EHLO failed but HELO does not support required STARTTLS", 502),
    ("starttls", "454 4.7.0 TLS not available", MailCode::Tls, "Error upgrading connection with STARTTLS", 454),
    ("ehlo2", "421 4.3.2 shutting down", MailCode::Connection, "Server terminates connection", 421),
    ("auth", "535 5.7.8 bad credentials", MailCode::Auth, "Invalid login", 535),
    ("auth", "454 4.7.0 temporary failure", MailCode::Auth, "Invalid login", 454),
    ("auth_user", "504 5.5.4 unrecognized mechanism", MailCode::Auth, "Invalid login", 504),
    ("mail", "550 5.1.8 bad sender", MailCode::Envelope, "Mail command failed", 550),
    ("mail", "452 4.3.1 insufficient storage", MailCode::Envelope, "Mail command failed", 452),
    ("rcpt", "550 5.1.1 no such user", MailCode::Envelope, "Can't send mail - all recipients were rejected", 550),
    ("rcpt", "450 4.2.1 mailbox busy", MailCode::Envelope, "Can't send mail - all recipients were rejected", 450),
    ("data", "554 5.5.1 no valid recipients", MailCode::Envelope, "Data command failed", 554),
    ("body", "554 5.7.1 message rejected", MailCode::Message, "Message failed", 554),
    ("body", "452 4.3.1 storage exceeded", MailCode::Message, "Message failed", 452),
];

#[tokio::test]
async fn a_refusal_at_each_step_has_its_own_error_code() {
    for pipelined in [false, true] {
        for &(phase, reply, code, message, response_code) in REFUSALS {
            // `auth_user` is only reached by the LOGIN method.
            let auth = if phase == "auth_user" { "AUTH LOGIN" } else { "AUTH PLAIN" };
            let mut script = Script::new(TlsMode::StartTls).ehlo(&[auth]).reply(phase, reply);
            if pipelined {
                // The batch server answers only after DATA, which is when a pipelining client has sent everything.
                script = script.ehlo(&["PIPELINING", auth]);
                script.batch = true;
            }
            let fixture = start(script).await;
            let error = failure(&fixture).await;
            let label = format!("{phase} {reply} (pipelined: {pipelined})");
            assert_eq!(error.code, code, "{label}: {error}");
            assert!(error.message.starts_with(message), "{label}: {}", error.message);
            assert_eq!(error.response_code, Some(response_code), "{label}");
        }
    }
}

#[tokio::test]
async fn a_recipient_listed_twice_is_sent_once() {
    let fixture = start(Script::new(TlsMode::Implicit)).await;
    let mut message = sample();
    message.to = "a@example.com, a@example.com, b@example.com".to_owned();
    fixture.send(&message).await.expect("sent");
    let rcpt: Vec<String> = fixture.log().await.into_iter().filter(|line| line.starts_with("RCPT")).collect();
    assert_eq!(rcpt, ["RCPT TO:<a@example.com>", "RCPT TO:<b@example.com>"]);
}

#[tokio::test]
async fn a_message_without_a_recipient_is_an_envelope_error_after_the_login() {
    let fixture = start(Script::new(TlsMode::Implicit).ehlo(&["AUTH PLAIN"])).await;
    let mut message = sample();
    message.to = "not an address".to_owned();
    let error = fixture.send(&message).await.expect_err("no recipient");
    assert_eq!(error.code, MailCode::Envelope);
    assert_eq!(error.message, "No recipients defined");
    assert!(fixture.seen.log.lock().unwrap().iter().any(|line| line.starts_with("AUTH")));
}

// ---- the connection itself ----

#[tokio::test]
async fn a_server_that_hangs_up_is_econnection() {
    for phase in ["greeting", "ehlo", "mail", "rcpt", "data"] {
        let fixture = start(Script::new(TlsMode::StartTls).step(phase, Step::Close)).await;
        let error = failure(&fixture).await;
        assert_eq!(error.code, MailCode::Connection, "{phase}: {error}");
        assert_eq!(error.code.as_str(), "ECONNECTION");
    }
}

#[tokio::test]
async fn a_port_with_no_server_is_esocket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let mut config = MailConfig::new("127.0.0.1", port, "bot@example.com", "s3cret");
    config.timeout = Duration::from_secs(5);
    let error = mail::send(&config, &sample()).await.expect_err("nothing listens");
    assert_eq!(error.code.as_str(), "ESOCKET", "{error}");
}

#[tokio::test]
async fn a_certificate_the_roots_do_not_vouch_for_is_esocket() {
    let fixture = start(Script::new(TlsMode::Implicit)).await;
    // `send` trusts the webpki roots only: the scripted server's own certificate is not among them.
    let error = mail::send(&fixture.config(), &sample()).await.expect_err("untrusted");
    assert_eq!(error.code.as_str(), "ESOCKET", "{error}");
    assert!(fixture.seen.log.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_name_that_does_not_resolve_is_edns() {
    let mut config = MailConfig::new("no-such-host.invalid", 587, "bot@example.com", "s3cret");
    config.timeout = Duration::from_secs(5);
    let error = mail::send(&config, &sample()).await.expect_err("no such host");
    assert_eq!(error.code.as_str(), "EDNS", "{error}");
}

#[tokio::test]
async fn the_password_is_not_in_the_debug_text_of_the_config_or_of_an_error() {
    let fixture = start(Script::new(TlsMode::StartTls).ehlo(&["AUTH PLAIN"]).reply("auth", "535 5.7.8 bad credentials")).await;
    let error = failure(&fixture).await;
    assert!(!format!("{:?} {error:?} {error}", fixture.config()).contains("s3cret"));
}

impl Fixture {
    fn config(&self) -> MailConfig {
        let mut config = MailConfig::new("localhost", self.addr.port(), "bot@example.com", "s3cret");
        config.secure = self.secure;
        config.timeout = Duration::from_secs(10);
        config
    }

    async fn send(&self, message: &Message) -> Result<(), MailError> {
        mail::send_trusting(&self.config(), message, &[self.root.clone()]).await
    }

    async fn send_with(&self, config: &MailConfig, message: &Message) -> Result<(), MailError> {
        mail::send_trusting(config, message, &[self.root.clone()]).await
    }

    /// The commands the server received, once the client's QUIT has arrived (bounded wait).
    async fn log(&self) -> Vec<String> {
        for _ in 0..60 {
            if self.seen.log.lock().unwrap().last().is_some_and(|last| last == "QUIT") {
                break;
            }
            mixdog_rt::time::sleep(Duration::from_millis(50)).await;
        }
        self.seen.log.lock().unwrap().clone()
    }
}
