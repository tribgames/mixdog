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
    let reached = tokio::time::timeout(Duration::from_secs(60), rx.wait_for(|s| wanted(s))).await;
    reached.expect("timed out after 60 s waiting for the server to reach the awaited state").unwrap();
}

/// The test function the scripted servers run as (`mixdog_testkit::mcp_server`): nothing unless started as one.
#[test]
fn scripted_server() {
    mixdog_testkit::mcp_server::serve_if_asked();
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
        mixdog_rt::time::sleep(Duration::from_millis(100)).await;
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
    hub.apply(vec![config("good", json!({"timeoutMs": 0, "outbound": {"echo": "message"}})), config("busy", json!({"timeoutMs": 0})), missing]);
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
    let echoed = mixdog_rt::time::timeout(Duration::from_secs(5), call(&good, "echo", json!({"text": "fast"}))).await;
    assert_eq!(echoed.expect("not blocked by the hung server").unwrap(), "fast");
    cancel.cancel();
    assert!(matches!(hanging.await.unwrap(), Err(CallError::Rpc(RpcError::Cancelled))));

    let tools = hub.tools();
    assert!(tools.iter().any(|t| t.spec().name == "mcp__good__echo"));
    assert!(tools.iter().any(|t| t.spec().name == "mcp__busy__echo"));
    assert!(hub.resolve("mcp__good__big").is_some());
    // The session tool set narrows each tool by its own server's scope, found by name.
    let target = hub.tool_target("mcp__good__echo").expect("a listed tool resolves");
    assert_eq!(target.server.name(), "good");
    assert!(target.entry.is_some());
    assert!(hub.tool_target("mcp__nowhere__echo").is_none());
    // The policy asks the resolved tool what a call does outside the machine: `good` declares
    // its `echo` a message, `busy` declares nothing and `echo` is read-only there.
    let echo = hub.tool("mcp__good__echo").expect("a published tool resolves");
    assert_eq!(echo.spec().name, "mcp__good__echo");
    assert_eq!(echo.outbound_kind(&json!({})), Some(mixdog_core_api::domain::approval::ActionKind::Message));
    assert_eq!(hub.tool("mcp__busy__echo").expect("resolves").outbound_kind(&json!({})), None);
    assert!(hub.tool("mcp__good__nothing").is_none() && hub.tool("read").is_none());
    hub.close_all().await;
}

