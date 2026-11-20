//! The tools a native provider's request carries (`request_definitions`): the session's stored tools once each, and for a
//! native-deferred Anthropic-family session the catalog tools the conversation discovered, marked for deferred loading.

use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Value;
use serde_json::json;

use super::context_world::request_definitions;

fn tool(name: &str) -> Value {
    json!({ "name": name, "description": format!("{name} tool"), "inputSchema": { "type": "object" } })
}

fn header(session: Value) -> serde_json::Map<String, Value> {
    session.as_object().expect("a session object").clone()
}

/// `(name, defer_loading)` of each definition, in request order.
fn listed(definitions: &[ToolDefinition]) -> Vec<(&str, bool)> {
    definitions.iter().map(|definition| (definition.name.as_str(), definition.defer_loading)).collect()
}

fn deferred_session() -> serde_json::Map<String, Value> {
    header(json!({
        "deferredNativeTools": true,
        "deferredToolCatalog": [tool("grep"), tool("glob"), tool("mcp__srv__ping")],
        "deferredLateToolCatalog": [tool("mcp__srv__late")],
    }))
}

#[test]
fn the_stored_tools_ride_the_request_once_each_in_session_order() {
    let docs = [tool("read"), json!("not a tool"), tool("edit"), tool("read"), json!({ "description": "nameless" })];
    let definitions = request_definitions(&header(json!({})), &docs, &[], "openai");
    assert_eq!(listed(&definitions), [("read", false), ("edit", false)]);
    assert_eq!(definitions[0].description, "read tool");
    assert_eq!(definitions[0].input_schema, json!({ "type": "object" }));
}

#[test]
fn a_tool_schema_is_read_from_the_first_key_that_holds_one() {
    let docs = [json!({ "name": "a", "input_schema": { "type": "object", "x": 1 }, "inputSchema": null }), json!({ "name": "b", "parameters": { "p": 1 } })];
    let definitions = request_definitions(&header(json!({})), &docs, &[], "openai");
    assert_eq!(definitions[0].input_schema, json!({ "type": "object", "x": 1 }));
    assert_eq!(definitions[1].input_schema, json!({ "p": 1 }));
}

#[test]
fn a_native_deferred_anthropic_session_adds_the_discovered_catalog_tools_as_deferred_after_its_own() {
    let mut session = deferred_session();
    session.insert("deferredDiscoveredTools".into(), json!(["glob"]));
    let definitions = request_definitions(&session, &[tool("read")], &[], "anthropic");
    // `grep` is the anchor: the first non-MCP catalog tool the request does not already carry keeps tool-search mode in the cached prefix.
    assert_eq!(listed(&definitions), [("read", false), ("grep", true), ("glob", true)]);
}

#[test]
fn a_tool_the_transcript_referenced_is_deferred_too_but_only_for_the_provider_that_searched() {
    let session = deferred_session();
    let row = |provider: &str| json!({ "role": "tool", "nativeToolSearch": { "provider": provider, "toolReferences": ["mcp__srv__ping"] } });
    let names = |rows: &[Value], provider: &str| {
        request_definitions(&session, &[tool("read")], rows, provider).iter().map(|definition| definition.name.clone()).collect::<Vec<_>>()
    };
    assert_eq!(names(&[row("anthropic")], "anthropic"), ["read", "grep", "mcp__srv__ping"]);
    assert_eq!(
        names(&[row("anthropic")], "anthropic-oauth"),
        ["read", "grep", "mcp__srv__ping"],
        "the two first-party Anthropic providers share their searches"
    );
    assert_eq!(names(&[row("openai")], "anthropic"), ["read", "grep"], "another provider's search says nothing here");
}

#[test]
fn a_late_catalog_entry_replaces_an_earlier_one_of_the_same_name() {
    let mut session = deferred_session();
    session.insert("deferredDiscoveredTools".into(), json!(["mcp__srv__ping"]));
    session.insert("deferredLateToolCatalog".into(), json!([{ "name": "mcp__srv__ping", "description": "newer", "inputSchema": {} }]));
    let definitions = request_definitions(&session, &[tool("read")], &[], "anthropic");
    let ping = definitions.iter().find(|definition| definition.name == "mcp__srv__ping").expect("ping rides the request");
    assert_eq!((ping.description.as_str(), ping.defer_loading), ("newer", true));
}

#[test]
fn only_a_native_deferred_anthropic_family_session_defers_anything() {
    let mut discovered = deferred_session();
    discovered.insert("deferredDiscoveredTools".into(), json!(["glob"]));
    assert_eq!(listed(&request_definitions(&discovered, &[tool("read")], &[], "openai")), [("read", false)], "another family");
    assert_eq!(listed(&request_definitions(&discovered, &[tool("read")], &[], "gemini")), [("read", false)], "a provider with no native search");
    discovered.insert("deferredNativeTools".into(), json!(false));
    assert_eq!(listed(&request_definitions(&discovered, &[tool("read")], &[], "anthropic")), [("read", false)], "a session that is not native-deferred");
    let session = deferred_session();
    assert!(request_definitions(&session, &[], &[], "anthropic").is_empty(), "no tools, nothing deferred");
}

#[test]
fn a_catalog_tool_the_request_already_carries_is_not_added_again() {
    let mut session = deferred_session();
    session.insert("deferredDiscoveredTools".into(), json!(["glob"]));
    let definitions = request_definitions(&session, &[tool("read"), tool("glob")], &[], "anthropic");
    assert_eq!(listed(&definitions), [("read", false), ("glob", false), ("grep", true)]);
}
