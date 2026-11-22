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
use mixdog_core_api::feed_publisher::LoginFeeds;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockScopedFeeds;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::connector_accounts::AccountHealth;
use mixdog_mcp::declaration_cache::DeclarationCache;
use mixdog_mcp::extension_service::ExtensionConfig;
use mixdog_mcp::mcp_glue::GlueInputs;
use mixdog_mcp::mcp_glue::McpGlue;
use mixdog_mcp::mcp_glue::McpScopes;
use mixdog_mcp::mcp_glue::McpSurface;
use mixdog_mcp::mcp_service::McpRuntime;
use mixdog_mcp::oauth::AccountMode;
use mixdog_mcp::oauth::MemoryStore;
use mixdog_mcp::oauth::OAuthEnv;
use mixdog_mcp::oauth::SecretStore;
use mixdog_mcp::oauth::session::{McpOAuth, account_of};
use mixdog_mcp::plugin_admin::GitRunner;
use mixdog_mcp::plugin_admin::PluginAdmin;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::scope_runtime::Op;
use mixdog_mcp::scope_runtime::with_request_scope;
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
    /// Requests to the MCP endpoint.
    dials: usize,
    /// The next request without the accepted token is answered only once released, and its refusal names
    /// `/scoped-metadata`, whose authorization server no other answer names.
    held_refusal: Option<Arc<RefreshPause>>,
    /// The next request to the MCP endpoint, whatever it carries, is answered only once released.
    held_request: Option<Arc<RefreshPause>>,
    /// The MCP endpoint answers every request `503`.
    down: bool,
    /// The next `tools/list` is answered only once released.
    held_listing: Option<Arc<RefreshPause>>,
    /// The token endpoint answers a refresh with this OAuth error.
    refresh_error: Option<&'static str>,
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
                    let (valid, down, held) = {
                        let mut auth = shared.lock().unwrap();
                        auth.dials += 1;
                        (auth.valid.clone(), auth.down, auth.held_request.take())
                    };
                    if let Some(pause) = held {
                        pause.received.notify_one();
                        pause.release.notified().await;
                    }
                    if down {
                        return respond(&mut stream, "503 Service Unavailable", &[], "").await;
                    }
                    if headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {valid}")) {
                        let held = shared.lock().unwrap().held_refusal.take();
                        let metadata = match held {
                            Some(pause) => {
                                pause.received.notify_one();
                                pause.release.notified().await;
                                "scoped-metadata"
                            }
                            None => ".well-known/oauth-protected-resource",
                        };
                        let hint = format!("Bearer resource_metadata=\"{base}/{metadata}\"");
                        return respond(&mut stream, "401 Unauthorized", &[("www-authenticate", hint)], "").await;
                    }
                    let message: Value = serde_json::from_str(&body).unwrap();
                    let id = message["id"].clone();
                    if message["method"] == "tools/list" {
                        let held = shared.lock().unwrap().held_listing.take();
                        if let Some(pause) = held {
                            pause.received.notify_one();
                            pause.release.notified().await;
                        }
                    }
                    let result = match message["method"].as_str().unwrap_or_default() {
                        "initialize" => json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}}),
                        "tools/list" => json!({"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]}),
                        "tools/call" => json!({"content": [{"type": "text", "text": message["params"]["arguments"]["text"]}]}),
                        _ => return respond(&mut stream, "202 Accepted", &[], "").await,
                    };
                    respond(&mut stream, "200 OK", &json_header, &json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()).await;
                }
                ("GET", "/scoped-metadata") => {
                    let doc = json!({"resource": format!("{base}/mcp"), "authorization_servers": [format!("{base}/as")]});
                    respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
                }
                ("GET", "/.well-known/oauth-authorization-server/as") => {
                    let doc = json!({
                        "issuer": format!("{base}/as"),
                        "authorization_endpoint": format!("{base}/as/authorize"),
                        "token_endpoint": format!("{base}/as/token"),
                        "registration_endpoint": format!("{base}/register"),
                        "code_challenge_methods_supported": ["S256"],
                    });
                    respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
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
                            _ if auth.refresh_error.is_some() => json!({"error": auth.refresh_error}),
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
    let env = OAuthEnv { store: store.clone(), plugin_data: dir.path().to_path_buf(), io: io.durability, installation: None };
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
    other.set_oauth_env(OAuthEnv { store: flaky.clone(), plugin_data: dir.path().to_path_buf(), io: io.durability, installation: None });
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

#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_refused_a_connect_is_still_dialled_and_connects_once_signed_in() {
    let _seams = crate::oauth_seams().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shared: Shared = Arc::default();
    tokio::spawn(serve(listener, Arc::clone(&shared)));
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let dir = tempfile::tempdir().unwrap();
    let env = OAuthEnv { store: Arc::new(MemoryStore::default()), plugin_data: dir.path().to_path_buf(), io: io.durability, installation: None };
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    hub.set_oauth_env(env);
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp")});
    hub.apply(vec![McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap()]);
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    let dialled = shared.lock().unwrap().dials;
    assert!(dialled > 0);
    assert!(hub.oauth("acme").unwrap().sign_in_required());

    hub.reconnect("acme").await.unwrap_err();
    assert!(server.state().describe().contains("reauthenticationRequired"), "{}", server.state().describe());
    assert!(shared.lock().unwrap().dials > dialled, "a refusal met while talking to a server never stops its next dial");

    let session = hub.login_flow("acme", AccountMode::Connect).unwrap().start().await.unwrap();
    authorize(session.as_ref(), &shared, port).await;
    hub.reconnect("acme").await.unwrap();
    assert!(matches!(*server.state(), ServerState::Ready(_)), "{}", server.state().describe());
    hub.close_all().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_catalog_connector_never_signed_in_needs_a_sign_in_before_any_connect() {
    let tokens = mixdog_rt::testing::tokens();
    let dir = tempfile::tempdir().unwrap();
    let env = OAuthEnv { store: Arc::new(MemoryStore::default()), plugin_data: dir.path().to_path_buf(), io: tokens.durability_io, installation: None };
    let entry = json!({"url": "https://mcp.airtable.com/mcp", "connector": "airtable"});
    let binding = McpServerConfig::from_entry("airtable", &entry, &Default::default()).unwrap().oauth.unwrap();
    let oauth = McpOAuth::new(binding, &env).unwrap();
    assert!(!oauth.sign_in_required());
    assert!(oauth.sign_in_absent().await);
    assert!(oauth.sign_in_required(), "the status reads the missing sign-in");

    // Through the connect: failed on the fact, with nothing dialled.
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    hub.set_oauth_env(env.clone());
    hub.apply(vec![McpServerConfig::from_entry("airtable", &entry, &Default::default()).unwrap()]);
    let server = hub.server("airtable").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    assert_eq!(server.state().describe(), "failed: MCP OAuth reauthenticationRequired: sign in to connect");
    hub.close_all().await;

    let custom = json!({"url": "https://mcp.example.com/mcp"});
    let binding = McpServerConfig::from_entry("custom", &custom, &Default::default()).unwrap().oauth.unwrap();
    let env = OAuthEnv { store: Arc::new(MemoryStore::default()), ..env };
    let custom = McpOAuth::new(binding, &env).unwrap();
    let _ = custom.renew(None, None).await;
    assert!(custom.sign_in_required());
    assert!(!custom.sign_in_absent().await, "a server outside the catalog is always dialled");
}

const NEEDS_SIGN_IN: &str = "failed: MCP OAuth reauthenticationRequired: sign in to connect";

/// A hub over `store` and the test server it connects, whose requests `Shared` counts.
async fn hub_at_the_test_server(store: Arc<dyn SecretStore>) -> (tempfile::TempDir, Arc<McpHub>, Shared, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let shared: Shared = Arc::default();
    tokio::spawn(serve(listener, Arc::clone(&shared)));
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    hub.set_oauth_env(OAuthEnv { store, plugin_data: dir.path().to_path_buf(), io: io.durability, installation: None });
    (dir, hub, shared, port)
}

/// `acme` with the one thing a catalog connector at the catalog's own sign-in address has (`requires_sign_in`), at the
/// test server's address, where its requests are counted.
fn needing_sign_in(port: u16) -> McpServerConfig {
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp")});
    let mut config = McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap();
    config.oauth.as_mut().unwrap().requires_sign_in = true;
    config
}

async fn failed(hub: &McpHub, scope: &str) -> Arc<McpServer> {
    let server = hub.server_in(scope, "acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    server
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connector_never_signed_in_is_dialled_only_while_a_login_of_it_is_in_progress() {
    let _seams = crate::oauth_seams().await;
    let (_dir, hub, shared, port) = hub_at_the_test_server(Arc::new(MemoryStore::default())).await;
    let dials = || shared.lock().unwrap().dials;
    for scope in ["a", "b"] {
        hub.apply_in(scope, vec![needing_sign_in(port)]);
    }
    let (a, b) = (failed(&hub, "a").await, failed(&hub, "b").await);
    for server in [&a, &b] {
        assert_eq!(server.state().describe(), NEEDS_SIGN_IN);
        server.reconnect().await.unwrap_err();
        assert_eq!(server.state().describe(), NEEDS_SIGN_IN);
    }
    assert_eq!(dials(), 0, "no connect of either scope dials a sign-in known to be absent");
    let oauth = hub.oauth_in("a", "acme").unwrap();
    assert_eq!(oauth.refusal_challenge(), None, "nothing was asked, so nothing was refused");

    // A login of the credential begins, as the sign-in holds it before its reconnect: the scope's connect dials, and
    // the sign-in starts from what that request was refused with.
    let login = oauth.login_in_progress();
    a.reconnect().await.unwrap_err();
    assert_eq!(dials(), 1);
    let challenge = oauth.refusal_challenge().expect("the refusal of the transport's request is kept");
    assert!(challenge.contains("resource_metadata"), "{challenge}");
    // Another scope's connect of the credential dials too, and takes nothing from the scope that began the login.
    b.reconnect().await.unwrap_err();
    a.reconnect().await.unwrap_err();
    assert_eq!(dials(), 3);

    // The login itself holds it from here, until it ended.
    let session = oauth.login_flow("acme", AccountMode::Connect).with_challenge(Some(&challenge)).start().await.unwrap();
    drop(login);
    loop {
        match session.next().await.expect("an authorize state") {
            LoginState::Authorize { .. } => break,
            LoginState::Starting => {}
            other => panic!("unexpected {other:?}"),
        }
    }
    b.reconnect().await.unwrap_err();
    assert_eq!(dials(), 4);

    // It ends with no tokens stored: the connects are not dialled again.
    session.cancel();
    let ended = loop {
        match session.next().await.expect("a terminal state") {
            state if state.is_terminal() => break state,
            _ => {}
        }
    };
    assert!(matches!(ended, LoginState::Cancelled), "{ended:?}");
    for server in [&a, &b] {
        server.reconnect().await.unwrap_err();
        assert_eq!(server.state().describe(), NEEDS_SIGN_IN);
    }
    assert_eq!(dials(), 4, "the login ended without a sign-in: nothing dials");
    hub.close_all().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connector_whose_store_does_not_answer_is_dialled() {
    let store = Arc::new(Flaky { inner: Arc::new(MemoryStore::default()), unrun: AtomicBool::new(true) });
    let (_dir, hub, shared, port) = hub_at_the_test_server(store).await;
    hub.apply_in("a", vec![needing_sign_in(port)]);
    let server = failed(&hub, "a").await;
    assert_eq!(shared.lock().unwrap().dials, 1, "a store that did not answer says nothing about the sign-in");
    assert_ne!(server.state().describe(), NEEDS_SIGN_IN);
    hub.close_all().await;
}

async fn hub_refused_with_a_scope_challenge() -> (tempfile::TempDir, Arc<McpHub>) {
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
    let env = OAuthEnv { store: Arc::new(MemoryStore::default()), plugin_data: dir.path().to_path_buf(), io: io.durability, installation: None };
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    hub.set_oauth_env(env);
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp")});
    hub.apply(vec![McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap()]);
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    (dir, hub)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_starts_from_the_challenge_of_the_refused_transport_request() {
    let _seams = crate::oauth_seams().await;
    let (_dir, hub) = hub_refused_with_a_scope_challenge().await;
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
    hub.close_all().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_renewed_token_refused_with_another_challenge_keeps_the_last_challenge() {
    let _seams = crate::oauth_seams().await;
    let (_dir, hub) = hub_refused_with_a_scope_challenge().await;
    let oauth = hub.oauth("acme").unwrap();
    let first = "Bearer scope=\"files\"";
    let last = "Bearer error=\"insufficient_scope\", scope=\"files admin\"";
    let _ = oauth.renew(Some("old".to_owned()), Some(first.to_owned())).await;
    assert_eq!(oauth.refusal_challenge().as_deref(), Some(first));
    oauth.refused_after_renewal(Some("old"), Some(last));
    assert_eq!(oauth.refusal_challenge().as_deref(), Some(last), "the last refusal's challenge is kept");
    hub.close_all().await;
}

struct Agent(Mutex<serde_json::Map<String, Value>>);

#[async_trait::async_trait]
impl ExtensionConfig for Agent {
    fn agent(&self) -> serde_json::Map<String, Value> {
        self.0.lock().unwrap().clone()
    }
    async fn save_agent(&self, _: &serde_json::Map<String, Value>, _: &serde_json::Map<String, Value>) -> Result<(), String> {
        Ok(())
    }
    fn set_disabled_skills(&self, _: &[String]) {}
}

struct NoGit;

impl GitRunner for NoGit {
    fn run(&self, _: &[String], _: std::time::Duration) -> Result<String, String> {
        Err("git is not used".to_owned())
    }
}

struct Surface(std::path::PathBuf);

#[async_trait::async_trait]
impl McpSurface for Surface {
    async fn current_cwd(&self, _: Option<&str>) -> Result<std::path::PathBuf, String> {
        Ok(self.0.clone())
    }
    async fn thread_scope(&self, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn refresh_surface(&self) {}
    async fn tool_names(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn open_browser(&self, _: &str) {}
    fn announce_plugins(&self) {}
    async fn flush_skills_save(&self) {}
}

/// The MCP runtime as the daemon composes it, over the configured `mcpServers` and the test server at `port`: what
/// `mcp.login.begin` reaches.
struct Runtime {
    glue: Arc<McpGlue>,
    /// The configuration the runtime reads at each resolve.
    agent: Arc<Agent>,
    shared: Shared,
    port: u16,
    env: OAuthEnv,
    dir: tempfile::TempDir,
}

impl Runtime {
    /// `servers` is given the test server's port.
    async fn new(servers: impl FnOnce(u16) -> Value) -> Self {
        Self::with_env(servers, Default::default()).await
    }

    /// [`Self::new`] in the process environment `process_env`, as the configuration reads it.
    async fn with_env(servers: impl FnOnce(u16) -> Value, process_env: mixdog_mcp::config::Env) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let shared: Shared = Arc::default();
        tokio::spawn(serve(listener, Arc::clone(&shared)));
        let tokens = mixdog_rt::testing::tokens();
        let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
        let dir = tempfile::tempdir().unwrap();
        let env = OAuthEnv { store: Arc::new(MemoryStore::default()), plugin_data: dir.path().to_path_buf(), io: io.durability, installation: None };
        let agent = Arc::new(Agent(Mutex::new(json!({"mcpServers": servers(port)}).as_object().unwrap().clone())));
        let glue = McpGlue::new(GlueInputs {
            hub: McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default()),
            config: agent.clone(),
            admin: Arc::new(PluginAdmin::new(dir.path().to_path_buf(), Arc::new(NoGit), Arc::new(|| {}))),
            declarations: Arc::new(DeclarationCache::new()),
            maintenance: tokens.maintenance_io,
            oauth_env: env.clone(),
            env: process_env,
            surface: Arc::new(Surface(dir.path().to_path_buf())),
            health: Arc::new(AccountHealth::default()),
            login_feeds: Arc::new(LoginFeeds::new(Arc::new(MockScopedFeeds::new(MockLimits::default())))),
        });
        Self { glue, agent, shared, port, env, dir }
    }

    /// Opens `scope` and returns its server `name` once the scope's first connect settled.
    async fn open(&self, scope: &str, name: &str) -> Arc<McpServer> {
        let owner = format!("owner-{scope}");
        let opened = McpScopes::open(self.glue.as_ref(), scope, &owner, self.dir.path());
        mixdog_rt::time::timeout(std::time::Duration::from_secs(20), opened).await.expect("the scope's first connect in 20 s").expect("the scope opens");
        self.glue.hub().server_in(scope, name).expect("the scope holds the server")
    }

    /// `mcp.login.begin` of `name` as a request of `scope`: the authorization page it answers, and its flow, cancelled.
    async fn begin(&self, scope: &str, name: &str) -> Url {
        let options = json!({"openBrowser": false});
        let began = with_request_scope(Some(scope.to_owned()), self.glue.begin_login(name, &options));
        let began = mixdog_rt::time::timeout(std::time::Duration::from_secs(20), began).await.expect("the sign-in begins in 20 s").expect("the sign-in begins");
        assert_eq!(began["state"], "pending", "{began}");
        let url = Url::parse(began["url"].as_str().expect("the authorization page")).unwrap();
        self.glue.cancel_login(began["flowId"].as_str().unwrap()).await.unwrap();
        url
    }
}

/// The status still lists a sign-in whose secret holds no tokens any more (the marker outlived them). The sign-in's
/// reconnect is the "signed in" one, and it dials all the same: the login is in progress before it. A built-in Google
/// connector is the catalog address a test reaches without the network (it is answered in this process), and the stored
/// entry keeps a discovery, so the flow asks no authorization server for one.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_whose_marker_outlived_its_tokens_dials_and_starts_from_the_refusal() {
    let _seams = crate::oauth_seams().await;
    const ADDRESS: &str = "https://calendar.mixdog.invalid/mcp";
    const NAME: &str = "google-calendar";
    let runtime = Runtime::new(|_| json!({NAME: {"url": ADDRESS, "connector": "google-calendar", "oauthClientId": "mine"}})).await;
    let base = format!("http://127.0.0.1:{}", runtime.port);
    let account = account_of(ADDRESS);
    let entry = json!({"url": ADDRESS, "revision": "r1", "discovery": {"authorizationServerUrl": base, "authorizationServerMetadata": {
        "issuer": base,
        "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"),
        "code_challenge_methods_supported": ["S256"],
    }}});
    runtime.env.store.set(&account, &entry.to_string()).await.unwrap();
    let markers = runtime.dir.path().join("mcp-oauth");
    std::fs::create_dir_all(&markers).unwrap();
    std::fs::write(markers.join(format!("{account}.rev")), "r1+tokens").unwrap();

    let server = runtime.open("a", NAME).await;
    assert_eq!(server.state().describe(), NEEDS_SIGN_IN);
    let hub = runtime.glue.hub();
    assert_eq!(hub.oauth_in("a", NAME).unwrap().refusal_challenge(), None, "the scope's own connect asked nothing");

    let authorize = runtime.begin("a", NAME).await;
    let challenge = hub.oauth_in("a", NAME).unwrap().refusal_challenge().expect("the sign-in's reconnect asked, and was refused");
    assert!(challenge.contains("calendar.mixdog.invalid"), "{challenge}");
    assert_eq!(authorize.path(), "/authorize", "{authorize}");
    hub.close_all().await;
}

fn two_accounts(port: u16) -> Value {
    let url = format!("http://127.0.0.1:{port}/mcp");
    json!({"linear": {"connector": "linear", "url": url, "accounts": [
        {"name": "work", "url": url, "oauthKey": "work"},
        {"name": "home", "url": url, "oauthKey": "home"},
    ]}})
}

/// A connector answers its reconnect as soon as one account is ready. The account that signs in is refused later, and by
/// a challenge that names another authorization server than its earlier refusal did: the sign-in reads that one.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_of_an_account_beside_a_ready_one_starts_from_its_own_servers_refusal() {
    let _seams = crate::oauth_seams().await;
    let runtime = Runtime::new(two_accounts).await;
    let connector = McpServerConfig::from_entry("linear", &two_accounts(runtime.port)["linear"], &Default::default()).unwrap();
    let work = connector.accounts.iter().find(|account| account.server.name == "work").unwrap().server.oauth.clone().unwrap();
    let session = McpOAuth::new(work, &runtime.env).unwrap().login_flow("work", AccountMode::Connect).start().await.unwrap();
    authorize(session.as_ref(), &runtime.shared, runtime.port).await;

    let linear = runtime.open("a", "linear").await;
    assert!(matches!(*linear.state(), ServerState::Ready(_)), "{}", linear.state().describe());
    let home = linear.account_server("home").unwrap();
    let mut states = home.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    let earlier = runtime.glue.hub().oauth_in("a", "home").unwrap().refusal_challenge().expect("the account's startup was refused");
    assert!(earlier.contains(".well-known/oauth-protected-resource"), "{earlier}");

    let pause = Arc::new(RefreshPause::default());
    runtime.shared.lock().unwrap().held_refusal = Some(Arc::clone(&pause));
    let release = async {
        let ten = std::time::Duration::from_secs(10);
        mixdog_rt::time::timeout(ten, pause.received.notified()).await.expect("the account's server is asked again");
        // Answered only once the sign-in waits for it: one that did not wait has read the earlier refusal by now.
        mixdog_rt::time::timeout(ten, runtime.glue.account_waits().notified()).await.expect("the sign-in waits for the account's server");
        pause.release.notify_one();
    };
    let (authorize, ()) = tokio::join!(runtime.begin("a", "home"), release);
    assert_eq!(authorize.path(), "/as/authorize", "the issuer only the held-back refusal names: {authorize}");
    runtime.glue.hub().close_all().await;
}

/// The account is removed from the configuration while the sign-in waits for its server's answer: what signs in is read
/// after the wait, so the sign-in ends as one of an account that is not configured, and asks no authorization server.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_of_an_account_removed_while_its_server_answers_starts_no_authorization() {
    let _seams = crate::oauth_seams().await;
    let runtime = Runtime::new(two_accounts).await;
    let connector = McpServerConfig::from_entry("linear", &two_accounts(runtime.port)["linear"], &Default::default()).unwrap();
    let work = connector.accounts.iter().find(|account| account.server.name == "work").unwrap().server.oauth.clone().unwrap();
    let session = McpOAuth::new(work, &runtime.env).unwrap().login_flow("work", AccountMode::Connect).start().await.unwrap();
    authorize(session.as_ref(), &runtime.shared, runtime.port).await;

    let linear = runtime.open("a", "linear").await;
    let home = linear.account_server("home").unwrap();
    let mut states = home.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    let registered = runtime.shared.lock().unwrap().registrations;

    let pause = Arc::new(RefreshPause::default());
    runtime.shared.lock().unwrap().held_refusal = Some(Arc::clone(&pause));
    let remove = async {
        mixdog_rt::time::timeout(std::time::Duration::from_secs(10), pause.received.notified()).await.expect("the account's server is asked again");
        let mut only_work = two_accounts(runtime.port);
        only_work["linear"]["accounts"].as_array_mut().unwrap().retain(|account| account["name"] == "work");
        runtime.agent.0.lock().unwrap().insert("mcpServers".to_owned(), only_work);
        pause.release.notify_one();
    };
    let options = json!({"openBrowser": false});
    let begin = with_request_scope(Some("a".to_owned()), runtime.glue.begin_login("home", &options));
    let (began, ()) = tokio::join!(mixdog_rt::time::timeout(std::time::Duration::from_secs(20), begin), remove);
    let refused = began.expect("the sign-in ends in 20 s").expect_err("no sign-in of an account that is gone");
    assert_eq!(refused, "MCP server not configured: home");
    assert_eq!(runtime.shared.lock().unwrap().registrations, registered, "no authorization server was asked for a client");
    runtime.glue.hub().close_all().await;
}

/// Signs account `work` of `linear` in and opens scope `a`: the connector as the scope holds it, once every other
/// account of it failed its startup.
async fn work_signed_in(runtime: &Runtime, servers: fn(u16) -> Value) -> Arc<McpServer> {
    let connector = McpServerConfig::from_entry("linear", &servers(runtime.port)["linear"], &Default::default()).unwrap();
    let work = connector.accounts.iter().find(|account| account.server.name == "work").unwrap().server.oauth.clone().unwrap();
    let session = McpOAuth::new(work, &runtime.env).unwrap().login_flow("work", AccountMode::Connect).start().await.unwrap();
    authorize(session.as_ref(), &runtime.shared, runtime.port).await;
    let linear = runtime.open("a", "linear").await;
    // A scope whose servers have no startup budget opens without waiting for their first connect.
    let mut states = linear.subscribe();
    let ready = states.wait_for(|s| !matches!(**s, ServerState::Starting));
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), ready).await.expect("the connector's first connect in 10 s").unwrap();
    assert!(matches!(*linear.state(), ServerState::Ready(_)), "{}", linear.state().describe());
    if let Some(account) = linear.account_server("home") {
        let mut states = account.subscribe();
        mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    }
    linear
}

