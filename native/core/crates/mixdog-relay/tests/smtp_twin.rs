//! The twin of the SMTP client: the same messages go through nodemailer (`tests/twin/node/smtp-capture.mjs`, the
//! transport options of `lib/feedback.mjs`) and through `mixdog_relay::mail` to one fake server over STARTTLS, with
//! and without PIPELINING, and what the server saw is compared: the SMTP commands, every header except `Date` and the
//! boundary base, the decoded body and the decoded attachment names and bytes. The wire bytes themselves are compared
//! too, after the date and the boundary base are replaced.
//!
//! The Node half needs `nodemailer` installed (`apps/relay/node_modules` or the tree's `node_modules`); without it the
//! script exits with its message on stderr, prints no result and the test fails saying how to run it by hand. Implicit TLS (port 465) is not run here: both halves
//! would need that port, and `tests/smtp.rs` covers it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_relay::mail::{self, Attachment, MailConfig, Message};
use regex::Regex;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

// ---- the capture server ----

trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

/// What one connection sent: the command lines and the message as it came over the wire.
struct Capture {
    commands: Vec<String>,
    data: Vec<u8>,
}

struct Conn {
    io: Box<dyn Duplex>,
    buf: Vec<u8>,
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|window| window == needle)
}

impl Conn {
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

    async fn say(&mut self, text: &str) {
        let wire = text.split('\n').map(|line| format!("{line}\r\n")).collect::<String>();
        let _ = self.io.write_all(wire.as_bytes()).await;
        let _ = self.io.flush().await;
    }

    /// The message up to, and without, the terminator line, as a server stores it (a doubled leading dot is one dot).
    async fn body(&mut self) -> Option<Vec<u8>> {
        loop {
            if let Some(at) = find(&self.buf, b"\r\n.\r\n") {
                let raw: Vec<u8> = self.buf.drain(..at + 5).collect();
                let text = String::from_utf8_lossy(&raw[..at + 2]).into_owned();
                let lines: Vec<&str> = text.split("\r\n").map(|line| line.strip_prefix('.').filter(|rest| rest.starts_with('.')).unwrap_or(line)).collect();
                return Some(lines.join("\r\n").into_bytes());
            }
            if !self.fill().await {
                return None;
            }
        }
    }
}

async fn serve(tcp: TcpStream, acceptor: TlsAcceptor, pipelining: bool, captures: Arc<Mutex<Vec<Capture>>>) {
    let mut conn = Conn { io: Box::new(tcp), buf: Vec::new() };
    let mut secured = false;
    let (mut commands, mut data) = (Vec::new(), Vec::new());
    conn.say("220 twin.test ESMTP ready").await;
    while let Some(line) = conn.line().await {
        commands.push(line.clone());
        match line.to_ascii_uppercase().split(' ').next().unwrap_or("") {
            "EHLO" => {
                let mut lines = vec!["twin.test greets you"];
                if !secured {
                    lines.push("STARTTLS");
                }
                if pipelining {
                    lines.push("PIPELINING");
                }
                lines.extend(["8BITMIME", "AUTH PLAIN LOGIN"]);
                let last = lines.len() - 1;
                let text = lines.iter().enumerate().map(|(i, l)| format!("250{}{l}", if i == last { ' ' } else { '-' })).collect::<Vec<_>>().join("\n");
                conn.say(&text).await;
            }
            "STARTTLS" => {
                conn.say("220 2.0.0 Ready to start TLS").await;
                match acceptor.accept(conn.io).await {
                    Ok(stream) => conn = Conn { io: Box::new(stream), buf: Vec::new() },
                    Err(_) => return,
                }
                secured = true;
            }
            "AUTH" => conn.say("235 2.7.0 Authentication successful").await,
            "MAIL" | "RCPT" => conn.say("250 2.1.0 Ok").await,
            "DATA" => {
                conn.say("354 End data with <CR><LF>.<CR><LF>").await;
                let Some(body) = conn.body().await else { break };
                data = body;
                conn.say("250 2.0.0 Ok: queued as 4D1F").await;
            }
            "QUIT" => {
                conn.say("221 2.0.0 Bye").await;
                break;
            }
            _ => conn.say("500 5.5.2 command not recognized").await,
        }
    }
    captures.lock().unwrap().push(Capture { commands, data });
}

struct Pki {
    acceptor: TlsAcceptor,
    root: Vec<u8>,
    pem: String,
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
    Pki { acceptor: TlsAcceptor::from(Arc::new(config)), root: certificate.to_vec(), pem: issued.cert.pem() }
}

