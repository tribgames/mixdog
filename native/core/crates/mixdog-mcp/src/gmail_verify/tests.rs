//! The check against fake IMAP and SMTP servers on loopback TLS. The expected command lines and
//! texts come from reading imapflow 2.5.7, nodemailer 10.1.7 and `gmail-app-password.mjs`, not
//! from this implementation's own output.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{RootCertStore, ServerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

use super::{GmailAppPassword, Target, Timeouts, describe};
use super::wire::Failure;

const EMAIL: &str = "user@gmail.com";
const SECRET: &str = "abcdwxyzabcdwxyz";
const ID_LINE: &str = "ID (\"name\" \"imapflow\" \"version\" \"2.5.7\" \"vendor\" \"Postal Systems\" \"support-url\" \"https://github.com/postalsys/imapflow/issues\")";

type Log = Arc<Mutex<Vec<String>>>;

struct Pki {
    acceptor: TlsAcceptor,
    roots: RootCertStore,
}

fn pki() -> Pki {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let issued = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()]).unwrap();
    let certificate = issued.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(issued.signing_key.serialize_der()));
    let config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone()], key)
        .unwrap();
    let mut roots = RootCertStore::empty();
    roots.add(certificate).unwrap();
    Pki { acceptor: TlsAcceptor::from(Arc::new(config)), roots }
}

/// A server-side line reader and writer, with the DEFLATE layer a server switches on after
/// `COMPRESS DEFLATE`.
struct Chan {
    io: TlsStream<TcpStream>,
    buffer: Vec<u8>,
    inflate: Option<Decompress>,
    deflate: Option<Compress>,
    log: Log,
}

impl Chan {
    async fn line(&mut self) -> Option<String> {
        loop {
            if let Some(at) = self.buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=at).collect();
                let line = String::from_utf8_lossy(&line).trim_end().to_owned();
                self.log.lock().unwrap().push(line.clone());
                return Some(line);
            }
            let mut chunk = [0u8; 4096];
            let read = self.io.read(&mut chunk).await.unwrap_or(0);
            if read == 0 {
                return None;
            }
            match self.inflate.as_mut() {
                None => self.buffer.extend_from_slice(&chunk[..read]),
                Some(inflate) => {
                    self.buffer.reserve(8192);
                    inflate.decompress_vec(&chunk[..read], &mut self.buffer, FlushDecompress::Sync).unwrap();
                }
            }
        }
    }

    async fn say(&mut self, text: &str) {
        let bytes = format!("{text}\r\n").into_bytes();
        let bytes = match self.deflate.as_mut() {
            None => bytes,
            Some(deflate) => {
                let mut out = Vec::with_capacity(bytes.len() + 64);
                deflate.compress_vec(&bytes, &mut out, FlushCompress::Sync).unwrap();
                out
            }
        };
        let _ = self.io.write_all(&bytes).await;
        let _ = self.io.flush().await;
    }
}

/// Listens on loopback; every accepted connection runs `handler` after the TLS handshake.
async fn serve<H, F>(pki: &Pki, log: &Log, handler: H) -> Target
where
    H: Fn(Chan) -> F + Send + Sync + 'static,
    F: Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let acceptor = pki.acceptor.clone();
    let log = log.clone();
    let handler = Arc::new(handler);
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (acceptor, handler, log) = (acceptor.clone(), handler.clone(), log.clone());
            tokio::spawn(async move {
                if let Ok(io) = acceptor.accept(tcp).await {
                    handler(Chan { io, buffer: Vec::new(), inflate: None, deflate: None, log }).await;
                }
            });
        }
    });
    Target::new("localhost", port)
}

#[derive(Clone)]
struct Imap {
    greeting: String,
    capabilities: String,
    /// What follows the tag on the answer to the login (`OK …` or `NO …`).
    login: String,
}

impl Imap {
    fn gmail() -> Self {
        Self {
            greeting: "* OK Gimap ready for requests from 203.0.113.9 abc".into(),
            capabilities: "IMAP4rev1 UNSELECT IDLE NAMESPACE QUOTA ID XLIST CHILDREN X-GM-EXT-1 UIDPLUS ENABLE MOVE CONDSTORE ESEARCH UTF8=ACCEPT LIST-EXTENDED LIST-STATUS LITERAL- SPECIAL-USE APPENDLIMIT=35651584".into(),
            login: "OK user@gmail.com authenticated (Success)".into(),
        }
    }

