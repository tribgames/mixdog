//! A result's output-schema check runs as a cpu-bulk lane job, and its pattern matching ends when the call is cancelled.
//! Its own test binary: it boots the production executors, which a process installs once (the `it` suite installs the
//! inline test backend, which runs a job on the thread that submits it).

use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

use mixdog_mcp::McpIo;
use mixdog_mcp::McpServer;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::output_schema::OutputValidators;
use mixdog_mcp::result::OutputPolicy;
use mixdog_mcp::result::Spiller;
use mixdog_mcp::rpc::RpcError;
use mixdog_mcp::server::CallError;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

const MOCK: &str = env!("CARGO_BIN_EXE_mixdog-mcp-mock-server");

/// A repetition holding a lookahead, which fancy-regex backtracks through (`^(a+)+$` alone it answers without
/// backtracking): on 40 `a`s and a `b` its steps run for hours under the bound of 10^10.
const HOSTILE: &str = "^(?:(?=a)a+)+$";

fn hostile_tools() -> Value {
    json!([
        {"name": "hostile", "inputSchema": {"type": "object"},
         "outputSchema": {"type": "object", "properties": {"v": {"type": "string", "pattern": HOSTILE}}}},
        {"name": "plain", "inputSchema": {"type": "object"},
         "outputSchema": {"type": "object", "properties": {"v": {"type": "string", "pattern": "^a+$"}}}},
    ])
}

fn hostile_value() -> Value {
    json!(format!("{}b", "a".repeat(40)))
}

/// On a runtime of one worker thread, a call whose result's pattern backtracks for hours leaves the worker free: a call
/// made after it answers while it is still being checked. Cancelling it then ends the check, and the call answers that it
/// was cancelled. The runtime runs on a thread of its own, so a check that held its worker fails the test at a deadline
/// the test thread keeps.
#[test]
fn a_pathological_pattern_holds_no_async_worker_and_ends_when_its_call_is_cancelled() {
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        calls_on_one_worker();
        let _ = done.send(());
    });
    match finished.recv_timeout(Duration::from_secs(90)) {
        Ok(()) => {}
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => panic!("the calls failed (their panic is printed above)"),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("no answer in 90 s: the hostile check holds the runtime's one worker")
        }
    }
}

fn calls_on_one_worker() {
    // Two cpu-bulk threads: the plain result's check runs beside the hostile one, which holds the other.
    let mut config = mixdog_rt::exec::RtConfig::for_cores(4);
    config.cpu_bulk = mixdog_rt::exec::PoolParams { threads: 2, queue: 2 };
    let (_executors, tokens) = mixdog_rt::exec::boot(config).expect("the production lanes");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk };
        let results = json!({
            "hostile": [{"content": [], "structuredContent": {"v": hostile_value()}}],
            "plain": [{"content": [], "structuredContent": {"v": "aaa"}}],
        });
        let scenario = json!({"tools": hostile_tools(), "results": results});
        let entry = json!({"command": MOCK, "env": {"MOCK_SCENARIO": scenario.to_string()}});
        let config = McpServerConfig::from_entry("srv", &entry, &std::env::vars().collect()).unwrap();
        let server = McpServer::new(config, io, Spiller::new(dir.path().to_path_buf(), io.durability), OutputPolicy::default(), None);
        tokio::time::timeout(Duration::from_secs(30), server.connect()).await.expect("the mock server connects in 30 s").unwrap();

        // The hostile call is sent at its first poll, before the plain call is spawned: the server answers the two in
        // that order. The hostile call is polled first whenever both can go on, so a check run on this worker would
        // start before the plain answer is read.
        let cancel = CancellationToken::new();
        let hostile = server.call_tool_settled("a", "hostile", json!({"i": 0}), &cancel, None);
        tokio::pin!(hostile);
        let plain = async {
            let server = server.clone();
            tokio::spawn(async move { server.call_tool_settled("b", "plain", json!({"i": 0}), &CancellationToken::new(), None).await })
                .await
                .unwrap()
        };
        tokio::select! {
            biased;
            answered = &mut hostile => panic!("the hostile result's check answered first: {answered:?}"),
            plain = plain => assert_eq!(plain.unwrap()["structuredContent"]["v"], "aaa"),
        }

        cancel.cancel();
        let answered = hostile.await;
        assert!(matches!(answered, Err(CallError::Rpc(RpcError::Cancelled))), "{answered:?}");
        server.close().await;
    });
}

/// The matcher reads the check set on its thread every `INTERVAL` backtracking steps: a check that answers stop the
/// first time it is read ends a match whose steps would run for hours, after one read.
#[test]
fn a_match_ends_at_the_first_read_of_a_check_that_answers_stop() {
    let regex = fancy_regex::RegexBuilder::new(HOSTILE).backtrack_limit(usize::MAX).build().unwrap();
    let reads = Rc::new(Cell::new(0_usize));
    let check = {
        let reads = Rc::clone(&reads);
        move || {
            reads.set(reads.get() + 1);
            true
        }
    };
    let haystack = hostile_value();
    let answered = fancy_regex::interrupt::checking(Rc::new(check), || regex.is_match(haystack.as_str().unwrap()));
    assert!(
        matches!(answered, Err(fancy_regex::Error::RuntimeError(fancy_regex::RuntimeError::BacktrackLimitExceeded))),
        "{answered:?}"
    );
    assert_eq!(reads.get(), 1, "the match ended at the first read of the check");
}

/// A check whose call is already cancelled ends at the matcher's first read of it and answers cancelled.
#[test]
fn a_cancelled_calls_check_answers_cancelled() {
    let validators = OutputValidators::of(hostile_tools().as_array().unwrap()).unwrap();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let result = json!({"content": [], "structuredContent": {"v": hostile_value()}});
    assert_eq!(validators.check("hostile", &result, &[cancelled]), Err(RpcError::Cancelled));
}
