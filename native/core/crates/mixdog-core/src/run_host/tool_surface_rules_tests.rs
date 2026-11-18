//! The tool catalog a session can load from: the boot catalog and the tools servers published later, merged by name with the
//! newer definition winning and the first position kept, minus what the session denies (and the retired staging tool).

use mixdog_agent::env::Clock;
use serde_json::Value;
use serde_json::json;

use super::tool_surface::SurfaceHost;
use super::tool_surface::ToolSurface;

struct Fixed;

impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        1
    }
}

struct Host;

impl SurfaceHost for Host {
    fn bridge_tools(&self) -> Vec<Value> {
        Vec::new()
    }
    fn mcp_server_instructions(&self, _: Option<&str>) -> Value {
        json!({})
    }
    fn defined(&self, _: &str) -> bool {
        true
    }
}

fn tool(name: &str, description: &str) -> Value {
    json!({ "name": name, "description": description })
}

fn union(session: Value) -> Vec<Value> {
    ToolSurface { host: &Host, clock: &Fixed }.catalog_union(&session)
}

fn names(tools: &[Value]) -> Vec<&str> {
    tools.iter().map(|tool| tool["name"].as_str().expect("a name")).collect()
}

#[test]
fn a_session_with_no_late_tools_loads_from_its_boot_catalog_as_it_is() {
    let tools = union(json!({ "deferredToolCatalog": [tool("a", "boot a"), tool("b", "boot b")] }));
    assert_eq!(tools, [tool("a", "boot a"), tool("b", "boot b")]);
    assert!(union(json!({})).is_empty());
}

#[test]
fn a_later_published_definition_replaces_the_boot_one_in_the_boot_ones_place_and_new_names_follow() {
    let tools = union(json!({
        "deferredToolCatalog": [tool("a", "boot a"), tool("mcp__s__x", "old x"), tool("b", "boot b")],
        "deferredLateToolCatalog": [tool("mcp__s__y", "late y"), tool("mcp__s__x", "new x")],
    }));
    assert_eq!(names(&tools), ["a", "mcp__s__x", "b", "mcp__s__y"]);
    assert_eq!(tools[1]["description"], "new x");
}

#[test]
fn a_denied_tool_and_the_retired_staging_tool_are_not_in_the_catalog() {
    let tools = union(json!({
        "disallowedTools": [" b "],
        "deferredToolCatalog": [tool("a", "a"), tool("b", "b"), tool("git_stage", "retired")],
        "deferredLateToolCatalog": [tool("c", "c"), tool("b", "b again"), tool("git_stage", "retired again")],
    }));
    assert_eq!(names(&tools), ["a", "c"]);
}

#[test]
fn an_entry_without_a_name_is_never_in_a_merged_catalog() {
    let tools = union(json!({
        "deferredToolCatalog": [tool("a", "a"), json!({ "description": "nameless" })],
        "deferredLateToolCatalog": [tool("b", "b"), json!({ "name": "  " })],
    }));
    assert_eq!(names(&tools), ["a", "b"]);
}