    async fn run(self, mut chan: Chan) {
        chan.say(&self.greeting).await;
        while let Some(line) = chan.line().await {
            let Some((tag, command)) = line.split_once(' ') else { continue };
            let word = command.split(' ').next().unwrap_or("").to_ascii_uppercase();
            match word.as_str() {
                "CAPABILITY" => {
                    chan.say(&format!("* CAPABILITY {}", self.capabilities)).await;
                    chan.say(&format!("{tag} OK Thats all she wrote!")).await;
                }
                "ID" => {
                    chan.say("* ID (\"name\" \"GImap\" \"vendor\" \"Google, Inc.\")").await;
                    chan.say(&format!("{tag} OK Success")).await;
                }
                "LOGIN" => chan.say(&format!("{tag} {}", self.login)).await,
                "AUTHENTICATE" => {
                    chan.say("+ ").await;
                    chan.line().await;
                    chan.say(&format!("{tag} {}", self.login)).await;
                }
                "NAMESPACE" => {
                    chan.say("* NAMESPACE ((\"\" \"/\")) NIL NIL").await;
                    chan.say(&format!("{tag} OK Success")).await;
                }
                "COMPRESS" => {
                    chan.say(&format!("{tag} OK DEFLATE active")).await;
                    chan.inflate = Some(Decompress::new(false));
                    chan.deflate = Some(Compress::new(Compression::default(), false));
                }
                "ENABLE" => {
                    chan.say("* ENABLED CONDSTORE UTF8=ACCEPT").await;
                    chan.say(&format!("{tag} OK Success")).await;
                }
                "LOGOUT" => {
                    chan.say("* BYE Logging out").await;
                    chan.say(&format!("{tag} OK Success")).await;
                    return;
                }
                _ => chan.say(&format!("{tag} BAD unknown command")).await,
            }
        }
    }
}

#[derive(Clone)]
struct Smtp {
    greeting: String,
    ehlo: Vec<String>,
    /// The reply to a finished login.
    auth: String,
}

impl Smtp {
    fn gmail() -> Self {
        Self {
            greeting: "220 smtp.gmail.com ESMTP abc - gsmtp".into(),
            ehlo: vec![
                "250-smtp.gmail.com at your service".into(),
                "250-SIZE 35882577".into(),
                "250-8BITMIME".into(),
                "250-AUTH LOGIN PLAIN XOAUTH2 PLAIN-CLIENTTOKEN OAUTHBEARER XOAUTH".into(),
                "250 SMTPUTF8".into(),
            ],
            auth: "235 2.7.0 Accepted".into(),
        }
    }

    async fn run(self, mut chan: Chan) {
        chan.say(&self.greeting).await;
        while let Some(line) = chan.line().await {
            if line.starts_with("EHLO ") {
                for reply in &self.ehlo {
                    chan.say(reply).await;
                }
            } else if line == "AUTH LOGIN" {
                chan.say("334 VXNlcm5hbWU6").await;
                chan.line().await;
                chan.say("334 UGFzc3dvcmQ6").await;
                chan.line().await;
                chan.say(&self.auth).await;
            } else if line.starts_with("AUTH PLAIN ") {
                chan.say(&self.auth).await;
            } else if line == "QUIT" {
                chan.say("221 2.0.0 closing connection").await;
                return;
            } else {
                chan.say("500 5.5.1 unrecognized").await;
            }
        }
    }
}

struct Rig {
    imap_log: Log,
    smtp_log: Log,
    verifier: GmailAppPassword,
}

async fn rig(imap: Imap, smtp: Smtp, timeouts: Timeouts) -> Rig {
    let pki = pki();
    let (imap_log, smtp_log): (Log, Log) = Default::default();
    let imap_target = serve(&pki, &imap_log, move |chan| imap.clone().run(chan)).await;
    let smtp_target = serve(&pki, &smtp_log, move |chan| smtp.clone().run(chan)).await;
    let verifier = GmailAppPassword::with_servers(imap_target, smtp_target, pki.roots, timeouts).with_hello_name("test.example");
    Rig { imap_log, smtp_log, verifier }
}

fn quick() -> Timeouts {
    Timeouts { connection: Duration::from_secs(5), greeting: Duration::from_secs(5), socket: Duration::from_secs(5) }
}

