//! MCP OAuth end to end against a loopback server that is both the MCP server and its
//! authorization server: discovery from the 401 challenge, dynamic registration, the browser
//! login through a LoginFlow (loopback callback), the connect that follows, a refused token
//! renewed from its refresh token, and sign-out.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::oauth::AccountMode;
use mixdog_mcp::oauth::MemoryStore;
use mixdog_mcp::oauth::OAuthEnv;
use mixdog_mcp::oauth::SecretStore;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::server::ServerState;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Default)]
struct Auth {
    challenge: Option<String>,
    /// The access token the MCP endpoint accepts.
    valid: String,
    grants: Vec<String>,
    registrations: usize,
}

type Shared = Arc<Mutex<Auth>>;

async fn read_request(stream: &mut TcpStream) -> (String, String, HashMap<String, String>, String) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let n = stream.read(&mut chunk).await.unwrap();
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        assert!(n > 0);
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap().split(' ');
    let (method, path) = (first.next().unwrap().to_owned(), first.next().unwrap().to_owned());
    let headers: HashMap<String, String> =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned())).collect();
    let length: usize = headers.get("content-length").map_or(0, |v| v.parse().unwrap());
    while buf.len() < header_end + length {
        let n = stream.read(&mut chunk).await.unwrap();
        buf.extend_from_slice(&chunk[..n]);
    }
    (method, path, headers, String::from_utf8_lossy(&buf[header_end..header_end + length]).into_owned())
}

async fn respond(stream: &mut TcpStream, status: &str, headers: &[(&str, String)], body: &str) {
    let mut out = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n", body.len());
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(body);
    stream.write_all(out.as_bytes()).await.unwrap();
}

fn form(body: &str) -> HashMap<String, String> {
    url::form_urlencoded::parse(body.as_bytes()).into_owned().collect()
}

async fn serve(listener: TcpListener, shared: Shared) {
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    loop {
        let (mut stream, _) = listener.accept().await.unwrap();
        let (shared, base) = (Arc::clone(&shared), base.clone());
        tokio::spawn(async move {
            let (method, path, headers, body) = read_request(&mut stream).await;
            let json_header = [("content-type", "application/json".to_owned())];
            match (method.as_str(), path.as_str()) {
                ("POST", "/mcp") => {
                    let valid = shared.lock().unwrap().valid.clone();
                    if headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {valid}")) {
                        let hint = format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource\"");
                        return respond(&mut stream, "401 Unauthorized", &[("www-authenticate", hint)], "").await;
                    }
                    let message: Value = serde_json::from_str(&body).unwrap();
                    let id = message["id"].clone();
                    let result = match message["method"].as_str().unwrap_or_default() {
                        "initialize" => json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}}),
                        "tools/list" => json!({"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}),
                        "tools/call" => json!({"content": [{"type": "text", "text": message["params"]["arguments"]["text"]}]}),
                        _ => return respond(&mut stream, "202 Accepted", &[], "").await,
                    };
                    respond(&mut stream, "200 OK", &json_header, &json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()).await;
                }
                ("GET", "/.well-known/oauth-protected-resource") => {
                    let doc = json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]});
                    respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
                }
                ("GET", "/.well-known/oauth-authorization-server") => {
                    let doc = json!({
                        "issuer": base,
                        "authorization_endpoint": format!("{base}/authorize"),
                        "token_endpoint": format!("{base}/token"),
                        "registration_endpoint": format!("{base}/register"),
                        "code_challenge_methods_supported": ["S256"],
                        "scopes_supported": ["offline_access"],
                    });
                    respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
                }
                ("POST", "/register") => {
                    let meta: Value = serde_json::from_str(&body).unwrap();
                    assert_eq!(meta["token_endpoint_auth_method"], "none");
                    shared.lock().unwrap().registrations += 1;
                    respond(&mut stream, "201 Created", &json_header, &json!({"client_id": "cid"}).to_string()).await;
                }
                ("POST", "/token") => {
                    let fields = form(&body);
                    let reply = {
                    let mut auth = shared.lock().unwrap();
                    auth.grants.push(fields["grant_type"].clone());
                    match fields["grant_type"].as_str() {
                        "authorization_code" => {
                            let challenge = auth.challenge.clone().unwrap();
                            let computed = URL_SAFE_NO_PAD.encode(Sha256::digest(fields["code_verifier"].as_bytes()));
                            if fields["code"] != "the-code" || computed != challenge || fields["client_id"] != "cid" {
                                json!({"error": "invalid_grant"})
                            } else {
                                auth.valid = "t1".into();
                                json!({"access_token": "t1", "refresh_token": "r1", "token_type": "Bearer",
                                       "team": {"name": "Acme"}})
                            }
                        }
                        _ if fields["refresh_token"] == "r1" => {
                            auth.valid = "t2".into();
                            json!({"access_token": "t2", "token_type": "Bearer"})
                        }
                        _ => json!({"error": "invalid_grant"}),
                    }
                    };
                    let status = if reply.get("error").is_some() { "400 Bad Request" } else { "200 OK" };
                    respond(&mut stream, status, &json_header, &reply.to_string()).await;
                }
                _ => respond(&mut stream, "404 Not Found", &[], "").await,
            }
        });
    }
}