/// With the startup budget switched off the sign-in still reads its own server's refusal: the wait for it has no bound
/// of its own.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_beside_a_ready_account_waits_for_its_servers_refusal_with_no_startup_budget() {
    let _seams = crate::oauth_seams().await;
    let no_budget = [("MIXDOG_MCP_STARTUP_TIMEOUT_MS".to_owned(), "0".to_owned())].into_iter().collect();
    let runtime = Runtime::with_env(two_accounts, no_budget).await;
    let linear = work_signed_in(&runtime, two_accounts).await;
    assert_eq!(linear.account_server("home").unwrap().config().startup_timeout, None);

    let pause = Arc::new(RefreshPause::default());
    runtime.shared.lock().unwrap().held_refusal = Some(Arc::clone(&pause));
    let release = async {
        let ten = std::time::Duration::from_secs(10);
        mixdog_rt::time::timeout(ten, pause.received.notified()).await.expect("the account's server is asked again");
        // Answered only once the sign-in waits for it: one that did not wait has read the earlier refusal by now.
        mixdog_rt::time::timeout(ten, runtime.glue.account_waits().notified()).await.expect("the sign-in waits for the account's server");
        pause.release.notify_one();
    };
    let (authorize, ()) = tokio::join!(runtime.begin("a", "home"), release);
    assert_eq!(authorize.path(), "/as/authorize", "the issuer only the held-back refusal names: {authorize}");
    runtime.glue.hub().close_all().await;
}

