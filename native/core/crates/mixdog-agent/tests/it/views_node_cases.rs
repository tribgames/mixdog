//! Node's job-views cases (`fixtures/job-views-cases`, `record-job-views-cases.mjs`): the test's sessions behind a
//! `Workers` seam (Node's test fakes the session manager the same way), its tasks on a `JobBoard`, and the agent
//! tool's text of each `JobViews` list, job list and status card (`render`) against Node's `renderResult`; the spawn
//! meta builders' identity fields against Node's meta objects.
#![allow(clippy::disallowed_methods)]

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::Completion;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::board::NewJob;
use mixdog_agent::agent_tool::flow::preset::pending_spawn_meta;
use mixdog_agent::agent_tool::flow::preset::prepared_spawn_meta;
use mixdog_agent::agent_tool::host::*;
use mixdog_agent::agent_tool::progress::RuntimeFacts;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::SessionFacts;
use mixdog_agent::agent_tool::scope::TagRecord;
use mixdog_agent::agent_tool::views::JobViews;
use mixdog_agent::agent_tool::views::Stamp;
use mixdog_agent::agent_tool::views::WorkerFacts;
use mixdog_agent::agent_tool::views::WorkerLive;
use mixdog_agent::agent_tool::views::Workers;
use mixdog_agent::env::Clock;
use mixdog_tools::orch::agent::AgentReply;
use mixdog_tools::orch::agent::TaskResult;
use mixdog_tools::orch::agent::render;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

struct Fixed(i64);
impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

