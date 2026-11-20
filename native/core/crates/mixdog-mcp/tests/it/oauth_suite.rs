//! MCP OAuth end to end against a loopback server that is both the MCP server and its
//! authorization server: discovery from the 401 challenge, dynamic registration, the browser
//! login through a LoginFlow (loopback callback), the connect that follows, a refused token
//! renewed from its refresh token, and sign-out.

use std::collections::HashMap;
use std::future::{Future, poll_fn};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::task::Poll;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::oauth::AccountMode;
use mixdog_mcp::oauth::MemoryStore;
use mixdog_mcp::oauth::OAuthEnv;
use mixdog_mcp::oauth::SecretStore;
use mixdog_mcp::oauth::session::{McpOAuth, account_of};
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::server::ServerState;
use mixdog_mcp::transport::Authorizer;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use url::Url;

/// A secret store over a shared one whose reads can be made to never run, as a refused lane's do.
struct Flaky {
    inner: Arc<MemoryStore>,
    unrun: AtomicBool,
}

#[async_trait::async_trait]
impl SecretStore for Flaky {
    async fn get(&self, account: &str) -> Result<Option<String>, mixdog_secrets::SecretError> {
        if self.unrun.load(Ordering::SeqCst) {
            return Err(mixdog_secrets::SecretError::unrun("the durability lane is full"));
        }
        self.inner.get(account).await
    }
    async fn set(&self, account: &str, value: &str) -> Result<(), mixdog_secrets::SecretError> {
        self.inner.set(account, value).await
    }
    async fn delete(&self, account: &str) -> Result<(), mixdog_secrets::SecretError> {
        self.inner.delete(account).await
    }
}

#[derive(Default)]
struct Auth {
    challenge: Option<String>,
    /// The access token the MCP endpoint accepts.
    valid: String,
    grants: Vec<String>,
    registrations: usize,
    refresh_pause: Option<Arc<RefreshPause>>,
    rotated_again: bool,
}

#[derive(Default)]
struct RefreshPause {
    received: Notify,
    release: Notify,
}

type Shared = Arc<Mutex<Auth>>;

pub(crate) async fn read_request(stream: &mut TcpStream) -> (String, String, HashMap<String, String>, String) {
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
    let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_owned())).collect();
    let length: usize = headers.get("content-length").map_or(0, |v| v.parse().unwrap());
    while buf.len() < header_end + length {
        let n = stream.read(&mut chunk).await.unwrap();
        buf.extend_from_slice(&chunk[..n]);
    }
    (method, path, headers, String::from_utf8_lossy(&buf[header_end..header_end + length]).into_owned())
}

pub(crate) async fn respond(stream: &mut TcpStream, status: &str, headers: &[(&str, String)], body: &str) {
    let mut out = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n", body.len());
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    out.push_str(body);
    stream.write_all(out.as_bytes()).await.unwrap();
}

pub(crate) fn form(body: &str) -> HashMap<String, String> {
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
                    let (reply, pause) = {
                        let mut auth = shared.lock().unwrap();
                        auth.grants.push(fields["grant_type"].clone());
                        let reply = match fields["grant_type"].as_str() {
                            "authorization_code" => {
                                let challenge = auth.challenge.clone().unwrap();
                                let computed = URL_SAFE_NO_PAD.encode(Sha256::digest(fields["code_verifier"].as_bytes()));
                                if fields["code"] != "the-code" || computed != challenge || fields["client_id"] != "cid" {
                                    json!({"error": "invalid_grant"})
                                } else {
                                    auth.valid = if auth.grants.len() == 1 { "t1" } else { "switched" }.into();
                                    json!({"access_token": auth.valid, "refresh_token": "r1", "token_type": "Bearer",
                                       "team": {"name": "Acme"}})
                                }
                            }
                            _ if fields["refresh_token"] == "r1" => {
                                auth.valid = "t2".into();
                                json!({"access_token": "t2", "refresh_token": "r2", "token_type": "Bearer"})
                            }
                            _ if fields["refresh_token"] == "r2" && !auth.rotated_again => {
                                auth.rotated_again = true;
                                auth.valid = "t3".into();
                                json!({"access_token": "t3", "refresh_token": "r3", "token_type": "Bearer"})
                            }
                            _ => json!({"error": "invalid_grant"}),
                        };
                        let pause = (reply["access_token"] == "t3").then(|| auth.refresh_pause.take()).flatten();
                        (reply, pause)
                    };
                    if let Some(pause) = pause {
                        pause.received.notify_one();
                        pause.release.notified().await;
                    }
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
    stream.write_all(format!("GET {target} HTTP/1.1\r\nHost: {}:{}\r\n\r\n", url.host_str().unwrap(), url.port().unwrap()).as_bytes()).await.unwrap();
    let mut out = String::new();
    stream.read_to_string(&mut out).await.unwrap();
    out
}