/// The account's server has not answered, and the sign-in that waits for it is cancelled (as a sign-out, or a second
/// sign-in of the name, cancels it): it ends there, not when the server answers or its startup budget runs out.
#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_sign_in_does_not_wait_for_the_accounts_server() {
    let _seams = crate::oauth_seams().await;
    let runtime = Runtime::new(two_accounts).await;
    work_signed_in(&runtime, two_accounts).await;

    let pause = Arc::new(RefreshPause::default());
    runtime.shared.lock().unwrap().held_refusal = Some(Arc::clone(&pause));
    let glue = Arc::clone(&runtime.glue);
    let begun = with_request_scope(Some("a".to_owned()), async move { glue.begin_login("home", &json!({"openBrowser": false})).await });
    let begun = tokio::spawn(begun);
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), pause.received.notified()).await.expect("the account's server is asked again");

    let five = std::time::Duration::from_secs(5);
    let cancelled = mixdog_rt::time::timeout(five, runtime.glue.guard_sign_out("home")).await.expect("cancelled while the server has not answered");
    drop(cancelled);
    let ended = mixdog_rt::time::timeout(five, begun).await.expect("the cancelled sign-in answers at once").unwrap();
    ended.expect_err("a cancelled sign-in started no authorization");
    pause.release.notify_one();
    runtime.glue.hub().close_all().await;
}

