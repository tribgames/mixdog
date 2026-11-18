//! A connected server's tool is published as a stored entry that carries its publisher, and that publisher is what later
//! judges a withdrawal: through a persisted copy and a hub that has seen nothing of the earlier run.
#![allow(clippy::disallowed_methods, reason = "test fixtures")]

use std::sync::Arc;

use mixdog_core_api::domain::tool::Provenance;
use mixdog_core_api::domain::tool::StoredTool;
use mixdog_core_api::domain::tool::Tool;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use serde_json::Value;
use serde_json::json;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");

/// A hub whose server `fs` lists `tools` (by their own names); connected or only configured.
async fn hub_listing(tools: &[&str], connect: bool) -> (Arc<McpHub>, tempfile::TempDir) {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    let listed: Vec<Value> = tools.iter().map(|tool| json!({"name": tool, "inputSchema": {"type": "object"}})).collect();
    let entry = json!({"command": MOCK, "env": {"MOCK_SCENARIO": json!({"tools": listed, "results": {}}).to_string()}});
    hub.apply(vec![McpServerConfig::from_entry("fs", &entry, &std::env::vars().collect()).unwrap()]);
    if connect {
        hub.server("fs").unwrap().connect().await.unwrap();
    }
    (hub, dir)
}

fn tool_of(hub: &McpHub, qualified: &str) -> Arc<dyn Tool> {
    hub.tools().into_iter().find(|tool| tool.spec().name == qualified).unwrap_or_else(|| panic!("{qualified} is listed"))
}

/// The restart case, by production construction: an ordinary unshortened tool is published by its server and persisted; the
/// runtime is destroyed; a new hub whose server publishes without it withdraws it from the persisted entry alone, while a hub
/// whose server is only down withdraws nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_persisted_entry_is_withdrawn_by_its_recorded_publisher_after_a_restart() {
    let (first, _dir) = hub_listing(&["t", "other"], true).await;
    let stored = tool_of(&first, "mcp__fs__t").stored();
    assert_eq!(stored.provenance(), &Provenance::Mcp { server: "fs".into(), tool: Some("t".into()) });
    let keys: Vec<&str> = stored.stored().as_object().unwrap().keys().map(String::as_str).take(3).collect();
    assert_eq!(keys, ["name", "mcpToolName", "mcpServerName"], "the publisher is stored right after the name, unshortened or not");
    let persisted = serde_json::to_string(&stored.encode()).unwrap();
    first.close_all().await;
    drop(first);

    let reloaded = StoredTool::decode(&serde_json::from_str(&persisted).unwrap());
    assert_eq!(reloaded, stored, "the entry survives persistence whole");
    let publisher = reloaded.publisher().expect("a known publisher");

    let (down, _dir_down) = hub_listing(&["t", "other"], false).await;
    assert!(!down.withdrawn("mcp__fs__t", publisher), "a server that is only down withdraws nothing");
    let (publishing, _dir_publishing) = hub_listing(&["other"], true).await;
    assert!(publishing.withdrawn("mcp__fs__t", publisher), "its publisher published a catalog without it");
    assert!(!publishing.withdrawn("mcp__fs__other", publisher), "what it still lists stays");
    publishing.close_all().await;
}

/// A stored entry with no recorded publisher is legacy-unknown: decoded as such, kept whole, and no hub is asked about it.
#[test]
fn an_entry_stored_without_a_publisher_is_legacy_unknown() {
    let legacy = json!({"name": "mcp__fs__t", "description": "d", "inputSchema": {"type": "object"}});
    let entry = StoredTool::decode(&legacy);
    assert_eq!(entry.provenance(), &Provenance::LegacyUnknown);
    assert_eq!(entry.publisher(), None);
    assert_eq!(entry.encode(), legacy);
}
