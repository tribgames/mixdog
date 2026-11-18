//! What the trace writer records for tool failures, cache breaks, watchdog aborts and concurrent flushes, with every
//! input written inline.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test fixture I/O; the flushers run on plain threads"
)]

use std::collections::BTreeMap;
use std::fs;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_trace as t;
use mixdog_trace::AgentTrace;
use mixdog_trace::TraceConfig;
use mixdog_trace::flush_probe;
use serde_json::Value;
use serde_json::json;

fn object(value: Value) -> serde_json::Map<String, Value> {
    value.as_object().unwrap().clone()
}

#[test]
fn failure_text_is_classified_by_its_leading_line_and_the_tool() {
    let cases: &[(&str, &str, &str)] = &[
        // Shell tool wrappers.
        ("[shell-tool-failed] shell arg \"x\" is unsupported", "shell", "schema/args"),
        ("[shell-tool-failed] boom", "shell", "tool-call/failure"),
        ("[shell-run-failed] [timeout: 5s]", "shell", "timeout/abort"),
        ("[shell-run-failed] cause: output-limit", "shell", "runtime/failure"),
        ("[shell-run-failed] [signal: SIGKILL]", "shell", "process/signal"),
        ("[shell-run-failed] exited", "shell", "command-exit"),
        ("[exit code: 2]\nboom", "grep", "command-exit"),
        ("anything at all", "shell", "command-exit"),
        // Cancellations and preflight refusals.
        ("Session \"s1\" closed: aborted during call", "read", "expected-cancellation"),
        ("computer_user_takeover: the user moved the mouse", "computer", "expected-cancellation"),
        ("this is a compacted-history placeholder", "read", "expected-preflight"),
        ("edit failed (old_string not found in file)", "edit", "runtime/failure"),
        // Argument and schema errors.
        ("[tool-input-validation] bad field", "read", "schema/args"),
        ("unknown parameter foo", "read", "schema/args"),
        ("limit must be a number", "read", "schema/args"),
        ("{\"ok\":false,\"error\":\"requires either a or b\"}", "recall", "schema/args"),
        // Upstream and lifecycle.
        ("fetch failed errorCode: HTTP_ERROR", "web_fetch", "upstream/http"),
        ("generation failed on x: failed (429): slow down", "media", "upstream/http"),
        ("Web search failed: native web search failed: x: runtime is closing", "web_search", "lifecycle/closing"),
        // Patches.
        ("patch partially applied", "apply_patch", "patch/partial-apply"),
        ("add file target already exists", "apply_patch", "expected-preflight"),
        ("patch too large", "apply_patch", "patch/limit"),
        ("multiple operations target a.txt", "apply_patch", "patch/duplicate-target"),
        ("context not found in a.txt", "apply_patch", "patch/context"),
        ("hunk rejected near line 4", "apply_patch", "patch/stale-context"),
        ("parse failed: unexpected token", "apply_patch", "patch/parse"),
        ("target(s) fall outside the write root", "apply_patch", "path/outside-root"),
        ("preflight rejected the patch", "apply_patch", "patch/verification"),
        // Resources and the filesystem.
        ("advisory lock timeout on x", "edit", "resource/lock"),
        ("EACCES: cannot open x", "edit", "path/permission"),
        ("ENOENT: no such file", "read", "navigation/miss"),
        ("ENOENT: no such file", "edit", "path/enoent"),
        ("executable not found in this environment", "computer", "environment/unavailable"),
        ("request timed out", "web_fetch", "timeout/abort"),
        ("not allowed here", "edit", "permission"),
        ("unknown tool foo", "x", "tool-surface"),
        ("something unforeseen", "x", "runtime/failure"),
    ];
    let mut wrong = Vec::new();
    for (text, tool, want) in cases {
        let got = t::classify_tool_failure(&Value::String((*text).into()), tool);
        if got != *want {
            wrong.push(format!("{text:?} ({tool}): want {want}, got {got}"));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn a_permission_error_is_never_a_navigation_miss() {
    let text = Value::String("EACCES: permission denied, no such file".into());
    assert_eq!(t::classify_tool_failure(&text, "read"), "path/permission");
}

#[test]
fn the_trace_and_failure_files_never_hold_a_credential() {
    let dir = tempfile::tempdir().unwrap();
    let (trace_path, failures_path) = (dir.path().join("trace.jsonl"), dir.path().join("failures.jsonl"));
    let env: BTreeMap<&str, String> = [
        ("MIXDOG_AGENT_TRACE_PATH", trace_path.to_string_lossy().into_owned()),
        ("MIXDOG_TOOL_FAILURE_LOG_PATH", failures_path.to_string_lossy().into_owned()),
    ]
    .into_iter()
    .collect();
    let trace = AgentTrace::new(&TraceConfig::from_env(dir.path(), &|name| env.get(name).cloned(), false));
    let command = "curl -H 'Authorization: Bearer tok-abc' --password hunter2 -p sekret https://user:pw-xyz@host/x?token=qq9";
    let failing = object(json!({
        "sessionId": "s", "iteration": 1, "toolName": "shell", "resultKind": "error",
        "toolArgs": {"command": command, "api_key": "key-777"},
        "resultText": format!("[shell-run-failed] {command}"),
    }));
    trace.tool(&failing, 1000);
    // A session closed under a running call is traced but is not a failure worth auditing.
    let cancelled = object(json!({
        "sessionId": "s", "iteration": 2, "toolName": "read", "resultKind": "error",
        "resultText": "Session \"s\" closed: aborted during call",
    }));
    trace.tool(&cancelled, 1001);
    assert!(trace.flush(1002).is_empty());
    let traced = fs::read_to_string(&trace_path).unwrap();
    let failed = fs::read_to_string(&failures_path).unwrap();
    for secret in ["tok-abc", "hunter2", "sekret", "pw-xyz", "qq9", "key-777"] {
        assert!(!traced.contains(secret), "{secret} reached the trace: {traced}");
        assert!(!failed.contains(secret), "{secret} reached the failure log: {failed}");
    }
    assert!(traced.contains("[redacted]") && failed.contains("[redacted]"));
    assert_eq!(traced.lines().count(), 2, "both calls are traced");
    assert_eq!(failed.lines().count(), 1, "only the real failure is audited");
    let row: Value = serde_json::from_str(failed.lines().next().unwrap()).unwrap();
    assert_eq!(row["category"], "command-exit");
}

#[test]
fn a_cache_break_record_becomes_a_payload_a_trace_row_and_a_stderr_line() {
    let record = object(json!({
        "sessionId": "s1", "iteration": 2, "classification": "unexpected", "reason": "prefix_changed",
        "source": "loop", "provider": "openai", "model": "m", "previousCount": 3, "nextCount": 4,
        "previousHash": "abcdef0123456789-and-more", "cachedTokens": 10, "requestPrefixChanged": true,
        "markersChanged": false, "changedBlocks": "a\r\n\tb",
    }));
    let payload = t::cache_break_payload(&record);
    assert_eq!(
        Value::Object(payload.clone()),
        json!({
            "classification": "unexpected", "reason": "prefix_changed", "source": "loop", "provider": "openai", "model": "m",
            "previous_count": 3, "next_count": 4,
            // Hashes are cut to 16 characters; a run of CR/LF/TAB is one space.
            "previous_hash": "abcdef0123456789", "request_prefix_changed": true, "cached_tokens": 10,
            "actual_cache_miss": false, "changed_blocks": "a b", "system_markers_changed": false,
        })
    );
    let row = t::cache_break_trace_record(&record);
    assert_eq!(row["kind"], "cache_break");
    assert_eq!(row["sessionId"], "s1");
    assert_eq!(row["reason"], "prefix_changed");
    assert_eq!(row["payload"], Value::Object(payload));
    assert_eq!(
        t::cache_break_line(&record),
        "[cache-break] classification=\"unexpected\" reason=\"prefix_changed\" source=\"loop\" session=\"s1\" provider=\"openai\" \
         model=\"m\" iteration=2 previousCount=3 nextCount=4 previousHash=\"abcdef0123456789\" cachedTokens=10 \
         changedBlocks=\"a b\" systemMarkersChanged=false"
    );
}

#[test]
fn an_empty_cache_break_record_is_unknown_and_flags_are_false() {
    let payload = t::cache_break_payload(&object(json!({})));
    assert_eq!(
        Value::Object(payload),
        json!({"classification": "unknown", "reason": "unknown", "request_prefix_changed": false, "actual_cache_miss": false})
    );
}

#[test]
fn the_writer_leaves_the_cache_break_row_in_the_trace_file() {
    let dir = tempfile::tempdir().unwrap();
    let env = |name: &str| (name == "MIXDOG_DIAGNOSTICS").then(|| "1".to_owned());
    let trace = AgentTrace::new(&TraceConfig::from_env(dir.path(), &env, false));
    let record = object(json!({
        "sessionId": "s1", "iteration": 1, "classification": "intentional", "reason": "image_strip_rebaseline",
        "source": "image_strip_retry", "provider": "p", "model": "m", "previousCount": 2, "nextCount": 2,
    }));
    trace.cache_break(&record, 1_700_000_000_000);
    assert!(trace.flush(1_700_000_000_000).is_empty());
    let written = fs::read_to_string(dir.path().join("history").join("agent-trace.jsonl")).unwrap();
    let lines: Vec<Value> = written.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["kind"], "cache_break");
    assert_eq!(lines[0]["session_id"], "s1");
    assert_eq!(lines[0]["ts"], 1_700_000_000_000_i64);
    assert_eq!(lines[0]["payload"]["reason"], "image_strip_rebaseline");
}

fn abort_trace(context: Value, now: i64) -> Option<(Value, Value)> {
    let abort = t::watchdog_abort_records(&object(context), now)?;
    Some((Value::Object(t::build_row(&abort.trace, now)), abort.failure))
}

#[test]
fn a_watchdog_abort_needs_a_session_and_an_error() {
    assert!(abort_trace(json!({"error": {"message": "stale"}}), 1).is_none());
    assert!(abort_trace(json!({"sessionId": "s"}), 1).is_none());
}

#[test]
fn a_stale_transport_abort_names_its_window_limit_and_clock() {
    let (trace, failure) = abort_trace(
        json!({
            "sessionId": "s", "iteration": 3, "agent": "worker", "buildVersion": "1.5.0",
            "error": {"message": "agent first transport stale (30000ms without a byte)"},
            "snapshot": {"stage": "waiting", "lastProgressAt": 1000, "waitingForTransport": true},
            "policy": {"idleStaleMs": 600000},
        }),
        5000,
    )
    .unwrap();
    assert_eq!(trace["kind"], "stall_abort");
    assert_eq!(trace["payload"]["elapsed_ms"], 4000);
    assert_eq!(trace["payload"]["stage"], "waiting");
    assert_eq!(failure["kind"], "stall_abort");
    assert_eq!(failure["category"], "agent-stall");
    assert_eq!(failure["window"], "first_response");
    assert_eq!(failure["form"], "first_transport");
    assert_eq!(failure["limit_ms"], 30000, "the limit in the message wins over the policy's");
    assert_eq!(failure["compared_field"], "last_progress_at");
    assert_eq!(failure["compared_at"], 1000);
    assert_eq!(failure["elapsed_ms"], 4000);
    assert_eq!(failure["snapshot_present"], true);
    assert_eq!(failure["snapshot_source"], "direct");
    assert_eq!(failure["waiting_for_transport"], true);
    assert_eq!(failure["waiting_for_first_semantic"], false);
    assert_eq!(failure["build_version"], "1.5.0");
}

#[test]
fn a_first_output_abort_is_measured_from_the_model_request() {
    let (_, failure) = abort_trace(
        json!({
            "sessionId": "s", "error": {"message": "agent first semantic response stale (45000ms)"},
            "snapshot": {"waitingForFirstSemantic": true, "modelRequestStartedAt": 2000, "askStartedAt": 1000, "lastProgressAt": 3000},
            "policy": {"idleStaleMs": 1},
        }),
        10_000,
    )
    .unwrap();
    assert_eq!(failure["window"], "first_output");
    assert_eq!(failure["form"], "first_semantic");
    assert_eq!(failure["compared_field"], "model_request_started_at");
    assert_eq!(failure["elapsed_ms"], 8000);
}

#[test]
fn an_idle_abort_without_a_snapshot_falls_back_to_the_anchor_and_the_policy_limit() {
    let (_, failure) = abort_trace(
        json!({
            "sessionId": "s", "anchorTs": 4000,
            "error": {"message": "agent task stale (600000ms without stream/tool progress)"},
        }),
        9000,
    )
    .unwrap();
    assert_eq!(failure["window"], "idle");
    assert_eq!(failure["form"], "idle_progress");
    assert_eq!(failure["limit_ms"], 600000);
    assert_eq!(failure["compared_field"], "anchor_ts");
    assert_eq!(failure["elapsed_ms"], 5000);
    assert_eq!(failure["snapshot_present"], false);
    assert_eq!(failure["snapshot_source"], Value::Null);

    let (_, other) = abort_trace(json!({"sessionId": "s", "error": {"message": "boom"}}), 9000).unwrap();
    assert_eq!(other["form"], "other");
    assert_eq!(other["window"], Value::Null);
    assert_eq!(other["elapsed_ms"], Value::Null, "no clock, no elapsed time");
}

/// Failure deadline of every wait: nothing in a passing run waits for it.
const DEADLINE: Duration = Duration::from_secs(60);

enum Event {
    Blocked,
    Writing(String),
}

/// Holds the first flush at its write until the test releases it; reports every write and every flush that waits.
struct Probe {
    events: Mutex<mpsc::Sender<Event>>,
    release: Mutex<mpsc::Receiver<()>>,
    held_first: AtomicBool,
}

impl flush_probe::Probe for Probe {
    fn blocked(&self) {
        self.events.lock().unwrap().send(Event::Blocked).unwrap();
    }

    fn writing(&self, chunk: &str) {
        self.events.lock().unwrap().send(Event::Writing(chunk.to_owned())).unwrap();
        if !self.held_first.swap(true, Ordering::SeqCst) {
            self.release.lock().unwrap().recv_timeout(DEADLINE).expect("the test did not release the first flush from its write");
        }
    }
}

#[test]
fn a_flush_started_while_another_writes_waits_and_keeps_the_rows_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("trace").join("agent-trace.jsonl");
    let env: BTreeMap<String, String> = [("MIXDOG_DIAGNOSTICS", "1"), ("MIXDOG_AGENT_TRACE_PATH", path.to_str().unwrap())]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    let trace = AgentTrace::new(&TraceConfig::from_env(dir.path(), &|name| env.get(name).cloned(), false));
    let (events, seen) = mpsc::channel();
    let (release, released) = mpsc::channel();
    flush_probe::install(
        &path,
        Arc::new(Probe { events: Mutex::new(events), release: Mutex::new(released), held_first: AtomicBool::new(false) }),
    );
    let now = 1_700_000_000_000;
    let row = |n: i64| object(json!({"kind": "r", "ts": n, "sessionId": "s"}));
    let line = |n: i64| format!("{{\"kind\":\"r\",\"ts\":{n},\"session_id\":\"s\",\"payload\":{{}}}}");
    let next = || seen.recv_timeout(DEADLINE).expect("no flush reached its write or its wait for the first flush");
    std::thread::scope(|scope| {
        // Owned here: a failed assertion drops it, which frees the held flush instead of leaving the scope waiting for it.
        let release = release;
        trace.append(&row(1), now);
        let first = scope.spawn(|| trace.flush(now));
        let Event::Writing(chunk) = next() else { panic!("the first flush did not write first") };
        assert_eq!(chunk.lines().collect::<Vec<_>>(), [line(1)], "the first write holds only the row queued before it");
        trace.append(&row(2), now);
        trace.append(&row(3), now);
        let second = scope.spawn(|| trace.flush(now));
        assert!(matches!(next(), Event::Blocked), "a second flush wrote while the first held its write");
        release.send(()).unwrap();
        let Event::Writing(chunk) = next() else { panic!("the second flush did not write after the first") };
        assert_eq!(chunk.lines().collect::<Vec<_>>(), [line(2), line(3)], "the rows queued meanwhile follow, in order");
        assert!(first.join().unwrap().is_empty());
        assert!(second.join().unwrap().is_empty());
    });
    let written = fs::read_to_string(&path).unwrap();
    assert_eq!(written.lines().collect::<Vec<_>>(), [line(1), line(2), line(3)]);
}
