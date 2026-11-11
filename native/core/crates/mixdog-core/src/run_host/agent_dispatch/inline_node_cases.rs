//! Node's inline host agent dispatch (`fixtures/inline-dispatch-cases`, `record-inline-dispatch-cases.mjs`): the
//! test's calls through `InlineAgentDispatch::run`, each whole outcome (answer or error message) against Node's.
//! The slow host's gate (Node: loading the agent graph) is the provider preparation, the step before the dispatcher.

use tokio::sync::Notify;

use super::*;

fn golden() -> Value {
    #[allow(clippy::disallowed_methods)] // the recording, read at run time
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/inline-dispatch-cases/golden.json")).expect("the recording");
    serde_json::from_str(&text).expect("json")
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
    let case = &golden["cases"][0];
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
