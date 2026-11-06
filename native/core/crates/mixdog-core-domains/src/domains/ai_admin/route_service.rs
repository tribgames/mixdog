//! `route/set` and `fast/set`: the adoption half of `setRoute` (model-route/set-route.mjs) and
//! `setFast` / `setEffort` (model-route/route-tuning.mjs). A selection is resolved and validated,
//! its model settings and (on an explicit main-model choice) the Lead route are saved through
//! `Config::save_agent_config`, and the live route is replaced; what the adopted route does to
//! the thread's session is [`SessionFollow`] (`SessionRoutes::follow` / `tune`, WP-SESSION's).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::service::admin_route::{
    Obj, clean, find_preset, jnum, model_meta_looks_resolved, normalize_workflow_route, persist_adopted_model_settings, resolve_route,
    resolve_route_context_state, save_model_settings, selection_fast_capable, truthy, validate_requested_model_selector,
    workflow_preset_id,
};
use mixdog_ai::effort::normalize_effort_input;
use mixdog_ai::service::routes::{route_chain, validate_route_chain_providers};
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::chain::{RouteFacts, resolve_chain_entry};
use mixdog_core_config::config::Config;
use mixdog_core_ports::ports::route::FollowOptions;
use mixdog_core_ports::ports::route::Followed;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route::SessionRoutes;
use mixdog_core_ports::ports::route_write::RouteWriter;

/// The session half of a route change.
#[async_trait]
pub trait SessionFollow: Send + Sync {
    /// The generation an addressed selection is opened under (its origin, else now).
    fn open_lease(&self, thread: &ThreadId, origin: Option<u64>) -> u64;
    async fn follow(&self, thread: &ThreadId, options: &FollowOptions) -> Result<Followed, PortError>;
    async fn tune(&self, thread: &ThreadId) -> Result<(), PortError>;
    /// `continueSessionInModel`'s switch of the conversation in place.
    async fn switch_now(&self, thread: &ThreadId) -> Result<Option<Value>, PortError>;
}

#[async_trait]
impl SessionFollow for SessionRoutes {
    fn open_lease(&self, thread: &ThreadId, origin: Option<u64>) -> u64 {
        SessionRoutes::open_lease(self, thread, origin)
    }

    async fn follow(&self, thread: &ThreadId, options: &FollowOptions) -> Result<Followed, PortError> {
        SessionRoutes::follow(self, thread, options).await
    }

    async fn tune(&self, thread: &ThreadId) -> Result<(), PortError> {
        SessionRoutes::tune(self, thread).await
    }

    async fn switch_now(&self, thread: &ThreadId) -> Result<Option<Value>, PortError> {
        SessionRoutes::switch_now(self, thread).await
    }
}

/// The options of `setRoute(next, options)`.
#[derive(Clone, Default, Debug)]
pub struct SetRouteOptions {
    /// `keepMainModel`: `Some(false)` is an explicit main-model choice (the Lead editor, the
    /// setup tool); every other selection keeps the main model.
    pub keep_main_model: Option<bool>,
    /// A conditional fill: never replaces a route that already has a model.
    pub only_if_empty: bool,
    /// An agent child's route belongs to that session alone: nothing is saved.
    pub session_only: bool,
    /// Rejects an unacceptable selection without applying it.
    pub validate_only: bool,
    /// What the session does with the adopted route.
    pub follow: FollowOptions,
}

/// `setFast(value)`: `true`/`false`, or `'ultrafast'`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FastValue {
    Off,
    On,
    Ultrafast,
}

