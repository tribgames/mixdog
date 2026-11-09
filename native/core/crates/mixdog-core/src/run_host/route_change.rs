//! What a route change does to the session besides its route fields (Node `updateSessionRoute`,
//! `session-lifecycle.mjs`): `applyRouteContextWindow`, `resetSessionForRouteChange` and, when the
//! caller crosses providers, the context-usage and baseline invalidation. One function, shared by
//! the session's route adapter and the run's fallback hop, so a hop changes the header exactly as a
//! picked model does.
//!
//! The pending workspace re-root and the `# Session` block rebuild are
//! `session::worktree::route_prompt_refresh` (they read the prompt messages, which a header does
//! not hold); the replay strip of the transcript is `route_fallback::strip_provider_replay_messages`.

use std::sync::Arc;

use mixdog_agent::compact::pressure::{invalidate_context_usage_snapshot, invalidate_provider_context_baseline};
use mixdog_agent::env::Clock;
use mixdog_store::schema::record::{Header, HeaderChange};
use serde_json::{json, Map, Value};

use mixdog_core_ports::ports::route::Route;
use mixdog_core_run::run_host::session_context_meta::ContextMeta;
use mixdog_core_session::session::route_session::route_changed;
use mixdog_core_session::session::route_session::RouteChange;
use mixdog_core_session::session::route_session::RouteLookups;

/// What a route change reads from the provider registry and the cache policy.
#[async_trait::async_trait]
pub trait RouteFacts: Send + Sync {
    /// The model's context window, `None` when the provider is not registered (`getProvider`
    /// answers nothing) or the session has no model. `seed` is `contextSeedForRouteUpdate`.
    fn context_meta(&self, provider: &str, model: &str, seed: &Value) -> Option<ContextMeta>;

    /// `buildSessionProviderCacheOpts(provider, sessionId, agent, null, session)`: the explicit
    /// cache-breakpoint policy of an explicit-breakpoint provider, a role's shared-scope policy for
    /// others, `None` when the provider has none.
    fn cache_opts(&self, provider: &str, session_id: &str, agent: Option<&str>, header: &Header) -> Option<Value>;

    /// The tool surface, rules variant and deferred-tool fields a new route rebuilds
    /// (`_prepareResumeTools`, `applyAgentToolExposure`, `_refreshSessionRuleVariantsForModel`).
    /// Synchronous and pure, over the skill list [`RouteFacts::surface_lookup`] collected before the
    /// change ran. Nothing by default (facts that rebuild no surface).
    fn surface_change(&self, _header: &Header, _previous: &Route, _lookup: &SurfaceLookup) -> HeaderChange {
        HeaderChange { set: Map::new(), unset: Vec::new() }
    }

    /// Whether `lookup` was collected for the facts `header` and `previous` state now: Node reads the skill list
    /// of the live session's folder inside the call, so a listing for another folder is never used. Always, by
    /// default (facts that collect nothing).
    fn surface_current(&self, _header: &Header, _previous: &Route, _lookup: &SurfaceLookup) -> bool {
        true
    }

    /// The skill list the surface is resolved from, collected now (Node collects it inside the call):
    /// the working folder it was collected for, and the listing or why there is none. Nothing by
    /// default.
    async fn surface_lookup(&self, _header: &Header, _previous: &Route) -> SurfaceLookup {
        None
    }
}

/// What [`RouteFacts::surface_lookup`] collected: the working folder and its skill listing.
pub type SurfaceLookup = Option<(std::path::PathBuf, Result<bool, String>)>;

