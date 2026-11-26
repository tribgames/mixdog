//! The pieces of the MCP sign-in a server's metadata and a challenge decide: what a 401's `WWW-Authenticate` names, where the
//! authorization server's endpoints are (RFC 8414 and the legacy default paths), whether PKCE S256 and a scope are offered, which
//! resource the token is asked for (RFC 8707), the PKCE pair (RFC 7636) and the sign-in errors a caller tells apart.

use std::sync::Arc;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_mcp::oauth::OAuthError;
use mixdog_mcp::oauth::protocol::Challenge;
use mixdog_mcp::oauth::protocol::Discovery;
use mixdog_mcp::oauth::protocol::Protocol;
use mixdog_mcp::oauth::protocol::TokenError;
use mixdog_mcp::oauth::protocol::parse_challenge;
use mixdog_mcp::oauth::protocol::pkce;
use mixdog_mcp::oauth::protocol::random_state;
use mixdog_mcp::oauth::shared::is_reauthentication_required;
use mixdog_mcp::oauth::shared::is_scope_not_granted;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tokio::net::TcpListener;
use url::Url;

fn discovery(metadata: Option<serde_json::Value>) -> Discovery {
    Discovery { authorization_server_url: "https://auth.example/base".to_owned(), authorization_server_metadata: metadata, ..Discovery::default() }
}

#[test]
fn a_challenge_names_its_metadata_scope_and_error_and_a_missing_header_names_nothing() {
    let header =
        r#"Bearer realm="mcp", resource_metadata="https://x.example/.well-known/oauth-protected-resource", scope="read write", error="insufficient_scope""#;
    assert_eq!(
        parse_challenge(Some(header)),
        Challenge {
            resource_metadata_url: Some("https://x.example/.well-known/oauth-protected-resource".to_owned()),
            scope: Some("read write".to_owned()),
            error: Some("insufficient_scope".to_owned()),
        }
    );
    assert_eq!(parse_challenge(Some("Bearer")), Challenge::default());
    assert_eq!(parse_challenge(None), Challenge::default());
}

#[test]
fn advertised_endpoints_are_the_ones_used() {
    let advertised = discovery(Some(json!({
        "authorization_endpoint": "https://auth.example/o/authorize",
        "token_endpoint": "https://auth.example/o/token",
        "registration_endpoint": "https://auth.example/o/register",
        "revocation_endpoint": "https://auth.example/o/revoke",
    })));
    assert_eq!(advertised.authorization_endpoint().unwrap().as_str(), "https://auth.example/o/authorize");
    assert_eq!(advertised.token_endpoint().unwrap().as_str(), "https://auth.example/o/token");
    assert_eq!(advertised.registration_endpoint().unwrap().as_str(), "https://auth.example/o/register");
    assert_eq!(advertised.revocation_endpoint().as_deref(), Some("https://auth.example/o/revoke"));
}

#[test]
fn a_server_that_advertises_nothing_gets_the_default_paths_at_its_root() {
    let bare = discovery(None);
    assert_eq!(bare.authorization_endpoint().unwrap().as_str(), "https://auth.example/authorize");
    assert_eq!(bare.token_endpoint().unwrap().as_str(), "https://auth.example/token");
    assert_eq!(bare.registration_endpoint().unwrap().as_str(), "https://auth.example/register");
    assert_eq!(bare.revocation_endpoint(), None);
}

#[test]
fn metadata_that_leaves_an_endpoint_out_gets_no_guessed_one() {
    let partial = discovery(Some(json!({"token_endpoint": "https://auth.example/t"})));
    assert_eq!((partial.authorization_endpoint(), partial.registration_endpoint()), (None, None));
}

#[test]
fn pkce_s256_is_assumed_unless_the_server_lists_methods_without_it_and_a_scope_must_be_listed_to_be_offered() {
    assert!(discovery(None).supports_s256());
    assert!(discovery(Some(json!({}))).supports_s256(), "nothing listed: PKCE is assumed");
    assert!(discovery(Some(json!({"code_challenge_methods_supported": ["plain", "S256"]}))).supports_s256());
    assert!(!discovery(Some(json!({"code_challenge_methods_supported": ["plain"]}))).supports_s256());
    assert!(!discovery(Some(json!({"code_challenge_methods_supported": "S256"}))).supports_s256(), "a list is required");
    let scoped = discovery(Some(json!({"scopes_supported": ["a", "b"]})));
    assert!(scoped.offers_scope("a") && !scoped.offers_scope("c"));
    assert!(!discovery(Some(json!({}))).offers_scope("a") && !discovery(None).offers_scope("a"));
}

#[test]
fn the_resource_is_omitted_without_protected_resource_metadata_else_named_or_fragmentless_server_url() {
    let server = Url::parse("https://mcp.example/v1/mcp#section").unwrap();
    assert_eq!(discovery(None).resource(&server), None);
    let unnamed = Discovery { resource_metadata: Some(json!({})), ..discovery(None) };
    assert_eq!(unnamed.resource(&server).as_deref(), Some("https://mcp.example/v1/mcp"));
    let named = Discovery { resource_metadata: Some(json!({"resource": "https://mcp.example/"})), ..discovery(None) };
    assert_eq!(named.resource(&server).as_deref(), Some("https://mcp.example/"));
    let scopes = Discovery { resource_metadata: Some(json!({"scopes_supported": ["a", 3, "b"]})), ..discovery(None) };
    assert_eq!(scopes.resource_scopes().as_deref(), Some("a b"));
    let none = Discovery { resource_metadata: Some(json!({"scopes_supported": []})), ..discovery(None) };
    assert_eq!((none.resource_scopes(), discovery(None).resource_scopes()), (None, None));
}