async fn browser_get(url: &Url) -> String {
    let mut stream = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())).await.unwrap();
    let target = format!("{}?{}", url.path(), url.query().unwrap());
    stream
        .write_all(format!("GET {target} HTTP/1.1\r\nHost: {}:{}\r\n\r\n", url.host_str().unwrap(), url.port().unwrap()).as_bytes())
        .await
        .unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    out
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_in_connect_refresh_and_sign_out() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shared: Shared = Arc::default();
    tokio::spawn(serve(listener, Arc::clone(&shared)));

    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io };
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    hub.set_oauth_env(OAuthEnv { store: store.clone(), plugin_data: dir.path().to_path_buf(), io: io.durability });
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp")});
    hub.apply(vec![McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap()]);

    // Not signed in: the connect fails on the fact, and no browser is opened by itself.
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    tokio::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. })))
        .await
        .unwrap()
        .unwrap();
    assert!(server.state().describe().contains("reauthenticationRequired"), "{}", server.state().describe());
    assert!(!hub.oauth("acme").unwrap().has_stored_tokens().await);

    // The explicit sign-in: the flow hands out the authorization URL; the "browser" follows it.
    let session = hub.login_flow("acme", AccountMode::Connect).unwrap().start().await.unwrap();
    let authorize = loop {
        match session.next().await.expect("an authorize state") {
            LoginState::Authorize { url, .. } => break Url::parse(&url).unwrap(),
            LoginState::Starting => {}
            other => panic!("unexpected {other:?}"),
        }
    };
    let query: HashMap<String, String> = authorize.query_pairs().into_owned().collect();
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["client_id"], "cid");
    assert_eq!(query["resource"], format!("http://127.0.0.1:{port}/mcp"));
    shared.lock().unwrap().challenge = Some(query["code_challenge"].clone());
    let callback = Url::parse(&format!("{}?code=the-code&state={}", query["redirect_uri"], query["state"])).unwrap();
    let page = tokio::spawn(async move { browser_get(&callback).await });
    let done = loop {
        match session.next().await.expect("a terminal state") {
            state if state.is_terminal() => break state,
            _ => {}
        }
    };
    assert!(matches!(done, LoginState::Done { .. }), "{done:?}");
    assert!(page.await.unwrap().starts_with("HTTP/1.1 200"), "the browser page reports success");
    assert!(session.next().await.is_none(), "nothing follows the terminal state");

    let oauth = hub.oauth("acme").unwrap();
    assert!(oauth.has_stored_tokens().await);
    assert!(store.get(&mixdog_mcp::oauth::session::account_of(oauth.binding().credential_key.as_str())).await.unwrap().is_some());

    // Signed in: the connect works and a call goes through.
    hub.reconnect("acme").await.unwrap();
    let call = |text: &'static str| {
        let server = Arc::clone(&server);
        async move { server.call_tool("t", "echo", json!({"text": text}), &CancellationToken::new(), None).await }
    };
    assert_eq!(call("one").await.unwrap().parts, vec![ToolPart::Text("one".into())]);

    // The server stops accepting the token: it is renewed from the refresh token, once.
    shared.lock().unwrap().valid = "expired".into();
    assert_eq!(call("two").await.unwrap().parts, vec![ToolPart::Text("two".into())]);
    assert_eq!(shared.lock().unwrap().grants, ["authorization_code", "refresh_token"]);
    assert_eq!(shared.lock().unwrap().registrations, 1);

    assert!(!oauth.secrets().is_empty());
    assert!(!oauth.sign_out(false).await.unwrap(), "no revocation endpoint: nothing was revoked");
    assert!(!oauth.has_stored_tokens().await);
    hub.close_all().await;
}
