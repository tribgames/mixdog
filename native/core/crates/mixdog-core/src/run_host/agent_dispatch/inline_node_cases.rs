//! Node's inline host agent dispatch (`fixtures/inline-dispatch-cases`, `record-inline-dispatch-cases.mjs`): the
//! test's calls through `InlineAgentDispatch::run`, each whole outcome (answer or error message) against Node's, and
//! what the dispatcher was handed. The slow host's gate and the failing graph (Node: loading the agent graph) are the
//! provider preparation, the step before the dispatcher.

use tokio::sync::Notify;

use super::*;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/inline-dispatch-cases/golden.json")).expect("json")
}

/// An open host whose provider preparation waits for `gate` (when set) and reports that it started.
#[derive(Default)]
struct Gated {
    gate: Option<Arc<Notify>>,
    entered: Notify,
}

#[async_trait]
impl HostWorld for Gated {
    fn assert_open(&self, cancel: Option<&Cancel>) -> Result<(), String> {
        match cancel.filter(|cancel| cancel.is_aborted()) {
            Some(cancel) => Err(cancel.reason()),
            None => Ok(()),
        }
    }

    async fn prepare_providers(&self, _cancel: &Cancel) -> Result<(), String> {
        self.entered.notify_one();
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        Ok(())
    }
}

struct Answers;

#[async_trait]
impl ChildRunner for Answers {
    async fn run_child(&self, request: &DispatchRequest, _cancel: Cancel) -> ChildResult {
        ChildResult { outcome: Ok(format!("answer for {}", request.prompt)) }
    }
}

/// Answers `answer for <prompt>` and keeps what each dispatch was handed, in Node's recorded shape.
#[derive(Default)]
struct Handed(Mutex<Vec<Value>>);

#[async_trait]
impl ChildRunner for Handed {
    async fn run_child(&self, request: &DispatchRequest, _cancel: Cancel) -> ChildResult {
        self.0.lock().unwrap().push(json!({
            "prompt": request.prompt,
            "preset": request.preset.clone().unwrap_or(Value::Null),
            "cwd": request.cwd,
            // A JS number: JSON writes an integral one with no fraction.
            "idleTimeoutMs": request.idle_timeout_ms.map(|ms| if ms.fract() == 0.0 { json!(ms as i64) } else { json!(ms) }),
            // The child's cancel is the caller's (Node: `parentSignal`, an AbortSignal).
            "parentSignal": true,
        }));
        ChildResult { outcome: Ok(format!("answer for {}", request.prompt)) }
    }
}

/// An open host whose first provider preparation fails with `graph import failed`.
#[derive(Default)]
struct FailsOnce(Mutex<u32>);

#[async_trait]
impl HostWorld for FailsOnce {
    fn assert_open(&self, _cancel: Option<&Cancel>) -> Result<(), String> {
        Ok(())
    }

    async fn prepare_providers(&self, _cancel: &Cancel) -> Result<(), String> {
        let mut loads = self.0.lock().unwrap();
        *loads += 1;
        if *loads == 1 { Err("graph import failed".to_owned()) } else { Ok(()) }
    }
}

fn recorded_case<'a>(golden: &'a Value, name: &str) -> &'a Value {
    golden["cases"].as_array().unwrap().iter().find(|case| case["case"] == name).unwrap_or_else(|| panic!("case {name}"))
}

/// Each recorded call through `InlineAgentDispatch::run`: the outcomes, in order.
async fn outcomes(host: &InlineAgentDispatch, calls: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for call in calls.as_array().unwrap() {
        out.push(shown(host.run(payload_of(&json!({ "payload": call["payload"] })), &Cancel::new()).await));
    }
    out
}

#[tokio::test]
async fn the_dispatcher_is_handed_the_call_parameters_as_in_node() {
    mixdog_rt::testing::tokens();
    let golden = golden();
    let case = recorded_case(&golden, "agentDispatch caches one dispatcher per agent and forwards the call parameters");
    let runner = Arc::new(Handed::default());
    let host = InlineAgentDispatch::new(runner.clone(), Arc::new(Gated::default()), Arc::new(Watch::default()));
    let got = json!({
        "outcomes": outcomes(&host, &case["recorded"]["calls"]).await,
        "handed": runner.0.lock().unwrap().clone(),
    });
    let want = json!({
        "outcomes": case["recorded"]["calls"].as_array().unwrap().iter().map(|c| c["outcome"].clone()).collect::<Vec<_>>(),
        "handed": case["recorded"]["handed"],
    });
    assert_eq!(got, want, "{}", case["case"]);
}

#[tokio::test]
async fn a_failed_preparation_fails_that_dispatch_and_the_next_ones_answer_as_in_node() {
    mixdog_rt::testing::tokens();
    let golden = golden();
    let case = recorded_case(&golden, "agent graph loading retries after a failure and shares the successful graph");
    let host = InlineAgentDispatch::new(Arc::new(Answers), Arc::new(FailsOnce::default()), Arc::new(Watch::default()));
    let want: Vec<Value> = case["recorded"]["calls"].as_array().unwrap().iter().map(|c| c["outcome"].clone()).collect();
    assert_eq!(outcomes(&host, &case["recorded"]["calls"]).await, want, "{}", case["case"]);
}

fn shown(outcome: Result<String, String>) -> Value {
    match outcome {
        Ok(answer) => json!({ "ok": answer }),
        Err(error) => json!({ "error": error }),
    }
}

#[tokio::test]
async fn a_missing_or_running_id_and_a_caller_abort_answer_as_in_node() {
    mixdog_rt::testing::tokens();
    let golden = golden();
    let case = recorded_case(&golden, "agentDispatch rejects a missing or already-running dispatch id and aborts with the caller signal");
    let recorded = case["recorded"]["calls"].as_array().unwrap();
    let call = |n: usize| payload_of(&json!({ "payload": recorded[n]["payload"] }));
    let mut calls = Vec::new();

    let harness = InlineAgentDispatch::new(Arc::new(Answers), Arc::new(Gated::default()), Arc::new(Watch::default()));
    calls.push(shown(harness.run(call(0), &Cancel::new()).await));

    let gate = Arc::new(Notify::new());
    let world = Arc::new(Gated { gate: Some(gate.clone()), entered: Notify::new() });
    let slow = Arc::new(InlineAgentDispatch::new(Arc::new(Answers), world.clone(), Arc::new(Watch::default())));
    let caller = Cancel::new();
    let entered = world.entered.notified();
    let running = {
        let (slow, caller, payload) = (slow.clone(), caller.clone(), call(2));
        tokio::spawn(async move { slow.run(payload, &caller).await })
    };
    mixdog_core_session::session::testing::awaiting(|| "the running dispatch to reach its gate".to_owned(), entered).await;
    calls.push(shown(slow.run(call(1), &Cancel::new()).await));
    caller.abort("caller gave up");
    gate.notify_one();
    calls.push(shown(mixdog_core_session::session::testing::awaiting(|| "the aborted dispatch to end".to_owned(), running).await.unwrap()));

    let want: Vec<Value> = recorded.iter().map(|c| c["outcome"].clone()).collect();
    assert_eq!(calls, want, "{}", case["case"]);
}
