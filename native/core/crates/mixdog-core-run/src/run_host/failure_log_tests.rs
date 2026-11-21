use std::future::Future;
use std::pin::Pin;
use std::task::Context;
use std::task::Waker;

use super::*;

struct At(i64);

impl Clock for At {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

fn row(tool: &str) -> Map<String, Value> {
    let Value::Object(row) = json!({ "sessionId": "s", "toolName": tool, "resultText": "failed", "resultKind": "error" }) else { unreachable!() };
    row
}

type Flush = Pin<Box<dyn Future<Output = ()> + Send>>;

/// A flush stuck on the lane with seven more asked for behind it once spent a lane worker on each of them (they waited for the
/// turn inside their lane jobs). The seven are asked for from the lane, right after the first job wrote its chunk: they submit
/// nothing, and one more job, started after they asked, writes the row queued meanwhile and answers all of them.
#[tokio::test]
async fn flushes_asked_for_while_one_runs_wait_off_the_lane_and_share_the_next_flush() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    let config = TraceConfig::from_env(data.path(), &|_| None, false);
    let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
    let writer = Arc::new(FailureWriter::new(&config, io, Arc::new(At(1))));
    let asked: Arc<Mutex<Vec<Flush>>> = Arc::default();
    {
        let (writer_on_lane, asked) = (Arc::downgrade(&writer), Arc::clone(&asked));
        *writer.on_lane.lock().unwrap() = Some(Arc::new(move || {
            let writer = writer_on_lane.upgrade().unwrap();
            if writer.submitted.load(Ordering::Acquire) != 1 {
                return;
            }
            writer.trace.tool_failure(&row("second"), 2);
            for _ in 0..7 {
                let writer = Arc::clone(&writer);
                let mut flush: Flush = Box::pin(async move { writer.flush().await });
                assert!(flush.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending(), "a flush asked for while one runs did not wait");
                asked.lock().unwrap().push(flush);
            }
            assert_eq!(writer.submitted.load(Ordering::Acquire), 1, "a flush asked for while one runs went to the lane");
        }));
    }

    writer.trace.tool_failure(&row("first"), 1);
    writer.flush().await;

    let asked = std::mem::take(&mut *asked.lock().unwrap());
    assert_eq!(asked.len(), 7);
    for flush in asked {
        mixdog_rt::time::timeout(Duration::from_secs(30), flush).await.expect("a flush asked for while one ran was not answered within 30 s");
    }
    assert_eq!(writer.submitted.load(Ordering::Acquire), 2, "the seven flushes asked for meanwhile share one lane job");
    let written = mixdog_testkit::read_string(data.path().join("history").join("tool-failures.jsonl"));
    let tools: Vec<String> = written.lines().map(|line| serde_json::from_str::<Value>(line).unwrap()["tool_name"].as_str().unwrap().to_owned()).collect();
    assert_eq!(tools, ["first", "second"]);
    assert!(!writer.turn.lock().unwrap().running);
}

/// A running flush cancelled while the lane still has its job keeps the turn until that job ends: the job still writes its
/// chunk, and a flush that took the turn at the cancellation would write a later chunk before it.
#[tokio::test]
async fn a_cancelled_flush_keeps_the_turn_until_its_lane_job_ends() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    let config = TraceConfig::from_env(data.path(), &|_| None, false);
    let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
    let writer = Arc::new(FailureWriter::new(&config, io, Arc::new(At(1))));

    // The first flush as its cancellation finds it: the turn taken, its job on the lane.
    let running = Running { writer: &writer, served: Vec::new(), finished: false };
    let job = {
        let mut turn = writer.turn.lock().unwrap();
        turn.running = true;
        turn.job_live = true;
        JobEnd(Arc::clone(&writer.turn))
    };
    drop(running);

    writer.trace.tool_failure(&row("second"), 2);
    let next = Arc::clone(&writer);
    let mut next: Flush = Box::pin(async move { next.flush().await });
    assert!(next.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending(), "a flush took the turn while the cancelled one's job lived");
    assert_eq!(writer.submitted.load(Ordering::Acquire), 0);

    drop(job);
    mixdog_rt::time::timeout(Duration::from_secs(30), next).await.expect("the waiting flush did not take the turn within 30 s of the job's end");
    assert_eq!(writer.submitted.load(Ordering::Acquire), 1);
    assert!(mixdog_testkit::read_string(data.path().join("history").join("tool-failures.jsonl")).contains("\"second\""));
    let turn = writer.turn.lock().unwrap();
    assert!(!turn.running && !turn.job_live && !turn.orphaned);
}