fn s(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// The test's session records, as the session manager hands them over.
struct Sessions {
    records: HashMap<String, Value>,
    entries: Vec<(String, String)>,
}

fn facts(record: &Value) -> WorkerFacts {
    WorkerFacts {
        id: s(record, "id").unwrap(),
        agent: s(record, "agent"),
        provider: s(record, "provider"),
        model: s(record, "model"),
        status: s(record, "status"),
        closed: record["closed"] == true,
        created_at: s(record, "createdAt").map(Stamp::Text),
        client_host_pid: record["clientHostPid"].as_u64(),
        ..WorkerFacts::default()
    }
}

#[async_trait]
impl Workers for Sessions {
    async fn session(&self, id: &str) -> Option<WorkerFacts> {
        self.records.get(id).map(facts)
    }
    fn live(&self, id: &str) -> WorkerLive {
        let Some(runtime) = self.records.get(id).map(|r| &r["runtime"]).filter(|r| r.is_object()) else { return WorkerLive::default() };
        WorkerLive {
            runtime_stage: s(runtime, "stage"),
            runtime: Some(RuntimeFacts { last_stream_delta_at: runtime["lastStreamDeltaAt"].as_i64().unwrap_or(0), ..RuntimeFacts::default() }),
            ..WorkerLive::default()
        }
    }
    async fn entries(&self, _: bool, _: &Scope) -> Vec<(String, WorkerFacts)> {
        self.entries.iter().map(|(tag, id)| (tag.clone(), facts(&self.records[id]))).collect()
    }
}

#[derive(Default)]
struct Reg(Mutex<Vec<bool>>);
#[async_trait]
impl Registry for Reg {
    fn resolve_tombstone_owners(&self) {}
    async fn refresh_tags_from_sessions(&self, scan_sessions: bool, _: &Scope) {
        self.0.lock().unwrap().push(scan_sessions);
    }
    fn resolve_tag(&self, _: &str, _: &Scope, _: ResolveOptions) -> Result<Option<String>, String> {
        Ok(None)
    }
    fn live_session(&self, _: &str) -> Option<SessionFacts> {
        None
    }
    fn tag_session(&self, _: &str) -> Option<String> {
        None
    }
    fn has_tag_agent(&self, _: &str) -> bool {
        false
    }
    fn tag_count(&self) -> usize {
        0
    }
    fn tag_for_session(&self, _: &str) -> Option<String> {
        None
    }
    fn unbind_tag(&self, _: &str) {}
    fn bind_tag(&self, _: &str, _: &SessionFacts, _: &str) {}
    fn forget_terminal_session(&self, _: Option<&str>, _: &str) {}
    fn remove_worker_row(&self, _: &str) {}
    fn mark_released(&self, _: &[String]) {}
    fn read_worker_rows(&self, _: &Scope) -> Result<Vec<TagRecord>, String> {
        Ok(Vec::new())
    }
    fn read_all_tag_tombstones(&self) -> Vec<TagRecord> {
        Vec::new()
    }
    fn tag_tombstone_for_tag(&self, _: &str, _: &Scope) -> Option<TagRecord> {
        None
    }
    fn consume_tag_tombstone(&self, _: &TagRecord) {}
    fn last_tag_session(&self, _: &str, _: &Scope) -> Option<TagRecord> {
        None
    }
    async fn resumable_tag_session(&self, _: &str, _: &str, _: &Scope) -> Option<Resumable> {
        None
    }
}

fn rig(now: i64, case: &Value) -> (JobBoard, Arc<Reg>, JobViews) {
    let records = case["sessions"].as_array().unwrap().iter().map(|r| (s(r, "id").unwrap(), r.clone())).collect();
    let entries = case["entries"].as_array().map_or_else(Vec::new, |e| e.iter().map(|e| (s(e, "tag").unwrap(), s(e, "session").unwrap())).collect());
    let board = JobBoard::new(Arc::new(Fixed(now)), None, None);
    let reg = Arc::new(Reg::default());
    let views = JobViews::new(board.clone(), reg.clone(), Arc::new(Sessions { records, entries }), Arc::new(Fixed(now)));
    (board, reg, views)
}

fn meta_json(meta: &JobMeta) -> Value {
    json!({
        "tag": meta.tag, "sessionId": meta.session_id, "agent": meta.agent, "preset": meta.preset,
        "provider": meta.provider, "model": meta.model, "effort": meta.effort, "fast": meta.fast,
    })
}

/// Node's meta object restricted to the identity fields (its spread extras are the named difference).
fn identity(node: &Value) -> Value {
    let keys = ["tag", "sessionId", "agent", "preset", "provider", "model", "effort", "fast"];
    Value::Object(node.as_object().unwrap().iter().filter(|(k, _)| keys.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect::<Map<_, _>>())
}

async fn replay(now: i64, case: &Value) -> Value {
    match case["kind"].as_str().unwrap() {
        "list" => {
            let (_board, reg, views) = rig(now, case);
            let lead = Scope { caller_session_id: Some("lead".into()), ..Scope::default() };
            let active = views.list(&lead, ListOptions { scan_sessions: true, ..ListOptions::default() }).await;
            views.list(&Scope::default(), ListOptions { include_terminal: true, ..ListOptions::default() }).await;
            let roster = |workers| render(&AgentReply::Roster { workers, jobs: Vec::new() }, "");
            json!({ "refreshScans": *reg.0.lock().unwrap(), "active": roster(active) })
        }
        "jobs" => {
            let (board, _reg, views) = rig(now, case);
            for task in case["tasks"].as_array().unwrap() {
                let meta = &task["meta"];
                board
                    .register(NewJob {
                        task_id: s(task, "taskId"),
                        operation: s(task, "operation").unwrap(),
                        label: s(meta, "tag"),
                        meta: JobMeta {
                            tag: s(meta, "tag"),
                            session_id: s(meta, "sessionId"),
                            agent: s(meta, "agent"),
                            provider: s(meta, "provider"),
                            model: s(meta, "model"),
                            respawned: meta["respawned"] == true,
                            resumed: meta["resumed"] == true,
                            ..JobMeta::default()
                        },
                        started_at_ms: task["startedAtMs"].as_i64(),
                        ..NewJob::default()
                    })
                    .unwrap();
            }
            for (id, completion) in case["completions"].as_object().unwrap() {
                board.complete(
                    id,
                    Completion {
                        result: s(completion, "result").map(TaskResult::Content),
                        notify: completion["notify"] != false,
                        ..Completion::new(completion["status"].as_str().unwrap())
                    },
                );
            }
            let roster = |jobs| render(&AgentReply::Roster { workers: Vec::new(), jobs }, "");
            let host = |pid| Scope { host_pid: Some(pid), ..Scope::default() };
            let mut cards = Vec::new();
            for lookup in case["recorded"]["cards"].as_array().unwrap() {
                let args = &lookup["args"];
                let card = match views.get_job_or_worker(args, &Scope::default(), true).await {
                    Ok(job) => json!(render(&AgentReply::Task { view: job.view, diagnostics: true }, "")),
                    Err(error) => json!({ "error": error }),
                };
                cards.push(json!({ "args": args, "card": card }));
            }
            json!({
                "jobs": roster(views.list_jobs(&Scope::default()).await),
                "jobsHost777": roster(views.list_jobs(&host(777)).await),
                "jobsHost778": roster(views.list_jobs(&host(778)).await),
                "cards": cards,
            })
        }
        "meta" => {
            let recorded = &case["recorded"];
            let pending: Vec<Value> = recorded["pending"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| json!({ "args": p["args"], "extra": p["extra"], "meta": meta_json(&pending_spawn_meta(&p["args"], None, false)) }))
                .collect();
            let a = &recorded["prepared"]["args"];
            let prepared = prepared_spawn_meta(
                a["tag"].as_str().unwrap(),
                a["session"]["id"].as_str().unwrap(),
                a["agent"].as_str().unwrap(),
                &a["preset"],
                &a["presetName"],
                false,
            );
            json!({ "pending": pending, "prepared": { "args": a, "meta": meta_json(&prepared) } })
        }
        other => panic!("kind {other}"),
    }
}

/// The recording with each meta object restricted to its identity fields.
fn wanted(case: &Value) -> Value {
    let mut want = case["recorded"].clone();
    if case["kind"] == "meta" {
        for p in want["pending"].as_array_mut().unwrap() {
            p["meta"] = identity(&p["meta"]);
        }
        want["prepared"]["meta"] = identity(&want["prepared"]["meta"]);
    }
    want
}

/// The paths where `got` departs from `want`, each with both values.
fn differences(path: &str, want: &Value, got: &Value) -> Vec<String> {
    match (want, got) {
        (Value::Object(w), Value::Object(g)) => {
            let keys: std::collections::BTreeSet<&String> = w.keys().chain(g.keys()).collect();
            keys.into_iter().flat_map(|k| differences(&format!("{path}.{k}"), w.get(k).unwrap_or(&Value::Null), g.get(k).unwrap_or(&Value::Null))).collect()
        }
        (Value::Array(w), Value::Array(g)) if w.len() == g.len() => {
            w.iter().zip(g).enumerate().flat_map(|(i, (w, g))| differences(&format!("{path}[{i}]"), w, g)).collect()
        }
        _ if want == got => Vec::new(),
        _ => vec![format!("  {path}:\n    want {want}\n    got  {got}")],
    }
}

#[tokio::test]
async fn every_recorded_job_views_case_is_nodes_agent_tool_text() {
    mixdog_rt::testing::tokens();
    let path = format!("{}/../../fixtures/job-views-cases/golden.json", env!("CARGO_MANIFEST_DIR"));
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let now = golden["now"].as_i64().unwrap();
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let got = replay(now, case).await;
        let want = wanted(case);
        if got != want {
            failures.push(format!("{}:\n{}", case["case"], differences("", &want, &got).join("\n")));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
}
