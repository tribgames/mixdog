//! What an MCP server editor's input becomes in the stored config: the name slug, the transport a URL or a command makes, the
//! per-server timeouts, and how a partial edit merges over the stored entry.

use std::path::Path;

use mixdog_mcp::mcp_server_input::merge_mcp_server_config;
use mixdog_mcp::mcp_server_input::merged_server_input;
use mixdog_mcp::mcp_server_input::normalize_mcp_server_input;
use serde_json::Value;
use serde_json::json;

fn normalize(input: Value) -> Result<(String, Value), String> {
    normalize_mcp_server_input(&input, Path::new("/work"), Path::new("/home/user"))
}

#[test]
fn a_name_becomes_a_lowercase_slug_and_one_with_nothing_left_is_refused() {
    let (name, _) = normalize(json!({"name": "  My Server_1.0! ", "command": "run"})).unwrap();
    assert_eq!(name, "my-server_1.0");
    let (name, _) = normalize(json!({"name": "a  b///c", "command": "run"})).unwrap();
    assert_eq!(name, "a-b-c");
    assert_eq!(normalize(json!({"name": "!!!", "command": "run"})).unwrap_err(), "MCP server name is required");
    assert_eq!(normalize(json!({"command": "run"})).unwrap_err(), "MCP server name is required");
}

#[test]
fn a_url_is_an_http_server_unless_it_says_websocket_or_names_its_type() {
    let kind = |input: Value| normalize(input).unwrap().1["type"].as_str().unwrap().to_owned();
    assert_eq!(kind(json!({"name": "s", "url": "https://x.example/mcp"})), "http");
    assert_eq!(kind(json!({"name": "s", "url": "wss://x.example/live"})), "ws");
    assert_eq!(kind(json!({"name": "s", "url": "https://x.example/mcp", "type": "sse"})), "sse");
    assert_eq!(kind(json!({"name": "s", "url": "https://x.example/mcp", "type": "streamable-http"})), "http");
    assert_eq!(kind(json!({"name": "s", "url": "https://x.example/mcp", "type": "WS"})), "ws");
}

#[test]
fn a_url_server_keeps_its_address_as_typed_and_its_headers_and_credentials_as_text() {
    assert_eq!(normalize(json!({"name": "s", "url": "https://x.example"})).unwrap().1["url"], "https://x.example");
    let (_, config) = normalize(json!({
        "name": "s", "url": "https://x.example/mcp", "headers": {"A": 1, "B": null}, "bearerTokenEnvVar": " TOKEN ", "oauthClientId": "cid"
    }))
    .unwrap();
    assert_eq!(config["headers"], json!({"A": "1"}));
    assert_eq!(config["bearer_token_env_var"], "TOKEN");
    assert_eq!(config["oauthClientId"], "cid");
}

#[test]
fn a_command_is_a_stdio_server_with_its_arguments_split_and_its_environment_as_text() {
    let (_, config) = normalize(json!({"name": "s", "command": " npx ", "args": "-y   pkg", "env": {"A": 1, "B": null}, "env_vars": ["X", " ", "Y"]})).unwrap();
    assert_eq!(config, json!({"type": "stdio", "command": "npx", "args": ["-y", "pkg"], "env": {"A": "1"}, "env_vars": ["X", "Y"]}));
    let (_, listed) = normalize(json!({"name": "s", "command": "run", "args": ["a", 3, ""]})).unwrap();
    assert_eq!(listed["args"], json!(["a", "3"]), "a listed argument is read as text and an empty one is dropped");
    assert_eq!(normalize(json!({"name": "s"})).unwrap_err(), "MCP server command or URL is required");
}

#[test]
fn timeouts_are_stored_under_the_keys_the_client_reads_and_must_be_positive_numbers() {
    let stored = |extra: Value| {
        let mut input = json!({"name": "s", "command": "run"});
        input.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        normalize(input)
    };
    assert_eq!(stored(json!({"toolTimeoutSec": 1.5})).unwrap().1["timeoutMs"].as_f64(), Some(1500.0));
    assert_eq!(stored(json!({"timeoutMs": 2.5})).unwrap().1["timeoutMs"].as_f64(), Some(3.0), "milliseconds round half up");
    assert_eq!(stored(json!({"startupTimeoutSec": 5})).unwrap().1["startupTimeoutSec"].as_f64(), Some(5.0));
    assert_eq!(stored(json!({"startupTimeoutMs": 100})).unwrap().1["startupTimeoutMs"].as_f64(), Some(100.0));
    assert_eq!(stored(json!({"toolTimeoutSec": -1})).unwrap_err(), "toolTimeoutSec must be a positive number");
    assert_eq!(stored(json!({"timeoutMs": "soon"})).unwrap_err(), "timeoutMs must be a positive number");
    assert_eq!(stored(json!({"startupTimeoutSec": 0})).unwrap_err(), "startupTimeoutSec must be a positive number");
    assert!(stored(json!({"toolTimeoutSec": ""})).unwrap().1.get("timeoutMs").is_none(), "an empty value sets nothing");
}

#[test]
fn a_new_transport_replaces_the_old_one_whole_and_a_new_timeout_replaces_only_its_own_group() {
    let existing = json!({"type": "http", "url": "https://old.example/", "headers": {"A": "1"}, "timeoutMs": 5, "note": "keep"});
    let merged = merge_mcp_server_config(&existing, &json!({"command": "run", "startupTimeoutSec": 3}));
    assert_eq!(merged, json!({"timeoutMs": 5, "note": "keep", "command": "run", "startupTimeoutSec": 3}));
    let retimed = merge_mcp_server_config(&json!({"timeoutMs": 5, "call_timeout_ms": 9}), &json!({"timeout_ms": 7}));
    assert_eq!(retimed, json!({"timeout_ms": 7}), "every spelling of the call timeout goes");
}

#[test]
fn a_partial_edit_keeps_the_stored_credentials_until_the_transport_itself_changes() {
    let existing = json!({"type": "http", "url": "https://x.example/", "headers": {"Authorization": "t"}, "note": "keep"});
    let patched = merged_server_input(&json!({"headers": {"X": "1"}}), &existing, "srv");
    assert_eq!(patched["headers"], json!({"Authorization": "t", "X": "1"}));
    assert_eq!((patched["url"].as_str(), patched["note"].as_str(), patched["name"].as_str()), (Some("https://x.example/"), Some("keep"), Some("srv")));
    let renamed = merged_server_input(&json!({"name": " New "}), &existing, "srv");
    assert_eq!(renamed["name"], "New");
    // A command on a server that was a URL one is a new transport: nothing of the old one is carried over.
    let switched = merged_server_input(&json!({"command": "run"}), &existing, "srv");
    assert_eq!(switched, json!({"command": "run", "name": "srv"}));
}
