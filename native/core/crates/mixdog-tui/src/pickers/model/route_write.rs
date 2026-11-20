//! The serialized, optimistic route write behind the session's `setRoute` (`src/tui/session/session-api/routes-write.mjs`): every
//! model picker, the presets and the agent child routes save through it.
//!
//! The store applies these decisions; the pickers only call `setRoute`. The rules:
//!
//! - A selection is never refused: another command's lock neither blocks it nor is released by it.
//! - The requested provider, model, effort, Fast, parameters and context are published at once ([`optimistic_route_patch`]);
//!   what is not previewed (effort options, Fast capability, context window) is provider metadata the runtime resolves while
//!   the preview is already on screen.
//! - Writes run one after another in the order they began (the executor's queue; [`RouteWrites::begin`] hands out the
//!   token), so a later click is never dropped. A completion of an earlier write cannot replace the newest visible choice: only
//!   the write holding the newest token publishes the final route, or rolls the preview back ([`RouteWrites::settle`]).
//! - A write settles against the session generation it began under: a selection that outlived its session republishes the
//!   route that is actually selected, and never restores or announces its own session's state.
//! - A session-only request (an agent child's route) may name just the model, just the tuning, or both. The core completes it
//!   inside its own serialized write against the latest selected route (`route/set`, `route_set_service::complete_session_only`
//!   of mixdog-core-domains), so the request is sent as asked.

use serde_json::{Map, Value};

/// The route fields a request publishes before the runtime write settles.
pub const ROUTE_PREVIEW_KEYS: [&str; 8] = ["provider", "model", "effort", "fast", "autoEffort", "modelParameters", "contextPercent", "contextTokens"];

/// `String(a ?? b ?? '')`.
fn nullish_text(first: Option<&Value>, second: Option<&Value>) -> String {
    [first, second].into_iter().flatten().find(|value| !value.is_null()).map(mixdog_js::value_to_string).unwrap_or_default()
}

/// `optimisticRoutePatch(requested, current)`: the patch that publishes a requested route before the runtime write settles;
/// `None` when the request carries nothing previewable. A different model carries none of the previous model's tuning: an
/// omitted key means "this model has no such control", not "keep the old value".
pub fn optimistic_route_patch(requested: &Value, current: &Value) -> Option<Map<String, Value>> {
    let route = requested.as_object().cloned().unwrap_or_default();
    let has = |key: &str| route.contains_key(key);
    let mut patch = Map::new();
    for key in ROUTE_PREVIEW_KEYS {
        if let Some(value) = route.get(key) {
            patch.insert(key.to_owned(), value.clone());
        }
    }
    if !has("provider") && !has("model") {
        return (!patch.is_empty()).then_some(patch);
    }
    let same_model = ["provider", "model"].into_iter().all(|key| nullish_text(patch.get(key), current.get(key)) == nullish_text(current.get(key), None));
    if !same_model {
        if !has("effort") {
            patch.insert("effort".to_owned(), Value::Null);
        }
        if !has("fast") {
            patch.insert("fast".to_owned(), Value::Bool(false));
        }
        if !has("modelParameters") {
            patch.insert("modelParameters".to_owned(), Value::Object(Map::new()));
        }
    }
    Some(patch)
}

/// The request of a `setRoute` call and the flags that steer it (`applyToCurrentSession`, `keepMainModel`, `sessionOnly`,
/// `onlyIfEmpty`), the flags taken out.
#[derive(Clone, Debug, PartialEq)]
pub struct RouteRequest {
    pub requested: Map<String, Value>,
    /// Keep the durable session address while deferring route application.
    pub apply_to_current_session: bool,
    pub keep_main_model: bool,
    pub session_only: bool,
    /// A conditional fill (only when the route is still empty) may not apply, so it never previews: the runtime's answer is
    /// what gets published.
    pub only_if_empty: bool,
}