/// A scope is a key into the one hub (Node's registry key `scope\0name`, `mcp/client.mjs:110-118`): the
/// servers connected under it are its tools and its lookups only, an empty id is the default scope, a
/// scope never connected has nothing, and releasing a scope (`disconnectAll({ scopeId })`) closes its
/// servers and leaves every other scope's running.
#[tokio::test(flavor = "multi_thread")]
async fn a_scope_holds_its_own_servers_and_releasing_it_closes_only_them() {
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io(), dir.path().to_path_buf(), OutputPolicy::default());
    hub.apply(vec![config("shared", json!({}))]);
    hub.apply_in("runtime-a", vec![config("own", json!({}))]);
    hub.apply_in(" runtime-b ", vec![config("shared", json!({}))]);
    for (scope, name) in [("global", "shared"), ("runtime-a", "own"), ("runtime-b", "shared")] {
        until(&hub.server_in(scope, name).unwrap(), |s| matches!(s, ServerState::Ready(_))).await;
    }
    let names = |scope: &str| -> Vec<String> { hub.tools_in(scope).iter().map(|tool| tool.spec().name.clone()).collect() };
    let of = |scope: &str, server: &str| names(scope).iter().all(|name| name.starts_with(&format!("mcp__{server}__"))) && !names(scope).is_empty();
    assert!(of("runtime-a", "own") && of("global", "shared") && of("runtime-b", "shared"));
    assert_eq!(names(""), names("global"), "an empty id is the default scope");
    assert!(names("runtime-c").is_empty() && !hub.has_scope("runtime-c"), "a scope never connected has nothing");

    assert!(hub.tool_target_in("runtime-a", "mcp__own__echo").is_some());
    assert!(hub.tool_target_in("runtime-b", "mcp__own__echo").is_none(), "another scope's server is not found");
    assert!(hub.tool_target("mcp__own__echo").is_none() && hub.tool("mcp__own__echo").is_none());
    assert!(hub.tool_in("runtime-a", "mcp__own__echo").is_some());
    assert!(hub.tool_in("runtime-b", "mcp__own__echo").is_none(), "a lookup in another scope does not find it");
    assert_eq!(hub.status().len(), 1, "the default scope's status lists its own servers");

    // Changing one scope's servers leaves the others': a scope applied again keeps what is unchanged.
    let before = hub.server_in("runtime-b", "shared").unwrap();
    hub.apply_in("runtime-a", vec![config("own", json!({})), config("more", json!({}))]);
    assert!(Arc::ptr_eq(&before, &hub.server_in("runtime-b", "shared").unwrap()));
    assert_eq!(hub.servers_in("runtime-a").iter().map(|s| s.name().to_owned()).collect::<Vec<_>>(), ["own", "more"]);

    let own = hub.server_in("runtime-a", "own").unwrap();
    hub.release_scope("runtime-a").await;
    assert!(!hub.has_scope("runtime-a") && names("runtime-a").is_empty());
    assert!(matches!(&*own.state(), ServerState::Closed));
    assert!(of("global", "shared") && of("runtime-b", "shared"), "the other scopes are untouched");
    hub.close_all().await;
    assert!(!hub.has_scope("global") && !hub.has_scope("runtime-b"));
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
    let ran = run_mcp_tool_handler(&hub, None, &echo, json!({"text": "from hook"}), "PreToolUse", &cancel).await;
    assert_eq!((ran.exit_code, ran.stdout.as_str(), ran.timed_out), (0, "from hook", false));

    let hang = hook_handler(json!({"type": "mcp_tool", "tool": "mcp__mock__hang", "timeout": 0.3}));
    let started = std::time::Instant::now();
    let ran = run_mcp_tool_handler(&hub, None, &hang, json!({}), "PreToolUse", &cancel).await;
    assert_eq!((ran.exit_code, ran.timed_out), (-1, true));
    assert!(ran.stderr.contains("timed out"), "{}", ran.stderr);
    assert!(started.elapsed() < Duration::from_secs(5));

    let none = hook_handler(json!({"type": "mcp_tool"}));
    let ran = run_mcp_tool_handler(&hub, None, &none, json!({}), "PreToolUse", &cancel).await;
    assert_eq!(ran.stderr, "mcp_tool handler missing tool name");
    hub.close_all().await;
}

/// An `mcp_tool` hook finds its tool among the servers of the scope its session holds
/// (`scopeId: rt.mcpScopeId`, `boot/infrastructure.mjs:97`), never another session's.
#[tokio::test(flavor = "multi_thread")]
async fn an_mcp_tool_hook_runs_in_its_sessions_scope_only() {
    use mixdog_mcp::hook_runner::run_mcp_tool_handler;
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io(), dir.path().to_path_buf(), OutputPolicy::default());
    hub.apply_in("session-a", vec![config("mock", json!({}))]);
    until(&hub.server_in("session-a", "mock").unwrap(), |s| matches!(s, ServerState::Ready(_))).await;
    let cancel = CancellationToken::new();
    let echo = hook_handler(json!({"type": "mcp_tool", "server": "mock", "tool": "echo"}));

    let own = run_mcp_tool_handler(&hub, Some("session-a"), &echo, json!({"text": "from a"}), "PreToolUse", &cancel).await;
    assert_eq!((own.exit_code, own.stdout.as_str()), (0, "from a"));
    let other = run_mcp_tool_handler(&hub, Some("session-b"), &echo, json!({"text": "from b"}), "PreToolUse", &cancel).await;
    assert_eq!(other.stderr, "MCP server \"mock\" not connected", "another session's server is not used");
    let none = run_mcp_tool_handler(&hub, None, &echo, json!({"text": "from none"}), "PreToolUse", &cancel).await;
    assert_eq!(none.stderr, "MCP server \"mock\" not connected", "a session with no scope reads the default scope, which holds nothing here");
    hub.close_all().await;
}

