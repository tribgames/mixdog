//! Which asks leave a gateway usage event, against Node's real `askSession`
//! (fixtures/gateway-usage-failures/golden.json, written by
//! benchmarks/rust-core/recorders/record-gateway-usage-failures.mjs): a completed turn records one event once its usage
//! reached the session; a provider failure, an abort mid-stream and an abort the provider ignored record none, whatever
//! usage the turn had already spent. Each recorded scenario is replayed through the session actor with a run that ends
//! the way the run host ends it (`Settled` then `Completed`, `Failed`, or `Interrupted`), and the store file the actor's
//! writer leaves must be Node's.

use std::sync::Arc;

use mixdog_core_api::domain::provider::Usage;
use serde_json::Value;

use mixdog_core_api::ThreadHandle;

use crate::session::seams::RunOutcome;
use crate::session::run::Settled;
use crate::session::testing::Rig;
use crate::session::tests::eventually;
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
        let mut completed = events.iter().map(|event| event["messageCount"].as_u64().unwrap() as usize);
        let plan: Arc<std::sync::Mutex<std::collections::VecDeque<(End, usize)>>> =
            Arc::new(std::sync::Mutex::new(ends.iter().map(|end| (*end, if matches!(end, End::Completed) { completed.next().unwrap() } else { 0 })).collect()));
        let spent = usage.clone();
        rig.set_script(Arc::new(move |run| {
            let (end, messages) = plan.lock().unwrap().pop_front().expect("a planned turn");
            let usage = spent.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                match end {
                    End::Completed => {
                        let transcript = (0..messages).map(|n| mixdog_agent::message::AgentMessage::user(&format!("m{n}"))).collect();
                        let settled = Settled { transcript, usage: usage.clone(), last_turn_usage: usage, tool_calls_total: 0, send_tools: Vec::new(), response_model: "fake-model".into(), asked_at_ms: start };
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
        let params = serde_json::json!({ "threadId": handle.id, "set": { "provider": "ask-session-turn-test", "model": "fake-model" }, "unset": [] });
        handle
            .request(mixdog_core_api::call::CoreRequest { method: mixdog_core_api::ids::Method("thread/header/patch"), params, op: None, ctx: mixdog_core_api::call::CallContext::internal("test") })
            .await
            .expect("route");
        for (index, _) in ends.iter().enumerate() {
            turn(&handle, "go", &format!("op-{index}")).await;
            eventually(|| idle(&handle).then_some(())).await;
        }
        writer.settle().await;
        let path = rig._data.path().join(super::STORE_FILE);
        match case["store"].as_str() {
            None => assert!(!path.exists(), "{name}: Node wrote no store"),
            Some(want) => {
                let got = std::fs::read_to_string(&path).unwrap().replace(handle.id.as_str(), "<session>");
                // The transcript estimate (`contextUsedPct`, `compact.afterTokens`) prices Node's real system prompt and
                // tool schemas, which this rig has no meters for (it estimates 0); the estimate is replayed against Node
                // in the writer's own recordings. Every other byte of the file must be Node's.
                let unmetered = |text: &str| {
                    text.lines()
                        .map(|line| {
                            let Ok(mut event) = serde_json::from_str::<Value>(line) else { return line.to_owned() };
                            event["contextUsedPct"] = Value::Null;
                            event["compact"]["afterTokens"] = Value::Null;
                            event.to_string()
                        })
                        .collect::<Vec<_>>()
                };
                assert_eq!(unmetered(&got), unmetered(want), "{name}");
            }
        }
    }
}