async fn spawn_metadata_server(handler: impl Fn(&str, &str) -> (&'static str, String) + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let handler = Arc::new(handler);
    let (seen_task, base_task) = (Arc::clone(&seen), base.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { break };
            let (seen, base, handler) = (Arc::clone(&seen_task), base_task.clone(), Arc::clone(&handler));
            tokio::spawn(async move {
                let (_, path, _, _) = crate::oauth_suite::read_request(&mut stream).await;
                seen.lock().unwrap().push(path.clone());
                let (status, body) = handler(&path, &base);
                let headers = if body.is_empty() { Vec::new() } else { vec![("content-type", "application/json".to_owned())] };
                crate::oauth_suite::respond(&mut stream, status, &headers, &body).await;
            });
        }
    });
    (base, seen)
}

#[tokio::test(flavor = "multi_thread")]
async fn discovery_without_protected_resource_metadata_uses_origin_root_without_query_string() {
    let (base, seen) = spawn_metadata_server(|path, base| match path {
        "/.well-known/oauth-authorization-server" => (
            "200 OK",
            json!({
                "issuer": base,
                "authorization_endpoint": format!("{base}/custom/auth"),
                "token_endpoint": format!("{base}/custom/token"),
                "registration_endpoint": format!("{base}/custom/register"),
                "scopes_supported": ["offline_access"],
            })
            .to_string(),
        ),
        _ => ("404 Not Found", String::new()),
    })
    .await;

    let server = Url::parse(&format!("{base}/v1/mcp?token=secret#frag")).unwrap();
    let discovery = Protocol::new().unwrap().discover(&server, None).await.unwrap();
    assert_eq!(discovery.authorization_server_url, format!("{base}/"));
    assert_eq!(discovery.resource_metadata, None);
    assert_eq!(discovery.resource(&server), None);
    assert_eq!(discovery.authorization_endpoint().unwrap().as_str(), format!("{base}/custom/auth"));
    assert_eq!(discovery.token_endpoint().unwrap().as_str(), format!("{base}/custom/token"));
    assert_eq!(discovery.registration_endpoint().unwrap().as_str(), format!("{base}/custom/register"));
    assert!(discovery.offers_scope("offline_access"));
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["/.well-known/oauth-protected-resource/v1/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server",]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn discovery_stops_fallback_lookups_after_a_5xx() {
    let (prm_base, prm_seen) = spawn_metadata_server(|path, base| match path {
        "/.well-known/oauth-protected-resource/mcp" => ("500 Internal Server Error", String::new()),
        "/.well-known/oauth-protected-resource" => {
            ("200 OK", json!({"resource": format!("{base}/mcp"), "authorization_servers": [format!("{base}/wrong")]}).to_string())
        }
        "/.well-known/oauth-authorization-server" => (
            "200 OK",
            json!({
                "issuer": base,
                "authorization_endpoint": format!("{base}/oauth/auth"),
                "token_endpoint": format!("{base}/oauth/token"),
            })
            .to_string(),
        ),
        _ => ("404 Not Found", String::new()),
    })
    .await;

    let prm_server = Url::parse(&format!("{prm_base}/mcp")).unwrap();
    let discovery = Protocol::new().unwrap().discover(&prm_server, None).await.unwrap();
    assert_eq!(discovery.resource_metadata, None);
    assert_eq!(discovery.authorization_server_url, format!("{prm_base}/"));
    assert_eq!(discovery.authorization_endpoint().unwrap().as_str(), format!("{prm_base}/oauth/auth"));
    assert_eq!(*prm_seen.lock().unwrap(), vec!["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]);

    let (as_base, as_seen) = spawn_metadata_server(|path, base| match path {
        "/.well-known/oauth-authorization-server" => ("503 Service Unavailable", String::new()),
        "/.well-known/openid-configuration" => (
            "200 OK",
            json!({
                "issuer": base,
                "authorization_endpoint": format!("{base}/oidc/auth"),
                "token_endpoint": format!("{base}/oidc/token"),
            })
            .to_string(),
        ),
        _ => ("404 Not Found", String::new()),
    })
    .await;

    let as_server = Url::parse(&format!("{as_base}/mcp")).unwrap();
    assert_eq!(Protocol::new().unwrap().discover(&as_server, None).await, Err(TokenError::Failed));
    assert_eq!(
        *as_seen.lock().unwrap(),
        vec!["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server",]
    );
}

#[test]
fn a_pkce_pair_is_a_long_url_safe_verifier_and_the_s256_challenge_of_it_and_never_repeats() {
    let pair = pkce();
    assert!((43..=128).contains(&pair.verifier.len()), "RFC 7636 §4.1: {}", pair.verifier.len());
    assert!(pair.verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "{}", pair.verifier);
    assert_eq!(pair.challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(pair.verifier.as_bytes())), "RFC 7636 §4.2: S256");
    assert_ne!(pkce().verifier, pair.verifier);
    let (a, b) = (random_state(), random_state());
    assert!(a.len() >= 22 && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "{a}");
    assert_ne!(a, b);
}

#[test]
fn a_connect_that_only_needs_a_sign_in_and_a_scope_not_granted_are_told_apart_from_any_other_failure() {
    let reauth = OAuthError::ReauthenticationRequired.to_string();
    assert!(is_reauthentication_required(&reauth) && !is_scope_not_granted(&reauth));
    assert!(!is_reauthentication_required("connection refused"));
    assert!(!is_scope_not_granted("connection refused"));
}