/// `providerCacheKey(provider)`.
pub fn provider_cache_key(provider: &str) -> String {
    if provider.is_empty() {
        return "mixdog-default".to_owned();
    }
    let alias = match provider {
        "openai-oauth" => "codex",
        "anthropic-oauth" => "claude",
        "cursor-oauth" | "cursor-api" => "cursor",
        other => other,
    };
    format!("mixdog-{alias}")
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

fn text(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or_default()
}

fn set(change: &mut HeaderChange, key: &str, value: Value) {
    change.unset.retain(|k| k != key);
    change.set.insert(key.to_owned(), value);
}

fn unset(change: &mut HeaderChange, key: &str) {
    change.set.shift_remove(key);
    if !change.unset.iter().any(|k| k == key) {
        change.unset.push(key.to_owned());
    }
}

fn merge(into: &mut HeaderChange, other: HeaderChange) {
    for (key, value) in other.set {
        set(into, &key, value);
    }
    for key in other.unset {
        unset(into, &key);
    }
}

/// The route change of the session's route adapter and the fallback hop.
pub struct RunHostRouteChange {
    facts: Arc<dyn RouteFacts>,
    clock: Arc<dyn Clock>,
}

impl RunHostRouteChange {
    pub fn new(facts: Arc<dyn RouteFacts>, clock: Arc<dyn Clock>) -> Self {
        Self { facts, clock }
    }

    /// `applyRouteContextWindow`: always derived anew from the model; never seeded with the old
    /// route's persisted boundary.
    fn context_window(&self, header: &Header, route: &Route, route_changed: bool, change: &mut HeaderChange) {
        let (provider, model) = (text(header.get("provider")), text(header.get("model")));
        let seed = if !route_changed {
            Value::Object(header.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        } else if route.contains_key("selectedContextWindow") {
            let selected = header.get("selectedContextWindow").filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
            json!({ "selectedContextWindow": selected })
        } else {
            json!({})
        };
        let meta = (!provider.is_empty() && !model.is_empty()).then(|| self.facts.context_meta(provider, model, &seed)).flatten();
        let Some(meta) = meta else {
            for key in ["contextWindow", "rawContextWindow", "effectiveContextWindowPercent", "autoCompactTokenLimit", "compactBoundaryTokens"] {
                unset(change, key);
            }
            return;
        };
        set(change, "contextWindow", meta.context_window.clone());
        set(change, "rawContextWindow", meta.raw_context_window.clone());
        set(change, "effectiveContextWindowPercent", meta.effective_context_window_percent.clone());
        set(change, "autoCompactTokenLimit", meta.auto_compact_token_limit.clone());
        set(change, "compactBoundaryTokens", meta.compact_boundary_tokens.clone());
        let mut compaction = header.get("compaction").and_then(Value::as_object).cloned().unwrap_or_default();
        compaction.insert("boundaryTokens".into(), meta.compact_boundary_tokens);
        compaction.insert("contextWindow".into(), meta.context_window);
        compaction.insert("rawContextWindow".into(), meta.raw_context_window);
        compaction.insert("effectiveContextWindowPercent".into(), meta.effective_context_window_percent);
        compaction.insert("autoCompactTokenLimit".into(), meta.auto_compact_token_limit);
        set(change, "compaction", Value::Object(compaction));
    }

    /// `resetSessionForRouteChange`: a new provider/model starts a fresh cache chain, usage baseline
    /// and tool surface.
    fn reset(&self, header: &Header, previous: &Route, lookup: &SurfaceLookup, change: &mut HeaderChange) {
        let provider = text(header.get("provider"));
        set(change, "promptCacheKey", json!(provider_cache_key(provider)));
        let agent = header.get("agent").and_then(Value::as_str).filter(|a| !a.is_empty());
        let opts = self.facts.cache_opts(provider, text(header.get("id")), agent, header);
        set(change, "providerCacheOpts", opts.unwrap_or(Value::Null));
        set(change, "providerCacheOptsOverride", json!(false));
        // A thread's first route is its creation: Node builds that record with the route (`buildSessionRecord`) and
        // calls no `resetSessionForRouteChange`, so a record that never ran a request carries no reading at all. The
        // previous route's readings are reset only when there was a previous route.
        if previous.contains_key("model") {
            for key in ["lastInputTokens", "lastOutputTokens", "lastCachedReadTokens", "lastCacheWriteTokens", "lastContextTokens"] {
                set(change, key, json!(0));
            }
            set(change, "lastContextTokensUpdatedAt", json!(self.clock.now_ms()));
            set(change, "lastContextTokensStaleAfterCompact", json!(false));
        }
        unset(change, "providerState");
        // The previous route's prefix snapshot measured another prompt; the new chain baselines on
        // its first send.
        unset(change, "_providerPrefixGuardState");
        // The new route resolves its own wire before its first request.
        set(change, "wireRoute", Value::Null);
        merge(change, self.facts.surface_change(header, previous, lookup));
    }

    /// `invalidateContextUsageSnapshot` and `invalidateProviderContextBaseline` (WP-COMPACT's
    /// patches): the next turn re-measures against the new model's window.
    fn invalidate(change: &mut HeaderChange) {
        for patch in [invalidate_context_usage_snapshot(), invalidate_provider_context_baseline()] {
            for (key, value) in patch.set {
                set(change, &key, value);
            }
            for key in patch.unset {
                unset(change, &key);
            }
        }
    }}

#[async_trait::async_trait]
impl RouteChange for RunHostRouteChange {
    /// A cleared conversation's environment reset (Node's resetSessionBp3Environment), as the header
    /// change the clear writes in its own patch.
    fn environment_reset(&self, header: &Header) -> HeaderChange {
        let blocks = mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(header);
        crate::run_host::prompt_session::reset_environment(header, &blocks).change
    }

    async fn lookups(&self, header: &Header, route: &Route) -> RouteLookups {
        let mut previous = Route::new();
        for key in ["provider", "model"] {
            if let Some(value) = header.get(key) {
                previous.insert(key.to_owned(), value.clone());
            }
        }
        let lookup: SurfaceLookup = if route_changed(route, &previous) { self.facts.surface_lookup(header, &previous).await } else { None };
        Box::new(lookup)
    }

    fn lookups_hold(&self, header: &Header, route: &Route, lookups: &RouteLookups) -> bool {
        let mut previous = Route::new();
        for key in ["provider", "model"] {
            if let Some(value) = header.get(key) {
                previous.insert(key.to_owned(), value.clone());
            }
        }
        if !route_changed(route, &previous) {
            return true;
        }
        let none: SurfaceLookup = None;
        self.facts.surface_current(header, &previous, lookups.downcast_ref::<SurfaceLookup>().unwrap_or(&none))
    }

    fn route_change(&self, header: &Header, route: &Route, previous: &Route, cross_provider: bool, lookups: &RouteLookups) -> HeaderChange {
        let none: SurfaceLookup = None;
        let lookup = lookups.downcast_ref::<SurfaceLookup>().unwrap_or(&none);
        let route_changed = route_changed(route, previous);
        let mut change = HeaderChange { set: Map::new(), unset: Vec::new() };
        self.context_window(header, route, route_changed, &mut change);
        if route_changed {
            self.reset(header, previous, lookup, &mut change);
            if cross_provider {
                Self::invalidate(&mut change);
            }
        }
        // A staged re-root and the # Session block, rewritten in the same patch (WP-PROMPT).
        let blocks = mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(header);
        merge(&mut change, crate::run_host::prompt_session::route_prompt(header, &blocks, route_changed).change);
        change
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::Role;

    use super::*;

    struct Facts;
    #[async_trait::async_trait]
    impl RouteFacts for Facts {
        fn context_meta(&self, _: &str, _: &str, _: &Value) -> Option<ContextMeta> {
            None
        }
        fn cache_opts(&self, provider: &str, _: &str, _: Option<&str>, _: &Header) -> Option<Value> {
            (provider == "anthropic").then(|| json!({ "cacheStrategy": { "tools": "none", "system": "1h", "tier3": "1h", "messages": "1h" } }))
        }
    }

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_793_939_969_114
        }
    }

    fn session() -> Value {
        json!({
            "id": "sess_rc", "provider": "openai", "model": "gpt-5", "agent": "lead",
            "promptCacheKey": "mixdog-openai", "providerCacheOptsOverride": true,
            "lastInputTokens": 9, "lastOutputTokens": 8, "lastCachedReadTokens": 7, "lastCacheWriteTokens": 6,
            "lastContextTokens": 5, "lastContextTokensStaleAfterCompact": true,
            "providerState": { "x": 1 }, "_providerPrefixGuardState": { "y": 1 }, "wireRoute": { "wire": "responses" },
            "contextUsageSnapshot": { "a": 1 },
            "contextPressureBaselineTokens": 10, "contextPressureBaselineOutputTokens": 3, "contextPressureBaselineProvider": "openai",
            "contextPressureBaselineUpdatedAt": 11, "contextPressureBaselineSource": "usage",
            "contextPressureUnanchoredAfterRestart": true, "contextPressureUnanchoredReason": "restart",
            "contextWindow": 272000, "rawContextWindow": 272000, "compaction": { "keep": true, "boundaryTokens": 1 },
        })
    }

    /// Node's `updateSessionRoute` on four route changes of one session: the fields the golden names,
    /// after the route's own fields and this change are applied to the stored header.
    #[tokio::test]
    async fn a_route_change_leaves_the_header_as_node_does() {
        let golden: Value = serde_json::from_str(include_str!("golden/route_change.json")).expect("fixture");
        let cases: [(&str, Value, bool); 4] = [
            ("same_model_tune", json!({ "fast": true }), false),
            ("other_provider_cross", json!({ "provider": "anthropic", "model": "claude-sonnet-4" }), true),
            ("other_provider_plain", json!({ "provider": "anthropic", "model": "claude-sonnet-4" }), false),
            ("same_provider_model", json!({ "model": "gpt-5-mini" }), true),
        ];
        let change = RunHostRouteChange::new(Arc::new(Facts), Arc::new(Fixed));
        for (name, route, cross) in cases {
            let route: Route = route.as_object().unwrap().clone();
            let before: Header = session().as_object().unwrap().clone().into_iter().collect();
            let previous: Route = [("provider", "openai"), ("model", "gpt-5")].iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect();
            // The header the adapter hands over already carries the route's own fields.
            let mut header = before.clone();
            for (key, value) in &route {
                header.insert(key.clone(), value.clone());
            }
            let lookups = change.lookups(&before, &route).await;
            let result = change.route_change(&header, &route, &previous, cross, &lookups);
            for key in &result.unset {
                header.shift_remove(key);
            }
            for (key, value) in &result.set {
                header.insert(key.clone(), value.clone());
            }
            let want = &golden[name];
            for (field, expected) in want["fields"].as_object().unwrap() {
                let got = header.get(field).cloned().unwrap_or_else(|| json!("__deleted__"));
                // The route's own `fast` and the windows come from other layers or the registry.
                if expected == "__deleted__" && header.get(field).is_none() || &got == expected {
                    continue;
                }
                panic!("{name}: {field}: got {got}, node {expected}");
            }
            assert_eq!(want["updatedAtIsNumber"].as_bool().unwrap(), result.set.get("lastContextTokensUpdatedAt").is_some_and(Value::is_number), "{name}");
        }
        let _ = Role::User;
    }

    /// The clear of a conversation takes its environment reset from the route change the host
    /// wires: it is the prompt module's reset, as one header change.
    #[test]
    fn the_environment_reset_is_the_prompt_modules_reset_as_one_header_change() {
        let header: Header = json!({
            "providerState": { "x": 1 }, "bp3EnvSplit": true,
            "promptEnv": "# Session\nold\n\ntail", "bp3EnvironmentContext": "tail", "sessionStartMetaInjected": true,
        })
        .as_object()
        .unwrap()
        .clone()
        .into_iter()
        .collect();
        let change = RunHostRouteChange::new(Arc::new(Facts), Arc::new(Fixed));
        let reset = change.environment_reset(&header);
        let expected = crate::run_host::prompt_session::reset_environment(&header, &mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(&header)).change;
        assert_eq!(reset.set, expected.set);
        assert_eq!(reset.unset, expected.unset);
        assert_eq!(reset.set.get("promptEnv"), Some(&json!("tail")));
        assert_eq!(reset.set.get("sessionStartMetaInjected"), Some(&json!(false)));
    }

    /// A thread's first route (no previous model) leaves no usage reading behind: Node's `buildSessionRecord` stores none, so
    /// a cancelled first turn's header has none (`stored-header` of the `cancel` scenario).
    #[tokio::test]
    async fn the_first_route_of_a_thread_writes_no_usage_reading() {
        let change = RunHostRouteChange::new(Arc::new(Facts), Arc::new(Fixed));
        let route: Route = [("provider", "openai"), ("model", "gpt-5")].iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect();
        let header: Header = json!({ "id": "sess_new", "provider": "openai", "model": "gpt-5" }).as_object().unwrap().clone().into_iter().collect();
        let lookups = change.lookups(&header, &route).await;
        let result = change.route_change(&header, &route, &Route::new(), false, &lookups);
        for key in ["lastInputTokens", "lastOutputTokens", "lastCachedReadTokens", "lastCacheWriteTokens", "lastContextTokens", "lastContextTokensUpdatedAt", "lastContextTokensStaleAfterCompact"] {
            assert!(!result.set.contains_key(key), "{key}");
        }
    }

    #[test]
    fn the_cache_key_names_the_provider_family() {
        assert_eq!(provider_cache_key("openai-oauth"), "mixdog-codex");
        assert_eq!(provider_cache_key("anthropic-oauth"), "mixdog-claude");
        assert_eq!(provider_cache_key("cursor-api"), "mixdog-cursor");
        assert_eq!(provider_cache_key("groq"), "mixdog-groq");
        assert_eq!(provider_cache_key(""), "mixdog-default");
    }
}