struct Server {
    port: u16,
    captures: Arc<Mutex<Vec<Capture>>>,
    root: Vec<u8>,
    pem: String,
}

async fn start(pipelining: bool) -> Server {
    let Pki { acceptor, root, pem } = pki();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let captures: Arc<Mutex<Vec<Capture>>> = Arc::default();
    let shared = captures.clone();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            tokio::spawn(serve(tcp, acceptor.clone(), pipelining, shared.clone()));
        }
    });
    Server { port, captures, root, pem }
}

impl Server {
    /// The captures once `count` connections have finished (bounded wait).
    async fn captured(&self, count: usize) -> Vec<(Vec<String>, Vec<u8>)> {
        for _ in 0..100 {
            if self.captures.lock().unwrap().len() >= count {
                break;
            }
            mixdog_rt::time::sleep(Duration::from_millis(50)).await;
        }
        let captures = self.captures.lock().unwrap();
        assert!(captures.len() >= count, "{} of {count} connections finished", captures.len());
        captures.iter().map(|c| (c.commands.clone(), c.data.clone())).collect()
    }
}

// ---- the two senders ----

const USER: &str = "feedback@example.com";
const PASS: &str = "s3cret-pass";

async fn rust_send(server: &Server, message: &Message) {
    let mut config = MailConfig::new("localhost", server.port, USER, PASS);
    config.timeout = Duration::from_secs(15);
    mail::send_trusting(&config, message, &[server.root.clone()]).await.expect("the Rust client sends");
}

fn node_mail(message: &Message) -> Value {
    let attachments: Vec<Value> = message
        .attachments
        .iter()
        .map(|a| json!({ "filename": a.filename, "contentBase64": STANDARD.encode(&a.content), "contentType": a.content_type, "contentDisposition": "attachment" }))
        .collect();
    let mut mail = json!({
        "from": message.from,
        "to": message.to,
        "subject": message.subject,
        "text": message.text,
        "messageId": message.message_id,
    });
    if let Some(reply_to) = &message.reply_to {
        mail["replyTo"] = json!(reply_to);
    }
    if !attachments.is_empty() {
        mail["attachments"] = json!(attachments);
    }
    mail
}

async fn node_send(server: &Server, message: &Message) {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/twin/node/smtp-capture.mjs");
    let request = json!({ "host": "localhost", "port": server.port, "user": USER, "pass": PASS, "timeoutMs": 15000, "ca": server.pem, "mail": node_mail(message) });
    let request = request.to_string();
    // The test runs on two worker threads: this one waits for node while the other serves its connection.
    let stdout = mixdog_testkit::output("node", &[script.as_os_str(), std::ffi::OsStr::new(&request)]);
    let outcome: Value = serde_json::from_str(stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("null"))
        .unwrap_or_else(|_| panic!("smtp-capture.mjs printed no result (run it by hand: node {} '<request>'); stdout: {stdout:?}", script.display()));
    assert_eq!(outcome["ok"], json!(true), "nodemailer sends: {outcome}");
}

// ---- reading what the server received ----

/// The wire bytes as text (one char per byte), with the date and the boundary base replaced.
fn normalize(data: &[u8]) -> String {
    let text: String = data.iter().map(|&b| b as char).collect();
    let text = Regex::new(r"(?m)^Date: [^\r\n]*").unwrap().replace_all(&text, "Date: X").into_owned();
    Regex::new(r"_NmP-[0-9a-f]{16}").unwrap().replace_all(&text, "_NmP-BASE").into_owned()
}

struct Part {
    headers: Vec<(String, String)>,
    content: Vec<u8>,
}

impl Part {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// Splits headers (unfolded) from the body, which is decoded by its transfer encoding.
fn parse_part(text: &str) -> Part {
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text, ""));
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in head.split("\r\n") {
        if line.starts_with([' ', '\t']) {
            if let Some(last) = headers.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
        } else if let Some((name, value)) = line.split_once(':') {
            headers.push((name.to_owned(), value.trim().to_owned()));
        }
    }
    let encoding = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("Content-Transfer-Encoding")).map(|(_, v)| v.to_ascii_lowercase()).unwrap_or_default();
    let content = match encoding.as_str() {
        "base64" => STANDARD.decode(body.split_whitespace().collect::<String>()).expect("base64 body"),
        "quoted-printable" => decode_quoted_printable(body),
        _ => body.chars().map(|c| c as u8).collect(),
    };
    Part { headers, content }
}