async fn finish_authorization(session: &dyn LoginSession, shared: &Shared, port: u16) -> (LoginState, String) {
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
    assert!(session.next().await.is_none(), "nothing follows the terminal state");
    (done, page.await.unwrap())
}

async fn authorize(session: &dyn LoginSession, shared: &Shared, port: u16) {
    let (done, page) = finish_authorization(session, shared, port).await;
    assert!(matches!(done, LoginState::Done { .. }), "{done:?}");
    assert!(page.starts_with("HTTP/1.1 200"), "the browser page reports success");
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_in_connect_refresh_and_sign_out() {
    let _seams = crate::oauth_seams().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shared: Shared = Arc::default();
    tokio::spawn(serve(listener, Arc::clone(&shared)));

    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    let env = OAuthEnv { store: store.clone(), plugin_data: dir.path().to_path_buf(), io: io.durability };
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    hub.set_oauth_env(env.clone());
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp")});
    hub.apply(vec![McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap()]);

    // Not signed in: the connect fails on the fact, and no browser is opened by itself.
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    assert!(server.state().describe().contains("reauthenticationRequired"), "{}", server.state().describe());
    assert!(!hub.oauth("acme").unwrap().has_stored_tokens().await.unwrap());

    let session = hub.login_flow("acme", AccountMode::Connect).unwrap().start().await.unwrap();
    authorize(session.as_ref(), &shared, port).await;

    let oauth = hub.oauth("acme").unwrap();
    assert!(oauth.has_stored_tokens().await.unwrap());
    let stored = store.get(&account_of(oauth.binding().credential_key.as_str())).await.unwrap().unwrap();
    let alias_env = OAuthEnv { plugin_data: dir.path().join("other-markers"), ..env.clone() };
    let alias = McpOAuth::new(oauth.binding().clone(), &alias_env).unwrap();
    let mut separate_binding = oauth.binding().clone();
    separate_binding.credential_key = "mcp-account:separate".to_owned();
    store.set(&account_of(&separate_binding.credential_key), &stored).await.unwrap();
    let separate_store = Arc::new(Flaky { inner: store.clone(), unrun: AtomicBool::new(false) });
    let separate_env = OAuthEnv { store: separate_store.clone(), ..env };
    let separate = McpOAuth::new(separate_binding, &separate_env).unwrap();
    assert_eq!(alias.token().await.unwrap().as_deref(), Some("t1"));
    assert_eq!(separate.token().await.unwrap().as_deref(), Some("t1"));
    separate_store.unrun.store(true, Ordering::SeqCst);

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
    assert_eq!(alias.token().await.unwrap().as_deref(), Some("t2"));

    // A store read that never ran is neither "reauthentication required" nor a reason to erase the
    // sign-in: a second hub over the same entries, whose reads never run, renews with an error.
    let flaky = Arc::new(Flaky { inner: store.clone(), unrun: AtomicBool::new(true) });
    let other = McpHub::new(io, dir.path().join("artifacts-flaky"), OutputPolicy::default());
    other.set_oauth_env(OAuthEnv { store: flaky.clone(), plugin_data: dir.path().to_path_buf(), io: io.durability });
    other.apply(vec![McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap()]);
    let unread = other.oauth("acme").unwrap();
    let error = unread.renew(Some("expired".into()), None).await.unwrap_err();
    assert!(error.to_string().contains("credential store"), "{error}");
    assert!(!unread.sign_in_required(), "the user is not asked to sign in again");
    flaky.unrun.store(false, Ordering::SeqCst);
    assert!(oauth.has_stored_tokens().await.unwrap(), "the stored sign-in is untouched");
    other.close_all().await;

    let switch = oauth.login_flow("acme", AccountMode::Switch).start().await.unwrap();
    authorize(switch.as_ref(), &shared, port).await;
    assert_eq!(alias.token().await.unwrap().as_deref(), Some("switched"));
    oauth.rollback_switch().await.unwrap();
    assert_eq!(alias.token().await.unwrap().as_deref(), Some("t2"));

    // A failure in the second marker must leave the old grant in the shared store.
    let who = alias_env.plugin_data.join("mcp-oauth").join(format!("{}.who", account_of(&oauth.binding().credential_key)));
    std::fs::create_dir_all(&who).unwrap();
    let failed_switch = alias.login_flow("alias", AccountMode::Switch).start().await.unwrap();
    let (done, _) = finish_authorization(failed_switch.as_ref(), &shared, port).await;
    assert!(matches!(done, LoginState::Failed(_)), "{done:?}");
    std::fs::remove_dir(&who).unwrap();
    let cold_holder = McpOAuth::new(oauth.binding().clone(), &alias_env).unwrap();
    assert_eq!(cold_holder.token().await.unwrap().as_deref(), Some("t2"));

    // The provider consumes r2 while explicit login owns the gate. A transport
    // renewing the same token must adopt the rotation even if its marker write fails.
    assert_eq!(alias.token().await.unwrap().as_deref(), Some("t2"));
    std::fs::create_dir_all(&who).unwrap();
    let pause = Arc::new(RefreshPause::default());
    shared.lock().unwrap().refresh_pause = Some(pause.clone());
    let login = alias.login_flow("alias", AccountMode::Reauth).start().await.unwrap();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), pause.received.notified()).await.unwrap();
    let mut renew = std::pin::pin!(oauth.renew(Some("t2".into()), None));
    poll_fn(|cx| {
        assert!(renew.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    pause.release.notify_one();
    renew.await.unwrap();
    loop {
        let state = login.next().await.unwrap();
        if state.is_terminal() {
            assert!(matches!(state, LoginState::Done { .. }), "{state:?}");
            break;
        }
    }
    assert_eq!(alias.token().await.unwrap().as_deref(), Some("t3"));
    assert_eq!(oauth.token().await.unwrap().as_deref(), Some("t3"));
    assert_eq!(shared.lock().unwrap().grants.iter().filter(|grant| grant.as_str() == "refresh_token").count(), 2);
    std::fs::remove_dir(&who).unwrap();

    assert!(!alias.secrets().is_empty());
    assert!(!alias.sign_out(false).await.unwrap(), "no revocation endpoint: nothing was revoked");
    assert_eq!(oauth.token().await.unwrap(), None);
    assert_eq!(alias.token().await.unwrap(), None);
    assert!(!oauth.has_stored_tokens().await.unwrap());
    assert_eq!(separate.token().await.unwrap().as_deref(), Some("t1"));
    hub.close_all().await;
}

/// The sign-in follows the whole challenge the server refused its own transport's request with — a 403 asking for more
/// scope as much as a 401 (`authorizedFetch`): its discovery asks the resource metadata that challenge names, and the
/// authorization asks for the scope it names. A request answered afterwards clears the refusal.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_starts_from_the_challenge_of_the_refused_transport_request() {
    let _seams = crate::oauth_seams().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let base = format!("http://127.0.0.1:{port}");
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let base = base.clone();
            tokio::spawn(async move {
                let (_, path, _, _) = read_request(&mut stream).await;
                let json_header = [("content-type", "application/json".to_owned())];
                match path.as_str() {
                    "/scoped-metadata" => {
                        let doc = json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]});
                        respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
                    }
                    "/.well-known/oauth-authorization-server" => {
                        let doc = json!({
                            "issuer": base,
                            "authorization_endpoint": format!("{base}/authorize"),
                            "token_endpoint": format!("{base}/token"),
                            "registration_endpoint": format!("{base}/register"),
                            "code_challenge_methods_supported": ["S256"],
                        });
                        respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
                    }
                    "/register" => respond(&mut stream, "201 Created", &json_header, &json!({"client_id": "cid"}).to_string()).await,
                    _ => {
                        let hint = format!("Bearer error=\"insufficient_scope\", scope=\"files\", resource_metadata=\"{base}/scoped-metadata\"");
                        respond(&mut stream, "403 Forbidden", &[("www-authenticate", hint)], "").await;
                    }
                }
            });
        }
    });

    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let dir = tempfile::tempdir().unwrap();
    let env = OAuthEnv { store: Arc::new(MemoryStore::default()), plugin_data: dir.path().to_path_buf(), io: io.durability };
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    hub.set_oauth_env(env);
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp")});
    hub.apply(vec![McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap()]);
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();

    let oauth = hub.oauth("acme").unwrap();
    let challenge = oauth.refusal_challenge().expect("the refusal of the transport's request is kept");
    assert!(challenge.contains("insufficient_scope"), "{challenge}");
    let session = hub.login_flow("acme", AccountMode::Connect).unwrap().with_challenge(Some(&challenge)).start().await.unwrap();
    let authorize = mixdog_rt::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            match session.next().await.expect("an authorize state") {
                LoginState::Authorize { url, .. } => break Url::parse(&url).unwrap(),
                LoginState::Starting => {}
                other => panic!("unexpected {other:?}"),
            }
        }
    })
    .await
    .expect("the authorization page in 10 s");
    let query: HashMap<String, String> = authorize.query_pairs().into_owned().collect();
    assert_eq!(authorize.path(), "/authorize", "found through the metadata the 403 named");
    assert_eq!(query.get("scope").map(String::as_str), Some("files"), "{authorize}");
    oauth.answered(None);
    assert_eq!(oauth.refusal_challenge(), None, "an answered request clears the refusal");

    // A renewed token refused with another challenge: the explicit sign-in answers that last one.
    let first = "Bearer scope=\"files\"";
    let last = "Bearer error=\"insufficient_scope\", scope=\"files admin\"";
    let _ = oauth.renew(Some("old".to_owned()), Some(first.to_owned())).await;
    assert_eq!(oauth.refusal_challenge().as_deref(), Some(first));
    oauth.refused_after_renewal(Some("old"), Some(last));
    assert_eq!(oauth.refusal_challenge().as_deref(), Some(last), "the last refusal's challenge is kept");
    hub.close_all().await;
}