fn one_account(port: u16) -> Value {
    let url = format!("http://127.0.0.1:{port}/mcp");
    json!({"linear": {"connector": "linear", "url": url, "accounts": [{"name": "work", "url": url, "oauthKey": "work"}]}})
}

/// A connector whose only account failed its last connect is reconnected: the account's connect is scheduled before
/// the connector asks its accounts, and the connector waits for that connect, not for the state the last one left.
#[tokio::test(flavor = "multi_thread")]
async fn a_connector_reconnected_with_its_account_waits_for_the_accounts_connect() {
    let _seams = crate::oauth_seams().await;
    let runtime = Runtime::new(one_account).await;
    let linear = work_signed_in(&runtime, one_account).await;
    let work = linear.account_server("work").unwrap();
    runtime.shared.lock().unwrap().down = true;
    work.reconnect().await.unwrap_err();
    assert!(matches!(*linear.state(), ServerState::Ready(_)), "{}", linear.state().describe());

    let pause = Arc::new(RefreshPause::default());
    {
        let mut auth = runtime.shared.lock().unwrap();
        auth.down = false;
        auth.held_request = Some(Arc::clone(&pause));
    }
    let release = async {
        mixdog_rt::time::timeout(std::time::Duration::from_secs(10), pause.received.notified()).await.expect("the account connects again");
        mixdog_rt::time::sleep(std::time::Duration::from_millis(300)).await;
        pause.release.notify_one();
    };
    let reconnect = runtime.glue.scope_runtime().run("a", Op::Only("linear".to_owned(), true));
    tokio::join!(reconnect, release);
    let linear = runtime.glue.hub().server_in("a", "linear").unwrap();
    assert!(matches!(*linear.account_server("work").unwrap().state(), ServerState::Ready(_)));
    assert!(matches!(*linear.state(), ServerState::Ready(_)), "the connector is ready with its account: {}", linear.state().describe());
    runtime.glue.hub().close_all().await;
}