fn text(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn port(e: PortError) -> String {
    match e {
        PortError::Failed { message, .. } | PortError::Unavailable { message, .. } | PortError::Refused { message, .. } => message,
        PortError::NotFound { message, .. } => message,
        PortError::Invalid { reason, .. } => reason,
        PortError::Denied(message) => message,
        PortError::Cancelled => "cancelled".into(),
    }
}

fn same_model(a: &Obj, b: &Obj) -> bool {
    clean(a.get("provider")) == clean(b.get("provider")) && clean(a.get("model")) == clean(b.get("model"))
}

pub struct RouteService {
    pub config: Config,
    pub facts: Arc<dyn RouteFacts>,
    pub writer: Arc<dyn RouteWriter>,
    pub session: Arc<dyn SessionFollow>,
}

impl RouteService {
    fn resolve(&self, config: &Obj, request: &Obj) -> Result<Obj, String> {
        resolve_route(config, request, &|p, c| self.facts.is_known(p, c))
    }

    /// A lease holds while the session generation it was opened under stands (an unaddressed
    /// selection holds none).
    fn lease_holds(&self, thread: &ThreadId, lease: Option<u64>) -> bool {
        lease.is_none_or(|token| self.writer.generation(thread) == token)
    }

    /// `completeRequest`: the request, completed from the live route where the caller left gaps.
    fn complete_request(&self, config: &Obj, live: &Route, next: &Obj) -> Result<Obj, String> {
        let mut requested = next.clone();
        validate_requested_model_selector(config, &requested)?;
        if !requested.contains_key("effort") && !truthy(requested.get("provider")) && !truthy(requested.get("model")) && live.contains_key("effort") {
            requested.insert("effort".into(), live["effort"].clone());
        }
        if !truthy(requested.get("provider")) && truthy(requested.get("model")) && find_preset(config, requested.get("model")).is_none() {
            requested.insert("provider".into(), live.get("provider").cloned().unwrap_or(Value::Null));
        }
        Ok(requested)
    }

    /// `resolveSelectedRoute`: the route a selection resolves to, clamped against the model row.
    async fn resolve_selected_route(&self, thread: &ThreadId, next: &Obj) -> Result<(Obj, bool, Value), String> {
        let config = self.config.agent();
        let provider_explicit = !clean(next.get("provider")).is_empty();
        let selected = self.resolve(&config, &self.complete_request(&config, &self.writer.route(thread), next)?)?;
        let provider = clean(selected.get("provider"));
        let model = clean(selected.get("model"));
        self.facts.ensure_ready(&config, &provider).await?;
        let meta = self.facts.model_meta(&provider, &model);
        if !provider_explicit && !truthy(selected.get("preset")) && !model_meta_looks_resolved(Some(&meta)) && !self.facts.catalog_knows(&model, &provider) {
            return Err(format!("unknown model: {provider}/{model}"));
        }
        let fast_capable = selection_fast_capable(Some(&meta), || {
            let params = selected.get("modelParameters").cloned().unwrap_or(Value::Null);
            self.facts.fast_capable(&provider, &meta, selected.get("effort").and_then(Value::as_str), &params)
        });
        let window = self.facts.window_meta(&provider, &model, &meta);
        let state = resolve_route_context_state(&selected, window.as_ref());
        // An exact selection is saved clamped, and not at all when it is the default window; an
        // unknown window keeps it as requested.
        let tokens: Option<Value> = if state.context_default_percent.is_none() {
            selected.get("contextTokens").cloned()
        } else {
            state.context_tokens.map(jnum)
        };
        let requested_tokens = selected.get("contextTokens").cloned();
        let mut fields = selected;
        fields.shift_remove("contextTokens");
        // Tokens that land on the default window select the default, whatever percent travelled
        // with them.
        let at_default = truthy(requested_tokens.as_ref()) && !truthy(tokens.as_ref()) && state.context_default_percent.is_some();
        if at_default {
            fields.insert("contextPercent".into(), state.context_default_percent.map(jnum).unwrap_or(Value::Null));
        }
        let fast = fast_capable && fields.get("fast") == Some(&Value::Bool(true));
        fields.insert("fast".into(), Value::Bool(fast));
        // Lets the saved model settings tell a chosen window from the default.
        if let Some(percent) = state.context_default_percent {
            fields.insert("contextDefaultPercent".into(), jnum(percent));
        }
        if let Some(tokens) = tokens.filter(|t| truthy(Some(t))) {
            fields.insert("contextTokens".into(), tokens);
        }
        Ok((fields, fast_capable, meta))
    }

    /// `leadFallbackChain`: the Lead's fallback models after this selection, checked like an
    /// agent's chain. An explicit list replaces the stored one (`[]` clears it); a selection
    /// without one keeps it as stored.
    async fn lead_fallback_chain(&self, next: &Obj, primary: &Obj) -> Result<Vec<Value>, String> {
        let config = self.config.agent();
        let stored_preset = find_preset(&config, Some(&Value::from(workflow_preset_id("lead")))).cloned();
        let explicit = next.contains_key("fallbacks");
        let requested = if explicit { next.get("fallbacks").cloned() } else { stored_preset.as_ref().and_then(|p| p.get("fallbacks")).cloned() };
        let Some(requested) = requested.filter(|r| r.as_array().is_some_and(|a| !a.is_empty())) else { return Ok(Vec::new()) };
        let head = |fallbacks: Value| json!({ "provider": primary.get("provider"), "model": primary.get("model"), "fallbacks": fallbacks });
        let fallbacks_of = |route: Option<Value>| route.and_then(|r| r.get("fallbacks").and_then(Value::as_array).cloned()).unwrap_or_default();
        let none = Value::Object(Obj::new());
        if !explicit {
            return Ok(fallbacks_of(normalize_workflow_route(&head(requested), &none, false)?));
        }
        let chain = route_chain(&head(requested))?;
        validate_route_chain_providers(&chain, false)?;
        let stored_chain = route_chain(stored_preset.as_ref().unwrap_or(&none))?;
        // Each entry goes through the agents' normalizer (fast clamp, context window).
        let mut resolved = Vec::new();
        for entry in chain.iter().skip(1) {
            let previous = stored_chain
                .iter()
                .find(|c| c.get("provider") == entry.get("provider") && c.get("model") == entry.get("model"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let entry = entry.as_object().cloned().unwrap_or_default();
            resolved.push(Value::Object(resolve_chain_entry(self.facts.as_ref(), &self.config.agent(), &entry, &previous).await?));
        }
        Ok(fallbacks_of(normalize_workflow_route(&head(Value::Array(resolved)), &none, false)?))
    }

    /// `syncEmptyMainRoute`: a Main route with no model takes the Lead route a reload brought in.
    fn sync_empty_main_route(&self, thread: &ThreadId) -> Result<(), String> {
        if !clean(self.writer.route(thread).get("model")).is_empty() {
            return Ok(());
        }
        let resolved = self.resolve(&self.config.agent(), &Obj::new())?;
        if !clean(resolved.get("model")).is_empty() {
            self.writer.set_route_state(thread, resolved);
        }
        Ok(())
    }

    /// `adoptFillWinner`: after a conditional Lead fill of `filled`, adopt the Lead route the file
    /// holds instead when it differs. A route the user has moved off `filled` stays.
    fn adopt_fill_winner(&self, thread: &ThreadId, filled: &Obj) -> Result<bool, String> {
        if !same_model(&self.writer.route(thread), filled) {
            return Ok(false);
        }
        let winner = self.resolve(&self.config.agent(), &Obj::new())?;
        if clean(winner.get("model")).is_empty() || same_model(&winner, filled) {
            return Ok(false);
        }
        self.writer.set_route_state(thread, winner);
        Ok(true)
    }

    /// `adoptRoute`: validate, persist and adopt the requested route as the live route. `false`
    /// when the selection no longer owns the route (its lease moved, or a conditional fill found
    /// a model already there).
    async fn adopt_route(&self, thread: &ThreadId, next: &Obj, options: &SetRouteOptions, lease: Option<u64>) -> Result<bool, String> {
        let (selected, fast_capable, meta) = self.resolve_selected_route(thread, next).await?;
        // The Lead's fallback chain travels with an explicit main-model choice only; a session's
        // own pick never touches it.
        let mut persisted = selected.clone();
        if options.keep_main_model == Some(false) && !options.session_only {
            persisted.insert("fallbacks".into(), Value::Array(self.lead_fallback_chain(next, &selected).await?));
        }
        if !self.lease_holds(thread, lease) {
            return Ok(false);
        }
        // A conditional fill never replaces a route that already has a model. A Lead route
        // another process persisted may not have reached this runtime yet: the config is re-read
        // here, which adopts it into an empty route, and that route is the winner.
        let has_model = |this: &Self| !clean(this.writer.route(thread).get("model")).is_empty();
        if options.only_if_empty {
            if has_model(self) {
                return Ok(false);
            }
            self.config.reload_full_config().await.map_err(text)?;
            self.sync_empty_main_route(thread)?;
            if has_model(self) {
                return Ok(false);
            }
        }
        // The Lead route a conditional fill wrote, until the file confirms it.
        let mut filled: Option<Obj> = None;
        let route = if options.session_only {
            // The shared modelSettings bucket and the main model are never written.
            self.resolve(&self.config.agent(), &selected)?
        } else {
            let before = self.config.agent();
            let mut after = before.clone();
            save_model_settings(&mut after, &selected, fast_capable);
            let live = self.writer.route(thread);
            let lead = persist_adopted_model_settings(&mut after, &live, &persisted, Some(options.keep_main_model != Some(false)), &|p, c| self.facts.is_known(p, c))?;
            self.config.save_agent_config(&before, &after, options.only_if_empty && lead.is_some()).await.map_err(text)?;
            filled = lead.as_ref().and_then(Value::as_object).cloned();
            // Resolved against the config as adopted: a fill the file skipped is confirmed below.
            let request = if lead.is_some() { json!({ "model": workflow_preset_id("lead") }) } else { Value::Object(selected.clone()) };
            self.resolve(&after, request.as_object().expect("a request is an object"))?
        };
        if !self.lease_holds(thread, lease) || (options.only_if_empty && has_model(self)) {
            return Ok(false);
        }
        self.writer.set_route_state(thread, route);
        // A conditional fill reaches the file only while no Lead route is stored there. When
        // another process wrote one after the re-read above, the file's route replaces the fill.
        let mut replaced = false;
        if let Some(filled) = &filled
            && self.config.confirm_lead_fill(&Value::Object(filled.clone())).await.map_err(text)?.is_some()
        {
            replaced = self.adopt_fill_winner(thread, filled)?;
        }
        // The refresh completes against the route just adopted and only while the selection still owns it.
        self.writer.refresh_route_effort(thread, (!replaced).then_some(meta), true, lease).await.map_err(port)?;
        if !self.lease_holds(thread, lease) {
            return Ok(false);
        }
        self.writer.refresh_statusline_usage(thread, &self.writer.route(thread));
        Ok(true)
    }

    /// `setRoute(next, options)`: the live route after the selection (`{ ...route, modelSwitch }`
    /// when the conversation was switched in place).
    pub async fn set_route(&self, thread: &ThreadId, next: &Obj, options: &SetRouteOptions) -> Result<Value, String> {
        let live = || Value::Object(self.writer.route(thread));
        if options.validate_only {
            self.resolve_selected_route(thread, next).await?;
            return Ok(live());
        }
        // A selection addressed to a conversation belongs to the generation it was enqueued
        // under; once that has moved, every route or session effect is skipped.
        let addressed = options.follow.apply_to_current_session || options.follow.switch_established || options.follow.defer_until_next_turn;
        let lease = addressed.then(|| self.session.open_lease(thread, options.follow.lease));
        if !self.adopt_route(thread, next, options, lease).await? {
            return Ok(live());
        }
        let follow = FollowOptions { lease, ..options.follow.clone() };
        let followed = self.session.follow(thread, &follow).await.map_err(port)?;
        Ok(match followed.model_switch {
            Some(boundary) => {
                let mut route = self.writer.route(thread);
                route.insert("modelSwitch".into(), boundary);
                Value::Object(route)
            }
            None => live(),
        })
    }

    /// `continueSessionInModel(sessionId, next)`: the quota escape hatch. The selection is adopted
    /// as the live route and the addressed, established conversation switches onto it in place.
    /// `{ modelSwitch }` with the recorded boundary, else `true` (nothing switched, or the
    /// session moved on while the selection resolved).
    pub async fn continue_session_in_model(&self, thread: &ThreadId, session_id: &str, next: &Obj) -> Result<Value, String> {
        if session_id.is_empty() || session_id != thread.as_str() {
            return Err(format!("session {session_id} is not the active session"));
        }
        let lease = Some(self.session.open_lease(thread, None));
        if !self.adopt_route(thread, next, &SetRouteOptions::default(), lease).await? || !self.lease_holds(thread, lease) {
            return Ok(Value::Bool(true));
        }
        Ok(match self.session.switch_now(thread).await.map_err(port)? {
            Some(boundary) => json!({ "modelSwitch": boundary }),
            None => Value::Bool(true),
        })
    }

    /// `commitRouteTuning`: saves the live route's model settings (a Main-model rewrite only when
    /// the live model is Main), refreshes the effort and tunes the session.
    async fn commit_route_tuning(&self, thread: &ThreadId, fast_capable: bool, meta: Value, session_only: bool) -> Result<(), String> {
        if !session_only {
            let before = self.config.agent();
            let mut after = before.clone();
            let live = self.writer.route(thread);
            save_model_settings(&mut after, &live, fast_capable);
            let lead = persist_adopted_model_settings(&mut after, &live, &live, None, &|p, c| self.facts.is_known(p, c))?;
            self.config.save_agent_config(&before, &after, false).await.map_err(text)?;
            if lead.is_some() {
                let route = self.resolve(&after, &json!({ "model": workflow_preset_id("lead") }).as_object().cloned().unwrap_or_default())?;
                self.writer.set_route_state(thread, route);
            }
        }
        self.writer.refresh_route_effort(thread, Some(meta), false, None).await.map_err(port)?;
        self.session.tune(thread).await.map_err(port)
    }

    /// `setFast(value)`: whether Fast is on afterwards.
    pub async fn set_fast(&self, thread: &ThreadId, value: FastValue) -> Result<bool, String> {
        let route = self.writer.route(thread);
        let (provider, model) = (clean(route.get("provider")), clean(route.get("model")));
        let ultra = value == FastValue::Ultrafast;
        let enabled = value != FastValue::Off;
        let meta = self.facts.model_meta(&provider, &model);
        let route = self.writer.route(thread);
        if ultra && !self.facts.ultrafast_capable(&provider, &meta) {
            return Err(format!("ultrafast is not available for {provider}/{model}"));
        }
        let mut other = route.get("modelParameters").filter(|p| truthy(Some(p))).and_then(Value::as_object).cloned().unwrap_or_default();
        let previous_tier = other.shift_remove("serviceTier");
        let mut parameters = route.get("modelParameters").cloned().unwrap_or(Value::Null);
        if ultra {
            other.insert("serviceTier".into(), Value::from("ultrafast"));
            parameters = Value::Object(other);
        } else if previous_tier.as_ref().and_then(Value::as_str) == Some("ultrafast") {
            parameters = Value::Object(other);
        }
        let effort = if truthy(route.get("effectiveEffort")) { route.get("effectiveEffort") } else { route.get("effort") };
        let effort = effort.and_then(Value::as_str).map(str::to_owned);
        let current_params = route.get("modelParameters").cloned().unwrap_or(Value::Null);
        let fast_capable = selection_fast_capable(Some(&meta), || self.facts.fast_capable(&provider, &meta, effort.as_deref(), &current_params));
        if enabled && !fast_capable {
            return Err(format!("fast mode is not available for {provider}/{model}"));
        }
        let request = json!({
            "provider": route.get("provider"), "model": route.get("model"), "effort": route.get("effort"),
            "fast": fast_capable && enabled, "modelParameters": parameters,
        });
        let resolved = self.resolve(&self.config.agent(), request.as_object().expect("a request is an object"))?;
        self.writer.set_route_state(thread, resolved);
        self.commit_route_tuning(thread, fast_capable, meta, false).await?;
        Ok(self.writer.route(thread).get("fast") == Some(&Value::Bool(true)))
    }

    /// `toggleFast()`.
    pub async fn toggle_fast(&self, thread: &ThreadId) -> Result<bool, String> {
        let on = self.writer.route(thread).get("fast") == Some(&Value::Bool(true));
        self.set_fast(thread, if on { FastValue::Off } else { FastValue::On }).await
    }

    /// `setEffort(value, { sessionOnly })`: the live route afterwards.
    pub async fn set_effort(&self, thread: &ThreadId, value: &Value, session_only: bool) -> Result<Value, String> {
        let normalized = normalize_effort_input(Some(value))?;
        // An explicit level is the user's choice for this route: Auto effort would replace it on
        // the next turn, so the pick turns the route's Auto off.
        let mut route = self.writer.route(thread);
        route.insert("effort".into(), normalized.clone().map_or(Value::Null, Value::from));
        if normalized.is_some() {
            route.insert("autoEffort".into(), Value::Bool(false));
        }
        self.writer.set_route_state(thread, route);
        let route = self.writer.route(thread);
        let (provider, model) = (clean(route.get("provider")), clean(route.get("model")));
        let meta = self.facts.model_meta(&provider, &model);
        let params = route.get("modelParameters").cloned().unwrap_or(Value::Null);
        let fast_capable = selection_fast_capable(Some(&meta), || self.facts.fast_capable(&provider, &meta, normalized.as_deref(), &params));
        self.commit_route_tuning(thread, fast_capable, meta, session_only).await?;
        Ok(Value::Object(self.writer.route(thread)))
    }
}
