//! Which routes refresh the statusline usage reading, what an internal run is, and which stored sessions the user can open.

use mixdog_core_ports::ports::route::Route;
use serde_json::{Value, json};

use super::internal_kind;
use super::is_openable;
use super::sources::statusline_target;

fn route(value: Value) -> Route {
    value.as_object().cloned().unwrap()
}

#[test]
fn only_a_registered_oauth_provider_refreshes_the_reading() {
    let registered = |name: &str| name == "openai-oauth";
    assert_eq!(
        statusline_target(&route(json!({ "provider": "openai-oauth", "model": "gpt-x" })), &registered),
        Some(("openai-oauth".to_owned(), "gpt-x".to_owned()))
    );
    assert_eq!(
        statusline_target(&route(json!({ "provider": " openai-oauth ", "model": " m " })), &registered),
        Some(("openai-oauth".to_owned(), "m".to_owned())),
        "names are trimmed"
    );
    assert_eq!(statusline_target(&route(json!({ "provider": "openai", "model": "m" })), &|_| true), None, "an API-key provider has no reading");
    assert_eq!(
        statusline_target(&route(json!({ "provider": "anthropic-oauth", "model": "m" })), &registered),
        None,
        "an unregistered one has nothing to refresh"
    );
    assert_eq!(statusline_target(&route(json!({})), &|_| true), None);
}

#[test]
fn the_title_run_is_internal_and_the_users_own_conversation_is_not() {
    assert_eq!(internal_kind("session-title"), "session-title");
    assert_eq!(internal_kind(" Session-Title "), "session-title");
    assert_eq!(internal_kind(""), "");
}

#[test]
fn an_internal_run_is_never_openable_and_an_agent_child_is_when_an_owner_links_it() {
    assert!(!is_openable(&json!("not a row"), ""));
    let child = json!({ "agent": "reviewer", "ownerSessionId": "r_owner", "owner": "agent" });
    assert!(is_openable(&child, ""), "its own owner link");
    let unlinked = json!({ "agent": "reviewer", "owner": "agent" });
    assert!(is_openable(&unlinked, "r_owner"), "the request names the owner");
    let title = json!({ "agent": "reviewer", "ownerSessionId": "r_owner", "sourceType": "session-title" });
    assert!(!is_openable(&title, "r_owner"));
}