impl RouteRequest {
    /// Splits the options of a `setRoute` call.
    pub fn from_options(options: &Value) -> Self {
        let mut requested = options.as_object().cloned().unwrap_or_default();
        let flag = |requested: &mut Map<String, Value>, key: &str| requested.remove(key);
        let apply = flag(&mut requested, "applyToCurrentSession");
        let keep = flag(&mut requested, "keepMainModel");
        let session_only = flag(&mut requested, "sessionOnly");
        let only_if_empty = flag(&mut requested, "onlyIfEmpty");
        Self {
            requested,
            apply_to_current_session: apply == Some(Value::Bool(true)),
            keep_main_model: keep != Some(Value::Bool(false)),
            session_only: session_only == Some(Value::Bool(true)),
            only_if_empty: only_if_empty == Some(Value::Bool(true)),
        }
    }
}

/// What starting a write asks the store to do.
#[derive(Clone, Debug, PartialEq)]
pub struct WriteBegin {
    /// The write's place in the order: its completion publishes only while it is still the newest.
    pub token: u64,
    /// The patch to publish now (`None` for a conditional fill or a request with nothing previewable).
    pub preview: Option<Map<String, Value>>,
    /// `commandBusy` is raised for as long as this API holds the lock.
    pub raise_command_busy: bool,
}

/// How a write ended.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WriteOutcome {
    pub failed: bool,
    /// The runtime applied the route to the current session (or switched model): the context stats are re-synced.
    pub sync: bool,
    /// The model-switch divider to publish, when the runtime made one.
    pub model_switch: Option<Value>,
}

/// What settling a write asks the store to do, in this order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Settlement {
    /// Publish the divider of an in-place model switch.
    pub publish_model_switch: bool,
    /// Put the route that was selected before this write back (the preview failed).
    pub rollback_preview: bool,
    /// Re-sync the context stats (an estimate is allowed).
    pub sync_context: bool,
    /// Publish the resolved (or restored) route.
    pub publish_route: bool,
}

/// The sequence of route writes of one session API.
#[derive(Clone, Debug, Default)]
pub struct RouteWrites {
    sequence: u64,
    /// Whether this API (not another command) is the one holding `commandBusy`.
    locked: bool,
}

impl RouteWrites {
    pub fn new() -> Self {
        Self::default()
    }

    /// A selection began: its token, the preview to publish and whether `commandBusy` goes up. Another command's lock
    /// neither blocks it nor is released by it.
    pub fn begin(&mut self, request: &RouteRequest, previewed: &Value, current: &Value, command_busy: bool) -> WriteBegin {
        self.sequence += 1;
        let preview = if request.only_if_empty { None } else { optimistic_route_patch(previewed, current) };
        if !command_busy {
            self.locked = true;
        }
        WriteBegin { token: self.sequence, preview, raise_command_busy: self.locked }
    }

    /// The write of `token` settled. `owned` is whether the session generation it began under is still the live one; `had_preview`
    /// whether [`WriteBegin::preview`] was published. A stale selection only republishes the route that is actually selected;
    /// it never restores or announces its own session's state. A newer selection publishes the final route itself.
    pub fn settle(&self, token: u64, owned: bool, had_preview: bool, outcome: &WriteOutcome) -> Settlement {
        let mut settlement = Settlement { publish_model_switch: owned && outcome.model_switch.is_some(), ..Settlement::default() };
        if token != self.sequence {
            return settlement;
        }
        if owned && outcome.failed {
            settlement.rollback_preview = had_preview;
            return settlement;
        }
        settlement.sync_context = owned && outcome.sync;
        settlement.publish_route = true;
        settlement
    }

