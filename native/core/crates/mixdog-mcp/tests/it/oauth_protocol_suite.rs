//! The pieces of the MCP sign-in a server's metadata and a challenge decide: what a 401's `WWW-Authenticate` names, where the
//! authorization server's endpoints are (RFC 8414 and the legacy default paths), whether PKCE S256 and a scope are offered, which
//! resource the token is asked for (RFC 8707), the PKCE pair (RFC 7636) and the sign-in errors a caller tells apart.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_mcp::oauth::OAuthError;
use mixdog_mcp::oauth::protocol::Challenge;
use mixdog_mcp::oauth::protocol::Discovery;
use mixdog_mcp::oauth::protocol::parse_challenge;
use mixdog_mcp::oauth::protocol::pkce;
use mixdog_mcp::oauth::protocol::random_state;
use mixdog_mcp::oauth::shared::is_reauthentication_required;
use mixdog_mcp::oauth::shared::is_scope_not_granted;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
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
fn the_resource_asked_for_is_the_one_the_server_names_else_its_own_url_without_a_fragment() {
    let server = Url::parse("https://mcp.example/v1/mcp#section").unwrap();
    assert_eq!(discovery(None).resource(&server), "https://mcp.example/v1/mcp");
    let named = Discovery { resource_metadata: Some(json!({"resource": "https://mcp.example/"})), ..discovery(None) };
    assert_eq!(named.resource(&server), "https://mcp.example/");
    let scopes = Discovery { resource_metadata: Some(json!({"scopes_supported": ["a", 3, "b"]})), ..discovery(None) };
    assert_eq!(scopes.resource_scopes().as_deref(), Some("a b"));
    let none = Discovery { resource_metadata: Some(json!({"scopes_supported": []})), ..discovery(None) };
    assert_eq!((none.resource_scopes(), discovery(None).resource_scopes()), (None, None));
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
