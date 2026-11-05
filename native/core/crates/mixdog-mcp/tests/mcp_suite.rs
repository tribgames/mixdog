//! MCP plugin suite: the client against a real stdio server process (`mock/server.rs`).
#![allow(clippy::disallowed_methods, reason = "test fixtures read artifacts directly")]

use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Spiller;
use mixdog_mcp::rpc::RpcError;
use mixdog_mcp::server::CallError;
use mixdog_mcp::server::ServerState;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");

fn io() -> McpIo {
    let tokens = mixdog_rt::testing::tokens();
    McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io }
}

fn config(name: &str, extra: Value) -> McpServerConfig {
    let mut entry = json!({"command": MOCK});
    entry.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    let env = std::env::vars().collect();
    McpServerConfig::from_entry(name, &entry, &env).unwrap()
}

fn server(extra: Value, artifacts: &std::path::Path) -> Arc<McpServer> {
    let spiller = Spiller::new(artifacts.to_path_buf(), io().durability);
    McpServer::new(config("mock", extra), io(), spiller, OutputPolicy::default(), None)
}

async fn ready(extra: Value, artifacts: &std::path::Path) -> Arc<McpServer> {
    let server = server(extra, artifacts);
    server.connect().await.unwrap();
    server
}

async fn until(server: &McpServer, wanted: impl Fn(&ServerState) -> bool) {
    let mut rx = server.subscribe();
    tokio::time::timeout(Duration::from_secs(10), rx.wait_for(|s| wanted(s)))
        .await
        .expect("state reached in time")
        .unwrap();
}

fn text_of(parts: &[ToolPart]) -> String {
    parts
        .iter()
        .filter_map(|p| if let ToolPart::Text(t) = p { Some(t.as_str()) } else { None })
        .collect()
}