    /// The write of `token` is over: whether `commandBusy` comes down (only the newest write releases the lock this API took),
    /// after which the resolved route is flushed before an RPC reply reads the state.
    pub fn finish(&mut self, token: u64) -> bool {
        if token != self.sequence {
            return false;
        }
        let release = self.locked;
        self.locked = false;
        release
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(options: Value) -> RouteRequest {
        RouteRequest::from_options(&options)
    }

    #[test]
    fn a_different_model_carries_none_of_the_previous_tuning() {
        let current = json!({"provider": "anthropic", "model": "a", "effort": "high", "fast": true});
        let patch = optimistic_route_patch(&json!({"provider": "openai", "model": "b"}), &current).expect("patch");
        assert_eq!(Value::Object(patch), json!({"provider": "openai", "model": "b", "effort": null, "fast": false, "modelParameters": {}}));
        let same = optimistic_route_patch(&json!({"provider": "anthropic", "model": "a", "effort": "low"}), &current).expect("patch");
        assert_eq!(Value::Object(same), json!({"provider": "anthropic", "model": "a", "effort": "low"}));
        assert!(optimistic_route_patch(&json!({"unrelated": 1}), &current).is_none());
        let tuning = optimistic_route_patch(&json!({"fast": true}), &current).expect("patch");
        assert_eq!(Value::Object(tuning), json!({"fast": true}));
    }

    #[test]
    fn a_late_completion_never_rolls_back_a_newer_route() {
        let mut writes = RouteWrites::new();
        let current = json!({"provider": "a", "model": "x"});
        let first = writes.begin(&request(json!({"provider": "b", "model": "y"})), &json!({"provider": "b", "model": "y"}), &current, false);
        let second = writes.begin(&request(json!({"provider": "c", "model": "z"})), &json!({"provider": "c", "model": "z"}), &current, true);
        assert!(first.raise_command_busy && second.raise_command_busy, "the lock this API took stays up while writes queue");
        // The older write fails after the newer one began: it neither restores its previous route nor publishes.
        let failed = WriteOutcome { failed: true, ..WriteOutcome::default() };
        assert_eq!(writes.settle(first.token, true, true, &failed), Settlement::default());
        assert!(!writes.finish(first.token), "only the newest write releases the lock");
        // The newest write settles and publishes the final route.
        let ok = WriteOutcome { sync: true, ..WriteOutcome::default() };
        assert_eq!(writes.settle(second.token, true, true, &ok), Settlement { sync_context: true, publish_route: true, ..Settlement::default() });
        assert!(writes.finish(second.token));
    }

    #[test]
    fn a_failed_newest_write_restores_the_previous_route_only_when_it_previewed() {
        let mut writes = RouteWrites::new();
        let begin = writes.begin(&request(json!({"provider": "b", "model": "y"})), &json!({"provider": "b", "model": "y"}), &json!({}), false);
        let failed = WriteOutcome { failed: true, ..WriteOutcome::default() };
        assert_eq!(writes.settle(begin.token, true, true, &failed), Settlement { rollback_preview: true, ..Settlement::default() });
        assert_eq!(writes.settle(begin.token, true, false, &failed), Settlement::default());
        // A write whose session was replaced republishes the selected route and never announces its own divider.
        let switched = WriteOutcome { failed: false, sync: true, model_switch: Some(json!({"to": "y"})) };
        assert_eq!(writes.settle(begin.token, false, true, &switched), Settlement { publish_route: true, ..Settlement::default() });
        assert_eq!(
            writes.settle(begin.token, true, true, &switched),
            Settlement { publish_model_switch: true, sync_context: true, publish_route: true, ..Settlement::default() }
        );
    }

    #[test]
    fn another_commands_lock_is_neither_taken_nor_released() {
        let mut writes = RouteWrites::new();
        let begin = writes.begin(&request(json!({"model": "y"})), &json!({"model": "y"}), &json!({}), true);
        assert!(!begin.raise_command_busy);
        assert!(!writes.finish(begin.token));
    }

    #[test]
    fn a_conditional_fill_never_previews() {
        let mut writes = RouteWrites::new();
        let fill = request(json!({"provider": "b", "model": "y", "onlyIfEmpty": true}));
        assert!(fill.only_if_empty && !fill.requested.contains_key("onlyIfEmpty"));
        assert!(writes.begin(&fill, &json!({"provider": "b", "model": "y"}), &json!({}), false).preview.is_none());
    }

    #[test]
    fn the_flags_leave_the_request() {
        let split = request(json!({"model": "m", "applyToCurrentSession": true, "keepMainModel": false, "sessionOnly": true}));
        assert!(split.apply_to_current_session && !split.keep_main_model && split.session_only && !split.only_if_empty);
        assert_eq!(Value::Object(split.requested), json!({"model": "m"}));
        assert!(request(json!({})).keep_main_model);
    }
}
