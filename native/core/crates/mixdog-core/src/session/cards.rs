//! Which arriving completions show a live card (Node's `notification-router.mjs`,
//! `execution-delivery.mjs` `pushCard`, `execution-dedup.mjs`): the status-only skip, one card
//! per execution and presentation phase (`card:<execution_id>:b0|b1`), no card for a
//! successful bodyless preview, and none once the execution's body was shown. The card itself
//! is the transcript's (`transcript_response::agent_response`).

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_protocol::message_class::envelope::agent_job_ids;
use mixdog_protocol::message_class::envelope::is_status_only_agent_completion;
use mixdog_protocol::text_class::parse_task_notification;
use serde_json::Value;

/// `limit` of `createExecutionDedup`.
const LIMIT: usize = 256;

/// `TERMINAL_STATUS` of `agent-status-refresh.mjs`.
fn terminal(status: &str) -> bool {
    JsRegex::new_static(r"^(completed|complete|done|success|succeeded|ok|failed|error|timeout|killed|cancelled|canceled|denied)$", "")
        .is_match(status)
}

/// `FAILURE_STATUS` of `execution-delivery.mjs`.
fn failure(status: &str) -> bool {
    JsRegex::new_static(r"^(failed|error|timeout|killed|cancelled|canceled|denied)$", "").is_match(status)
}

/// `SUCCESS_STATUS` of `execution-delivery.mjs`.
fn success(status: &str) -> bool {
    JsRegex::new_static(r"^(completed|complete|done|success|succeeded|ok)$", "").is_match(status)
}

/// A bounded key set whose finished keys are evicted first (`pickEviction`); insertion order.
#[derive(Default)]
struct Bounded {
    order: VecDeque<String>,
    terminal: HashSet<String>,
}

impl Bounded {
    fn contains(&self, key: &str) -> bool {
        self.order.iter().any(|k| k == key)
    }

    /// Re-inserts `key` last, evicting first a finished key, else the oldest, to stay under
    /// the bound. Returns the evicted keys.
    fn remember(&mut self, key: &str, terminal: bool) -> Vec<String> {
        self.order.retain(|k| k != key);
        if terminal {
            self.terminal.insert(key.to_owned());
        } else {
            self.terminal.remove(key);
        }
        let mut evicted = Vec::new();
        while self.order.len() >= LIMIT {
            let at = self.order.iter().position(|k| self.terminal.contains(k)).unwrap_or(0);
            let Some(gone) = self.order.remove(at) else { break };
            self.terminal.remove(&gone);
            evicted.push(gone);
        }
        self.order.push_back(key.to_owned());
        evicted
    }
}

/// The session's card dedup state (`createExecutionDedup`).
#[derive(Default)]
pub(crate) struct CardGate {
    displayed: Bounded,
    executions: HashMap<String, String>,
    responses: Bounded,
    states: HashMap<String, &'static str>,
}

impl CardGate {
    fn remember_card(&mut self, key: &str, terminal: bool, execution: &str) {
        if !execution.is_empty() {
            self.executions.insert(key.to_owned(), execution.to_owned());
        }
        for gone in self.displayed.remember(key, terminal) {
            self.executions.remove(&gone);
        }
    }

    fn remember_state(&mut self, execution: &str, state: &'static str, terminal: bool) {
        for gone in self.responses.remember(execution, terminal) {
            self.states.remove(&gone);
        }
        self.states.insert(execution.to_owned(), state);
    }

    /// `promote`: a finished execution's keys go first when the bound is reached.
    fn promote(&mut self, execution: &str) {
        if execution.is_empty() {
            return;
        }
        let keys: Vec<String> =
            self.executions.iter().filter(|(k, e)| *e == execution && self.displayed.contains(k)).map(|(k, _)| k.clone()).collect();
        for key in keys {
            self.displayed.terminal.insert(key);
        }
        if let Some(state) = self.states.get(execution).copied() {
            self.remember_state(execution, state, true);
        }
    }

