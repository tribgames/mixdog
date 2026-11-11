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
    // The notify case (a spawned worker's nested completion and owner deliveries) has no replay yet.
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