async fn call(server: &McpServer, tool: &str, args: Value) -> Result<String, CallError> {
    let out = server.call_tool("t1", tool, args, &CancellationToken::new(), None).await?;
    Ok(text_of(&out.parts))
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_every_page_and_calls_a_tool() {
    let dir = tempfile::tempdir().unwrap();
    let server = ready(json!({}), dir.path()).await;
    let catalog = server.catalog().unwrap();
    assert_eq!(catalog.entries.len(), 9, "both pages were followed");
    assert_eq!(catalog.entries[0].qualified, "mcp__mock__echo");
    assert_eq!(catalog.entries[0].annotations.read_only_hint, Some(true));
    assert_eq!(call(&server, "echo", json!({"text": "hi"})).await.unwrap(), "hi");
    assert!(matches!(
        call(&server, "nope", json!({})).await,
        Err(CallError::UnknownTool { .. })
    ));
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn server_reported_error_is_a_failure_not_text() {
    let dir = tempfile::tempdir().unwrap();
    let server = ready(json!({}), dir.path()).await;
    match call(&server, "fail", json!({})).await {
        Err(CallError::Reported(reported)) => assert_eq!(reported.text, "Error: boom"),
        other => panic!("{other:?}"),
    }
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn oversize_output_keeps_head_and_tail_and_names_the_artifact() {
    let dir = tempfile::tempdir().unwrap();
    let server = ready(json!({}), dir.path()).await;
    let out = server.call_tool("t", "big", json!({}), &CancellationToken::new(), None).await.unwrap();
    let note = out.truncation.expect("truncation recorded");
    let full: String = (1..=3000).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
    assert_eq!(note.total, full.len() as u64);
    let shown = text_of(&out.parts);
    let artifact = std::fs::read_dir(dir.path()).unwrap().next().unwrap().unwrap().path();
    assert!(shown.contains(&artifact.display().to_string()));
    assert_eq!(std::fs::read_to_string(artifact).unwrap(), full);
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_resets_the_idle_timeout_and_silence_cancels_the_request() {
    let dir = tempfile::tempdir().unwrap();
    let server = ready(json!({"timeoutMs": 300}), dir.path()).await;
    // 500 ms in total but never 300 ms without progress.
    assert_eq!(call(&server, "slow", json!({})).await.unwrap(), "slow done");
    match call(&server, "hang", json!({})).await {
        Err(CallError::Rpc(RpcError::IdleTimeout)) => {}
        other => panic!("{other:?}"),
    }
    assert_eq!(call(&server, "cancels", json!({})).await.unwrap(), "1", "server saw notifications/cancelled");
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn caller_cancel_ends_the_call() {
    let dir = tempfile::tempdir().unwrap();
    let server = ready(json!({"timeoutMs": 0}), dir.path()).await;
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        trigger.cancel();
    });
    let result = server.call_tool("t", "hang", json!({}), &cancel, None).await;
    assert!(matches!(result, Err(CallError::Rpc(RpcError::Cancelled))), "{result:?}");
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_is_a_failed_state_with_the_stderr_tail_and_reconnect_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let server = ready(json!({}), dir.path()).await;
    let crashed = call(&server, "crash", json!({})).await;
    assert!(matches!(crashed, Err(CallError::Rpc(RpcError::Closed(_)))), "{crashed:?}");
    until(&server, |s| matches!(s, ServerState::Failed { .. })).await;
    match &*server.state() {
        ServerState::Failed { cause } => assert!(cause.contains("crashing on purpose"), "{cause}"),
        _ => unreachable!(),
    }
    assert!(matches!(call(&server, "echo", json!({})).await, Err(CallError::NotReady { .. })));
    server.reconnect().await.unwrap();
    assert_eq!(call(&server, "echo", json!({"text": "again"})).await.unwrap(), "again");
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn elicitation_is_answered_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let server = ready(json!({}), dir.path()).await;
    assert_eq!(call(&server, "elicit", json!({})).await.unwrap(), "unsupported");
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn list_changed_relists_the_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let server = ready(json!({}), dir.path()).await;
    let before = server.catalog().unwrap().digest.clone();
    call(&server, "grow", json!({})).await.unwrap();
    until(&server, |s| matches!(s, ServerState::Ready(r) if r.catalog.entries.len() == 10)).await;
    assert_ne!(server.catalog().unwrap().digest, before);
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hung_or_missing_server_never_blocks_another() {
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io(), dir.path().to_path_buf(), OutputPolicy::default());
    let mut missing = config("missing", json!({}));
    missing.transport = mixdog_mcp::config::TransportConfig::Stdio {
        command: "mixdog-definitely-not-installed".to_owned(),
        args: Vec::new(),
        env: std::env::vars().collect(),
        cwd: None,
    };
    hub.apply(vec![config("good", json!({"timeoutMs": 0})), config("busy", json!({"timeoutMs": 0})), missing]);
    for name in ["good", "busy", "missing"] {
        until(&hub.server(name).unwrap(), |s| !matches!(s, ServerState::Starting)).await;
    }
    let status = hub.status();
    assert!(status.iter().find(|s| s.name == "missing").unwrap().state.starts_with("failed"));
    assert_eq!(status.iter().find(|s| s.name == "good").unwrap().state, "ready");

    // `busy` has a call that never returns; `good` answers regardless.
    let busy = hub.server("busy").unwrap();
    let cancel = CancellationToken::new();
    let hanging = {
        let (busy, cancel) = (Arc::clone(&busy), cancel.clone());
        tokio::spawn(async move { busy.call_tool("t", "hang", json!({}), &cancel, None).await })
    };
    let good = hub.server("good").unwrap();
    let echoed = tokio::time::timeout(Duration::from_secs(5), call(&good, "echo", json!({"text": "fast"}))).await;
    assert_eq!(echoed.expect("not blocked by the hung server").unwrap(), "fast");
    cancel.cancel();
    assert!(matches!(hanging.await.unwrap(), Err(CallError::Rpc(RpcError::Cancelled))));

    let tools = hub.tools();
    assert!(tools.iter().any(|t| t.spec().name == "mcp__good__echo"));
    assert!(tools.iter().any(|t| t.spec().name == "mcp__busy__echo"));
    assert!(hub.resolve("mcp__good__big").is_some());
    hub.close_all().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn admission_queues_beyond_max_concurrency() {
    let dir = tempfile::tempdir().unwrap();
    let server = ready(json!({"maxConcurrency": 1}), dir.path()).await;
    let first = {
        let server = Arc::clone(&server);
        tokio::spawn(async move { call(&server, "slow", json!({})).await })
    };
    while server.gate().active() < 1 {
        tokio::task::yield_now().await;
    }
    let second = {
        let server = Arc::clone(&server);
        tokio::spawn(async move { server.call_tool("t2", "echo", json!({"text": "q"}), &CancellationToken::new(), None).await })
    };
    while server.gate().queued() < 1 {
        tokio::task::yield_now().await;
    }
    assert_eq!(first.await.unwrap().unwrap(), "slow done");
    assert_eq!(text_of(&second.await.unwrap().unwrap().parts), "q");
    server.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unsupported_transport_fails_with_a_typed_cause() {
    let dir = tempfile::tempdir().unwrap();
    let entry = json!({"type": "sse", "url": "http://127.0.0.1:1/sse"});
    let config = McpServerConfig::from_entry("sse", &entry, &Default::default()).unwrap();
    let spiller = Spiller::new(dir.path().to_path_buf(), io().durability);
    let server = McpServer::new(config, io(), spiller, OutputPolicy::default(), None);
    let error = server.connect().await.unwrap_err();
    assert!(error.to_string().contains("request failed"), "{error}");
    assert!(matches!(&*server.state(), ServerState::Failed { .. }));
}

fn hook_handler(raw: Value) -> mixdog_mcp::hooks::HookHandler {
    mixdog_mcp::hooks::HookHandler {
        raw,
        source: std::path::PathBuf::new(),
        plugin_root: None,
        plugin_data: None,
        untrusted: false,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_mcp_tool_hook_runs_the_tool_and_a_timeout_cancels_it() {
    use mixdog_mcp::hook_runner::run_mcp_tool_handler;
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io(), dir.path().to_path_buf(), OutputPolicy::default());
    hub.apply(vec![config("mock", json!({}))]);
    let server = hub.server("mock").unwrap();
    until(&server, |s| matches!(s, ServerState::Ready(_))).await;
    let cancel = CancellationToken::new();

    let echo = hook_handler(json!({"type": "mcp_tool", "server": "mock", "tool": "echo"}));
    let ran = run_mcp_tool_handler(&hub, &echo, json!({"text": "from hook"}), "PreToolUse", &cancel).await;
    assert_eq!((ran.exit_code, ran.stdout.as_str(), ran.timed_out), (0, "from hook", false));

    let hang = hook_handler(json!({"type": "mcp_tool", "tool": "mcp__mock__hang", "timeout": 0.3}));
    let started = std::time::Instant::now();
    let ran = run_mcp_tool_handler(&hub, &hang, json!({}), "PreToolUse", &cancel).await;
    assert_eq!((ran.exit_code, ran.timed_out), (-1, true));
    assert!(ran.stderr.contains("timed out"), "{}", ran.stderr);
    assert!(started.elapsed() < Duration::from_secs(5));

    let none = hook_handler(json!({"type": "mcp_tool"}));
    let ran = run_mcp_tool_handler(&hub, &none, json!({}), "PreToolUse", &cancel).await;
    assert_eq!(ran.stderr, "mcp_tool handler missing tool name");
    hub.close_all().await;
}
