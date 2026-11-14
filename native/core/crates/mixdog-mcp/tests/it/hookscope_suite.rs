//! An `mcp_tool` hook runs in the scope of the runtime it belongs to (`scopeId: rt.mcpScopeId`,
//! `boot/infrastructure.mjs:98`): the session's own when the payload names a live session, the
//! daemon's runtime scope when it names none, and a scope that holds nothing when the session's runtime is
//! gone (Node's disconnected scope: `MCP server "x" not connected`, `mcp/client.mjs:499`).
#![allow(clippy::disallowed_methods, reason = "test fixtures write the hooks file and run a real stdio process")]

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessInfo;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::process::SpawnedProcess;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::HookCommon;
use mixdog_mcp::result::OutputPolicy;
use mixdog_protocol::ProcessHandle;
use serde_json::json;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");
/// The handlers here are `mcp_tool`s: no process is ever started.
struct NoProcesses;

#[async_trait]
impl ProcessManager for NoProcesses {
    async fn spawn(&self, _: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
        Err(ProcessError::UnknownHandle)
    }
    fn subscribe(&self, _: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
        Err(ProcessError::UnknownHandle)
    }
    async fn write_stdin(&self, _: &ProcessHandle, _: Vec<u8>) -> Result<(), ProcessError> {
        Err(ProcessError::UnknownHandle)
    }
    fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Err(ProcessError::UnknownHandle)
    }
    fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
        Err(ProcessError::UnknownHandle)
    }
    fn kill(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
        Err(ProcessError::UnknownHandle)
    }
    fn list(&self) -> Vec<ProcessInfo> {
        Vec::new()
    }
}

/// How many times the server of `scope` ran a fixture (its hook handler ran).
async fn runs(hub: &McpHub, scope: &str) -> usize {
    let out = hub
        .server_in(scope, "mock")
        .unwrap()
        .call_tool_unlisted("t", "fixture_count", json!({}), &tokio_util::sync::CancellationToken::new(), None)
        .await
        .unwrap();
    match &out.parts[0] {
        mixdog_core_api::domain::tool::ToolPart::Text(t) => t.parse().unwrap(),
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hook_runs_in_its_runtimes_scope_and_a_gone_runtime_has_none() {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let dir = tempfile::tempdir().unwrap();
    let hooks = json!({"hooks": {"CwdChanged": [{"hooks": [{"type": "mcp_tool", "server": "mock", "tool": "fixture_0"}]}]}});
    std::fs::write(dir.path().join("hooks.json"), hooks.to_string()).unwrap();
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    let runtime = hub.runtime_scope().to_owned();
    for scope in [runtime.as_str(), "s1"] {
        // A configuration of its own in each scope, so each runs its own process and counts its own runs: scopes that
        // connect the same configuration share one process (`_sharedStdio`).
        let entry = json!({"command": MOCK, "env": {"MOCK_FIXTURES": json!([""]).to_string(), "MOCK_SCOPE": scope}});
        let config = McpServerConfig::from_entry("mock", &entry, &std::env::vars().collect()).unwrap();
        hub.apply_in(scope, vec![config]);
        hub.server_in(scope, "mock").unwrap().connect().await.unwrap();
    }
    let bus = HookBus::new(dir.path().to_path_buf(), tokens.maintenance_io, Arc::new(NoProcesses), Some(Arc::clone(&hub)), None, None);
    // Sessions: `s-live` holds scope `s1`; `s-gone` has no runtime any more.
    assert!(bus.bind_scopes(Arc::new(|id: &str| (id == "s-live").then(|| "s1".to_owned()))).is_ok());
    let common = HookCommon::default();
    let cwd: &Path = dir.path();

    // No `session_id`: the daemon's runtime, whatever the payload says.
    bus.cwd_changed("", cwd, &common).await;
    assert_eq!((runs(&hub, &runtime).await, runs(&hub, "s1").await), (1, 0), "a payload with no session runs in the runtime scope");
    // A live session: its own scope, not the runtime's.
    bus.cwd_changed("s-live", cwd, &common).await;
    assert_eq!((runs(&hub, &runtime).await, runs(&hub, "s1").await), (1, 1));
    // A session whose runtime is gone holds no scope: the handler finds no server, as in Node, and
    // nothing runs in anyone else's.
    bus.cwd_changed("s-gone", cwd, &common).await;
    assert_eq!((runs(&hub, &runtime).await, runs(&hub, "s1").await), (1, 1));
    hub.close_all().await;
}