fn decode_quoted_printable(body: &str) -> Vec<u8> {
    let bytes: Vec<u8> = body.chars().map(|c| c as u8).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'=' && bytes.get(i + 1..i + 3) == Some(b"\r\n".as_slice()) {
            i += 3;
        } else if bytes[i] == b'=' && i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit() {
            out.push(u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap(), 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// RFC 2047 encoded words (`=?UTF-8?B?…?=`, `=?UTF-8?Q?…?=`) in a header value.
fn decode_words(value: &str) -> String {
    let joined = Regex::new(r"\?=\s+=\?").unwrap().replace_all(value, "?==?").into_owned();
    Regex::new(r"=\?UTF-8\?([BQ])\?([^?]*)\?=")
        .unwrap()
        .replace_all(&joined, |caps: &regex::Captures| {
            let bytes = if &caps[1] == "B" { STANDARD.decode(&caps[2]).unwrap() } else { decode_quoted_printable(&caps[2].replace('_', " ")) };
            String::from_utf8(bytes).unwrap()
        })
        .into_owned()
}

fn percent_decode(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// The attachment name of a part: the RFC 2231 `filename*N*` sections of Content-Disposition, or `filename=`.
fn disposition_name(part: &Part) -> String {
    let value = part.header("Content-Disposition").expect("an attachment has a disposition");
    let mut sections: Vec<(usize, bool, String)> = Vec::new();
    let mut plain = None;
    for param in value.split(';').skip(1) {
        let Some((key, raw)) = param.trim().split_once('=') else { continue };
        let raw = raw.trim().trim_matches('"').to_owned();
        if key == "filename" {
            plain = Some(raw);
        } else if let Some(rest) = key.strip_prefix("filename*") {
            let (index, encoded) = match rest.strip_suffix('*') {
                Some(index) => (index, true),
                None => (rest, false),
            };
            sections.push((index.parse().unwrap_or(0), encoded, raw));
        }
    }
    if sections.is_empty() {
        return plain.expect("a filename");
    }
    sections.sort_by_key(|(index, _, _)| *index);
    let mut bytes = Vec::new();
    for (position, (_, encoded, raw)) in sections.iter().enumerate() {
        let raw = if position == 0 { raw.strip_prefix("utf-8''").unwrap_or(raw) } else { raw };
        if *encoded { bytes.extend(percent_decode(raw)) } else { bytes.extend_from_slice(raw.as_bytes()) }
    }
    String::from_utf8(bytes).unwrap()
}

/// The `name=` parameter of Content-Type: a quoted or bare value, or a MIME word.
fn type_name(part: &Part) -> String {
    let value = part.header("Content-Type").expect("a content type");
    let raw = value.split(';').skip(1).find_map(|p| p.trim().strip_prefix("name=")).expect("a name parameter");
    decode_words(raw.trim_matches('"'))
}

struct Parsed {
    /// Every header of the message but Date, with the boundary base replaced.
    headers: Vec<(String, String)>,
    text: String,
    attachments: Vec<(String, String, Vec<u8>)>,
}

fn parse_message(data: &[u8]) -> Parsed {
    let wire = normalize(data);
    let root = parse_part(&wire);
    let headers: Vec<(String, String)> = root.headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("Date")).cloned().collect();
    let content_type = root.header("Content-Type").expect("a content type").to_owned();
    if !content_type.starts_with("multipart/mixed") {
        return Parsed { headers, text: String::from_utf8(root.content).unwrap(), attachments: Vec::new() };
    }
    let boundary = Regex::new(r#"boundary="([^"]+)""#).unwrap().captures(&content_type).expect("a boundary")[1].to_owned();
    let body = wire.split_once("\r\n\r\n").unwrap().1;
    let delimiter = format!("--{boundary}");
    let mut text = String::new();
    let mut attachments = Vec::new();
    for raw in body.split(delimiter.as_str()).skip(1) {
        let raw = raw.strip_prefix("\r\n").unwrap_or(raw);
        if raw.starts_with("--") {
            break;
        }
        let part = parse_part(raw.strip_suffix("\r\n").unwrap_or(raw));
        if part.header("Content-Disposition").is_some() {
            let (disposition, named) = (disposition_name(&part), type_name(&part));
            assert_eq!(disposition, named, "both name parameters decode to the same name");
            attachments.push((disposition, part.header("Content-Type").unwrap().split(';').next().unwrap().to_owned(), part.content));
        } else {
            text = String::from_utf8(part.content).unwrap();
        }
    }
    Parsed { headers, text, attachments }
}

// ---- the cases ----

fn base() -> Message {
    Message {
        from: USER.to_owned(),
        to: "support@mixdog.ai".to_owned(),
        reply_to: None,
        subject: "[Mixdog feedback] bug 7c1d4e2a-0000-4000-8000-000000000001".to_owned(),
        text: "hello world".to_owned(),
        attachments: Vec::new(),
        message_id: Some("<7c1d4e2a-0000-4000-8000-000000000001@feedback.mixdog>".to_owned()),
    }
}

fn png(seed: u8) -> Vec<u8> {
    let mut bytes = vec![0x89, b'P', b'N', b'G', 13, 10, 26, 10];
    bytes.extend((0..300u32).map(|i| (i as u8).wrapping_mul(seed).wrapping_add(i as u8)));
    bytes
}

fn cases() -> Vec<(&'static str, Message)> {
    vec![
        ("ascii", base()),
        ("korean with reply-to", Message { reply_to: Some("user@example.org".to_owned()), subject: "[Mixdog feedback] bug \u{d55c}\u{ae00}".to_owned(), text: "\u{c548}\u{b155}\u{d558}\u{c138}\u{c694} \u{d53c}\u{b4dc}\u{bc31}\u{c785}\u{b2c8}\u{b2e4}\n\u{b450}\u{bc88}\u{c9f8} \u{c904}".to_owned(), ..base() }),
        ("long lines and dots", Message { text: format!(".starts with a dot\n{}\nlast line \u{e9}", "word ".repeat(40)), ..base() }),
        (
            "three attachments",
            Message {
                reply_to: Some("Jane Q <jane@example.org>".to_owned()),
                text: "see the screenshots \u{c2a4}\u{d06c}\u{b9b0}\u{c0f7}".to_owned(),
                attachments: vec![
                    Attachment { filename: "shot.png".to_owned(), content: png(3), content_type: "image/png".to_owned() },
                    Attachment { filename: "\u{c2a4}\u{d06c}\u{b9b0}\u{c0f7} 1.png".to_owned(), content: png(5), content_type: "image/png".to_owned() },
                    Attachment {
                        filename: "a very long file name with spaces and (parens) that exceeds the usual line length limit .jpg".to_owned(),
                        content: png(7),
                        content_type: "image/jpeg".to_owned(),
                    },
                ],
                ..base()
            },
        ),
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_messages_through_nodemailer_and_the_rust_client_look_alike_to_the_server() {
    for pipelining in [false, true] {
        for (name, message) in cases() {
            let label = format!("{name} (pipelining: {pipelining})");
            let server = start(pipelining).await;
            rust_send(&server, &message).await;
            server.captured(1).await;
            node_send(&server, &message).await;
            let captured = server.captured(2).await;
            let ((rust_commands, rust_data), (node_commands, node_data)) = (captured[0].clone(), captured[1].clone());

            // The commands: nodemailer closes the socket after the message where the client says QUIT.
            let mut rust_commands = rust_commands;
            assert_eq!(rust_commands.pop().as_deref(), Some("QUIT"), "{label}");
            assert_eq!(rust_commands, node_commands, "{label}: the SMTP commands");
            assert_eq!(rust_commands[3], format!("AUTH PLAIN {}", STANDARD.encode(format!("\0{USER}\0{PASS}"))), "{label}");

            // The messages: the wire bytes, then what a reader decodes from them.
            assert_eq!(normalize(&rust_data), normalize(&node_data), "{label}: the message bytes");
            let (rust, node) = (parse_message(&rust_data), parse_message(&node_data));
            assert_eq!(rust.headers, node.headers, "{label}: the headers");
            for parsed in [&rust, &node] {
                // Line ends of the text become CRLF in 7bit and quoted-printable bodies and stay as they are inside base64.
                assert_eq!(parsed.text.replace("\r\n", "\n"), message.text, "{label}: the body");
                let sent: Vec<(String, String, Vec<u8>)> = message.attachments.iter().map(|a| (a.filename.clone(), a.content_type.clone(), a.content.clone())).collect();
                assert_eq!(parsed.attachments, sent, "{label}: the attachments");
                let subject = decode_words(&parsed.headers.iter().find(|(k, _)| k == "Subject").unwrap().1);
                assert_eq!(subject, message.subject, "{label}: the subject");
            }
        }
    }
}
