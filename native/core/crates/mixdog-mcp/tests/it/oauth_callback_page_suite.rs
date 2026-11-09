//! The page a user's browser shows on the MCP connector sign-in's loopback callback, replayed against Node's:
//! `native/core/fixtures/oauth-callback-mcp/golden.json` records, from the real Node client (`createMcpOAuth`) signing in
//! to a loopback MCP + authorization server, the complete answer of its callback listener to every request of every case
//! (`benchmarks/rust-core/recorders/record-oauth-callback-mcp.mjs`). The same server and requests are replayed here
//! through the explicit sign-in flow and every answer must equal the recorded one.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginState;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::config::InlineSecret;
use mixdog_mcp::config::StaticClient;
use mixdog_mcp::oauth::AccountMode;
use mixdog_mcp::oauth::MemoryStore;
use mixdog_mcp::oauth::OAuthEnv;
use mixdog_mcp::oauth::callback::HELD_PAGE_DELAYING;
use mixdog_mcp::oauth::callback::HELD_PAGE_DELAY_MS;
use mixdog_mcp::result::OutputPolicy;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::Notify;

use super::oauth_suite::form;
use super::oauth_suite::read_request;
use super::oauth_suite::respond;

const GOLDEN: &str = include_str!("../../../../fixtures/oauth-callback-mcp/golden.json");

/// The MCP server that is also its authorization server, as the recorder's: the token endpoint answers by `token`.
struct Auth {
    token: String,
    exchanges: AtomicUsize,
    arrived: Notify,
    gate: Notify,
}

async fn serve(listener: TcpListener, auth: Arc<Auth>) {
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    loop {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (auth, base) = (Arc::clone(&auth), base.clone());
        tokio::spawn(async move {
            let (_, path, headers, body) = read_request(&mut stream).await;
            let path = path.split('?').next().unwrap().to_owned();
            let json_header = [("content-type", "application/json".to_owned())];
            if path.starts_with("/.well-known/oauth-protected-resource") {
                let doc = json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]});
                respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
            } else if path.starts_with("/.well-known/") {
                let doc = json!({
                    "issuer": base,
                    "authorization_endpoint": format!("{base}/authorize"),
                    "token_endpoint": format!("{base}/token"),
                    "registration_endpoint": format!("{base}/register"),
                    "code_challenge_methods_supported": ["S256"],
                });
                respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
            } else if path == "/register" {
                respond(&mut stream, "201 Created", &json_header, &json!({"client_id": "fixture-client"}).to_string()).await;
            } else if path == "/token" {
                assert_eq!(form(&body)["grant_type"], "authorization_code");
                auth.exchanges.fetch_add(1, Ordering::SeqCst);
                auth.arrived.notify_one();
                if auth.token == "gated" {
                    auth.gate.notified().await;
                }
                if auth.token == "refused" {
                    return respond(&mut stream, "400 Bad Request", &json_header, &json!({"error": "invalid_grant"}).to_string()).await;
                }
                let mut grant = json!({"access_token": "fixture-token", "refresh_token": "fixture-refresh", "token_type": "Bearer", "expires_in": 3600});
                if auth.token == "missing scope" {
                    grant["scope"] = json!("openid email");
                }
                respond(&mut stream, "200 OK", &json_header, &grant.to_string()).await;
            } else if path == "/mcp" {
                if headers.get("authorization").map(String::as_str) == Some("Bearer fixture-token") {
                    return respond(&mut stream, "405 Method Not Allowed", &[], "").await;
                }
                let hint = format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource\"");
                respond(&mut stream, "401 Unauthorized", &[("www-authenticate", hint)], "").await;
            } else {
                respond(&mut stream, "404 Not Found", &[], "").await;
            }
        });
    }
}

/// One raw request and everything the listener answers; `Err` when it does not accept.
async fn exchange(port: u16, request: &str) -> Result<Vec<u8>, std::io::ErrorKind> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|error| error.kind())?;
    stream.write_all(request.as_bytes()).await.map_err(|error| error.kind())?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.map_err(|error| error.kind())?;
    Ok(answer)
}

/// Compares an answer with a recorded one: the status line, the decoded body and every header but the
/// representation of the framing (`Content-Length` here, `Transfer-Encoding: chunked` in Node's), the header-name case
/// and order, and `Date`. This normalizes only equivalent HTTP representations, it is not a filter: no browser sees
/// them differ, and every other header name and value is compared exactly.
fn assert_answer(got: Result<Vec<u8>, std::io::ErrorKind>, recorded: &Value, context: &str) {
    if let Some(connection) = recorded.get("connection") {
        assert_eq!(connection, "ECONNREFUSED", "{context}");
        assert_eq!(got.err(), Some(std::io::ErrorKind::ConnectionRefused), "{context}: the listener is closed");
        return;
    }
    let bytes = got.unwrap_or_else(|kind| panic!("{context}: {kind:?}"));
    let split = bytes.windows(4).position(|window| window == b"\r\n\r\n").expect("a complete head");
    let head = String::from_utf8(bytes[..split].to_vec()).unwrap();
    let mut lines = head.split("\r\n");
    assert_eq!(lines.next().unwrap(), recorded["statusLine"].as_str().unwrap(), "{context}: status");
    let framing = ["date", "content-length", "transfer-encoding"];
    let mut headers: Vec<(String, String)> = lines
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_ascii_lowercase(), value.trim().to_owned())
        })
        .filter(|(name, _)| !framing.contains(&name.as_str()))
        .collect();
    headers.sort();
    let mut want: Vec<(String, String)> = recorded["headers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| (pair[0].as_str().unwrap().to_owned(), pair[1].as_str().unwrap().to_owned()))
        .filter(|(name, _)| !framing.contains(&name.as_str()))
        .collect();
    want.sort();
    assert_eq!(headers, want, "{context}: headers");
    assert_eq!(String::from_utf8(bytes[split + 4..].to_vec()).unwrap(), recorded["body"].as_str().unwrap(), "{context}: body");
}

