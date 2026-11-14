//! The session lifecycle hooks over the bus (`HookBus::session_start`, `user_prompt_submit`, `stop`,
//! `stop_failure`, `session_end`): the payload each `mcp_tool` handler receives, built as Node's
//! `hookCommonPayload({ session_id, ...extra })` builds it (`session-start-hook.mjs`,
//! `turn-prepare.mjs` `dispatchPromptSubmit`, `turn-settle.mjs`, `teardown/session-close.mjs`), what
//! each emitter hands back of the handlers' answer, and the scope reconcile a cwd change runs
//! (`onCwdChanged`, `boot/infrastructure.mjs:299`).
#![allow(clippy::disallowed_methods, reason = "test fixtures write the hooks file")]

use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

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
use mixdog_mcp::hook_bus::TranscriptExport;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::scope_runtime::Resolved;
use mixdog_mcp::scope_runtime::ScopeConfigs;
use mixdog_mcp::scope_runtime::ScopeRuntime;
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

/// The session's transcript file as the session service exports it.
struct Exported;

#[async_trait]
impl TranscriptExport for Exported {
    async fn transcript_path(&self, session_id: &str) -> Value {
        json!(format!("/data/sessions/{session_id}.log.jsonl"))
    }
}

/// A bus over one hooks file whose `event` has one `mcp_tool` handler per entry of `outputs`
/// (what each answers), and the hub that runs them.
async fn wired(dir: &Path, event: &str, matcher: Option<&str>, outputs: &[Value]) -> (Arc<HookBus>, Arc<McpHub>) {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let handlers: Vec<Value> = (0..outputs.len()).map(|n| json!({"type": "mcp_tool", "server": "mock", "tool": format!("fixture_{n}")})).collect();
    let mut group = json!({"hooks": handlers});
    if let Some(matcher) = matcher {
        group["matcher"] = json!(matcher);
    }
    std::fs::write(dir.join("hooks.json"), json!({"hooks": {event: [group]}}).to_string()).unwrap();
    let hub = McpHub::new(io, dir.join("artifacts"), OutputPolicy::default());
    let entry = json!({"command": MOCK, "env": {"MOCK_FIXTURES": Value::Array(outputs.to_vec()).to_string()}});
    hub.apply(vec![McpServerConfig::from_entry("mock", &entry, &std::env::vars().collect()).unwrap()]);
    hub.server("mock").unwrap().connect().await.unwrap();
    let bus = HookBus::new(dir.to_path_buf(), tokens.maintenance_io, Arc::new(NoProcesses), Some(Arc::clone(&hub)), None, None);
    (bus, hub)
}

/// The payloads the handlers received, in order.
async fn received(hub: &McpHub) -> Value {
    let seen = hub.server("mock").unwrap().call_tool_unlisted("t", "fixture_args", json!({}), &tokio_util::sync::CancellationToken::new(), None).await.unwrap();
    match &seen.parts[0] {
        mixdog_core_api::domain::tool::ToolPart::Text(t) => serde_json::from_str::<Value>(t).unwrap(),
        other => panic!("{other:?}"),
    }
}

fn common() -> HookCommon {
    HookCommon { transcript_path: None, permission_mode: Some("plan".to_owned()), effort: Some(json!({"level": "high"})) }
}

/// The fields every payload of session `s1` carries, with the event's own after them.
fn payload(event: &str, cwd: &Path, extra: Value) -> Value {
    let mut payload = json!({
        "session_id": "s1",
        "cwd": cwd.to_string_lossy(),
        "hook_event_name": event,
        "transcript_path": "/data/sessions/s1.log.jsonl",
        "permission_mode": "plan",
        "effort": {"level": "high"},
    });
    for (key, value) in extra.as_object().unwrap() {
        payload[key] = value.clone();
    }
    payload
}

/// `SessionStart`: `{ source, model }`, matched on the source; the handlers' `additionalContext`
/// comes back in handler order (plain output is context for this event).
#[tokio::test(flavor = "multi_thread")]
async fn session_start_sends_source_and_model_and_returns_the_added_context() {
    let dir = tempfile::tempdir().unwrap();
    let outputs = [json!(json!({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "first"}}).to_string()), json!("second"), json!("")];
    let (bus, hub) = wired(dir.path(), "SessionStart", Some("startup"), &outputs).await;
    assert!(bus.bind_transcripts(Arc::new(Exported)).is_ok());
    let cwd = dir.path().join("work");
    let context = bus.session_start("s1", "startup", Some("m-1"), &cwd, &common()).await;
    assert_eq!(context, ["first", "second"]);
    let expected = payload("SessionStart", &cwd, json!({"source": "startup", "model": "m-1"}));
    assert_eq!(received(&hub).await, json!([expected, expected, expected]));
    // The matcher is tested against the source: a resumed session's start runs no `startup` handler.
    assert!(bus.session_start("s1", "resume", None, &cwd, &common()).await.is_empty());
    assert_eq!(received(&hub).await.as_array().unwrap().len(), 3, "no handler ran for another source");
    hub.close_all().await;
}

