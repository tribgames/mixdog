//! `mixdogd graph-worker`: the code graph helper a core's `GraphHost` starts as this program.
#![allow(clippy::disallowed_methods, reason = "the test writes its project folder with blocking calls on the test thread")]

use std::future::Future;
use std::time::Duration;

use mixdog_graph_host::CloseOutcome;
use mixdog_graph_host::GraphHost;
use mixdog_graph_host::HostConfig;
use mixdog_graph_host::HostState;
use mixdog_graph_host::OwnedCommand;
use mixdog_graph_host::wire::Query;
use mixdog_rt::CancellationToken;

/// How long an awaited event may take before the test fails instead of hanging.
const BOUND: Duration = Duration::from_secs(120);

async fn within<T>(future: impl Future<Output = T>) -> T {
    mixdog_rt::time::timeout(BOUND, future).await.expect("the awaited event did not come")
}

/// The helper the registered subcommand runs answers a query with the tool's text over the cache folder it was started with, and
/// at the host's close drains what it built into that folder and exits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_registered_helper_answers_a_query_and_exits_on_close() {
    let tmp = tempfile::tempdir().expect("tmp");
    let project = tmp.path().join("proj");
    std::fs::create_dir_all(project.join("src")).expect("the project folder");
    std::fs::write(project.join("package.json"), "{}").expect("the project sentinel");
    std::fs::write(project.join("src/math.mjs"), "export function add(a, b) {\n  return a + b;\n}\n").expect("the source");
    let project = project.canonicalize().expect("the project's path");
    let cache = tmp.path().join("code-graph-cache");
    let command = OwnedCommand::new(mixdog_testkit::bin_exe!("mixdogd")).arg("graph-worker").arg("--cache-dir").arg(cache.clone());
    let (host, driver) = GraphHost::new(HostConfig::new(command, BOUND));
    let driver = tokio::spawn(driver);

    let query = Query { session_cwd: project.clone(), args: serde_json::json!({ "mode": "find_symbol", "symbols": "add" }), registered: Vec::new(), selected: Vec::new() };
    let answer = within(host.query(query, &CancellationToken::new())).await.expect("the helper's answer");
    assert!(answer.text.contains("src/math.mjs:1-3") && answer.text.contains("export function add(a, b) {"), "{}", answer.text);
    assert!(answer.complete && answer.dependency_roots.is_some(), "{answer:?}");
    let running = host.status();
    assert_eq!((running.state, running.pid.is_some()), (HostState::Running, true), "{running:?}");

    assert_eq!(within(host.close(BOUND)).await, CloseOutcome::Drained, "the helper drained and exited by itself");
    assert_eq!(host.status().state, HostState::Closed);
    assert!(cache.join("manifest.json").is_file(), "the drain wrote the graph before the helper exited");
    drop(host);
    within(driver).await.expect("the driver ends with its last handle");
}