struct Callback {
    host: String,
    port: u16,
    path: String,
    state: String,
}

impl Callback {
    fn request(&self, step: &Value) -> String {
        let fill = |text: &str| {
            text.replace("{path}", &self.path).replace("{state}", &self.state).replace("{port}", &self.port.to_string())
        };
        let host = step["hostHeader"].as_str().map_or_else(|| format!("{}:{}", self.host, self.port), fill);
        format!("{} {} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n", step["method"].as_str().unwrap(), fill(step["target"].as_str().unwrap()))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_mcp_callback_answers_as_nodes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let title = case["title"].as_str().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin_port = listener.local_addr().unwrap().port();
        let auth = Arc::new(Auth {
            token: case["token"].as_str().unwrap().to_owned(),
            exchanges: AtomicUsize::new(0),
            arrived: Notify::new(),
            gate: Notify::new(),
        });
        let server_task = tokio::spawn(serve(listener, Arc::clone(&auth)));

        let tokens = mixdog_rt::testing::tokens();
        let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io };
        let dir = tempfile::tempdir().unwrap();
        let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
        hub.set_oauth_env(OAuthEnv { store: Arc::new(MemoryStore::default()), plugin_data: dir.path().to_path_buf(), io: io.durability });
        let name = case["serverName"].as_str().unwrap();
        let mut config = McpServerConfig::from_entry(name, &json!({"url": format!("http://127.0.0.1:{origin_port}/mcp")}), &Default::default()).unwrap();
        if let Some(client) = case["client"].as_object() {
            config.oauth.as_mut().unwrap().client = Some(StaticClient {
                client_id: client["clientId"].as_str().unwrap().to_owned(),
                secret_account: "scoped-client-secret".to_owned(),
                inline_secret: Some(InlineSecret("secret".to_owned())),
                scopes: client["scopes"].as_array().unwrap().iter().map(|scope| scope.as_str().unwrap().to_owned()).collect(),
                auth_params: BTreeMap::new(),
            });
        }
        hub.apply(vec![config]);

        let session = hub.login_flow(name, AccountMode::Connect).unwrap().start().await.unwrap();
        let authorize = loop {
            match session.next().await.expect("an authorize state") {
                LoginState::Authorize { url, .. } => break url::Url::parse(&url).unwrap(),
                LoginState::Starting => {}
                other => panic!("{title}: unexpected {other:?}"),
            }
        };
        let query: std::collections::HashMap<String, String> = authorize.query_pairs().into_owned().collect();
        let redirect = url::Url::parse(&query["redirect_uri"]).unwrap();
        let callback = Arc::new(Callback {
            host: redirect.host_str().unwrap().to_owned(),
            port: redirect.port().unwrap(),
            path: redirect.path().to_owned(),
            state: query["state"].clone(),
        });

        let steps = case["steps"].as_array().unwrap();
        let phase = |name: &'static str| steps.iter().filter(move |step| step["phase"] == name);
        // A pasted callback: Node stops listening before it answers the callback.
        if case["paste"].as_bool().unwrap() {
            let pasted = format!("http://{}:{}{}?code=fixture-code&state={}", callback.host, callback.port, callback.path, callback.state);
            session.provide(LoginInput::AuthorizationCode(pasted)).await.unwrap();
        }
        // A slow flush of the held page, to land requests between the outcome and the close of the listener.
        let flushing = case["slowFlush"].as_u64().unwrap();
        if flushing > 0 {
            HELD_PAGE_DELAY_MS.store(flushing, Ordering::SeqCst);
        }
        let mut held = Vec::new();
        for step in phase("pre") {
            let (request, port) = (callback.request(step), callback.port);
            if step["hold"].as_bool().unwrap() {
                held.push((step, tokio::spawn(async move { exchange(port, &request).await })));
            } else {
                assert_answer(exchange(port, &request).await, &step["answer"], &format!("{title}: pre {} {}", step["method"], step["target"]));
            }
        }
        if flushing > 0 {
            HELD_PAGE_DELAYING.notified().await;
            for step in phase("flush") {
                assert_answer(exchange(callback.port, &callback.request(step)).await, &step["answer"], &format!("{title}: flush {} {}", step["method"], step["target"]));
            }
        }
        if phase("during").next().is_some() {
            auth.arrived.notified().await;
            for step in phase("during") {
                assert_answer(exchange(callback.port, &callback.request(step)).await, &step["answer"], &format!("{title}: during {} {}", step["method"], step["target"]));
            }
            auth.gate.notify_one();
        }
        let end = loop {
            match session.next().await {
                Some(state) if state.is_terminal() => break state,
                Some(_) => {}
                None => break session.state(),
            }
        };
        for (step, answered) in held {
            assert_answer(answered.await.unwrap(), &step["answer"], &format!("{title}: held {} {}", step["method"], step["target"]));
        }
        assert_eq!(matches!(end, LoginState::Done { .. }), case["signedIn"].as_bool().unwrap(), "{title}: Node signed in = {}, got {end:?}", case["signedIn"]);
        assert_eq!(auth.exchanges.load(Ordering::SeqCst) as u64, case["exchanges"].as_u64().unwrap(), "{title}: token requests");
        for step in phase("post") {
            assert_answer(exchange(callback.port, &callback.request(step)).await, &step["answer"], &format!("{title}: post {} {}", step["method"], step["target"]));
        }
        hub.close_all().await;
        server_task.abort();
    }
}