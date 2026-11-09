//! Which asks leave a gateway usage event, against Node's real `askSession`
//! (fixtures/gateway-usage-failures/golden.json, written by
//! benchmarks/rust-core/recorders/record-gateway-usage-failures.mjs): a completed turn records one event once its usage
//! reached the session; a provider failure, an abort mid-stream and an abort the provider ignored record none, whatever
//! usage the turn had already spent. Each recorded scenario is replayed through the session actor with a run that ends
//! the way the run host ends it (`Settled` then `Completed`, `Failed`, or `Interrupted`), and the store file the actor's
//! writer leaves must be Node's.

use std::sync::Arc;

use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::Usage;
use serde_json::Value;

use mixdog_core_api::ThreadHandle;

use crate::session::seams::RunOutcome;
use crate::session::run::Settled;
use crate::session::testing::Rig;
use crate::eventually_on;
use crate::session::tests::idle;
use crate::session::tests::start_thread;
use crate::session::tests::turn;
use crate::session::SessionDirectory;

const GOLDEN: &str = include_str!("../../../../../fixtures/gateway-usage-failures/golden.json");

/// How Node's turn ended, as the run host reports it.
#[derive(Clone, Copy)]
enum End {
    Completed,
    Failed,
    Interrupted,
}

/// A recorded session's transcript (text messages) and tool schemas, as the neutral messages and definitions.
fn held_of(ask: &Value) -> (Vec<AgentMessage>, Vec<ToolDefinition>) {
    let messages = ask["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| {
            let role = match message["role"].as_str().unwrap() {
                "system" => Role::System,
                "user" => Role::User,
                "assistant" => Role::Assistant,
                other => panic!("unrecorded role {other}"),
            };
            AgentMessage::new(Message::new(role, Content::Text(message["content"].as_str().unwrap().to_owned())))
        })
        .collect();
    let tools = ask["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| ToolDefinition {
            name: tool["name"].as_str().unwrap().to_owned(),
            description: tool["description"].as_str().unwrap().to_owned(),
            input_schema: tool["inputSchema"].clone(),
            defer_loading: tool["deferLoading"] == Value::Bool(true),
            freeform: None,
        })
        .collect();
    (messages, tools)
}

/// The ends of the turns of each recorded scenario, in order (the scenario bodies of the recorder).
fn ends(name: &str) -> Vec<End> {
    match name {
        "completed" => vec![End::Completed],
        "provider failure" | "provider failure after a completed tool iteration" => vec![End::Failed],
        "abort mid-stream by the turn abort" | "abort mid-stream by the caller signal" | "an abort the provider ignores until it has a result" => vec![End::Interrupted],
        "a failed turn then a completed one" => vec![End::Failed, End::Completed],
        "an abort then a completed turn" => vec![End::Interrupted, End::Completed],
        other => panic!("unrecorded scenario {other}"),
    }
}

#[tokio::test(start_paused = true)]
async fn the_asks_that_fail_or_abort_record_no_event_as_in_node() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let start = golden["start"].as_i64().unwrap();
    let usage = Usage {
        input_tokens: golden["usage"]["inputTokens"].as_u64().unwrap(),
        output_tokens: golden["usage"]["outputTokens"].as_u64().unwrap(),
        cache_read_tokens: golden["usage"]["cachedTokens"].as_u64().unwrap(),
        ..Default::default()
    };
    for case in golden["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let events: Vec<Value> = case["store"].as_str().map(|text| text.lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()).unwrap_or_default();
        let ends = ends(name);
        assert_eq!(events.len(), ends.iter().filter(|end| matches!(end, End::Completed)).count(), "{name}: Node records one event per completed turn");
        let rig = Rig::new();
        rig.clock.0.store(start as u64, std::sync::atomic::Ordering::SeqCst);
        let deps = rig.deps();
        let writer = deps.gateway_usage.clone();
        // The transcript and the tool schemas the session held when Node wrote each event: the inputs of its estimate.
        let held = case["asks"].as_array().unwrap();
        assert_eq!(held.len(), events.len(), "{name}");
        let mut completed = held.iter();
        let plan: Arc<std::sync::Mutex<std::collections::VecDeque<(End, Option<(Vec<AgentMessage>, Vec<ToolDefinition>)>)>>> = Arc::new(std::sync::Mutex::new(
            ends.iter().map(|end| (*end, matches!(end, End::Completed).then(|| held_of(completed.next().unwrap())))).collect(),
        ));
        // Rust estimates what Node estimated, from the same inputs and a thread with books.
        rig.compaction.text_books.store(true, std::sync::atomic::Ordering::SeqCst);
        let context_window = held.first().map(|ask| ask["contextWindow"].clone());
        let spent = usage.clone();
        rig.set_script(Arc::new(move |run| {
            let (end, held) = plan.lock().unwrap().pop_front().expect("a planned turn");
            let usage = spent.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                match end {
                    End::Completed => {
                        let (transcript, send_tools) = held.expect("a completed turn holds its transcript");
                        let settled = Settled { transcript, usage: usage.clone(), last_turn_usage: usage, tool_calls_total: 0, send_tools, response_model: "fake-model".into(), asked_at_ms: start };
                        run.port.settled(settled).await.expect("settled");
                        RunOutcome::Completed(Default::default())
                    }
                    End::Failed => RunOutcome::Failed(crate::session::testing::quota_error(5000)),
                    End::Interrupted => RunOutcome::Interrupted,
                }
            })
        }));
        let directory = SessionDirectory::new(deps);
        let handle = start_thread(&directory).await;
        // The route as Node's session held it, with the context window its provider declared.
        let mut set = serde_json::json!({ "provider": "ask-session-turn-test", "model": "fake-model" });
        if let Some(window) = context_window.filter(|window| !window.is_null()) {
            set["contextWindow"] = window;
        }
        let params = serde_json::json!({ "threadId": handle.id, "set": set, "unset": [] });
        handle
            .request(mixdog_core_api::call::CoreRequest { method: mixdog_core_api::ids::Method("thread/header/patch"), params, op: None, ctx: mixdog_core_api::call::CallContext::internal("test") })
            .await
            .expect("route");
        for (index, _) in ends.iter().enumerate() {
            turn(&handle, "go", &format!("op-{index}")).await;
            eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        }
        writer.settle().await;
        let path = rig._data.path().join(super::STORE_FILE);
        match case["store"].as_str() {
            None => assert!(!path.exists(), "{name}: Node wrote no store"),
            Some(want) => {
                let got = std::fs::read_to_string(&path).unwrap().replace(handle.id.as_str(), "<session>");
                assert_eq!(got, want, "{name}");
            }
        }
    }
}
