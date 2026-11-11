//! The agents-section rows against Node's real list and job render
//! (`fixtures/agent-status/golden.json`, from `benchmarks/rust-core/recorders/record-agent-status.mjs`):
//! each worker and job is given to the builders as the recorded session, runtime and snapshot state,
//! and every row is compared whole with the one `liveAgentStatusRow` left.

use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::progress::RuntimeFacts;
use mixdog_agent::agent_tool::progress::Snapshot;

use super::*;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/agent-status/golden.json");

fn ms(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn live_of(runtime: &Value, snapshot: &Value, depth: &Value) -> WorkerLive {
    WorkerLive {
        runtime_stage: runtime["stage"].as_str().map(str::to_owned),
        snapshot: snapshot.as_object().map(|_| Snapshot {
            stage: snapshot["stage"].as_str().map(str::to_owned),
            last_progress_at: ms(snapshot, "lastProgressAt"),
            waiting_for_transport: snapshot["waitingForTransport"] == json!(true),
            waiting_for_first_semantic: snapshot["waitingForFirstSemantic"] == json!(true),
            ..Snapshot::default()
        }),
        runtime: runtime.as_object().map(|_| RuntimeFacts {
            last_progress_at: ms(runtime, "lastProgressAt"),
            last_stream_delta_at: ms(runtime, "lastStreamDeltaAt"),
            last_tool_call: runtime["lastToolCall"].as_str().map(str::to_owned),
            ..RuntimeFacts::default()
        }),
        queued_followups: depth.as_u64(),
        task_waiting: runtime["taskWaits"].as_u64().is_some_and(|n| n > 0),
        ..WorkerLive::default()
    }
}

fn awaiting(runtime: &Value) -> Option<Value> {
    runtime.get("awaitingUser").cloned()
}

#[test]
fn the_worker_rows_are_the_rows_nodes_list_leaves_after_live_agent_status_row() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let now = golden["now"].as_i64().unwrap();
    let mut listed = Vec::new();
    for worker in golden["workers"].as_array().unwrap() {
        let session = worker["session"].as_object().unwrap().clone();
        let live = live_of(&worker["runtime"], &worker["snapshot"], &worker["depth"]);
        let (status, stage) = row_state(&session, live.runtime_stage.as_deref());
        if !is_active_worker(&status, &stage) {
            continue;
        }
        let row = worker_status_row(&WorkerStatus {
            tag: worker["tag"].as_str().unwrap(),
            session: &session,
            live: &live,
            awaiting_user: awaiting(&worker["runtime"]),
            messages: count_of(&session, "messages", "messageCount"),
            tools: count_of(&session, "tools", "toolCount"),
            index_turn_started_at: worker["indexRow"]["turnStartedAt"].as_str(),
            todo: todo_progress(session.get("todo")),
            now,
        });
        let id = session["id"].as_str().unwrap().to_owned();
        let want = golden["workerRows"].as_array().unwrap().iter().find(|r| r["sessionId"] == json!(id)).unwrap_or_else(|| panic!("{id} is not listed by Node"));
        assert_eq!(Value::Object(row), *want, "{id}");
        listed.push(id);
    }
    let want: Vec<&str> = golden["workerRows"].as_array().unwrap().iter().map(|r| r["sessionId"].as_str().unwrap()).collect();
    assert_eq!(listed, want, "the listed workers");
}

#[test]
fn the_job_rows_are_the_rows_nodes_job_render_leaves_after_live_agent_status_row() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let now = golden["now"].as_i64().unwrap();
    let text = |value: &Value| value.as_str().map(str::to_owned);
    let mut seen = 0;
    for job in golden["jobs"].as_array().unwrap() {
        // The status the table really holds (a queued request may stay running).
        let want = golden["jobRows"].as_array().unwrap().iter().find(|r| r["task_id"] == job["id"]).unwrap();
        let status = want["status"].as_str().unwrap();
        let terminal = matches!(status, "completed" | "failed" | "cancelled");
        let meta = &job["meta"];
        let snapshot = JobSnapshot {
            task_id: job["id"].as_str().unwrap().to_owned(),
            operation: job["operation"].as_str().unwrap().to_owned(),
            label: None,
            status: status.to_owned(),
            started_ms: now,
            finished_ms: terminal.then_some(now),
            error: text(&job["error"]),
            result: None,
            meta: JobMeta {
                tag: text(&job["tag"]),
                session_id: text(&job["sessionId"]),
                agent: text(&meta["agent"]),
                preset: text(&meta["preset"]),
                provider: text(&meta["provider"]),
                model: text(&meta["model"]),
                effort: text(&meta["effort"]),
                fast: meta["fast"].as_bool(),
                respawned: false,
                resumed: false,
                auto_effort_off: false,
            },
            notified: false,
            terminal_reason: None,
        };
        let worker = &job["worker"];
        let session = worker["session"].as_object().cloned();
        let live = live_of(&worker["runtime"], &worker["snapshot"], &worker["depth"]);
        let row = job_status_row(&JobStatus {
            job: &snapshot,
            session: session.as_ref(),
            live: &live,
            awaiting_user: awaiting(&worker["runtime"]),
            now,
        });
        assert_eq!(Value::Object(row), *want, "{}", job["id"]);
        seen += 1;
    }
    assert_eq!(seen, golden["jobRows"].as_array().unwrap().len());
}
