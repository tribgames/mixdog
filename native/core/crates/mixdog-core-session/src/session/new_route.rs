//! The route a `thread/start` thread begins on (`NewThreadRoute`) over the route service.
//!
//! Node's desktop starts a task as `client.create` (a reserved session on the runtime's route, which
//! is the route the config resolves to) followed by the draft's `setRoute` with
//! `applyToCurrentSession` and `keepMainModel: false` (`session-host-lifecycle.ts`
//! `createNewTask` / `configureDraft`), all before the first prompt; the session record is composed
//! from the route that results (`session-options.mjs`, `materializeSession`). The route service
//! holds both halves: [`RouteService::adopt_draft`] / [`RouteService::ready_default`] settle the
//! live route, [`RouteService::seat_route`] writes it onto the created thread through the one
//! route-change path every later route change takes.

use mixdog_core_api::ids::ThreadId;
use mixdog_core_domains::domains::ai_admin::route_service::RouteService;
use mixdog_protocol::ModelSelection;
use serde_json::Map;
use serde_json::Value;

use super::NewThreadRoute;

/// `configureDraft`'s request: the draft's route with the optional parts it names (`effort` when
/// set, the flags when boolean, the numbers when numbers).
pub fn draft_pick(route: &ModelSelection) -> Map<String, Value> {
    let mut pick = Map::new();
    pick.insert("provider".into(), Value::String(route.provider.clone()));
    pick.insert("model".into(), Value::String(route.model.clone()));
    if let Some(effort) = route.effort.as_ref().filter(|effort| !effort.is_empty()) {
        pick.insert("effort".into(), Value::String(effort.clone()));
    }
    if let Some(fast) = route.fast {
        pick.insert("fast".into(), Value::Bool(fast));
    }
    if let Some(auto) = route.auto_effort {
        pick.insert("autoEffort".into(), Value::Bool(auto));
    }
    if let Some(parameters) = &route.model_parameters {
        pick.insert(
            "modelParameters".into(),
            Value::Object(parameters.iter().map(|(key, value)| (key.clone(), Value::String(value.clone()))).collect()),
        );
    }
    if let Some(percent) = route.context_percent {
        pick.insert("contextPercent".into(), mixdog_js::json_number(percent));
    }
    if let Some(tokens) = route.context_tokens {
        pick.insert("contextTokens".into(), Value::from(tokens));
    }
    pick
}

#[async_trait::async_trait]
impl NewThreadRoute for RouteService {
    async fn adopt(&self, thread: &ThreadId, draft: Option<&Map<String, Value>>) -> Result<(), String> {
        match draft {
            Some(draft) => self.adopt_draft(thread, draft).await,
            None => self.ready_default(thread).await,
        }
    }

    async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
        self.seat_route(thread).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// `configureDraft`: the optional parts travel only when the draft sets them (an empty effort is
    /// none), the flags as booleans and the numbers as numbers.
    #[test]
    fn a_drafts_pick_names_only_what_the_draft_sets() {
        let bare: ModelSelection = serde_json::from_value(json!({ "provider": "p", "model": "m", "effort": "" })).expect("draft");
        assert_eq!(Value::Object(draft_pick(&bare)), json!({ "provider": "p", "model": "m" }));
        let full: ModelSelection = serde_json::from_value(json!({
            "provider": "p", "model": "m", "effort": "high", "fast": true, "autoEffort": false,
            "modelParameters": { "context": "1m" }, "contextPercent": 30.0, "contextTokens": 200000,
        }))
        .expect("draft");
        assert_eq!(
            Value::Object(draft_pick(&full)),
            json!({
                "provider": "p", "model": "m", "effort": "high", "fast": true, "autoEffort": false,
                "modelParameters": { "context": "1m" }, "contextPercent": 30, "contextTokens": 200000,
            })
        );
    }
}