/// `fixtures/mcp-cwd-scope` `hook`: an `mcp_tool` hook of a session whose cwd is outside a plugin's scope still runs the
/// plugin's tool (Node's `executeMcpTool` resolves it in the session's MCP scope only, no session catalog). The recorded
/// registry is connected as real servers (`mixdog_testkit::mcp_server`: each lists its recorded tools, answers
/// `ran <server> <tool>` and logs what reaches it); the hook runs the recorded call, and the tool's answer and the servers
/// and tools its reach logs hold are compared with Node's recording (`result`, `ran`).
#[tokio::test(flavor = "multi_thread")]
async fn an_mcp_tool_hook_outside_the_plugins_scope_runs_as_nodes_does() {
    use mixdog_mcp::hook_runner::run_mcp_tool_handler;
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/mcp-cwd-scope/golden.json")).unwrap();
    let recorded = &golden["hook"];
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io(), dir.path().to_path_buf(), OutputPolicy::default());
    let mut configs = Vec::new();
    let mut servers = Vec::new();
    // One log for every server: the order of the calls across servers is the order they reached them in.
    let reach = dir.path().join("reach.log");
    for entry in golden["registry"].as_array().unwrap() {
        let server = entry["server"].as_str().unwrap();
        let tools: Vec<&str> = entry["tools"].as_array().unwrap().iter().map(|doc| doc["name"].as_str().unwrap()).collect();
        let launch = mixdog_testkit::mcp_server::launch("mcp_suite::scripted_server", server, &tools, &reach);
        let mut entry_config = json!({"command": launch.command, "args": launch.args, "env": launch.env});
        if let Some(plugin) = entry["pluginId"].as_str() {
            entry_config["_mixdogPlugin"] = json!({"id": plugin});
        }
        configs.push(McpServerConfig::from_entry(server, &entry_config, &std::env::vars().collect()).unwrap());
        servers.push(server.to_owned());
    }
    hub.apply_in("session-b", configs);
    for server in &servers {
        until(&hub.server_in("session-b", server).unwrap(), |s| matches!(s, ServerState::Ready(_))).await;
    }
    let name = recorded["name"].as_str().unwrap();
    let (server, tool) = name.strip_prefix("mcp__").unwrap().split_once("__").unwrap();
    let cancel = CancellationToken::new();
    let hook = hook_handler(json!({"type": "mcp_tool", "server": server, "tool": tool}));
    // The hook's payload is the arguments its tool receives (`hook-bus/handlers.mjs`: `args: payload`): the recorded ones.
    let payload = recorded["arguments"].clone();
    let ran = run_mcp_tool_handler(&hub, Some("session-b"), &hook, payload, "PreToolUse", &cancel).await;
    assert_eq!((ran.exit_code, ran.stdout.as_str()), (0, recorded["result"].as_str().unwrap()), "the hook's result");
    assert_eq!(json!(mixdog_testkit::mcp_server::reached(&reach)), recorded["ran"], "the servers, tools and arguments that reached a live server, in order");
    hub.close_all().await;
}

/// `extension-scopes.test.mjs` "a live MCP registry is filtered per session cwd, cascading the plugin scope from owner
/// metadata": a plugin's server is limited by the plugin's scope as well as its own.
#[tokio::test(flavor = "multi_thread")]
async fn a_live_registry_is_filtered_per_cwd_with_the_owning_plugins_scope() {
    use mixdog_mcp::scopes::ExtensionScopes;
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io(), dir.path().join("artifacts"), OutputPolicy::default());
    hub.apply_in(
        "scope-test",
        vec![
            config("UnityMCP", json!({})),
            config("plugin-unity-tools", json!({"_mixdogPlugin": {"id": "unity", "key": "tools"}})),
            config("demo", json!({})),
        ],
    );
    for name in ["UnityMCP", "plugin-unity-tools", "demo"] {
        until(&hub.server_in("scope-test", name).unwrap(), |s| matches!(s, ServerState::Ready(_))).await;
    }
    let (a, b) = (dir.path().join("alpha"), dir.path().join("beta"));
    let servers = |scopes: &ExtensionScopes, cwd: &std::path::Path| {
        let mut names: Vec<String> = hub
            .tools_for_cwd("scope-test", scopes, cwd)
            .iter()
            .filter_map(|tool| tool.spec().name.strip_prefix("mcp__")?.split_once("__").map(|(server, _)| server.to_owned()))
            .collect();
        names.dedup();
        names
    };
    let scoped = ExtensionScopes::from_config(&json!({"mcp": {"UnityMCP": [b.to_string_lossy()]}, "plugins": {"unity": [b.to_string_lossy()]}}));
    assert_eq!(servers(&scoped, &a), ["demo"]);
    assert_eq!(servers(&scoped, &b.join("Assets")), ["UnityMCP", "plugin-unity-tools", "demo"]);
    // No scopes at all: the live catalog passes through untouched.
    assert_eq!(hub.tools_for_cwd("scope-test", &ExtensionScopes::default(), &a).len(), hub.tools_in("scope-test").len());
    hub.close_all().await;
}