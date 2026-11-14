//! Owner: s4-engine-actions-pointer
//! A deterministic same-page batch (`actions/sequence.ts`): two to six chainable gestures run one after the other on one page.
//! Dispatch is never replayed, and a partial result always hands the caller a fresh observation for recovery.
//!
//! Each step is an ordinary command the runner runs ([`StepRunner::run_step`]) with the settle of a step between gestures; the one
//! observation of the whole batch is the reply the runner builds after this returns. A step starts only while the page is still the
//! document, the URL and the idle state the batch began on: a document that was replaced, a client-side route change or a load in
//! progress fences the remaining steps off.

use async_trait::async_trait;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_rt::CancelView;
use serde_json::Map;
use serde_json::Value;

use crate::limits::SEQUENCE_STEP_ACTIONS;
use crate::refs::ref_set::RefSet;
use crate::settle::settle::StepKind;
use crate::settle::settle::StepResult;
use crate::settle::settle::cancelled;
use crate::settle::settle::throw_if_cancelled;

use super::target::ActionContext;
use super::target::ActionError;
use super::target::ActionOutput;
use super::target::text_of;
use super::target::truthy;

/// What a sequence asks of the runner around it.
#[async_trait]
pub trait StepRunner: Send + Sync {
    /// Runs one step as a command of its own and settles the page after it (`runCommand` then `stepSettleResult`), timed as step
    /// `index` (1-based) of the batch.
    async fn run_step(&self, index: u32, step: Value, cancel: &CancelView) -> Result<StepResult, ActionError>;
    /// The observation of the page as a reply shows it (`reply.snapshotResult`), for the failure of a partial batch.
    async fn observe(&self, cancel: &CancelView) -> Result<String, ActionError>;
}

/// The action a step names, normalised.
fn step_action(step: &Value) -> String {
    js_to_lowercase(js_trim(&text_of(step.get("action"))))
}

/// The command a step runs as: its own fields, the batch's tab and session, and the mark that it is a step.
pub fn step_command(command: &Value, step: &Value, action: &str) -> Value {
    let mut out: Map<String, Value> = step.as_object().cloned().unwrap_or_default();
    out.insert("action".to_string(), Value::String(action.to_string()));
    // A step never carries its own tab, background mark or session: the batch's, or none.
    for key in ["tab", "background", "session_id", "turn_id"] {
        match command.get(key) {
            Some(value) => out.insert(key.to_string(), value.clone()),
            None => out.remove(key),
        };
    }
    out.insert("internalStep".to_string(), Value::Bool(true));
    if truthy(command.get("session_life")) {
        out.insert("session_life".to_string(), command["session_life"].clone());
    }
    if command.get("unattended_run") == Some(&Value::Bool(true)) {
        out.insert("unattended_run".to_string(), Value::Bool(true));
        match command.get("unattended_agent") {
            Some(agent) => out.insert("unattended_agent".to_string(), agent.clone()),
            None => out.remove("unattended_agent"),
        };
    }
    Value::Object(out)
}

/// Where the batch began: a step starts only while the page is still there.
struct Start {
    document_id: String,
    url: String,
    refs: Option<RefSet>,
}

async fn run_one(cx: &ActionContext<'_>, runner: &dyn StepRunner, start: &Start, index: usize, step: &Value, action: &str) -> Result<(), ActionError> {
    throw_if_cancelled(cx.cancel)?;
    // A client-side route change can keep the same document. Loading also fences the interval before a navigation commits.
    let facts = cx.page.facts();
    if facts.document_id != start.document_id || facts.url != start.url || facts.loading {
        return Err(ActionError::Failed("the page changed or is navigating; remaining steps were not dispatched".to_string()));
    }
    if !SEQUENCE_STEP_ACTIONS.contains(&action) {
        return Err(ActionError::Failed(format!("action \"{}\" is not chainable", if action.is_empty() { "(empty)" } else { action })));
    }
    // Every step addresses the refs the caller holds, not the ones an earlier step's gesture retired.
    if let Some(refs) = &start.refs {
        cx.page.restore_ref_set(refs.clone());
    }
    let number = u32::try_from(index + 1).unwrap_or(u32::MAX);
    let result = runner.run_step(number, step_command(cx.command, step, action), cx.cancel).await?;
    match result.outcome {
        StepKind::Blocked | StepKind::Inconclusive => Err(ActionError::Failed(result.text)),
        StepKind::Completed => Ok(()),
    }
}

