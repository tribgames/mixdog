//! The route a `thread/start` thread begins on (`NewThreadRoute`) over the route service.
//!
//! [`RouteService::adopt_draft`] / [`RouteService::ready_default`] settle the live route before the
//! first prompt, and [`RouteService::seat_route`] writes it onto the created thread through the one
//! route-change path every later route change takes.

use mixdog_ai::service::admin_route::truthy;
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
    if let Some(flag) = route.effort_auto {
        mixdog_ai::effort::EffortAuto::from_bool(flag).write_to(&mut pick);
    } else if let Some(legacy) = route.auto_effort {
        pick.insert("autoEffort".into(), Value::Bool(legacy));
    }
    if let Some(parameters) = &route.model_parameters {
        pick.insert("modelParameters".into(), Value::Object(parameters.iter().map(|(key, value)| (key.clone(), Value::String(value.clone()))).collect()));
    }
    if let Some(percent) = route.context_percent {
        pick.insert("contextPercent".into(), mixdog_js::json_number(percent));
    }
    if let Some(tokens) = route.context_tokens {
        pick.insert("contextTokens".into(), Value::from(tokens));
    }
    pick
}

pub(super) fn record_route(header: &Map<String, Value>, legacy_switch_on: bool) -> Option<Map<String, Value>> {
    if !mixdog_core_ports::ports::route::header_names_session(header) {
        return None;
    }
    let mut request = Map::new();
    for key in ["provider", "model"] {
        request.insert(key.into(), header.get(key).cloned().unwrap_or(Value::Null));
    }
    if let Some(effort) = header.get("effort").filter(|effort| truthy(Some(effort))) {
        request.insert("effort".into(), effort.clone());
    }
    request.insert("fast".into(), Value::Bool(header.get("fast") == Some(&Value::Bool(true))));
    mixdog_ai::effort::EffortAuto::resolve(header, legacy_switch_on).write_to(&mut request);
    let parameters = header.get("modelParameters").filter(|parameters| truthy(Some(parameters))).cloned();
    request.insert("modelParameters".into(), parameters.unwrap_or_else(|| Value::Object(Map::new())));
    Some(request)
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

    async fn adopt_control(&self, thread: &ThreadId) -> Result<Map<String, Value>, String> {
        self.ready_control(thread).await?;
        Ok(self.writer.route(thread))
    }

    async fn seat(&self, thread: &ThreadId) -> Result<(), String> {
        self.seat_route(thread).await
    }

    fn boot(&self, thread: &ThreadId, header: &Map<String, Value>) {
        let legacy_switch_on = mixdog_ai::service::admin_route::config_default_auto_effort(&self.config.agent());
        if let Some(request) = record_route(header, legacy_switch_on) {
            self.writer.boot(thread, &request);
        }
    }

    async fn prepare(&self, thread: &ThreadId) {
        self.prepare_route(thread).await;
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
            "provider": "p", "model": "m", "effort": "high", "fast": true, "effortAuto": false,
            "modelParameters": { "context": "1m" }, "contextPercent": 30.0, "contextTokens": 200000,
        }))
        .expect("draft");
        assert_eq!(
            Value::Object(draft_pick(&full)),
            json!({
                "provider": "p", "model": "m", "effort": "high", "fast": true, "effortAuto": false,
                "modelParameters": { "context": "1m" }, "contextPercent": 30, "contextTokens": 200000,
            })
        );
    }

    /// `resumedRouteFor`: converts pre-update headers once using the legacy switch and preserves
    /// explicit `effortAuto` regardless of the switch.
    #[test]
    fn a_records_route_asks_for_what_the_record_holds() {
        let header = |value: Value| value.as_object().cloned().expect("header");
        let bare = record_route(&header(json!({ "provider": "p", "model": "m", "effort": null })), false).expect("a route");
        assert_eq!(Value::Object(bare), json!({ "provider": "p", "model": "m", "fast": false, "effortAuto": false, "modelParameters": {} }));
        let pre_update_off = record_route(&header(json!({ "provider": "p", "model": "m", "effort": "high", "autoEffort": true })), false).expect("a route");
        assert_eq!(
            Value::Object(pre_update_off),
            json!({ "provider": "p", "model": "m", "effort": "high", "fast": false, "effortAuto": false, "modelParameters": {} })
        );
        let pre_update_on = record_route(&header(json!({ "provider": "p", "model": "m", "effort": "high" })), true).expect("a route");
        assert_eq!(
            Value::Object(pre_update_on),
            json!({ "provider": "p", "model": "m", "effort": "high", "fast": false, "effortAuto": true, "modelParameters": {} })
        );
        let explicit_auto = record_route(&header(json!({ "provider": "p", "model": "m", "effort": "high", "effortAuto": true })), false).expect("a route");
        assert_eq!(
            Value::Object(explicit_auto),
            json!({ "provider": "p", "model": "m", "effort": "high", "fast": false, "effortAuto": true, "modelParameters": {} })
        );
        let held = header(json!({
            "provider": "p", "model": "m", "effort": "high", "fast": true, "effortAuto": false,
            "modelParameters": { "context": "1m" }, "contextPercent": 30, "preset": "full",
        }));
        assert_eq!(
            Value::Object(record_route(&held, true).expect("a route")),
            json!({ "provider": "p", "model": "m", "effort": "high", "fast": true, "effortAuto": false, "modelParameters": { "context": "1m" } })
        );
        assert_eq!(record_route(&header(json!({ "provider": "p", "model": "" })), true), None);
    }

    #[test]
    fn explicit_effort_auto_and_legacy_flag_survive_draft_pick() {
        for (label, state) in [("auto", true), ("manual", false)] {
            let input = json!({ "provider": "p", "model": "m", "effort": "high", "effortAuto": state });
            let selection: ModelSelection = serde_json::from_value(input).expect("selection");
            let pick = draft_pick(&selection);
            assert_eq!(pick.get("effortAuto").and_then(Value::as_bool), Some(state), "draft_pick preserves {label}");
            assert!(pick.get("autoEffort").is_none());
        }
        let legacy: ModelSelection = serde_json::from_value(json!({ "provider": "p", "model": "m", "effort": "high", "autoEffort": true })).expect("legacy");
        let pick = draft_pick(&legacy);
        assert_eq!(pick.get("autoEffort").and_then(Value::as_bool), Some(true));
        assert!(pick.get("effortAuto").is_none());
    }
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
    let tools = preset.and_then(|preset| preset.get("tools")).filter(|tools| !matches!(tools, Value::Null | Value::Bool(false)) && tools.as_str() != Some(""));
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
