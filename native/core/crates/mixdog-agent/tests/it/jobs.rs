//! The agent tool's job board and progress derivation against Node's recorded results
//! (`fixtures/agent/record-jobs.mjs`).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::CancelAll;
use mixdog_agent::agent_tool::board::CancelNotice;
use mixdog_agent::agent_tool::board::Completion;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::board::JobOwner;
use mixdog_agent::agent_tool::board::JobSnapshot;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::progress::ProgressInput;
use mixdog_agent::agent_tool::progress::RuntimeFacts;
use mixdog_agent::agent_tool::progress::SemanticKind;
use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::agent_tool::progress::ToolSilence;
use mixdog_agent::agent_tool::progress::WatchdogPolicy;
use mixdog_agent::agent_tool::progress::WatchdogState;
use mixdog_agent::agent_tool::progress::progress_fields;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::stamp::iso_from_ms;
use mixdog_agent::env::Clock;
use mixdog_protocol::ThreadId;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::orch::agent::TaskResult;
use serde_json::Value;
use serde_json::json;

#[allow(clippy::disallowed_methods)] // test fixture loading
fn fixture(name: &str) -> Vec<Value> {
    let text = std::fs::read_to_string(format!("{}/../../fixtures/agent/jobs/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    serde_json::from_str::<Value>(&text).unwrap().as_array().unwrap().clone()
}

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
struct Notices {
    sent: Mutex<Vec<(String, String)>>,
    arrived: tokio::sync::Notify,
}

#[async_trait]
impl TaskNotifier for Notices {
    async fn finished(&self, owner: &ThreadId, surface: &str, _task_id: &str, _status: &str, notification: String) {
        assert_eq!(surface, "agent");
        self.sent.lock().unwrap().push((owner.as_str().to_owned(), notification));
        self.arrived.notify_waiters();
    }
}

/// Installs the test backend. Its ticker is per runtime (hang-lanes-138), so each test's deadlines
/// run on its own runtime's clock, paused or not, and nothing outlives the test.
fn backend() {
    mixdog_rt::testing::tokens();
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn scope(v: &Value) -> Scope {
    let s = v.get("scope").unwrap_or(&Value::Null);
    Scope { caller_session_id: text(s, "session"), host_pid: s.get("pid").and_then(Value::as_u64) }
}

fn row(t: &JobSnapshot) -> Value {
    json!({
        "task_id": t.task_id,
        "operation": t.operation,
        "label": t.label,
        "status": t.status,
        "startedAt": iso_from_ms(t.started_ms),
        "finishedAt": t.finished_ms.map(iso_from_ms),
        "error": t.error,
        "notified": t.notified,
        "tag": t.meta.tag,
        "sessionId": t.meta.session_id,
        "terminalReason": t.terminal_reason,
    })
}

/// Waits until `want` notifications have been delivered (delivery runs on a spawned task of the
/// runtime's work pool), then lets any task already runnable finish. The bound only turns a
/// notification that never arrives into a failure.
async fn settle(notices: &Notices, want: usize) {
    let arrive = async {
        loop {
            let arrived = notices.arrived.notified();
            tokio::pin!(arrived);
            arrived.as_mut().enable();
            if notices.sent.lock().unwrap().len() >= want {
                break;
            }
            arrived.await;
        }
    };
    mixdog_rt::time::timeout(std::time::Duration::from_secs(10), arrive).await.expect("a notification never arrived");
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}
#[tokio::test(start_paused = true)]
async fn the_board_equals_nodes_background_tasks() {
    backend();
    let board_rows = |board: &JobBoard, scope: &Scope| Value::Array(board.list_jobs(scope).iter().map(row).collect());
    for scenario in fixture("board.json") {
        let name = scenario["name"].as_str().unwrap();
        let start = scenario["start"].as_i64().unwrap();
        let clock = Arc::new(TestClock(AtomicI64::new(start)));
        let notices = Arc::new(Notices::default());
        let board = JobBoard::new(clock.clone(), Some(notices.clone()), None);
        let settled: Arc<Mutex<Vec<String>>> = Arc::default();
        {
            let settled = settled.clone();
            board.on_command_settled(Arc::new(move |cwd| settled.lock().unwrap().push(cwd.to_owned())));
        }
        let mut runs: std::collections::HashMap<String, tokio::sync::oneshot::Sender<Result<Option<TaskResult>, String>>> = Default::default();
        for (i, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            let want = &scenario["results"][i];
            let id = text(op, "id").unwrap_or_default();
            let mut got = serde_json::Map::new();
            let content = |key: &str| op.get(key).and_then(Value::as_str).map(|c| TaskResult::Content(c.to_owned()));
            match op["op"].as_str().unwrap() {
                "register" => {
                    let tag = text(op, "tag");
                    let session = text(op, "sessionId");
                    let operation = text(op, "operation").unwrap_or_else(|| "spawn".to_owned());
                    let result = board.register(NewJob {
                        task_id: Some(id.clone()),
                        label: tag.clone().or_else(|| session.clone()).or_else(|| Some(operation.clone())),
                        operation,
                        owner: JobOwner { caller_session_id: text(op, "caller"), owner_session_id: text(op, "owner"), host_pid: op.get("pid").and_then(Value::as_u64) },
                        meta: JobMeta { tag, session_id: session, agent: text(op, "agent"), ..JobMeta::default() },
                        notify_on_cancel: op.get("notifyOnCancel") == Some(&Value::Bool(true)),
                        started_at_ms: op.get("startedAt").and_then(Value::as_i64).map(|offset| start + offset),
                        cancel: None,
                        cwd: text(op, "cwd"),
                        render: None,
                    });
                    if let Err(error) = result {
                        got.insert("error".into(), Value::String(error));
                    }
                }
                "start" => {
                    let (send, receive) = tokio::sync::oneshot::channel();
                    runs.insert(id.clone(), send);
                    let tag = text(op, "tag");
                    board
                        .start(
                            NewJob {
                                task_id: Some(id.clone()),
                                label: tag.clone().or_else(|| Some("spawn".to_owned())),
                                operation: "spawn".into(),
                                owner: JobOwner { caller_session_id: text(op, "caller"), ..JobOwner::default() },
                                meta: JobMeta { tag, session_id: text(op, "sessionId"), ..JobMeta::default() },
                                notify_on_cancel: op.get("notifyOnCancel") == Some(&Value::Bool(true)),
                                ..NewJob::default()
                            },
                            |_| async move { receive.await.unwrap() },
                        )
                        .unwrap();
                }
                "resolveRun" => {
                    let _ = runs.remove(&id).unwrap().send(Ok(content("content")));
                }
                "rejectRun" => {
                    let _ = runs.remove(&id).unwrap().send(Err(text(op, "error").unwrap()));
                }
                "cancelAll" => {
                    let notice = match op.get("notice").and_then(Value::as_str) {
                        Some("now") => CancelNotice::Now,
                        Some("never") => CancelNotice::Never,
                        _ => CancelNotice::Default,
                    };
                    let cancelled = board.cancel_all(&CancelAll {
                        reason: text(op, "reason").unwrap_or_default(),
                        terminal_reason: text(op, "terminalReason"),
                        execution_session_id: text(op, "execution"),
                        scope: scope(op),
                        started_since_ms: op.get("startedSince").and_then(Value::as_i64).map_or(0, |offset| start + offset),
                        notice,
                    });
                    got.insert("cancelled".into(), json!(cancelled));
                }
                "complete" => {
                    board.complete(
                        &id,
                        Completion {
                            result: content("content"),
                            result_text: text(op, "resultText"),
                            error: text(op, "error"),
                            notify: op.get("notify") != Some(&Value::Bool(false)),
                            ..Completion::new(op["status"].as_str().unwrap())
                        },
                    );
                }
                "cancel" => {
                    let notice = match op.get("notice").and_then(Value::as_str) {
                        Some("now") => CancelNotice::Now,
                        Some("never") => CancelNotice::Never,
                        _ => CancelNotice::Default,
                    };
                    board.cancel(&id, op["reason"].as_str().unwrap(), notice);
                }
                "settle" => board.settle_cancelled(&id, content("content")),
                "reconcile" => board.reconcile(
                    &id,
                    Completion { result: content("content"), error: text(op, "error"), ..Completion::new(op["status"].as_str().unwrap()) },
                ),
                "ack" => board.acknowledge(&id),
                "appendix" => {
                    let appendix = text(op, "text").unwrap();
                    board.set_report_appendix(&id, Arc::new(move || appendix.clone()));
                }
                "merge" => {
                    let meta = op["meta"].clone();
                    board.update_meta(&id, |m| {
                        m.tag = text(&meta, "tag");
                        m.session_id = text(&meta, "sessionId");
                    });
                }
                "advance" => {
                    clock.0.fetch_add(op["ms"].as_i64().unwrap(), Ordering::SeqCst);
                }
                "list" => {
                    got.insert("rows".into(), board_rows(&board, &scope(op)));
                }
                "get" => {
                    let found = board.get(&id, &scope(op));
                    got.insert("found".into(), json!(found.is_some()));
                    got.insert("status".into(), json!(found.as_ref().map(|t| t.status.clone())));
                    got.insert("label".into(), json!(found.as_ref().and_then(|t| t.label.clone())));
                }
                "cleanup" => {
                    got.insert("removed".into(), json!(board.cleanup_jobs(&scope(op), op.get("force") == Some(&Value::Bool(true)))));
                }
                "bulk" => {
                    for i in 0..op["n"].as_u64().unwrap() {
                        clock.0.fetch_add(1, Ordering::SeqCst);
                        let id = format!("b{i}");
                        board.register(NewJob { task_id: Some(id.clone()), operation: "spawn".into(), ..NewJob::default() }).unwrap();
                        board.complete(&id, Completion { notify: false, ..Completion::new("completed") });
                    }
                    got.insert("rows".into(), json!(board.list_jobs(&Scope::default()).iter().map(|t| t.task_id.clone()).collect::<Vec<_>>()));
                }
                other => panic!("{name}: unknown op {other}"),
            }
            settle(&notices, want["notices"].as_array().map_or(0, Vec::len)).await;
            let sent: Vec<Value> = notices.sent.lock().unwrap().drain(..).map(|(session, text)| json!({ "session": session, "text": text })).collect();
            got.insert("notices".into(), Value::Array(sent));
            got.insert("settled".into(), json!(settled.lock().unwrap().drain(..).collect::<Vec<_>>()));
            assert_eq!(&Value::Object(got), want, "{name} op {i} ({})", op["op"]);
        }
    }
}

fn snapshot_of(v: &Value) -> Snapshot {
    let n = |k: &str| v.get(k).and_then(Value::as_i64).unwrap_or(0);
    let b = |k: &str| v.get(k) == Some(&Value::Bool(true));
    Snapshot {
        stage: text(v, "stage"),
        last_progress_at: n("lastProgressAt"),
        last_stream_delta_at: n("lastStreamDeltaAt"),
        tool_started_at: n("toolStartedAt"),
        ask_started_at: n("askStartedAt"),
        first_activity_at: n("firstActivityAt"),
        model_request_started_at: n("modelRequestStartedAt"),
        last_keepalive_at: n("lastKeepaliveAt"),
        last_visible_text_at: n("lastVisibleTextAt"),
        awaiting_model_response: b("awaitingModelResponse"),
        waiting_for_transport: b("waitingForTransport"),
        waiting_for_first_semantic: b("waitingForFirstSemantic"),
        has_first_semantic: b("hasFirstSemantic"),
        awaiting_user: b("awaitingUser"),
        last_semantic_kind: match v.get("lastSemanticKind").and_then(Value::as_str) {
            Some("tool") => Some(SemanticKind::Tool),
            Some("text") => Some(SemanticKind::Text),
            Some("reasoning") => Some(SemanticKind::Reasoning),
            _ => None,
        },
        current_tool: text(v, "currentTool"),
    }
}

#[test]
fn progress_fields_equal_nodes() {
    let cases = fixture("progress.json");
    assert!(cases.len() > 150);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let input = &case["input"];
        let snapshot = input.get("snapshot").map(snapshot_of);
        let runtime = input.get("runtime").map(|r| RuntimeFacts {
            last_progress_at: r.get("lastProgressAt").and_then(Value::as_i64).unwrap_or(0),
            last_stream_delta_at: r.get("lastStreamDeltaAt").and_then(Value::as_i64).unwrap_or(0),
            tool_started_at: r.get("toolStartedAt").and_then(Value::as_i64).unwrap_or(0),
            ask_started_at: r.get("askStartedAt").and_then(Value::as_i64).unwrap_or(0),
            empty_final: r.get("emptyFinal") == Some(&Value::Bool(true)),
            last_tool_call: text(r, "lastToolCall"),
        });
        let policy = input.get("policy").map(|p| WatchdogPolicy {
            first_transport_ms: p["firstTransportMs"].as_i64().unwrap(),
            first_semantic_ms: p["firstSemanticMs"].as_i64().unwrap(),
            idle_stale_ms: p["idleStaleMs"].as_i64().unwrap(),
        });
        let watchdog_state = input
            .get("watchdogState")
            .map(|w| WatchdogState { registered: w["registered"] == Value::Bool(true), error: text(w, "error") });
        let tool_silence = input.get("toolSilence").map(|q| ToolSilence {
            task_id: text(q, "taskId").unwrap(),
            silent_ms: q["silentMs"].as_u64().unwrap(),
            hung: q["hung"] == Value::Bool(true),
        });
        // `Number.isFinite(Number(x)) && x > 0`, floored: a string is not a count.
        let queued = input.get("queuedFollowups").and_then(Value::as_f64).map(|n| n.floor() as u64);
        let got = progress_fields(&ProgressInput {
            now: input["now"].as_i64().unwrap(),
            session_status: input.get("sessionStatus").and_then(Value::as_str),
            runtime_stage: input.get("runtimeStage").and_then(Value::as_str),
            snapshot: snapshot.as_ref(),
            runtime: runtime.as_ref(),
            policy,
            watchdog_state: watchdog_state.as_ref(),
            queued_followups: queued,
            task_status: input.get("taskStatus").and_then(Value::as_str),
            last_tool_call: input.get("lastToolCall").and_then(Value::as_str),
            tool_silence: tool_silence.as_ref(),
        });
        let mut out = serde_json::Map::new();
        out.insert("worker_stage".into(), json!(got.worker_stage));
        out.insert("last_progress".into(), json!(got.last_progress));
        out.insert("diagnostic".into(), json!(got.diagnostic));
        if let Some(v) = got.silent_for_secs {
            out.insert("silent_for".into(), json!(v));
        }
        if let Some(v) = got.watchdog {
            out.insert("watchdog".into(), json!(v));
        }
        if let Some(v) = got.tool_silent_for {
            out.insert("tool_silent_for".into(), json!(v));
        }
        if let Some(v) = got.queued_followups {
            out.insert("queued_followups".into(), json!(v));
        }
        assert_eq!(Value::Object(out), case["output"], "{name}");
    }
}