/// `UserPromptSubmit`: `{ prompt }` as submitted (text or parts); a handler's context is handed
/// back, and a block with its reason; the handlers after a block do not run.
#[tokio::test(flavor = "multi_thread")]
async fn user_prompt_submit_sends_the_prompt_and_returns_context_or_a_block() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work");
    let adds = [json!(json!({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "remember X"}}).to_string()), json!("and Y")];
    let (bus, hub) = wired(dir.path(), "UserPromptSubmit", None, &adds).await;
    assert!(bus.bind_transcripts(Arc::new(Exported)).is_ok());
    let answer = bus.user_prompt_submit("s1", &json!("do it"), &cwd, &common()).await;
    assert!(!answer.blocked);
    assert_eq!(answer.additional_context, ["remember X", "and Y"]);
    let parts = json!([{"type": "text", "text": "look"}, {"type": "image", "attachmentRef": "a"}]);
    bus.user_prompt_submit("s1", &parts, &cwd, &common()).await;
    let seen = received(&hub).await;
    assert_eq!(seen[0], payload("UserPromptSubmit", &cwd, json!({"prompt": "do it"})));
    assert_eq!(seen[2], payload("UserPromptSubmit", &cwd, json!({"prompt": parts})));
    hub.close_all().await;

    let dir = tempfile::tempdir().unwrap();
    let blocks = [json!(json!({"decision": "block", "reason": "not now"}).to_string()), json!("never asked")];
    let (bus, hub) = wired(dir.path(), "UserPromptSubmit", None, &blocks).await;
    let answer = bus.user_prompt_submit("s1", &json!("do it"), &cwd, &common()).await;
    assert!(answer.blocked);
    assert_eq!(answer.reason.as_deref(), Some("not now"));
    assert!(answer.additional_context.is_empty());
    assert_eq!(received(&hub).await.as_array().unwrap().len(), 1, "a block ends the event");
    hub.close_all().await;
}

/// `Stop`, `StopFailure` and `SessionEnd`: the common fields, then `error_type` / `reason`, which
/// the last two are matched on.
#[tokio::test(flavor = "multi_thread")]
async fn stop_stop_failure_and_session_end_send_what_node_does() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work");
    // A `Stop` handler's block changes nothing: the emitter answers nothing.
    let (bus, hub) = wired(dir.path(), "Stop", None, &[json!(json!({"decision": "block", "reason": "go on"}).to_string())]).await;
    assert!(bus.bind_transcripts(Arc::new(Exported)).is_ok());
    bus.stop("s1", &cwd, &common()).await;
    assert_eq!(received(&hub).await, json!([payload("Stop", &cwd, json!({}))]));
    hub.close_all().await;

    let dir = tempfile::tempdir().unwrap();
    let (bus, hub) = wired(dir.path(), "StopFailure", Some("rate_limit"), &[json!("")]).await;
    assert!(bus.bind_transcripts(Arc::new(Exported)).is_ok());
    bus.stop_failure("s1", "unknown", &cwd, &common()).await;
    bus.stop_failure("s1", "rate_limit", &cwd, &common()).await;
    assert_eq!(received(&hub).await, json!([payload("StopFailure", &cwd, json!({"error_type": "rate_limit"}))]));
    hub.close_all().await;

    let dir = tempfile::tempdir().unwrap();
    let (bus, hub) = wired(dir.path(), "SessionEnd", Some("exit"), &[json!("")]).await;
    assert!(bus.bind_transcripts(Arc::new(Exported)).is_ok());
    bus.session_end("s1", "other", &cwd, &common()).await;
    bus.session_end("s1", "exit", &cwd, &common()).await;
    assert_eq!(received(&hub).await, json!([payload("SessionEnd", &cwd, json!({"reason": "exit"}))]));
    hub.close_all().await;
}

/// The folders the scopes were resolved for, in order.
#[derive(Default)]
struct Folders(Mutex<Vec<(String, String)>>);

#[async_trait]
impl ScopeConfigs for Folders {
    async fn resolve(&self, scope: &str, cwd: &str, _only: Option<&str>) -> Resolved {
        self.0.lock().unwrap().push((scope.to_owned(), cwd.to_owned()));
        Resolved { configs: Vec::new(), targets: Vec::new(), data_folders: Vec::new() }
    }
}

/// A cwd change reconciles the session's own scope for the new folder (`onCwdChanged`: plugin
/// servers without a declared cwd follow the runtime's), and every later operation of the scope
/// resolves there; another scope, and one that is not open, are left alone.
#[tokio::test(flavor = "multi_thread")]
async fn a_cwd_change_reconciles_the_sessions_scope_for_the_new_folder() {
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    let folders = Arc::new(Folders::default());
    let scopes = ScopeRuntime::new(Arc::clone(&hub), folders.clone());
    scopes.open("a", "session-a", "/one").await.unwrap();
    scopes.open("b", "session-b", "/other").await.unwrap();
    scopes.cwd_changed("a", "/two").await;
    scopes.cwd_changed("gone", "/nowhere").await;
    scopes.run("a", mixdog_mcp::scope_runtime::Op::Reconcile).await;
    scopes.run("b", mixdog_mcp::scope_runtime::Op::Reconcile).await;
    let seen = folders.0.lock().unwrap().clone();
    let of = |scope: &str| seen.iter().filter(|(s, _)| s == scope).map(|(_, cwd)| cwd.as_str()).collect::<Vec<_>>();
    assert_eq!(of("a"), ["/one", "/two", "/two"], "the first connect, the cwd change's reconcile, a later one");
    assert_eq!(of("b"), ["/other", "/other"]);
    assert_eq!(seen.len(), 5, "a scope that is not open resolves nothing");
    hub.close_all().await;
}