    /// How the session's listener takes the completion `{content, meta}`: `None` when it only
    /// moves the agent's status (or is empty), else whether it shows a card now (recorded when
    /// it does). An `execution-ui` completion's queued copy shows no row of its own.
    pub(crate) fn admit(&mut self, content: &str, meta: &Value) -> Option<bool> {
        let text = js_trim(content);
        if text.is_empty() {
            return None;
        }
        let ids = agent_job_ids(text);
        let field = |key: &str| meta.get(key).and_then(Value::as_str).map(|s| js_trim(s).to_owned()).filter(|s| !s.is_empty());
        let execution = field("execution_id").or_else(|| ids.as_ref().map(|(id, _)| js_trim(id).to_owned())).unwrap_or_default();
        let status = field("status").or_else(|| ids.map(|(_, status)| status)).unwrap_or_default().to_lowercase();
        let finished = terminal(&status);
        if finished {
            self.promote(&execution);
        }
        // `status-only`: the agent's status moves, nothing is shown.
        if is_status_only_agent_completion(text) {
            return None;
        }
        let body = super::transcript::has_body(text);
        // `executionCardKey`: the card per execution and phase. A completion with no execution
        // id has none (the core's producers always name one).
        let key = if execution.is_empty() { String::new() } else { format!("card:{execution}:{}", if body { "b1" } else { "b0" }) };
        let first = key.is_empty() || !self.displayed.contains(&key);
        let successful_preview = parse_task_notification(text).is_none() && !body && !failure(&status) && success(&status);
        let body_shown = !execution.is_empty() && self.states.get(&execution) == Some(&"body");
        if !key.is_empty() && finished && self.displayed.contains(&key) {
            self.remember_card(&key, true, &execution);
        }
        if finished {
            self.promote(&execution);
        }
        if !first || successful_preview || body_shown {
            return Some(false);
        }
        if !key.is_empty() {
            self.remember_card(&key, finished, &execution);
        }
        if !execution.is_empty() {
            self.remember_state(&execution, if body { "body" } else { "preview" }, finished);
        }
        Some(true)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn meta(id: &str, status: &str) -> Value {
        json!({ "execution_surface": "agent", "execution_id": id, "status": status })
    }

    const BODY: &str = "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent \"rev\" completed</summary>\n<result>\nall done\n</result>\n</task-notification>";

    /// `resolveTuiRuntimeNotificationDelivery`: a header-only completed or cancelled agent
    /// result is status-only; a failed one, or one with a result, is a card.
    #[test]
    fn a_bodyless_finished_agent_result_is_status_only() {
        let mut gate = CardGate::default();
        assert_eq!(None, gate.admit("agent task: t1\nstatus: completed", &meta("t1", "completed")));
        assert_eq!(None, gate.admit("agent task: t2\nstatus: cancelled", &meta("t2", "cancelled")));
        assert_eq!(Some(true), gate.admit("agent task: t3\nstatus: failed", &meta("t3", "failed")));
        assert_eq!(Some(true), gate.admit("agent task: t4\nstatus: completed\n\nthe answer", &meta("t4", "completed")));
    }

    /// `pushCard`'s `successfulPreview`: a bodyless preview that reads as a success shows no card;
    /// a failed preview does, once.
    #[test]
    fn a_successful_preview_shows_no_card_and_a_failed_one_shows_once() {
        let mut gate = CardGate::default();
        let preview = "background task\ntask_id: t1\nsurface: agent\nstatus: done";
        assert_ne!(Some(true), gate.admit(preview, &json!({ "execution_id": "t1", "status": "done", "model_visible": false })));
        let failed = "background task\ntask_id: t2\nsurface: agent\nstatus: failed\nerror: boom";
        assert_eq!(Some(true), gate.admit(failed, &json!({ "execution_id": "t2", "status": "failed", "model_visible": false })));
        assert_ne!(Some(true), gate.admit(failed, &json!({ "execution_id": "t2", "status": "failed" })), "card:t2:b0 shown once");
    }

    /// `executionCardKey` and the response state: a preview does not keep the body from showing,
    /// the body shows once, and nothing shows after the body.
    #[test]
    fn one_card_per_execution_and_phase_and_none_after_the_body() {
        let mut gate = CardGate::default();
        let preview = "background task\ntask_id: t1\nsurface: agent\nstatus: failed";
        assert_eq!(Some(true), gate.admit(preview, &meta("t1", "failed")));
        assert_eq!(Some(true), gate.admit(BODY, &meta("t1", "completed")), "card:t1:b1 after card:t1:b0");
        assert_ne!(Some(true), gate.admit(BODY, &meta("t1", "completed")), "the body is shown once");
        assert_ne!(Some(true), gate.admit(preview, &meta("t1", "failed")), "nothing after the body");
    }

    /// `createExecutionDedup`'s bound: a finished execution's key is evicted before a live one.
    #[test]
    fn finished_keys_are_evicted_first() {
        let mut gate = CardGate::default();
        let failed = |id: &str| format!("background task\ntask_id: {id}\nsurface: agent\nstatus: failed");
        assert_eq!(Some(true), gate.admit(&failed("done-early"), &meta("done-early", "failed")));
        for n in 0..LIMIT {
            let running = format!("agent task: r{n}\nstatus: running\n\nprogress");
            assert_eq!(Some(true), gate.admit(&running, &meta(&format!("r{n}"), "running")));
        }
        assert!(!gate.displayed.contains("card:done-early:b0"), "the finished key went first");
        assert!(gate.displayed.contains("card:r0:b1"));
    }
}