/// A switch of a signed-in account reconnects nothing, so it waits for no connect: here the account's server is in a
/// connect another request began, which its server has not answered.
#[tokio::test(flavor = "multi_thread")]
async fn a_switch_of_a_signed_in_account_waits_for_no_connect() {
    let _seams = crate::oauth_seams().await;
    let runtime = Runtime::new(one_account).await;
    let linear = work_signed_in(&runtime, one_account).await;
    runtime.shared.lock().unwrap().down = true;
    linear.account_server("work").unwrap().reconnect().await.unwrap_err();

    let pause = Arc::new(RefreshPause::default());
    {
        let mut auth = runtime.shared.lock().unwrap();
        auth.down = false;
        auth.held_request = Some(Arc::clone(&pause));
    }
    let reconnect = runtime.glue.scope_runtime().run("a", Op::Only("linear".to_owned(), true));
    let switch = async {
        mixdog_rt::time::timeout(std::time::Duration::from_secs(10), pause.received.notified()).await.expect("the account connects again");
        let options = json!({"openBrowser": false, "mode": "switch"});
        let began = with_request_scope(Some("a".to_owned()), runtime.glue.begin_login("work", &options));
        let began =
            mixdog_rt::time::timeout(std::time::Duration::from_secs(5), began).await.expect("the switch waits for no connect").expect("the switch begins");
        assert_eq!(began["state"], "pending", "{began}");
        runtime.glue.cancel_login(began["flowId"].as_str().unwrap()).await.unwrap();
        pause.release.notify_one();
    };
    tokio::join!(reconnect, switch);
    runtime.glue.hub().close_all().await;
}

/// A reconnect of a server reached over the network replaces its connection: a call already on the old one returns its
/// own result, calls made after the reconnect go to the new one, and the old one ends once its call did.
#[tokio::test(flavor = "multi_thread")]
async fn a_call_in_flight_across_a_reconnect_returns_its_result() {
    let _seams = crate::oauth_seams().await;
    let (_dir, hub, shared, port) = hub_at_the_test_server(Arc::new(MemoryStore::default())).await;
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp")});
    hub.apply(vec![McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap()]);
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    let session = hub.login_flow("acme", AccountMode::Connect).unwrap().start().await.unwrap();
    authorize(session.as_ref(), &shared, port).await;
    hub.reconnect("acme").await.unwrap();
    let client_of = |server: &McpServer| match &*server.state() {
        ServerState::Ready(ready) => Arc::clone(&ready.client),
        other => panic!("{}", other.describe()),
    };
    let call = |text: &'static str| {
        let server = Arc::clone(&server);
        async move { server.call_tool("t", "echo", json!({"text": text}), &CancellationToken::new(), None).await }
    };

    let pause = Arc::new(RefreshPause::default());
    shared.lock().unwrap().held_request = Some(Arc::clone(&pause));
    let before = client_of(&server);
    let in_flight = tokio::spawn(call("kept"));
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), pause.received.notified()).await.expect("the call reached the server");

    server.reconnect().await.unwrap();
    assert!(!Arc::ptr_eq(&before, &client_of(&server)), "the reconnect made a new connection");
    assert!(!before.is_closed(), "the replaced connection stays open for the call on it");
    assert_eq!(call("new").await.unwrap().parts, vec![ToolPart::Text("new".into())]);

    pause.release.notify_one();
    assert_eq!(in_flight.await.unwrap().unwrap().parts, vec![ToolPart::Text("kept".into())]);
    let mut closed = before.closed();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), closed.wait_for(Option::is_some))
        .await
        .expect("the replaced connection ends once its call did")
        .unwrap();
    hub.close_all().await;
}

/// Two installations over one secret store keep a sign-in each. The sign-in an installation made under the name every
/// installation shared (its own markers list it) is read where it is, and nothing is written or removed to read it; an
/// installation that never signed in reads nothing, and neither does the first once it signed out.
#[tokio::test(flavor = "multi_thread")]
async fn an_installation_reads_the_sign_in_it_made_under_the_shared_name() {
    use mixdog_mcp::oauth::session::secret_account_of;
    let tokens = mixdog_rt::testing::tokens();
    let store = Arc::new(MemoryStore::default());
    let url = "https://mcp.example.com/mcp";
    let binding = McpServerConfig::from_entry("custom", &json!({"url": url}), &Default::default()).unwrap().oauth.unwrap();
    let shared_name = account_of(&binding.credential_key);
    let entry = json!({"url": url, "revision": "r1", "tokens": {"access_token": "t1", "refresh_token": "r1"}}).to_string();
    store.set(&shared_name, &entry).await.unwrap();
    let (first_dir, second_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let markers = first_dir.path().join("mcp-oauth");
    std::fs::create_dir_all(&markers).unwrap();
    std::fs::write(markers.join(format!("{shared_name}.rev")), "r1+tokens").unwrap();
    let env = |dir: &tempfile::TempDir, installation: &str| OAuthEnv {
        store: store.clone(),
        plugin_data: dir.path().to_path_buf(),
        io: tokens.durability_io,
        installation: Some(installation.to_owned()),
    };

    let second = McpOAuth::new(binding.clone(), &env(&second_dir, "second")).unwrap();
    assert_eq!(second.token().await.unwrap(), None, "an installation that never signed in takes nothing");
    let first = McpOAuth::new(binding.clone(), &env(&first_dir, "first")).unwrap();
    assert_eq!(first.token().await.unwrap().as_deref(), Some("t1"));
    assert_eq!(store.get(&shared_name).await.unwrap().as_deref(), Some(entry.as_str()), "the shared entry is as it was");
    assert_eq!(store.get(&secret_account_of("first", &binding.credential_key)).await.unwrap(), None, "reading it wrote nothing");
    assert_eq!(second.token().await.unwrap(), None);

    first.sign_out(false).await.unwrap();
    assert_eq!(store.get(&shared_name).await.unwrap().as_deref(), Some(entry.as_str()), "a sign-out leaves the shared entry too");
    let again = McpOAuth::new(binding, &env(&first_dir, "first")).unwrap();
    assert_eq!(again.token().await.unwrap(), None, "signed out: the shared entry is not read again");
}

/// An entry stored for another address is no entry of this server: its sign-in proceeds, and replaces it.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_replaces_an_entry_stored_for_another_address() {
    let _seams = crate::oauth_seams().await;
    let store = Arc::new(MemoryStore::default());
    let (_dir, hub, shared, port) = hub_at_the_test_server(store.clone()).await;
    let url = format!("http://127.0.0.1:{port}/mcp");
    let config = McpServerConfig::from_entry("acme", &json!({"url": url}), &Default::default()).unwrap();
    let account = account_of(&config.oauth.as_ref().unwrap().credential_key);
    let elsewhere = json!({"url": "http://127.0.0.1:1/elsewhere", "revision": "r0", "tokens": {"access_token": "theirs"}});
    store.set(&account, &elsewhere.to_string()).await.unwrap();
    hub.apply(vec![config]);
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();

    let session = hub.login_flow("acme", AccountMode::Connect).unwrap().start().await.unwrap();
    authorize(session.as_ref(), &shared, port).await;
    let stored: Value = serde_json::from_str(&store.get(&account).await.unwrap().unwrap()).unwrap();
    assert_eq!(stored["url"], url, "the sign-in replaced the entry of the other address");
    hub.reconnect("acme").await.unwrap();
    hub.close_all().await;
}

