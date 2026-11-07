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
use mixdog_core_ports::ports::route_write::RouteWriter;
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

/// The route keys `buildSessionRecord` / `createSession` write at creation and a route change does
/// not (`session-record.mjs:121`, `session-lifecycle.mjs:227`), made from the route the session is
/// created on (`rt.route`): `presetName` (the preset's name), `codexWireSessionId` (a UUIDv7 for
/// `openai-oauth`, else null), `contextPercent` (the route's, else null), `contextTokens` (only
/// when set), and, for a session with no owner agent, the preset's fallback chain
/// (`routeFallbacks`: `executionFallbacks(normalizeWorkflowRoute({provider, model, fallbacks}))`,
/// only when not empty) with its `routeFallbackSource`. The route's own fields (provider, model,
/// effort, Fast, parameters, window) are the seat's.
pub fn create_keys(route: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let text = |key: &str| route.get(key).and_then(Value::as_str).unwrap_or_default();
    let preset = route.get("preset").and_then(Value::as_object);
    let mut keys = Map::new();
    let name = preset.and_then(|preset| preset.get("name")).and_then(Value::as_str).filter(|name| !name.is_empty());
    keys.insert("presetName".into(), name.map_or(Value::Null, |name| Value::String(name.to_owned())));
    // `toolPreset` (`session-lifecycle.mjs`): `opts.tools || presetObj.tools || .. || 'full'`; a new thread has no `opts.tools`.
    let tools = preset
        .and_then(|preset| preset.get("tools"))
        .filter(|tools| !matches!(tools, Value::Null | Value::Bool(false)) && tools.as_str() != Some(""));
    keys.insert("preset".into(), tools.cloned().unwrap_or_else(|| Value::String("full".into())));
    let wire = if text("provider") == "openai-oauth" { Value::String(uuid::Uuid::now_v7().to_string()) } else { Value::Null };
    keys.insert("codexWireSessionId".into(), wire);
    let percent = mixdog_ai::service::admin_route::clean_context_percent(route.get("contextPercent"));
    keys.insert("contextPercent".into(), percent.map_or(Value::Null, mixdog_js::json_number));
    if let Some(tokens) = mixdog_ai::service::admin_route::normalize_context_tokens(route.get("contextTokens")) {
        keys.insert("contextTokens".into(), mixdog_js::json_number(tokens));
    }
    let mut head = Map::new();
    head.insert("provider".into(), route.get("provider").cloned().unwrap_or(Value::Null));
    head.insert("model".into(), route.get("model").cloned().unwrap_or(Value::Null));
    if let Some(fallbacks) = preset.and_then(|preset| preset.get("fallbacks")) {
        head.insert("fallbacks".into(), fallbacks.clone());
    }
    let head = Value::Object(head);
    let chain = match mixdog_ai::service::admin_route::normalize_workflow_route(&head, &serde_json::json!({}), false)? {
        Some(normalized) => mixdog_ai::service::routes::execution_fallbacks(&normalized)?,
        None => Vec::new(),
    };
    if !chain.is_empty() {
        keys.insert("routeFallbacks".into(), Value::Array(chain));
    }
    if let Some(source) = preset.and_then(|preset| preset.get("fallbackSource")).filter(|source| source.is_object()) {
        keys.insert("routeFallbackSource".into(), source.clone());
    }
    Ok(keys)
}

#[async_trait::async_trait]
impl NewThreadRoute for RouteService {
    async fn adopt(&self, thread: &ThreadId, draft: Option<&Map<String, Value>>) -> Result<Map<String, Value>, String> {
        match draft {
            Some(draft) => self.adopt_draft(thread, draft).await?,
            None => self.ready_default(thread).await?,
        }
        Ok(self.writer.route(thread))
    }

    async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
        self.seat_route(thread).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The create-only route keys equal the ones the Node harness session carries
    /// (`route_goldens/node_create_route.json`): a route with no preset and no window gives
    /// `presetName`/`codexWireSessionId`/`contextPercent` null and nothing else; a preset gives its
    /// name and the fallback chain Node's `createSession` seeds (evaluated from the Node sources).
    #[test]
    fn the_create_only_keys_equal_the_ones_node_recorded() {
        let golden: Value = serde_json::from_str(include_str!("route_goldens/node_create_route.json")).expect("golden");
        let object = |value: &Value| value.as_object().cloned().expect("object");
        let keys = create_keys(&object(&golden["route"])).expect("keys");
        for name in ["presetName", "codexWireSessionId", "contextPercent"] {
            assert_eq!(keys.get(name), golden["header"].get(name), "{name}");
        }
        for name in golden["absent"].as_array().expect("absent").iter().filter_map(Value::as_str) {
            if name != "autoEffort" {
                assert!(!keys.contains_key(name), "{name}");
            }
        }
        let case = &golden["preset_case"];
        let keys = create_keys(&object(&case["route"])).expect("keys");
        for (name, want) in case["header"].as_object().expect("header") {
            assert_eq!(keys.get(name), Some(want), "{name}");
        }
        let oauth = create_keys(&object(&json!({ "provider": "openai-oauth", "model": "gpt-5" }))).expect("keys");
        assert!(oauth["codexWireSessionId"].as_str().is_some_and(|id| id.len() == 36));
    }

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
