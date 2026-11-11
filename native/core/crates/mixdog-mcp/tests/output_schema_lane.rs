//! A result's output-schema check runs as a cpu-bulk lane job, and its pattern matching ends when the call is cancelled.
//! Its own test binary: it boots the production executors, which a process installs once (the `it` suite installs the
//! inline test backend, which runs a job on the thread that submits it).

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use fancy_regex::interrupt::CHUNK;
use fancy_regex::interrupt::INTERVAL;
use fancy_regex::interrupt::probe;
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

/// A long-running match of the lane test: its pattern, its haystack, how many times it reads its stop at least, and how
/// many steps one pass of the meta engine may add to the gap between two reads (`interrupt`'s one allowed exception: a
/// pass over at most the haystack, 0 where the shape has none).
struct Shape {
    name: &'static str,
    pattern: String,
    haystack: String,
    min_reads: usize,
    meta_pass: u64,
}

/// The ways a match runs long besides failing: VM steps that never fail (a repetition holding a lookahead over 500,000
/// characters, one failure at the end), an absent repeater's advance (300,000 characters, none failing), one search the
/// lazy DFA steps (a 4 MiB suffix after a lookahead), a literal of the pattern compared in one instruction (700,000
/// bytes; 300,000 case-insensitive characters), and the one call outside the step bound that this pattern reaches: the
/// meta engine reading the groups of a 4 MiB delegated match in one pass. Each runs to its answer.
fn long_shapes() -> Vec<Shape> {
    let shape = |name, pattern: String, haystack: String, min_reads, meta_pass| Shape { name, pattern, haystack, min_reads, meta_pass };
    vec![
        shape("VM steps without a failure", r"^(?:(?=a)a)*$".to_owned(), "a".repeat(500_000), 10, 0),
        shape("an absent repeater's advance", r"^(?~abc)$".to_owned(), "x".repeat(300_000), 10, 0),
        shape("one delegated search", r"^(?=x)[a-z]*$".to_owned(), format!("x{}", "a".repeat(4 << 20)), 10, 0),
        shape("a long literal", format!("^(?=a){}", "a".repeat(700_000)), "a".repeat(700_000), 10, 0),
        shape("a long case-insensitive literal", format!("(?i)^(?=a){}", "a".repeat(300_000)), "A".repeat(300_000), 4, 0),
        shape(
            "the groups of a delegated match",
            r"^(?=x)(x[a-z]*)$".to_owned(),
            format!("x{}", "a".repeat(4 << 20)),
            2,
            (4 << 20) + 1,
        ),
    ]
}

/// `regex` matched against `haystack` under `stop` (none: no stop set) on a cpu-bulk lane of one thread: the answer, the
/// steps at which the match read the stop, and how long the match took. A second job on the same lane then runs, so
/// the lane's thread is free again.
fn on_the_lane(
    tokens: &mixdog_rt::LaneTokens,
    regex: &Arc<fancy_regex::Regex>,
    haystack: &Arc<String>,
    stop: Option<bool>,
) -> (Result<bool, fancy_regex::Error>, Vec<u64>, Duration) {
    use mixdog_rt::LaneToken;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let (regex, haystack) = (Arc::clone(regex), Arc::clone(haystack));
        let job = tokens
            .cpu_bulk
            .submit(&CancellationToken::new(), move |_lane| {
                probe::take_reads();
                let started = std::time::Instant::now();
                let answer = match stop {
                    Some(stop) => fancy_regex::interrupt::checking(Arc::new(AtomicBool::new(stop)), || {
                        regex.is_match(haystack.as_str())
                    }),
                    None => regex.is_match(haystack.as_str()),
                };
                let took = started.elapsed();
                (answer, probe::take_reads(), took)
            })
            .unwrap();
        let ran = tokio::time::timeout(Duration::from_secs(120), job).await.expect("the match ends in 120 s").unwrap();
        let next = tokens.cpu_bulk.submit(&CancellationToken::new(), |_lane| 7).unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(30), next).await.expect("the lane runs its next job in 30 s").unwrap(), 7);
        ran
    })
}

/// Counted, not timed: a match reads its stop at least once every `INTERVAL + CHUNK` steps, whichever way it runs
/// long; a stop already set ends it at its first read, within `INTERVAL + CHUNK` steps; and either way the lane's thread
/// is free again after it. (The time of each shape with the stop read and with no stop set is printed: what the reads
/// cost.)
#[test]
fn a_long_match_reads_its_stop_within_a_bounded_number_of_steps_and_frees_its_lane() {
    let mut config = mixdog_rt::exec::RtConfig::for_cores(4);
    config.cpu_bulk = mixdog_rt::exec::PoolParams { threads: 1, queue: 2 };
    let (_executors, tokens) = mixdog_rt::exec::boot(config).expect("the production lanes");
    for Shape { name: shape, pattern, haystack, min_reads, meta_pass } in long_shapes() {
        let regex = Arc::new(fancy_regex::RegexBuilder::new(&pattern).backtrack_limit(usize::MAX).build().unwrap());
        let haystack = Arc::new(haystack);

        let (_, _, unread) = on_the_lane(&tokens, &regex, &haystack, None);
        let (answer, reads, read) = on_the_lane(&tokens, &regex, &haystack, Some(false));
        eprintln!("{shape}: {read:?} reading the stop {} times, {unread:?} with no stop", reads.len());
        assert!(matches!(answer, Ok(true)), "{shape}: {answer:?}");
        assert!(reads.len() >= min_reads, "{shape}: read {} times", reads.len());
        // The bound of `interrupt`: `INTERVAL + CHUNK` steps, plus a pass of the meta engine over at most the haystack.
        assert!(meta_pass == 0 || meta_pass >= haystack.len() as u64, "{shape}: the allowance covers the haystack");
        let mut before = 0;
        for read in &reads {
            assert!(read - before <= INTERVAL + CHUNK as u64 + meta_pass, "{shape}: {} steps between two reads", read - before);
            before = *read;
        }

        let (answer, reads, _) = on_the_lane(&tokens, &regex, &haystack, Some(true));
        assert!(
            matches!(answer, Err(fancy_regex::Error::RuntimeError(fancy_regex::RuntimeError::BacktrackLimitExceeded))),
            "{shape}: {answer:?}"
        );
        assert_eq!(reads.len(), 1, "{shape}: the match ended at its first read of the stop");
        assert!(reads[0] <= INTERVAL + CHUNK as u64, "{shape}: first read after {} steps", reads[0]);
    }
}

/// A check whose call is already cancelled ends at the matcher's first read of its stop and answers cancelled.
#[test]
fn a_cancelled_calls_check_answers_cancelled() {
    let validators = OutputValidators::of(hostile_tools().as_array().unwrap()).unwrap();
    let result = json!({"content": [], "structuredContent": {"v": hostile_value()}});
    assert_eq!(validators.check("hostile", &result, &Arc::new(AtomicBool::new(true))), Err(RpcError::Cancelled));
}