/// A sign-in made beside an entry bound to another address replaces it; when it is rolled back (its connect failed),
/// what comes back is that entry, so the address it belongs to still has its sign-in.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_rolled_back_puts_back_the_entry_of_another_address() {
    let _seams = crate::oauth_seams().await;
    let store = Arc::new(MemoryStore::default());
    let (_dir, hub, shared, port) = hub_at_the_test_server(store.clone()).await;
    let url = format!("http://127.0.0.1:{port}/mcp");
    let config = McpServerConfig::from_entry("acme", &json!({"url": url}), &Default::default()).unwrap();
    let account = account_of(&config.oauth.as_ref().unwrap().credential_key);
    let elsewhere = json!({"url": "http://127.0.0.1:1/elsewhere", "revision": "r0", "tokens": {"access_token": "theirs"}});
    store.set(&account, &elsewhere.to_string()).await.unwrap();
    hub.apply(vec![config]);
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    let stored = || async { serde_json::from_str::<Value>(&store.get(&account).await.unwrap().expect("an entry is stored")).unwrap() };

    let oauth = hub.oauth("acme").unwrap();
    let session = oauth.login_flow_beside("acme", AccountMode::Connect).start().await.unwrap();
    authorize(session.as_ref(), &shared, port).await;
    assert_eq!(stored().await["url"], url, "the sign-in is stored");

    oauth.rollback_switch().await.unwrap();
    let back = stored().await;
    assert_eq!((&back["url"], &back["tokens"]["access_token"]), (&elsewhere["url"], &elsewhere["tokens"]["access_token"]), "{back}");
    assert_eq!(oauth.token().await.unwrap(), None, "and it is still no sign-in of this address");
    hub.close_all().await;
}

/// A secret store over a shared one whose writes can be made to fail, and whose next write can be held until released.
#[derive(Default)]
struct Faulty {
    inner: Arc<MemoryStore>,
    /// Whether a write that begins now is refused.
    writes_fail: AtomicBool,
    /// The next write waits here, after it was admitted.
    held_write: Mutex<Option<Arc<RefreshPause>>>,
}

#[async_trait::async_trait]
impl SecretStore for Faulty {
    async fn get(&self, account: &str) -> Result<Option<String>, mixdog_secrets::SecretError> {
        self.inner.get(account).await
    }
    async fn set(&self, account: &str, value: &str) -> Result<(), mixdog_secrets::SecretError> {
        if self.writes_fail.load(Ordering::SeqCst) {
            return Err(mixdog_secrets::SecretError::new("the keychain refused the write"));
        }
        let held = self.held_write.lock().unwrap().take();
        if let Some(pause) = held {
            pause.received.notify_one();
            pause.release.notified().await;
        }
        self.inner.set(account, value).await
    }
    async fn delete(&self, account: &str) -> Result<(), mixdog_secrets::SecretError> {
        self.inner.delete(account).await
    }
}

/// Drives `session` through the browser's part, as a browser that follows the redirect would, to its last state.
async fn through_the_browser(session: &dyn LoginSession, shared: &Shared) -> LoginState {
    let authorize = loop {
        match session.next().await.expect("an authorize state") {
            LoginState::Authorize { url, .. } => break Url::parse(&url).unwrap(),
            LoginState::Starting => {}
            other => return other,
        }
    };
    let query: HashMap<String, String> = authorize.query_pairs().into_owned().collect();
    shared.lock().unwrap().challenge = Some(query["code_challenge"].clone());
    let callback = Url::parse(&format!("{}?code=the-code&state={}", query["redirect_uri"], query["state"])).unwrap();
    // The page may be cut short by a sign-in that ends meanwhile.
    let page = tokio::spawn(async move { browser_get(&callback).await });
    let last = loop {
        match session.next().await.expect("a terminal state") {
            state if state.is_terminal() => break state,
            _ => {}
        }
    };
    let _ = page.await;
    last
}

/// `acme` at the test server over `store`, signed in (token `t1`): its hub, sign-in object and the server's state.
async fn signed_in(store: Arc<dyn SecretStore>) -> (tempfile::TempDir, Arc<McpHub>, Arc<McpOAuth>, Shared, u16) {
    let (dir, hub, shared, port) = hub_at_the_test_server(store).await;
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp")});
    hub.apply(vec![McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap()]);
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    let oauth = hub.oauth("acme").unwrap();
    let session = oauth.login_flow("acme", AccountMode::Connect).start().await.unwrap();
    authorize(session.as_ref(), &shared, port).await;
    (dir, hub, oauth, shared, port)
}

/// A switch is cancelled while its sign-in is being stored: the write goes through, and putting the previous sign-in
/// back fails. What is stored is the switch's sign-in. A connection opened as the previous one does not take its
/// token: it keeps the one it had, and renews nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_switch_that_stayed_stored_is_not_the_sign_in_of_open_connections() {
    use mixdog_mcp::transport::OpenedAs;
    use mixdog_mcp::transport::TransportError;
    let _seams = crate::oauth_seams().await;
    let store = Arc::new(Faulty::default());
    let (_dir, hub, oauth, shared, _port) = signed_in(store.clone()).await;
    let connection = OpenedAs::new(oauth.clone());
    assert_eq!(connection.token().await.unwrap().as_deref(), Some("t1"));

    let write = Arc::new(RefreshPause::default());
    *store.held_write.lock().unwrap() = Some(Arc::clone(&write));
    let switch = oauth.login_flow("acme", AccountMode::Switch).start().await.unwrap();
    let cancel_in_the_write = async {
        mixdog_rt::time::timeout(std::time::Duration::from_secs(10), write.received.notified()).await.expect("the switch stores its sign-in");
        // The write under way was admitted; the one that would put the previous sign-in back is refused.
        store.writes_fail.store(true, Ordering::SeqCst);
        switch.cancel();
        write.release.notify_one();
    };
    let both = async { tokio::join!(through_the_browser(switch.as_ref(), &shared), cancel_in_the_write) };
    let (last, ()) = mixdog_rt::time::timeout(std::time::Duration::from_secs(20), both).await.expect("the switch ends in 20 s");
    assert!(!matches!(last, LoginState::Done { .. }), "{last:?}");
    store.writes_fail.store(false, Ordering::SeqCst);

    assert_eq!(oauth.token().await.unwrap().as_deref(), Some("switched"), "the switch's sign-in is what is stored");
    assert_eq!(connection.token().await.unwrap().as_deref(), Some("t1"), "the open connection is still the sign-in it was opened as");
    let renewed = connection.renew(Some("t1".to_owned()), None).await;
    assert!(matches!(renewed, Err(TransportError::AuthRequired)), "{renewed:?}");
    hub.close_all().await;
}

/// A request is refused for its scope and the renewal ends the grant: the authorization server answers
/// `invalid_grant` (the tokens are cleared) or `invalid_client` (the entry is erased). The connection keeps the token
/// it had, for what it still sends and for its close.
#[tokio::test(flavor = "multi_thread")]
async fn a_renewal_that_ends_the_grant_leaves_the_connection_the_token_it_had() {
    use mixdog_mcp::transport::OpenedAs;
    let _seams = crate::oauth_seams().await;
    let (_dir, hub, oauth, shared, port) = signed_in(Arc::new(MemoryStore::default())).await;
    let scope = "Bearer error=\"insufficient_scope\", scope=\"more\"";
    for (ends_with, token) in [("invalid_grant", "t1"), ("invalid_client", "switched")] {
        let connection = OpenedAs::new(oauth.clone());
        assert_eq!(connection.token().await.unwrap().as_deref(), Some(token));
        shared.lock().unwrap().refresh_error = Some(ends_with);
        connection.renew(Some(token.to_owned()), Some(scope.to_owned())).await.expect_err("the grant cannot be renewed");
        assert_eq!(oauth.token().await.unwrap(), None, "{ends_with}: nothing usable is stored");
        assert_eq!(connection.token().await.unwrap().as_deref(), Some(token), "{ends_with}: the connection keeps its token");
        assert_eq!(connection.held().as_deref(), Some(token), "{ends_with}: and closes as the sign-in it was opened as");
        shared.lock().unwrap().refresh_error = None;
        if ends_with == "invalid_grant" {
            let again = oauth.login_flow("acme", AccountMode::Connect).start().await.unwrap();
            authorize(again.as_ref(), &shared, port).await;
        }
    }
    hub.close_all().await;
}

