//! A stdio server that cannot start, exits, never answers or dies, replayed against what today's Node said
//! (`fixtures/stdio-spawn/golden.json`, recorded by `record-stdio-spawn.mjs` through the real client and the SDK's
//! `StdioClientTransport`): the failure text a server row shows.
#![cfg(windows)]
#![allow(clippy::disallowed_methods, reason = "test fixtures read artifacts directly")]

use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Spiller;
use mixdog_mcp::server::ServerState;
use serde_json::Value;

const GOLDEN: &str = include_str!("../../../../fixtures/stdio-spawn/golden.json");
const CLOSED: &str = "MCP error -32000: Connection closed\n--- server stderr (tail) ---\n";

#[tokio::test(flavor = "multi_thread")]
async fn a_stdio_server_that_fails_reads_as_nodes_row() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io };
    for case in golden["connect"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let entry: Value = serde_json::from_str(&case["entry"].to_string().replace("<ROOT>", &root.replace('\\', "\\\\"))).unwrap();
        let config = McpServerConfig::from_entry(name, &entry, &std::env::vars().collect()).unwrap();
        let server = McpServer::new(config, io, Spiller::new(dir.path().to_path_buf(), io.durability), OutputPolicy::default(), None);
        let connected = server.connect().await;
        let wanted = if case["status"].is_null() { &case["failure"] } else { &case["status"]["error"] };
        let rx = &mut server.subscribe();
        let state = rx.wait_for(|s| matches!(**s, ServerState::Failed { .. })).await.unwrap().clone();
        let ServerState::Failed { cause } = &*state else { unreachable!() };
        assert_eq!(connected.is_err(), !case["failure"].is_null(), "{name}");
        // cmd.exe's own words are in the language of the machine that recorded them.
        if case["localeBound"] == true {
            assert!(cause.starts_with(CLOSED) && cause.len() > CLOSED.len(), "{name}: {cause}");
        } else {
            assert_eq!(cause, wanted.as_str().unwrap(), "{name}");
        }
        if let Err(error) = connected {
            assert_eq!(error.to_string(), case["failure"].as_str().unwrap().split("\n---").next().unwrap(), "{name}");
        }
        server.close().await;
    }
}