/// `sequence`: 2 to 6 steps on the page as it is now. A step that fails, or a page that moved, stops the batch at that step and the
/// failure carries a fresh observation; the steps before it are not undone and no step is run twice.
pub async fn sequence(cx: &mut ActionContext<'_>, runner: &dyn StepRunner) -> Result<ActionOutput, ActionError> {
    let steps: Vec<Value> = cx.field("steps").and_then(Value::as_array).cloned().unwrap_or_default();
    if !(2..=6).contains(&steps.len()) {
        return Err(ActionError::Failed("sequence requires 2 to 6 steps".to_string()));
    }
    let facts = cx.page.facts();
    let start = Start { document_id: facts.document_id, url: facts.url, refs: cx.page.ref_set() };
    let mut performed: Vec<String> = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let action = step_action(step);
        if let Err(error) = run_one(cx, runner, &start, index, step, &action).await {
            let stopped = match runner.observe(cx.cancel).await {
                Ok(text) => text,
                // A cancelled command ends as a cancelled one; any other observation that fails leaves the failure without a page.
                Err(_) if cx.cancel.is_cancelled() => return Err(cancelled(cx.cancel).into()),
                Err(_) => String::new(),
            };
            let progress = if performed.is_empty() { "no step completed".to_string() } else { format!("completed {}", performed.join(", ")) };
            return Err(ActionError::Failed(format!("Sequence stopped at step {} ({action}); {progress}. {error}\n\n{stopped}", index + 1)));
        }
        performed.push(format!("{}:{action}", index + 1));
    }
    Ok(ActionOutput { lead: format!("Sequence completed {} steps ({}).\n\n", performed.len(), performed.join(", ")), ..ActionOutput::default() })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use mixdog_app_protocol::v2::browser_engine::PageFacts;
    use serde_json::json;

    use super::super::target::testing::Rig;
    use super::super::target::testing::TestPage;
    use super::*;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::refs::ref_set::tests::element;
    use crate::refs::ref_set::tests::payload;

    /// Runs the steps against a page; `after` is what the page does once a step ran.
    struct Script<'a> {
        page: &'a TestPage,
        calls: Mutex<Vec<(u32, Value)>>,
        results: Mutex<VecDeque<StepResult>>,
        refs_seen: Mutex<Vec<bool>>,
        after: Box<dyn Fn(&TestPage, u32) + Send + Sync>,
    }

    impl<'a> Script<'a> {
        fn new(page: &'a TestPage) -> Self {
            Self { page, calls: Mutex::new(Vec::new()), results: Mutex::new(VecDeque::new()), refs_seen: Mutex::new(Vec::new()), after: Box::new(|_, _| {}) }
        }

        fn indexes(&self) -> Vec<u32> {
            self.calls.lock().expect("calls").iter().map(|(index, _)| *index).collect()
        }
    }

    #[async_trait]
    impl StepRunner for Script<'_> {
        async fn run_step(&self, index: u32, step: Value, _cancel: &CancelView) -> Result<StepResult, ActionError> {
            self.refs_seen.lock().expect("refs").push(self.page.ref_set().is_some());
            self.calls.lock().expect("calls").push((index, step));
            self.page.invalidate_interaction();
            (self.after)(self.page, index);
            Ok(self.results.lock().expect("results").pop_front().unwrap_or(StepResult { outcome: StepKind::Completed, text: String::new() }))
        }

        async fn observe(&self, cancel: &CancelView) -> Result<String, ActionError> {
            if cancel.is_cancelled() { Err(ActionError::Failed("cannot observe".into())) } else { Ok("OBSERVED".to_string()) }
        }
    }

    fn facts_with(change: impl FnOnce(&mut PageFacts)) -> PageFacts {
        let mut facts: PageFacts = serde_json::from_value(page_facts("p1", 1)).expect("facts");
        change(&mut facts);
        facts
    }

    fn page() -> TestPage {
        TestPage::with(|state| state.ref_set = Some(RefSet::from_payload("p1-s1", &payload("p1-s1", vec![element("p1-s1-e1", "textbox", "Name")], "https://a.test/"))))
    }

    fn fills(count: usize) -> Value {
        json!({"action": "sequence", "tab": "t1", "session_id": "s", "steps": (0..count).map(|n| json!({"action": "fill", "text": n.to_string()})).collect::<Vec<_>>()})
    }

    async fn run(page: &TestPage, command: &Value, script: &Script<'_>) -> Result<ActionOutput, ActionError> {
        let host = FakeHost::scripted(Vec::new());
        let mut rig = Rig::new(None);
        let mut cx = ActionContext { host: &host, page, command, cancel: &rig.source.view(), recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        sequence(&mut cx, script).await
    }

    #[tokio::test]
    async fn six_steps_complete_and_the_reply_names_them() {
        let page = page();
        let script = Script::new(&page);
        let output = run(&page, &fills(6), &script).await.expect("completed");
        assert_eq!(output.lead, "Sequence completed 6 steps (1:fill, 2:fill, 3:fill, 4:fill, 5:fill, 6:fill).\n\n");
        assert!(!output.decorate_recovery);
        assert_eq!(script.indexes(), [1, 2, 3, 4, 5, 6]);
        assert_eq!(*script.refs_seen.lock().expect("refs"), [true; 6], "every step addresses the refs the caller holds");
    }

    #[tokio::test]
    async fn a_step_runs_as_an_internal_command_of_the_batch() {
        let page = page();
        let script = Script::new(&page);
        let mut command = fills(2);
        command["steps"][0] = json!({"action": " FILL ", "tab": "other", "turn_id": "mine", "text": "x"});
        command["session_life"] = json!("life");
        command["unattended_run"] = json!(true);
        command["unattended_agent"] = json!("bot");
        run(&page, &command, &script).await.expect("completed");
        let calls = script.calls.lock().expect("calls");
        assert_eq!(
            calls[0].1,
            json!({"action": "fill", "tab": "t1", "session_id": "s", "text": "x", "internalStep": true, "session_life": "life", "unattended_run": true, "unattended_agent": "bot"})
        );
        assert_eq!(step_command(&json!({}), &json!({"action": "wait", "tab": "x", "session_life": "mine"}), "wait"), json!({"action": "wait", "session_life": "mine", "internalStep": true}));
    }

    #[tokio::test]
    async fn a_wait_may_sit_between_gestures_and_other_actions_may_not() {
        let page = page();
        let script = Script::new(&page);
        let command = json!({"steps": [{"action": "fill"}, {"action": "wait", "text": "ready"}, {"action": "fill"}]});
        run(&page, &command, &script).await.expect("completed");
        assert_eq!(script.calls.lock().expect("calls").iter().map(|(_, step)| step["action"].clone()).collect::<Vec<_>>(), [json!("fill"), json!("wait"), json!("fill")]);

        let script = Script::new(&page);
        let error = run(&page, &json!({"steps": [{"action": "fill"}, {"action": "navigate"}]}), &script).await.expect_err("not chainable");
        assert_eq!(error.to_string(), "Sequence stopped at step 2 (navigate); completed 1:fill. action \"navigate\" is not chainable\n\nOBSERVED");
        let error = run(&page, &json!({"steps": [{}, {"action": "fill"}]}), &script).await.expect_err("empty");
        assert!(error.to_string().starts_with("Sequence stopped at step 1 (); no step completed. action \"(empty)\" is not chainable"));
    }

    #[tokio::test]
    async fn the_number_of_steps_is_bounded() {
        let page = page();
        let script = Script::new(&page);
        for count in [0, 1, 7] {
            let error = run(&page, &fills(count), &script).await.expect_err("out of range");
            assert_eq!(error.to_string(), "sequence requires 2 to 6 steps");
        }
        assert!(script.indexes().is_empty());
        let error = run(&page, &json!({"steps": "fill"}), &script).await.expect_err("not a list");
        assert_eq!(error.to_string(), "sequence requires 2 to 6 steps");
    }

    #[tokio::test]
    async fn a_replaced_document_a_route_change_or_a_load_fences_the_rest() {
        for change in ["document", "url", "loading"] {
            let page = page();
            let mut script = Script::new(&page);
            script.after = Box::new(move |page, _| {
                page.set(|state| {
                    state.facts = Some(facts_with(|facts| match change {
                        "document" => facts.document_id = "p1:2".into(),
                        "url" => facts.url = "https://a.test/next".into(),
                        _ => facts.loading = true,
                    }));
                });
            });
            let error = run(&page, &fills(2), &script).await.expect_err("fenced");
            let text = error.to_string();
            assert!(text.contains("remaining steps were not dispatched") && text.contains("completed 1:fill") && text.ends_with("OBSERVED"), "{change}: {text}");
            assert_eq!(script.indexes(), [1], "{change}: no input after the page moved");
        }
    }

    #[tokio::test]
    async fn a_blocked_or_inconclusive_step_stops_the_batch_with_what_it_said() {
        for outcome in [StepKind::Blocked, StepKind::Inconclusive] {
            let page = page();
            let script = Script::new(&page);
            script.results.lock().expect("results").push_back(StepResult { outcome, text: "A alert dialog is blocking the sequence.".into() });
            let error = run(&page, &fills(3), &script).await.expect_err("stopped");
            assert_eq!(error.to_string(), "Sequence stopped at step 1 (fill); no step completed. A alert dialog is blocking the sequence.\n\nOBSERVED");
            assert_eq!(script.indexes(), [1]);
        }
    }

    #[tokio::test]
    async fn a_cancelled_sequence_dispatches_no_further_input_and_ends_as_cancelled() {
        let page = page();
        let host = FakeHost::scripted(Vec::new());
        let source = mixdog_rt::CancelSource::new();
        let script = Script::new(&page);
        let mut rig = Rig::new(None);
        let command = fills(3);
        let view = source.view();
        let mut cx = ActionContext { host: &host, page: &page, command: &command, cancel: &view, recovery: &mut rig.recovery, effect_baseline: &mut rig.baseline };
        // The first step cancels its own command, the way a caller aborting mid-batch does.
        let aborting = AbortingRunner { inner: &script, source: &source };
        let error = sequence(&mut cx, &aborting).await.expect_err("cancelled");
        assert!(matches!(&error, ActionError::Cancelled(cancelled) if cancelled.to_string() == "cancelled by caller"), "{error:?}");
        assert_eq!(script.indexes(), [1]);
    }

    /// A runner whose first step cancels the command.
    struct AbortingRunner<'a, 'b> {
        inner: &'a Script<'b>,
        source: &'a mixdog_rt::CancelSource,
    }

    #[async_trait]
    impl StepRunner for AbortingRunner<'_, '_> {
        async fn run_step(&self, index: u32, step: Value, cancel: &CancelView) -> Result<StepResult, ActionError> {
            let result = self.inner.run_step(index, step, cancel).await;
            self.source.cancel("cancelled by caller");
            result
        }

        async fn observe(&self, cancel: &CancelView) -> Result<String, ActionError> {
            self.inner.observe(cancel).await
        }
    }
}