/// An account's own server is still starting, its listing unanswered, on a connection opened as the account's
/// sign-in, while another account keeps the connector ready. The account signs out and its connector reconnects, as a
/// sign-out's reconnect does: the starting server is not left to become ready as the signed-out account.
#[tokio::test(flavor = "multi_thread")]
async fn an_accounts_server_still_starting_does_not_become_ready_as_a_signed_out_account() {
    let _seams = crate::oauth_seams().await;
    let runtime = Runtime::new(two_accounts).await;
    let linear = work_signed_in(&runtime, two_accounts).await;
    let home = linear.account_server("home").unwrap();
    let signs_in = runtime.glue.hub().oauth_in("a", "home").unwrap();
    let session = signs_in.login_flow("home", AccountMode::Connect).start().await.unwrap();
    authorize(session.as_ref(), &runtime.shared, runtime.port).await;

    let listing = Arc::new(RefreshPause::default());
    runtime.shared.lock().unwrap().held_listing = Some(Arc::clone(&listing));
    let connecting = {
        let home = Arc::clone(&home);
        tokio::spawn(async move { home.reconnect().await })
    };
    let ten = std::time::Duration::from_secs(10);
    mixdog_rt::time::timeout(ten, listing.received.notified()).await.expect("the account's server asks for its tools");
    assert!(matches!(*home.state(), ServerState::Starting), "{}", home.state().describe());

    signs_in.sign_out(false).await.unwrap();
    let reconnect = runtime.glue.scope_runtime().run("a", Op::Only("linear".to_owned(), true));
    mixdog_rt::time::timeout(ten, reconnect).await.expect("the reconnect does not wait for the listing");
    listing.release.notify_one();

    let connected = mixdog_rt::time::timeout(ten, connecting).await.expect("the account's connect ends").unwrap();
    connected.expect_err("the account is signed out");
    let state = home.state().describe();
    assert!(state.contains("reauthenticationRequired"), "{state}");
    runtime.glue.hub().close_all().await;
}

const SHARED_URL: &str = "https://mcp.example.com/mcp";

fn shared_binding() -> mixdog_mcp::config::OAuthBinding {
    McpServerConfig::from_entry("custom", &json!({"url": SHARED_URL}), &Default::default()).unwrap().oauth.unwrap()
}

/// The entry of revision `revision` as an installation wrote it under the shared name, holding `token`.
fn shared_entry(revision: &str, token: &str) -> String {
    json!({"url": SHARED_URL, "revision": revision, "tokens": {"access_token": token, "refresh_token": "r"}}).to_string()
}

/// The sign-in object of installation `id`, whose data directory is new and whose marker lists revision `revision`
/// under the shared name.
fn installation(store: Arc<dyn SecretStore>, id: &str, revision: &str) -> (tempfile::TempDir, Arc<McpOAuth>) {
    let dir = tempfile::tempdir().unwrap();
    let markers = dir.path().join("mcp-oauth");
    std::fs::create_dir_all(&markers).unwrap();
    std::fs::write(markers.join(format!("{}.rev", account_of(&shared_binding().credential_key))), format!("{revision}+tokens")).unwrap();
    let io = mixdog_rt::testing::tokens().durability_io;
    let env = OAuthEnv { store, plugin_data: dir.path().to_path_buf(), io, installation: Some(id.to_owned()) };
    let oauth = McpOAuth::new(shared_binding(), &env).unwrap();
    (dir, oauth)
}

/// The installation's sign-in is the entry under the shared name, and its sign-out cannot be recorded in the marker
/// (here the part of it that names the account cannot be removed). The sign-out fails, and the installation is still
/// signed in when it next starts; once the marker can be written the sign-out goes through and stays.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_out_that_cannot_be_recorded_fails_and_leaves_the_sign_in() {
    let store = Arc::new(MemoryStore::default());
    let shared_name = account_of(&shared_binding().credential_key);
    store.set(&shared_name, &shared_entry("r1", "t1")).await.unwrap();
    let (dir, first) = installation(store.clone(), "first", "r1");
    assert_eq!(first.token().await.unwrap().as_deref(), Some("t1"));
    let next_start = || {
        let io = mixdog_rt::testing::tokens().durability_io;
        let env = OAuthEnv { store: store.clone(), plugin_data: dir.path().to_path_buf(), io, installation: Some("first".to_owned()) };
        McpOAuth::new(shared_binding(), &env).unwrap()
    };

    let who = dir.path().join("mcp-oauth").join(format!("{shared_name}.who"));
    std::fs::create_dir_all(&who).unwrap();
    first.sign_out(false).await.expect_err("a sign-out that left no record");
    std::fs::remove_dir(&who).unwrap();
    let started = next_start();
    assert_eq!(started.token().await.unwrap().as_deref(), Some("t1"), "still signed in");
    assert!(started.has_stored_tokens().await.unwrap(), "and shown as signed in");

    started.sign_out(false).await.unwrap();
    assert_eq!(next_start().token().await.unwrap(), None, "signed out for good");
}

/// Two installations list an entry under the shared name, each the one it wrote; the name holds the second's. The
/// first reads nothing; the second reads its own; neither changes what the name holds.
#[tokio::test(flavor = "multi_thread")]
async fn an_installation_reads_only_the_shared_entry_its_own_marker_names() {
    let store = Arc::new(MemoryStore::default());
    let shared_name = account_of(&shared_binding().credential_key);
    let theirs = shared_entry("r2", "second's");
    store.set(&shared_name, &theirs).await.unwrap();
    let (_first_dir, first) = installation(store.clone(), "first", "r1");
    let (_second_dir, second) = installation(store.clone(), "second", "r2");

    assert_eq!(first.token().await.unwrap(), None, "the entry is another installation's");
    assert_eq!(second.token().await.unwrap().as_deref(), Some("second's"));
    assert_eq!(first.token().await.unwrap(), None);
    assert_eq!(store.get(&shared_name).await.unwrap().as_deref(), Some(theirs.as_str()), "the shared entry is as it was");
}