fn lines(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

/// The server sees QUIT after the check has already returned.
async fn until(log: &Log, line: &str) {
    while !lines(log).iter().any(|l| l == line) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn texts(code: &str) -> String {
    match code {
        "REJECTED" => "GMAIL_APP_PASSWORD_REJECTED: Google did not accept this address and app password.".into(),
        "UNAVAILABLE" => "GMAIL_APP_PASSWORD_UNAVAILABLE: Google refused app-password access for this account: app passwords need 2-Step Verification, and a Workspace admin can block them or IMAP.".into(),
        "NETWORK" => "GMAIL_APP_PASSWORD_NETWORK: Couldn't reach Gmail. Check the network connection.".into(),
        other => panic!("{other}"),
    }
}

#[tokio::test]
async fn an_accepted_password_runs_imapflows_and_nodemailers_commands_in_order() {
    let rig = rig(Imap::gmail(), Smtp::gmail(), quick()).await;
    rig.verifier.check(EMAIL, SECRET).await.unwrap();
    until(&rig.smtp_log, "QUIT").await;
    until(&rig.imap_log, "7 LOGOUT").await;
    assert_eq!(
        lines(&rig.imap_log),
        [
            "1 CAPABILITY".to_owned(),
            format!("2 {ID_LINE}"),
            format!("3 LOGIN \"{EMAIL}\" \"{SECRET}\""),
            "4 CAPABILITY".to_owned(),
            "5 NAMESPACE".to_owned(),
            "6 ENABLE CONDSTORE UTF8=ACCEPT".to_owned(),
            "7 LOGOUT".to_owned(),
        ]
    );
    let plain = STANDARD.encode(format!("\0{EMAIL}\0{SECRET}"));
    assert_eq!(lines(&rig.smtp_log), ["EHLO test.example".to_owned(), format!("AUTH PLAIN {plain}"), "QUIT".to_owned()]);
}

#[tokio::test]
async fn a_refused_login_is_the_rejected_sentence_and_smtp_is_never_tried() {
    let mut imap = Imap::gmail();
    imap.login = "NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)".into();
    let rig = rig(imap, Smtp::gmail(), quick()).await;
    assert_eq!(rig.verifier.check(EMAIL, SECRET).await.unwrap_err(), texts("REJECTED"));
    assert!(lines(&rig.smtp_log).is_empty());
}

#[tokio::test]
async fn an_app_password_requirement_is_the_unavailable_sentence() {
    let mut imap = Imap::gmail();
    imap.login = "NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)".into();
    let rig = rig(imap, Smtp::gmail(), quick()).await;
    assert_eq!(rig.verifier.check(EMAIL, SECRET).await.unwrap_err(), texts("UNAVAILABLE"));
}

#[tokio::test]
async fn smtp_535_is_rejected_and_534_is_unavailable() {
    let mut smtp = Smtp::gmail();
    smtp.auth = "535-5.7.8 Username and Password not accepted. For more information, go to\n535 5.7.8  https://support.google.com/mail/?p=BadCredentials abc - gsmtp".into();
    let rig = rig(Imap::gmail(), smtp, quick()).await;
    assert_eq!(rig.verifier.check(EMAIL, SECRET).await.unwrap_err(), texts("REJECTED"));

    let mut smtp = Smtp::gmail();
    smtp.auth = "534 5.7.9 Application-specific password required.".into();
    let rig = self::rig(Imap::gmail(), smtp, quick()).await;
    assert_eq!(rig.verifier.check(EMAIL, SECRET).await.unwrap_err(), texts("UNAVAILABLE"));
}

#[tokio::test]
async fn a_server_offering_only_login_gets_auth_login() {
    let mut smtp = Smtp::gmail();
    smtp.ehlo = vec!["250-smtp.gmail.com at your service".into(), "250 AUTH LOGIN".into()];
    let rig = rig(Imap::gmail(), smtp, quick()).await;
    rig.verifier.check(EMAIL, SECRET).await.unwrap();
    until(&rig.smtp_log, "QUIT").await;
    assert_eq!(
        lines(&rig.smtp_log),
        [
            "EHLO test.example".to_owned(),
            "AUTH LOGIN".to_owned(),
            STANDARD.encode(EMAIL),
            STANDARD.encode(SECRET),
            "QUIT".to_owned(),
        ]
    );
}

#[tokio::test]
async fn a_server_that_advertises_no_auth_passes_without_a_login() {
    let mut smtp = Smtp::gmail();
    smtp.ehlo = vec!["250-smtp.gmail.com at your service".into(), "250 8BITMIME".into()];
    let rig = rig(Imap::gmail(), smtp, quick()).await;
    rig.verifier.check(EMAIL, SECRET).await.unwrap();
    until(&rig.smtp_log, "QUIT").await;
    assert_eq!(lines(&rig.smtp_log), ["EHLO test.example".to_owned(), "QUIT".to_owned()]);
}

#[tokio::test]
async fn advertised_plain_authenticates_with_authenticate_plain() {
    let mut imap = Imap::gmail();
    imap.capabilities.push_str(" AUTH=PLAIN");
    let rig = rig(imap, Smtp::gmail(), quick()).await;
    rig.verifier.check(EMAIL, SECRET).await.unwrap();
    until(&rig.imap_log, "7 LOGOUT").await;
    let plain = STANDARD.encode(format!("\0{EMAIL}\0{SECRET}"));
    let seen = lines(&rig.imap_log);
    assert_eq!(seen[2], "3 AUTHENTICATE PLAIN");
    assert_eq!(seen[3], plain);
}

#[tokio::test]
async fn compression_is_negotiated_and_the_rest_of_the_session_is_deflated() {
    let mut imap = Imap::gmail();
    imap.capabilities.push_str(" COMPRESS=DEFLATE");
    let rig = rig(imap, Smtp::gmail(), quick()).await;
    rig.verifier.check(EMAIL, SECRET).await.unwrap();
    until(&rig.imap_log, "8 LOGOUT").await;
    let seen = lines(&rig.imap_log);
    assert_eq!(&seen[4..], ["5 NAMESPACE", "6 COMPRESS DEFLATE", "7 ENABLE CONDSTORE UTF8=ACCEPT", "8 LOGOUT"]);
}

#[tokio::test]
async fn an_unreachable_server_is_the_network_sentence() {
    let pki = pki();
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    };
    let verifier = GmailAppPassword::with_servers(Target::new("localhost", closed), Target::new("localhost", closed), pki.roots, quick());
    assert_eq!(verifier.check(EMAIL, SECRET).await.unwrap_err(), texts("NETWORK"));
}

#[tokio::test]
async fn a_silent_server_hits_the_greeting_timeout_as_the_network_sentence() {
    let pki = pki();
    let log = Log::default();
    let silent = serve(&pki, &log, |mut chan: Chan| async move {
        chan.line().await;
    })
    .await;
    let timeouts = Timeouts { greeting: Duration::from_millis(150), ..quick() };
    let verifier = GmailAppPassword::with_servers(silent.clone(), silent, pki.roots, timeouts);
    assert_eq!(verifier.check(EMAIL, SECRET).await.unwrap_err(), texts("NETWORK"));
}

#[tokio::test]
async fn a_bye_greeting_and_an_idle_session_are_failed_with_nodes_details() {
    let mut imap = Imap::gmail();
    imap.greeting = "* BYE Too many connections".into();
    let rig = rig(imap, Smtp::gmail(), quick()).await;
    assert_eq!(
        rig.verifier.check(EMAIL, SECRET).await.unwrap_err(),
        "GMAIL_APP_PASSWORD_FAILED: Gmail refused the request. (Unexpected close)"
    );

    // Greeting, then nothing: the socket timeout fires while the session is being set up.
    let pki = pki();
    let log = Log::default();
    let stalled = serve(&pki, &log, |mut chan: Chan| async move {
        chan.say("* OK ready").await;
        chan.line().await;
        tokio::time::sleep(Duration::from_secs(5)).await;
    })
    .await;
    let timeouts = Timeouts { socket: Duration::from_millis(200), ..quick() };
    let verifier = GmailAppPassword::with_servers(stalled.clone(), stalled, pki.roots, timeouts);
    assert_eq!(verifier.check(EMAIL, SECRET).await.unwrap_err(), "GMAIL_APP_PASSWORD_FAILED: Gmail refused the request. (Socket timeout)");
}

#[tokio::test]
async fn an_unexpected_smtp_greeting_is_failed_and_the_password_is_redacted() {
    let mut smtp = Smtp::gmail();
    smtp.greeting = format!("554 no service for {SECRET}");
    let rig = rig(Imap::gmail(), smtp, quick()).await;
    let text = rig.verifier.check(EMAIL, SECRET).await.unwrap_err();
    assert!(!text.contains(SECRET));
    let reply = "554 no service for [redacted]";
    assert_eq!(text, format!("GMAIL_APP_PASSWORD_FAILED: Gmail refused the request. ({reply} Invalid greeting. response={reply}: {reply})"));
}

#[test]
fn the_classifier_follows_the_node_order_and_clips_the_detail() {
    let mut failure = Failure::new("EAUTH", "Invalid login");
    assert_eq!(describe(&failure, "pw"), texts("REJECTED"));
    failure.response_code = Some(534);
    assert_eq!(describe(&failure, "pw"), texts("UNAVAILABLE"));

    assert_eq!(describe(&Failure::new("ECONNREFUSED", "connect ECONNREFUSED"), "pw"), texts("NETWORK"));

    let long = Failure::new("EPROTOCOL", format!("{}  \n x", "a".repeat(250)));
    let clipped = describe(&long, "pw");
    assert_eq!(clipped, format!("GMAIL_APP_PASSWORD_FAILED: Gmail refused the request. ({}…)", "a".repeat(200)));

    let spaced = Failure::new("", " two\t\n words ");
    assert_eq!(describe(&spaced, "pw"), "GMAIL_APP_PASSWORD_FAILED: Gmail refused the request. (two words)");
    assert_eq!(describe(&Failure::new("", ""), "pw"), "GMAIL_APP_PASSWORD_FAILED: Gmail refused the request.");
}
