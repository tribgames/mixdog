//! Node's standalone agent tool cases (`fixtures/agent-worker-cases`, `record-agent-worker-cases.mjs`): each recorded
//! call through `AgentRuntime::handle` (job views over an empty `JobBoard`) and the tool's `render`, the whole answer
//! text against Node's. Named cases are left out.
#![allow(clippy::disallowed_methods)]

use std::sync::Arc;

use mixdog_agent::agent_tool::AgentDeps;
use mixdog_agent::agent_tool::AgentRuntime;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::agent_tool::error_text::PlainErrorText;
use mixdog_agent::agent_tool::scope::Caller;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::views::JobViews;
use mixdog_agent::agent_tool::views::WorkerFacts;
use mixdog_agent::agent_tool::views::WorkerLive;
use mixdog_agent::agent_tool::views::Workers;
use mixdog_agent::env::Clock;
use mixdog_tools::orch::agent::render;
use serde_json::Value;
use serde_json::json;

use crate::agent_tool::Caller1;
use crate::agent_tool::Fakes;
use crate::agent_tool::World;

fn fixture(name: &str) -> Value {
    let path = format!("{}/../../fixtures/agent-worker-cases/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        1_772_359_200_000
    }
}

struct NoWorkers;
#[async_trait::async_trait]
impl Workers for NoWorkers {
    async fn session(&self, _: &str) -> Option<WorkerFacts> {
        None
    }
    fn live(&self, _: &str) -> WorkerLive {
        WorkerLive::default()
    }
    async fn entries(&self, _: bool, _: &Scope) -> Vec<(String, WorkerFacts)> {
        Vec::new()
    }
}

#[tokio::test]
async fn every_recorded_agent_tool_error_answer_is_nodes() {
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let cases = golden["cases"].as_array().unwrap();
    let mut replayed = 0;
    for case in cases.iter().filter(|c| !excluded.contains_key(c["case"].as_str().unwrap()) && c["kind"] == "errors") {
        let fakes = Arc::new(Fakes(Arc::new(World::default())));
        let clock: Arc<dyn Clock> = Arc::new(FixedClock);
        let board = JobBoard::new(clock.clone(), None, None);
        let rt = AgentRuntime::new(AgentDeps {
            registry: fakes.clone(),
            send_flow: fakes.clone(),
            spawn_flow: fakes.clone(),
            terminal_trace: fakes.clone(),
            sessions: fakes.clone(),
            tasks: fakes.clone(),
            views: Arc::new(JobViews::new(board, fakes.clone(), Arc::new(NoWorkers), clock)),
            env: fakes.clone(),
            catalog: None,
            default_cwd: "/work".into(),
            scopes: Arc::new(Caller1),
            errors: Arc::new(PlainErrorText),
        });
        let caller = Caller { scope: Scope::default(), cwd: "/work".into() };
        let mut calls = Vec::new();
        for call in case["recorded"]["calls"].as_array().unwrap() {
            let args = &call["args"];
            let reply = rt.handle(args, &caller).await;
            calls.push(json!({ "args": args, "result": render(&reply, args.get("tag").and_then(Value::as_str).unwrap_or_default()) }));
        }
        assert_eq!(json!({ "calls": calls }), case["recorded"], "{}", case["case"]);
        replayed += 1;
    }
    assert_eq!(replayed, 1);
}

/// The notify case through the assembled agent tool (`flow_scenarios::rig`, the compose root's `assemble`): a spawn
/// whose worker turn hands its notify a nested shell completion, then an early terminal result, then returns. Compared:
/// the spawn's answer and every owner notification (session, whole text; the early one's meta too), as Node's.
#[tokio::test(start_paused = true)]
async fn the_owner_gets_the_completion_once_as_in_node() {
    use crate::flow_scenarios::{backend, lock, rig, settle};
    use mixdog_agent::agent_tool::scope::Scope;
    backend();
    let golden = fixture("golden.json");
    let excluded = fixture("MANIFEST.json")["excluded"].as_object().unwrap().clone();
    let name = "agent completion notifications route to the owner exactly once";
    let case = golden["cases"].as_array().unwrap().iter().find(|c| c["case"] == name).unwrap();
    for part in ["workerQueued", "ownerNotifications[1].meta"] {
        assert!(excluded.contains_key(&format!("{name}: {part}")), "{part} is named in the manifest");
    }
    let recorded = &case["recorded"];
    let owner = "sess_owner_notify_smoke";
    // The recorder's inputs: its config, the spawn, and the worker turn its fake runs.
    let nested = "background task\ntask_id: task_shell_notify_smoke\nsurface: shell\noperation: shell\nstatus: completed\nstarted: 2026-01-01T00:00:00.000Z\nfinished: 2026-01-01T00:00:01.000Z\n\nnested background done for <session>";
    let scenario = json!({
        "config": {
            "default": "sonnet-high",
            "providers": { "openai-oauth": { "enabled": true } },
            "presets": [
                { "id": "sonnet-high", "name": "sonnet-high", "provider": "openai-oauth", "model": "smoke-model", "type": "agent", "tools": "full" },
                { "id": "haiku", "name": "HAIKU", "provider": "openai-oauth", "model": "smoke-haiku", "type": "agent", "tools": "full" },
            ],
        },
        "session": { "id": "<session>", "cwd": "/work", "parentSessionId": owner, "ownerSessionId": owner },
        "owner": owner,
        "lockOwner": owner,
        "canonical": true,
        "steps": [
            { "notify": { "text": nested, "meta": { "type": "shell_task_result", "execution_surface": "shell", "execution_id": "task_shell_notify_smoke", "status": "completed" } } },
            { "terminal": { "content": "worker completed" } },
            { "return": { "content": "worker completed" } },
        ],
    });
    let host = json!({
        "agent": { "name": "worker", "defined": true, "disabled": false, "kind": null, "contact": false, "permission": null, "candidates": [] },
        "delegation": { "chain": [owner], "acting": owner },
    });
    let rig = rig(&scenario, Some(&host));
    let caller = Caller { scope: Scope { caller_session_id: Some(owner.into()), host_pid: Some(424_242) }, cwd: "/work".into() };
    let args = json!({ "type": "spawn", "agent": "worker", "tag": "notify-smoke", "prompt": "notify smoke" });
    let start = render(&rig.runtime.handle(&args, &caller).await, "notify-smoke");
    settle().await;
    settle().await;
    let id = rig.shared.board.list_jobs(&Scope::default()).first().map(|job| job.task_id.clone()).expect("the job");
    let notices: Vec<Value> = lock(&rig.shared.notices)
        .iter()
        .map(|notice| {
            // The recorder masks a time Node read from the wall clock (the finish) as <time>; the core reads its clock.
            let text = notice["text"].as_str().unwrap().replace(&id, "<task>").replace("finished: 2026-03-01T10:00:00.000Z", "finished: <time>");
            let meta: Value = serde_json::from_str(&notice["meta"].to_string().replace(&id, "<task>")).unwrap();
            json!({ "sessionId": notice["session"], "text": text, "meta": meta })
        })
        .collect();
    let mut want = recorded["ownerNotifications"].clone();
    // Named in the manifest: the final notification's meta.
    want[1].as_object_mut().unwrap().remove("meta");
    let mut got = json!({ "start": start.replace(&id, "<task>"), "ownerNotifications": notices });
    got["ownerNotifications"][1].as_object_mut().unwrap().remove("meta");
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap();
    let want = json!({ "start": recorded["start"], "ownerNotifications": want });
    assert!(got == want, "{name}\n--- core\n{}\n--- node\n{}", pretty(&got), pretty(&want));
}
