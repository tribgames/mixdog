//! The PreToolUse decision (`BusPreToolHook` over the hook bus) replayed against what today's
//! Node product decided (`tests/golden/pretool.mjs` → `pretool.json`) for 50 sequences of
//! `mcp_tool` handler outputs, matchers and tool names.
#![allow(clippy::disallowed_methods, reason = "test fixtures write the hooks file and run a real stdio process")]

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessInfo;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::process::PtySize;
use mixdog_core_api::domain::process::SpawnRequest;
use mixdog_core_api::domain::process::SpawnedProcess;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::common::EventSource;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::hook_bus::HookBus;
use mixdog_mcp::hook_bus::HookCommon;
use mixdog_mcp::pre_tool::BusPreToolHook;
use mixdog_mcp::result::OutputPolicy;
use mixdog_protocol::ProcessHandle;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_tools::policy::HookAction;
use mixdog_tools::policy::HookCall;
use mixdog_tools::policy::PreToolHook;
use serde_json::Value;
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

fn golden() -> Value {
    serde_json::from_str(include_str!("../golden/pretool.json")).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_pre_tool_decision_matches_node_for_every_recorded_hook_output() {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io };
    for case in golden()["cases"].as_array().unwrap() {
        let label = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let outputs = case["outputs"].as_array().unwrap();
        let handlers: Vec<Value> = (0..outputs.len()).map(|n| json!({"type": "mcp_tool", "server": "mock", "tool": format!("fixture_{n}")})).collect();
        let hooks = json!({"hooks": {"PreToolUse": [{"matcher": case["matcher"], "hooks": handlers}]}});
        std::fs::write(dir.path().join("hooks.json"), hooks.to_string()).unwrap();
        let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
        let entry = json!({"command": MOCK, "env": {"MOCK_FIXTURES": Value::Array(outputs.clone()).to_string()}});
        hub.apply(vec![McpServerConfig::from_entry("mock", &entry, &std::env::vars().collect()).unwrap()]);
        hub.server("mock").unwrap().connect().await.unwrap();
        let bus = HookBus::new(dir.path().to_path_buf(), tokens.maintenance_io, Arc::new(NoProcesses), Some(Arc::clone(&hub)), None, None);
        let hook = BusPreToolHook::new(bus, Arc::new(|_: &ThreadId| HookCommon::default()));
        let args = json!({"file_path": "original.txt"});
        let call_id = ToolCallId::from("call-1");
        let thread = ThreadId::from("thread-1");
        let tool = case["tool"].as_str().unwrap();
        let got = hook
            .pre_tool(&HookCall { call_id: &call_id, thread_id: &thread, name: tool, args: &args, cwd: dir.path() })
            .await
            .unwrap();
        let expected = &case["decision"];
        match (got, expected.is_null()) {
            (None, true) => {}
            (Some(d), true) if d.action == HookAction::Allow && d.name.is_none() && d.args.is_none() => {}
            (Some(d), false) => {
                let action = match d.action {
                    HookAction::Deny => "deny",
                    HookAction::Ask => "ask",
                    HookAction::Rewrite => "modify",
                    HookAction::Allow => "allow",
                };
                assert_eq!(action, expected["action"], "{label}: action");
                assert_eq!(d.reason.as_deref(), expected["reason"].as_str(), "{label}: reason");
                assert_eq!(d.name.as_deref(), expected["name"].as_str(), "{label}: name");
                assert_eq!(d.args.as_ref(), expected.get("args"), "{label}: args");
            }
            (got, _) => panic!("{label}: got {got:?}, Node decided {expected}"),
        }
        let count = hub
            .server("mock")
            .unwrap()
            .call_tool_unlisted("t", "fixture_count", json!({}), &tokio_util::sync::CancellationToken::new(), None)
            .await
            .unwrap();
        let count = match &count.parts[0] {
            mixdog_core_api::domain::tool::ToolPart::Text(t) => t.parse::<usize>().unwrap(),
            other => panic!("{other:?}"),
        };
        // `fixture_count` itself is not a fixture, so the count is the handlers that ran.
        assert_eq!(count, case["calls"].as_array().unwrap().len(), "{label}: handlers run");
        hub.close_all().await;
    }
}