/// A reconnect leaves the connection it replaced open for the call on it. Closing the server ends that connection too,
/// and has when it returns: the session of each connection was ended at its server, the replaced one's included,
/// though that server takes its time to end it.
#[tokio::test(flavor = "multi_thread")]
async fn a_closed_server_has_ended_the_session_of_the_connection_it_replaced() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let sessions: Arc<Mutex<(usize, Vec<String>)>> = Arc::default();
    let held = Arc::new(RefreshPause::default());
    tokio::spawn({
        let (sessions, held) = (Arc::clone(&sessions), Arc::clone(&held));
        async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let (sessions, held) = (Arc::clone(&sessions), Arc::clone(&held));
                tokio::spawn(async move {
                    let (method, _, headers, body) = read_request(&mut stream).await;
                    if method == "DELETE" {
                        let session = headers.get("mcp-session-id").cloned().unwrap_or_default();
                        if session == "s1" {
                            mixdog_rt::time::sleep(std::time::Duration::from_millis(300)).await;
                        }
                        sessions.lock().unwrap().1.push(session);
                        return respond(&mut stream, "200 OK", &[], "").await;
                    }
                    if method != "POST" {
                        return respond(&mut stream, "405 Method Not Allowed", &[], "").await;
                    }
                    let message: Value = serde_json::from_str(&body).unwrap();
                    let reply = |result: Value| json!({"jsonrpc": "2.0", "id": message["id"], "result": result}).to_string();
                    let json_header = ("content-type", "application/json".to_owned());
                    match message["method"].as_str().unwrap_or_default() {
                        "initialize" => {
                            let session = {
                                let mut sessions = sessions.lock().unwrap();
                                sessions.0 += 1;
                                format!("s{}", sessions.0)
                            };
                            let result = json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}});
                            respond(&mut stream, "200 OK", &[json_header, ("mcp-session-id", session)], &reply(result)).await;
                        }
                        "tools/list" => {
                            let result = json!({"tools": [{"name": "echo", "inputSchema": {"type": "object"}}]});
                            respond(&mut stream, "200 OK", &[json_header], &reply(result)).await;
                        }
                        "tools/call" => {
                            held.received.notify_one();
                            held.release.notified().await;
                            respond(&mut stream, "200 OK", &[json_header], &reply(json!({"content": []}))).await;
                        }
                        _ => respond(&mut stream, "202 Accepted", &[], "").await,
                    }
                });
            }
        }
    });

    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let dir = tempfile::tempdir().unwrap();
    let config = McpServerConfig::from_entry("acme", &json!({"url": format!("http://127.0.0.1:{port}/mcp")}), &Default::default()).unwrap();
    let spiller = mixdog_mcp::result::Spiller::new(dir.path().to_path_buf(), io.durability);
    let server = McpServer::new(config, io, spiller, OutputPolicy::default(), None);
    server.connect().await.unwrap();
    let in_flight = {
        let server = Arc::clone(&server);
        tokio::spawn(async move { server.call_tool("t", "echo", json!({}), &CancellationToken::new(), None).await })
    };
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), held.received.notified()).await.expect("the call reached the server");
    server.reconnect().await.unwrap();
    assert!(sessions.lock().unwrap().1.is_empty(), "the replaced connection is open for its call");

    server.close().await;
    let mut ended = sessions.lock().unwrap().1.clone();
    ended.sort();
    assert_eq!(ended, ["s1", "s2"], "both sessions were ended before the close returned");
    held.release.notify_one();
    let _ = in_flight.await;
}

/// A switch whose new sign-in could not be stored changed nothing: the stored sign-in is the one the open connections
/// were opened as, and they go on renewing it. One that was stored is another sign-in.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_that_could_not_be_stored_is_still_the_one_connections_were_opened_as() {
    let _seams = crate::oauth_seams().await;
    let store = Arc::new(Faulty::default());
    let (_dir, hub, shared, port) = hub_at_the_test_server(store.clone()).await;
    let entry = json!({"url": format!("http://127.0.0.1:{port}/mcp")});
    hub.apply(vec![McpServerConfig::from_entry("acme", &entry, &Default::default()).unwrap()]);
    let server = hub.server("acme").unwrap();
    let mut states = server.subscribe();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), states.wait_for(|s| matches!(**s, ServerState::Failed { .. }))).await.unwrap().unwrap();
    let oauth = hub.oauth("acme").unwrap();
    let session = oauth.login_flow("acme", AccountMode::Connect).start().await.unwrap();
    authorize(session.as_ref(), &shared, port).await;
    hub.reconnect("acme").await.unwrap();
    let opened_as = oauth.sign_in();

    store.writes_fail.store(true, Ordering::SeqCst);
    let unstored = oauth.login_flow("acme", AccountMode::Switch).start().await.unwrap();
    let (done, _) = finish_authorization(unstored.as_ref(), &shared, port).await;
    assert!(matches!(done, LoginState::Failed(_)), "{done:?}");
    assert_eq!(oauth.sign_in(), opened_as, "nothing was stored in its place");
    // The store takes writes again: a renewal stores the token it is given, and would fail on the store otherwise.
    store.writes_fail.store(false, Ordering::SeqCst);
    // The server now accepts only what a renewal of the stored sign-in gives: the open connection renews it.
    let call = server.call_tool("t", "echo", json!({"text": "renewed"}), &CancellationToken::new(), None).await;
    assert_eq!(call.unwrap().parts, vec![ToolPart::Text("renewed".into())]);

    let stored = oauth.login_flow("acme", AccountMode::Switch).start().await.unwrap();
    authorize(stored.as_ref(), &shared, port).await;
    assert_ne!(oauth.sign_in(), opened_as, "another sign-in is stored");
    hub.close_all().await;
}

/// A sign-out is followed by the reconnect of its server. An account's own server, ready on a connection opened as
/// the sign-in that is gone, is connected again with it: no call goes on being sent as the signed-out account.
#[tokio::test(flavor = "multi_thread")]
async fn a_signed_out_accounts_connection_is_ended_by_the_reconnect_that_follows() {
    let _seams = crate::oauth_seams().await;
    let runtime = Runtime::new(one_account).await;
    let linear = work_signed_in(&runtime, one_account).await;
    let work = linear.account_server("work").unwrap();
    let opened = match &*work.state() {
        ServerState::Ready(ready) => Arc::clone(&ready.client),
        other => panic!("{}", other.describe()),
    };

    runtime.glue.hub().oauth_in("a", "work").unwrap().sign_out(false).await.unwrap();
    runtime.glue.scope_runtime().run("a", Op::Only("linear".to_owned(), true)).await;

    let work = runtime.glue.hub().server_in("a", "linear").unwrap().account_server("work").unwrap();
    assert!(matches!(*work.state(), ServerState::Failed { .. }), "the account is not signed in: {}", work.state().describe());
    let mut closed = opened.closed();
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), closed.wait_for(Option::is_some)).await.expect("the signed-out connection is closed").unwrap();
    runtime.glue.hub().close_all().await;
}

fn home_at(port: u16, path: &str) -> Value {
    let url = format!("http://127.0.0.1:{port}/mcp");
    json!({"linear": {"connector": "linear", "url": url, "accounts": [
        {"name": "home", "url": format!("http://127.0.0.1:{port}/{path}"), "oauthKey": "home"},
    ]}})
}

/// An account keeps its credential key when its address changes. The sign-in object made for the old address is not
/// the account's any more: the next sign-in is made for, and stored under, the address the account has now.
#[tokio::test(flavor = "multi_thread")]
async fn a_sign_in_of_an_account_whose_address_changed_is_made_for_the_new_address() {
    let _seams = crate::oauth_seams().await;
    let runtime = Runtime::new(|port| home_at(port, "old")).await;
    let options = json!({"openBrowser": false});
    // No scope is open, so no server is live: the sign-in object is the one kept by credential key.
    if let Ok(began) = with_request_scope(Some("a".to_owned()), runtime.glue.begin_login("home", &options)).await
        && let Some(flow) = began["flowId"].as_str()
    {
        runtime.glue.cancel_login(flow).await.unwrap();
    }

    runtime.agent.0.lock().unwrap().insert("mcpServers".to_owned(), home_at(runtime.port, "mcp"));
    let began = with_request_scope(Some("a".to_owned()), runtime.glue.begin_login("home", &options));
    let began = mixdog_rt::time::timeout(std::time::Duration::from_secs(20), began).await.expect("the sign-in begins in 20 s").expect("the sign-in begins");
    let authorize = Url::parse(began["url"].as_str().expect("the authorization page")).unwrap();
    let query: HashMap<String, String> = authorize.query_pairs().into_owned().collect();
    runtime.shared.lock().unwrap().challenge = Some(query["code_challenge"].clone());
    let callback = Url::parse(&format!("{}?code=the-code&state={}", query["redirect_uri"], query["state"])).unwrap();
    let page = browser_get(&callback).await;
    assert!(page.starts_with("HTTP/1.1 200"), "{page}");
    let stored = runtime.env.store.get(&account_of("mcp-account:home")).await.unwrap().expect("the sign-in is stored");
    let stored: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored["url"], format!("http://127.0.0.1:{}/mcp", runtime.port));
    runtime.glue.hub().close_all().await;
}