struct TraceRig {
    data: tempfile::TempDir,
    writer: Arc<FailureWriter>,
    log: RunFailureLog,
}

impl TraceRig {
    fn new() -> Self {
        let tokens = mixdog_rt::testing::tokens();
        let data = tempfile::tempdir().unwrap();
        let config = TraceConfig::from_env(data.path(), &|name| (name == "MIXDOG_DIAGNOSTICS").then(|| "1".to_owned()), false);
        let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
        let writer = Arc::new(FailureWriter::new(&config, io, Arc::new(At(1))));
        let log = RunFailureLog::new(Arc::clone(&writer), "s", Some("lead"), "/ws");
        Self { data, writer, log }
    }

    fn batch(&self, calls: &[(&str, &str)]) {
        use mixdog_agent::env::{ToolBatch, ToolBatchCall};
        let calls = calls.iter().map(|(id, name)| ToolBatchCall { tool_call_id: (*id).into(), tool_name: (*name).into(), array_lengths: None }).collect();
        self.log.batch(&ToolBatch { iteration: 1, calls });
    }

    async fn trace_rows(&self) -> Vec<Value> {
        self.writer.flush().await;
        mixdog_testkit::read_string(self.data.path().join("history").join("agent-trace.jsonl"))
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn failure_rows(&self) -> usize {
        mixdog_testkit::read_string(self.data.path().join("history").join("tool-failures.jsonl")).lines().count()
    }
}

fn traced(id: &str, name: &str, kind: &'static str) -> mixdog_agent::env::TracedCall {
    mixdog_agent::env::TracedCall {
        iteration: 1,
        tool_call_id: id.into(),
        tool_name: name.into(),
        tool_kind: "builtin",
        tool_ms: 5,
        tool_args: json!({ "path": "." }),
        model: "m".into(),
        result_kind: kind,
        result: json!("Error: no"),
        result_text: "Error: no".into(),
        timing: None,
        execution_intervals: Vec::new(),
        result_telemetry: None,
        local_search: None,
    }
}

/// A tool row names its batch and keeps every run of the call (an ambiguous edit and its retry): `recordToolBatch`, `traceAgentTool`.
#[tokio::test]
async fn a_tool_row_names_its_batch_and_keeps_every_run_of_the_call() {
    use mixdog_agent::env::TracedCall;
    let rig = TraceRig::new();
    rig.batch(&[("x1", "edit")]);
    rig.log.tool(TracedCall { execution_intervals: vec![(10, 20), (20, 30)], result: json!("ok"), result_text: "ok".into(), ..traced("x1", "edit", "normal") });
    let rows = rig.trace_rows().await;
    let kinds: Vec<&str> = rows.iter().map(|row| row["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["batch", "tool"]);
    let batch_id = rows[0]["payload"]["batch_id"].as_str().unwrap();
    assert_eq!(rows[1]["payload"]["batch"], json!({ "batch_id": batch_id, "tool_call_id": "x1" }));
    assert_eq!(
        rows[1]["payload"]["execution_intervals"],
        json!([{ "started_at_ms": 10, "completed_at_ms": 20 }, { "started_at_ms": 20, "completed_at_ms": 30 }])
    );
    assert_eq!(rows[1]["local_search"], Value::Null);
}

/// A tool row carries what the tool reported about its result and its search.
#[tokio::test]
async fn a_tool_row_carries_the_result_telemetry_and_search_the_tool_reported() {
    use mixdog_agent::env::TracedCall;
    let rig = TraceRig::new();
    rig.batch(&[("l1", "list")]);
    let integrity = json!({ "kind": "directory-walk", "status": "complete", "entriesVisited": 3, "warnings": 0 });
    let search = json!({ "native_hits": 1, "native_ms": 4 });
    rig.log.tool(TracedCall { result_telemetry: Some(json!({ "integrity": integrity })), local_search: Some(search.clone()), ..traced("l1", "list", "error") });
    let rows = rig.trace_rows().await;
    assert_eq!(rows[1]["payload"]["integrity"], integrity);
    assert_eq!(rows[1]["local_search"], search);
}

/// An error call also gets its failure row, once.
#[tokio::test]
async fn an_error_call_also_gets_its_failure_row_once() {
    let rig = TraceRig::new();
    rig.batch(&[("l1", "list")]);
    rig.log.tool(traced("l1", "list", "error"));
    rig.writer.flush().await;
    assert_eq!(rig.failure_rows(), 1);
}

/// A cache hit's row keeps its batch and its (empty) execution, and nothing of what the call asked or answered.
#[tokio::test]
async fn a_cache_hit_row_keeps_nothing_of_what_the_call_asked_or_answered() {
    use mixdog_agent::env::TracedCall;
    let rig = TraceRig::new();
    rig.batch(&[("r1", "read"), ("g1", "grep")]);
    for (id, name, kind) in [("r1", "read", "cache-hit"), ("g1", "grep", "scoped-cache-hit")] {
        rig.log.tool(TracedCall {
            tool_ms: 0,
            tool_args: json!({ "path": "private-path", "pattern": "private-query" }),
            result: json!("private-body"),
            result_text: "private-body".into(),
            ..traced(id, name, kind)
        });
    }
    let rows = rig.trace_rows().await;
    let batch_id = rows[0]["payload"]["batch_id"].as_str().unwrap();
    for (row, id, kind) in [(&rows[1], "r1", "cache-hit"), (&rows[2], "g1", "scoped-cache-hit")] {
        assert_eq!(row["result_kind"], kind);
        assert_eq!(row["payload"]["batch"], json!({ "batch_id": batch_id, "tool_call_id": id }));
        assert_eq!(row["payload"]["execution_intervals"], json!([]));
        assert!(row["tool_args"].is_null() && row["tool_args_hash"].is_null());
        assert!(!row.to_string().contains("private-"));
    }
}

/// A cross-turn dedup receipt is a `steer` row with its tag and counts.
#[tokio::test]
async fn a_cross_turn_receipt_is_a_steer_row() {
    use mixdog_agent::env::CrossTurnReceipt;
    let rig = TraceRig::new();
    rig.log.cross_turn_receipt(CrossTurnReceipt { iteration: 2, tool: "grep", occurrence: 2, first_iteration: 1, total: 1 });
    let rows = rig.trace_rows().await;
    assert_eq!(rows[0]["kind"], "steer");
    assert_eq!(
        rows[0]["payload"],
        json!({
            "tag": "cross_turn_dedup", "tool": "grep", "occurrence": 2, "first_iteration": 1, "dedup_stub_total": 1,
        })
    );
}

/// A completed send's `loop` row and a host browser command's `browser_timing` row join the agent trace in Node's shape
/// (`traceAgentLoop`, `traceBrowserTiming`) only under `MIXDOG_AGENT_TRACE_TIMING`; without it nothing of them is queued or
/// flushed, and the trace holds the run's other rows alone.
#[tokio::test]
async fn timing_rows_join_the_agent_trace_only_under_the_timing_env() {
    use mixdog_agent::env::ToolBatchCall;
    let tokens = mixdog_rt::testing::tokens();
    for timing in [false, true] {
        let data = tempfile::tempdir().unwrap();
        let env = |name: &str| (name == "MIXDOG_DIAGNOSTICS" || (timing && name == "MIXDOG_AGENT_TRACE_TIMING")).then(|| "1".to_owned());
        let config = TraceConfig::from_env(data.path(), &env, false);
        let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
        let writer = Arc::new(FailureWriter::new(&config, io, Arc::new(At(1))));
        assert_eq!(writer.timing_rows(), timing, "the gate a caller checks before it times or builds anything");
        let log = RunFailureLog::new(Arc::clone(&writer), "s", Some("lead"), "/ws");
        log.provider_send(ProviderSend { iteration: 2, send_ms: 40, pre_send_ms: 5, tool_resume_ms: Some(3), message_count: 7 });
        let Value::Object(command) = json!({
            "context": { "sessionId": "s", "action": "click" },
            "bridgeMs": 12.5,
            "body": { "ok": true, "value": { "timing": { "queueMs": 1, "commandMs": 9, "url": "private" } } },
        }) else {
            unreachable!()
        };
        writer.record_browser_timing(&command);
        assert_eq!(writer.armed.load(Ordering::Acquire), timing, "a gated row arms no flush");
        log.batch(&ToolBatch { iteration: 2, calls: vec![ToolBatchCall { tool_call_id: "c1".into(), tool_name: "browser".into(), array_lengths: None }] });
        writer.flush().await;

        let written = mixdog_testkit::read_string(data.path().join("history").join("agent-trace.jsonl"));
        let lines: Vec<&str> = written.lines().collect();
        let kinds: Vec<String> = lines.iter().map(|line| serde_json::from_str::<Value>(line).unwrap()["kind"].as_str().unwrap().to_owned()).collect();
        if !timing {
            assert_eq!(kinds, ["batch"]);
            continue;
        }
        assert_eq!(kinds, ["loop", "browser_timing", "batch"]);
        assert_eq!(
            lines[0],
            r#"{"iteration":2,"kind":"loop","agent":"lead","send_ms":40,"pre_send_ms":5,"tool_resume_ms":3,"message_count":7,"body_bytes_est":null,"ts":1,"session_id":"s","payload":{}}"#
        );
        assert_eq!(
            lines[1],
            r#"{"kind":"browser_timing","action":"click","bridge_ms":12.5,"ok":true,"payload":{"queueMs":1,"commandMs":9},"ts":1,"session_id":"s"}"#
        );
    }
    // The env alone, with no trace file to take the rows (no diagnostic I/O, no `MIXDOG_AGENT_TRACE_PATH`), opens nothing.
    let data = tempfile::tempdir().unwrap();
    let env = |name: &str| (name == "MIXDOG_AGENT_TRACE_TIMING").then(|| "1".to_owned());
    let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
    assert!(!FailureWriter::new(&TraceConfig::from_env(data.path(), &env, false), io, Arc::new(At(1))).timing_rows());
}

/// A running flush whose task is cancelled with no job on the lane gives the turn up at once: the flush that waited on it
/// takes the turn and writes.
#[tokio::test]
async fn a_flush_waiting_on_a_cancelled_one_takes_the_turn() {
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    let config = TraceConfig::from_env(data.path(), &|_| None, false);
    let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
    let writer = Arc::new(FailureWriter::new(&config, io, Arc::new(At(1))));

    let running = Running { writer: &writer, served: Vec::new(), finished: false };
    writer.turn.lock().unwrap().running = true;
    writer.trace.tool_failure(&row("first"), 1);
    let waiting = Arc::clone(&writer);
    let mut waiting: Flush = Box::pin(async move { waiting.flush().await });
    assert!(waiting.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
    drop(running);

    mixdog_rt::time::timeout(Duration::from_secs(30), waiting).await.expect("the waiting flush did not take the turn within 30 s");
    assert_eq!(writer.submitted.load(Ordering::Acquire), 1);
    assert!(mixdog_testkit::read_string(data.path().join("history").join("tool-failures.jsonl")).contains("\"first\""));
}

/// A completed request's `usage_raw` row (`traceAgentUsage`) is in the agent trace with the session, the counts and the prompt total
/// of its provider's kind (Anthropic's cached tokens add to the input, a OpenAI-kind's are inside it).
#[tokio::test]
async fn a_requests_usage_raw_row_joins_the_agent_trace() {
    let tokens = mixdog_rt::testing::tokens();
    for (provider, prompt) in [("anthropic", 160), ("openai", 100)] {
        let data = tempfile::tempdir().unwrap();
        let env = |name: &str| (name == "MIXDOG_DIAGNOSTICS").then(|| "1".to_owned());
        let config = TraceConfig::from_env(data.path(), &env, false);
        let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
        let writer = Arc::new(FailureWriter::new(&config, io, Arc::new(At(1))));
        let log = RunFailureLog::new(Arc::clone(&writer), "s", Some("lead"), "/ws");
        let usage = mixdog_core_api::domain::provider::Usage { input_tokens: 100, output_tokens: 7, cache_read_tokens: 60, ..Default::default() };
        log.request_usage(RequestUsage {
            iteration: 3,
            provider: provider.into(),
            model: "m".into(),
            requested_model: "m".into(),
            source_type: Some("compaction".into()),
            usage,
        });
        writer.flush().await;
        let written = mixdog_testkit::read_string(data.path().join("history").join("agent-trace.jsonl"));
        let row: Value = serde_json::from_str(written.lines().next().expect("a row")).unwrap();
        assert_eq!((row["kind"].as_str(), row["session_id"].as_str(), row["iteration"].as_u64()), (Some("usage_raw"), Some("s"), Some(3)), "{provider}");
        assert_eq!(
            (row["input_tokens"].as_u64(), row["output_tokens"].as_u64(), row["cached_tokens"].as_u64(), row["prompt_tokens"].as_u64()),
            (Some(100), Some(7), Some(60), Some(prompt)),
            "{provider}"
        );
        assert_eq!((row["request_kind"].as_str(), row["payload"]["source_type"].as_str()), (Some("compaction"), Some("compaction")), "{provider}");
    }
}
