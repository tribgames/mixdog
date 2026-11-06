//! The session's post-tool hooks (`SessionPostTool` over the hook bus) replayed against what
//! today's Node product sent to the handlers and decided (`tests/golden/posttool.mjs` →
//! `posttool.json`): the payload every `mcp_tool` handler receives for `PostToolUse`,
//! `PostToolUseFailure` and `PostToolBatch`, the replacement the loop uses, and the batch block.
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
use mixdog_mcp::hook_bus::session::PostCall;
use mixdog_mcp::hook_bus::session::SessionPostTool;
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
async fn the_post_tool_hooks_send_and_decide_what_node_does() {
    let golden: Value = serde_json::from_str(include_str!("golden/posttool.json")).unwrap();
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
        let group = if event == "PostToolBatch" { json!({"hooks": handlers}) } else { json!({"matcher": case["matcher"], "hooks": handlers}) };
        std::fs::write(dir.path().join("hooks.json"), json!({"hooks": {event: [group]}}).to_string()).unwrap();
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
        let post = SessionPostTool::new(bus, Arc::new(move |_: &str| common.clone()));
        let cwd = dir.path().join("work").to_string_lossy().into_owned();
        let args = case["args"].clone();
        let call = PostCall { session_id: &session_id, name: case["tool"].as_str().unwrap(), args: &args, cwd: &cwd, result: case["result"].as_str().unwrap() };
        let decision = &case["decision"];
        match event {
            "PostToolUse" => {
                let got = post.tool(&call).await;
                let expected = case["updated"].get("value").cloned();
                assert_eq!(got, expected, "{label}: the replacement");
            }
            "PostToolUseFailure" => post.failure(&call).await,
            _ => {
                let got = post.batch(&session_id, &cwd, 2).await.expect("a batch with calls fires");
                assert_eq!(got.blocked, decision["blocked"] == true, "{label}: blocked");
                if got.blocked {
                    assert_eq!(got.reason.as_deref(), decision["reason"].as_str(), "{label}: reason");
                }
            }
        }
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

/// The transcript a bound export names is the path the handlers receive, placed where Node's
/// payload has it; an event with no handler never asks for the export.
struct CountedExport(std::sync::atomic::AtomicUsize);

#[async_trait]
impl mixdog_mcp::hook_bus::TranscriptExport for CountedExport {
    async fn transcript_path(&self, session_id: &str) -> Value {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        json!(format!("/exports/{session_id}.log.jsonl"))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bound_transcript_export_names_the_path_the_handlers_receive() {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io };
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work").to_string_lossy().into_owned();
    let handlers = json!([{"type": "mcp_tool", "server": "mock", "tool": "fixture_0"}]);
    let (file, text) = (dir.path().join("hooks.json"), json!({"hooks": {"PostToolBatch": [{"hooks": handlers}]}}).to_string());
    mixdog_rt::LaneToken::submit(tokens.maintenance_io, &tokio_util::sync::CancellationToken::new(), move |lane| {
        mixdog_statefile::append_file(lane, &file, text.as_bytes())
    })
    .unwrap()
    .await
    .unwrap()
    .unwrap();
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    let entry = json!({"command": MOCK, "env": {"MOCK_FIXTURES": json!([""]).to_string()}});
    hub.apply(vec![McpServerConfig::from_entry("mock", &entry, &std::env::vars().collect()).unwrap()]);
    hub.server("mock").unwrap().connect().await.unwrap();
    let bus = HookBus::new(dir.path().to_path_buf(), tokens.maintenance_io, Arc::new(NoProcesses), Some(Arc::clone(&hub)), None, None);
    let export = Arc::new(CountedExport(std::sync::atomic::AtomicUsize::new(0)));
    assert!(bus.bind_transcripts(export.clone()).is_ok());
    let post = SessionPostTool::new(bus, Arc::new(|_: &str| HookCommon { permission_mode: Some("plan".into()), ..HookCommon::default() }));

    // An event no handler is configured for runs nothing, so nothing is exported.
    let args = json!({});
    post.failure(&PostCall { session_id: "sess_t", name: "edit", args: &args, cwd: &cwd, result: "failed" }).await;
    assert_eq!(export.0.load(std::sync::atomic::Ordering::SeqCst), 0);

    post.batch("sess_t", &cwd, 2).await;
    assert_eq!(export.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    let seen = hub.server("mock").unwrap().call_tool_unlisted("t", "fixture_args", json!({}), &tokio_util::sync::CancellationToken::new(), None).await.unwrap();
    let mixdog_core_api::domain::tool::ToolPart::Text(text) = &seen.parts[0] else { panic!("{:?}", seen.parts) };
    let payload: Value = serde_json::from_str::<Value>(text).unwrap()[0].clone();
    assert_eq!(
        serde_json::to_string(&payload).unwrap(),
        json!({"session_id": "sess_t", "cwd": cwd, "hook_event_name": "PostToolBatch", "transcript_path": "/exports/sess_t.log.jsonl", "permission_mode": "plan"}).to_string()
    );
    hub.close_all().await;
}
