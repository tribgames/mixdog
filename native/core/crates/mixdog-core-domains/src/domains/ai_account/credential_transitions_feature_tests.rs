use std::collections::HashMap;
use std::sync::Arc;

use mixdog_ai::oauth::CredentialFile;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::PkceProvider;
use mixdog_ai::providers::devin::login::DevinLogin;
use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::ReqwestLink;
use mixdog_ai::transport::redirect::Redirected;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::net::TcpListener;
use tokio::net::TcpStream;

use super::collaborators::CustomProviders;
use super::custom_admin_tests::world;

const OK_CHAT: &str = "data: {\"id\":\"c1\",\"model\":\"m-a\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"OK\"},\"finish_reason\":null}],\"usage\":null}\n\ndata: {\"id\":\"c1\",\"model\":\"m-a\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\ndata: [DONE]\n\n";
const SIGN_IN_VERIFIER: &str = "sign-in-verifier-0c3e";
const GRANT: &str = "devin-sign-in-grant-41c7d09e";

/// The chat of a key in `refusing` is refused with a message quoting `quoted`; any other key's chat is served.
async fn server(refusing: &[&str], quoted: &[&str]) -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let refusing: Arc<Vec<String>> = Arc::new(refusing.iter().map(|k| format!("Bearer {k}")).collect());
    let message = format!("refused; the keys on file: {}", quoted.join(", "));
    tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::spawn(serve(socket, refusing.clone(), message.clone()));
        }
    });
    addr
}

async fn serve(mut socket: TcpStream, refusing: Arc<Vec<String>>, message: String) {
    let mut raw = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let head_end = loop {
            if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                break at + 4;
            }
            let n = socket.read(&mut buffer).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            raw.extend_from_slice(&buffer[..n]);
        };
        let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
        let header = |name: &str| head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_owned()));
        let length: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        while raw.len() < head_end + length {
            let n = socket.read(&mut buffer).await.unwrap();
            assert!(n > 0, "the request body ended early");
            raw.extend_from_slice(&buffer[..n]);
        }
        raw.drain(..head_end + length);
        let mut line = head.split_whitespace();
        let (method, path) = (line.next().unwrap().to_owned(), line.next().unwrap().to_owned());
        let bearer = header("authorization").unwrap_or_default();
        let (status, kind, body) = match (method.as_str(), path.as_str()) {
            ("HEAD", _) => {
                socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await.unwrap();
                continue;
            }
            ("GET", "/v1/models") => (200, "application/json", "{\"data\":[{\"id\":\"m-a\"}]}".to_owned()),
            ("POST", "/auth/cli/token") => (200, "application/json", json!({ "token": GRANT }).to_string()),
            ("POST", "/v1/chat/completions") if refusing.contains(&bearer) => {
                (400, "application/json", json!({ "error": { "message": message, "type": "invalid_request_error" } }).to_string())
            }
            ("POST", "/v1/chat/completions") => (200, "text/event-stream", OK_CHAT.to_owned()),
            other => panic!("a request the scripted endpoint does not know: {other:?}"),
        };
        let reason = if status == 200 { "OK" } else { "Bad Request" };
        let reply = format!(
            "HTTP/1.1 {status} {reason}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(reply.as_bytes()).await.unwrap();
        socket.flush().await.unwrap();
    }
}

/// An account whose key is read from `KEY` on every test, over the endpoint at `addr`.
async fn account(addr: std::net::SocketAddr) -> (super::custom_admin_tests::World, Value) {
    mixdog_ai::oauth::carried::reset_registry();
    // The warm-up gate does not lapse inside a test.
    let w = world(HashMap::from([("MIXDOG_LLM_KEEPALIVE_MS".to_owned(), "3600000".to_owned())])).await;
    let base = format!("http://{addr}/v1");
    let saved = w.admin.save(json!({ "name": "account a", "protocol": "openai-chat", "baseURL": base, "apiKeyEnv": "KEY" }), 0).await.unwrap();
    let settings = json!({ "schemaVersion": 2, "protocol": "openai-chat", "baseURL": base, "id": saved["id"], "name": "account a", "apiKeyEnv": "KEY" });
    (w, settings)
}

/// What the connection test shows for the key now in `KEY`: its answer, or its failure text.
async fn tested(w: &super::custom_admin_tests::World, settings: &Value, key: &str) -> Result<Value, String> {
    w.env.set("KEY", key);
    w.admin.test(settings.clone(), 0).await.map_err(|failure| failure.message().to_owned())
}

#[tokio::test]
async fn a_refusal_quoting_the_key_just_sent_shows_it_redacted() {
    let addr = server(&["account-a-credential-5f3c"], &["account-a-credential-5f3c"]).await;
    let (w, settings) = account(addr).await;
    assert_eq!(tested(&w, &settings, "account-a-credential-5f3c").await, Err("400 refused; the keys on file: [REDACTED]".to_owned()));
}

#[tokio::test]
async fn a_key_the_account_rotated_away_from_is_still_redacted_when_a_later_refusal_quotes_it() {
    let addr = server(&["rotated-credential-0002"], &["rotated-credential-0001", "rotated-credential-0002"]).await;
    let (w, settings) = account(addr).await;
    assert_eq!(tested(&w, &settings, "rotated-credential-0001").await, Ok(json!({ "ok": true })));
    assert_eq!(tested(&w, &settings, "rotated-credential-0002").await, Err("400 refused; the keys on file: [REDACTED], [REDACTED]".to_owned()));
}

#[tokio::test]
async fn a_string_no_request_carried_is_shown_as_the_upstream_quoted_it() {
    let addr = server(&["account-a-credential-5f3c"], &["account-a-credential-5f3c", "someone-elses-credential-9"]).await;
    let (w, settings) = account(addr).await;
    assert_eq!(
        tested(&w, &settings, "account-a-credential-5f3c").await,
        Err("400 refused; the keys on file: [REDACTED], someone-elses-credential-9".to_owned())
    );
}

#[tokio::test]
async fn a_sign_in_token_is_redacted_from_the_very_next_failure_before_any_request_carried_it() {
    let addr = server(&["account-e-credential-2f88"], &[GRANT]).await;
    let (w, settings) = account(addr).await;
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let path = dir.path().join("devin-oauth.json");
    let file = CredentialFile::new(path.clone(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
    let link = Redirected {
        inner: ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap(),
        addr,
        tap: Arc::new(|_, _| {}),
        returned: Arc::default(),
        fault_origin: Arc::default(),
        failed: Arc::new(|| {}),
    };
    // A fixed clock: the record expires a year after the sign-in.
    let login = DevinLogin::new(file, Arc::new(link)).with_clock(Arc::new(|| 1_800_000_000_000));
    login.exchange_checked("sign-in-code-5a1d", SIGN_IN_VERIFIER, "http://127.0.0.1:59653/callback").await.expect("the code exchange succeeds");
    let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(stored, json!({ "access_token": GRANT, "refresh_token": null, "expires_at": 1_831_536_000_000u64 }));
    assert_eq!(tested(&w, &settings, "account-e-credential-2f88").await, Err("400 refused; the keys on file: [REDACTED]".to_owned()));
}
