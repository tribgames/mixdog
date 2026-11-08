//! The session's compaction hooks (`HookBus::compact`) replayed against what today's Node product
//! sent to the handlers (`tests/golden/compact.mjs` -> `compact.json`): the payload every `mcp_tool`
//! handler receives for `PreCompact` and `PostCompact`, and that a matcher on the trigger selects them.
#![allow(clippy::disallowed_methods, reason = "test fixtures write the hooks file")]

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

/// The golden with its `<DIR>` placeholder replaced in every string.
fn unmask(value: &Value, dir: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace("<DIR>", dir)),
        Value::Array(items) => Value::Array(items.iter().map(|v| unmask(v, dir)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), unmask(v, dir))).collect()),
        other => other.clone(),
    }
}


#[tokio::test(flavor = "multi_thread")]
async fn the_compaction_hooks_send_what_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../golden/compact.json")).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io };
    let session_id = golden["common"]["session_id"].as_str().unwrap().to_owned();
    for case in golden["cases"].as_array().unwrap() {
        let label = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dir_text = dir.path().to_string_lossy().into_owned();
        let case = unmask(case, &dir_text);
        let common_json = unmask(&golden["common"], &dir_text);
        let outputs = case["outputs"].as_array().unwrap();
        let event = case["event"].as_str().unwrap();
        let handlers: Vec<Value> = (0..outputs.len()).map(|n| json!({"type": "mcp_tool", "server": "mock", "tool": format!("fixture_{n}")})).collect();
        std::fs::write(dir.path().join("hooks.json"), json!({"hooks": {event: [{"matcher": case["matcher"], "hooks": handlers}]}}).to_string()).unwrap();
        let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
        let entry = json!({"command": MOCK, "env": {"MOCK_FIXTURES": Value::Array(outputs.clone()).to_string()}});
        hub.apply(vec![McpServerConfig::from_entry("mock", &entry, &std::env::vars().collect()).unwrap()]);
        hub.server("mock").unwrap().connect().await.unwrap();
        let bus = HookBus::new(dir.path().to_path_buf(), tokens.maintenance_io, Arc::new(NoProcesses), Some(Arc::clone(&hub)), None, None);
        let common = HookCommon {
            transcript_path: common_json["transcript_path"].as_str().map(str::to_owned),
            permission_mode: common_json["permission_mode"].as_str().map(str::to_owned),
            effort: common_json.get("effort").cloned(),
        };
        let cwd = dir.path().join("work");
        // The recorded input has no trigger, or one of the strings; `null` is "no trigger" (Node's `{}`).
        let trigger = case["trigger"].as_str().unwrap_or("");
        bus.compact(event == "PostCompact", &session_id, trigger, &cwd, &common).await;
        let seen = hub
            .server("mock")
            .unwrap()
            .call_tool_unlisted("t", "fixture_args", json!({}), &tokio_util::sync::CancellationToken::new(), None)
            .await
            .unwrap();
        let seen = match &seen.parts[0] {
            mixdog_core_api::domain::tool::ToolPart::Text(t) => serde_json::from_str::<Value>(t).unwrap(),
            other => panic!("{other:?}"),
        };
        assert_eq!(seen, case["payloads"], "{label}: what the handlers received");
        hub.close_all().await;
    }
}

