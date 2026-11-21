//! The first-run onboarding wizard: four steps, each ROOT screen carrying a confirm bar (Back and Next, Finish on the last step).
//!
//! 1. provider auth: the provider setup picker with the wizard's title and a Next button ([`open_auth_step`]);
//! 2. models: one row per routing slot (Main, Web Search, each agent), Enter opening that slot's model picker
//!    ([`open_models_step`], [`open_role_model_picker`]);
//! 3. theme and 4. output style: the settings pickers, opened with `{ "onboarding": ... }` and answering through
//!    [`theme_advance`], [`theme_back`], [`output_style_advance`] and [`output_style_back`].
//!
//! Esc or cancel anywhere is a confirmed skip ([`onboarding_cancel`]): onboarding is marked complete with routes, agents and
//! provider untouched, so it does not reopen next launch (`mixdog --onboarding` still reopens it, [`start_onboarding`]).

use mixdog_tui_style::Key;
use mixdog_tui_style::theme::theme_color;
use mixdog_tui_widgets::confirm_bar::ConfirmButton;
use mixdog_tui_widgets::picker::{IndexMode, MetaPart, PickerItem};
use serde_json::{Map, Value, json};

use super::format::{is_web_search_default_route, web_search_default_route};
use super::panel::{ConfirmBar, PanelOwner, PanelRow, ProviderPanel, RowKind};
use super::setup::{ConfirmBarSpec, SetupOptions, open_provider_setup};
use super::{Callback, ProviderHost};
use crate::slash::host::{Opener, PromptSurface, Tone};
use crate::slash::notices::{truthy, value_text};
use crate::surface::{SurfaceClaim, SurfaceKind};

/// One agent of the roster Step 2 lists (`agentRosterEntry`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentEntry {
    pub id: String,
    pub label: String,
    pub description: String,
}

/// The wizard state (`onboardingRef.current`, the launch latch of `useOnboardingStart`, the claim and panel of the step on
/// screen).
#[derive(Clone, Debug, Default)]
pub struct OnboardingState {
    pub provider_models: Vec<Value>,
    pub agents: Vec<AgentEntry>,
    pub default_route: Option<Value>,
    pub web_search_route: Option<Value>,
    /// The explicit per-agent routes; an agent without one follows the Main Model at run time.
    pub agent_routes: Map<String, Value>,
    /// `onboardingPrefetchSeqRef`: bumped when the provider models are invalidated, so a stale prefetch is dropped.
    prefetch_seq: u64,
    /// The wizard was launched on this mount (`onboardingStartedRef`).
    started: bool,
    claim: Option<SurfaceClaim>,
    panel: Option<ProviderPanel>,
}

impl OnboardingState {
    /// A provider-scope cache clear (`clearModelCaches('all' | 'provider')`): the loaded models are dropped and a prefetch in
    /// flight is stale.
    pub fn invalidate_provider_models(&mut self) {
        self.provider_models.clear();
        self.prefetch_seq += 1;
    }

    fn has_provider_models(&self) -> bool {
        !self.provider_models.is_empty()
    }

    fn has_agents(&self) -> bool {
        !self.agents.is_empty()
    }
}

/// `resolveOnboardingCompleted(store, onboardingCompleted)`: the verdict the launcher resolved before mount when it has one;
/// else what `probe` reads from the store (`None` for a store without the status call). Anything unresolvable counts as
/// completed, so a transport hiccup cannot bring a dismissed wizard back.
pub fn resolve_onboarding_completed(verdict: Option<bool>, probe: impl FnOnce() -> Option<Result<Value, String>>) -> bool {
    if let Some(verdict) = verdict {
        return verdict;
    }
    match probe() {
        Some(Ok(status)) if status.is_object() => status.get("completed") == Some(&Value::Bool(true)),
        _ => true,
    }
}

/// `useOnboardingStart`: whether the wizard launches now. It launches at most once per mount, when onboarding is not completed
/// or `--onboarding` forces it; the application then calls [`open_auth_step`] on its next turn (`setTimeout(0)`) unless it
/// was torn down first.
pub fn start_onboarding(host: &mut dyn ProviderHost, force: bool, verdict: Option<bool>) -> bool {
    if host.onboarding().started {
        return false;
    }
    let completed =
        resolve_onboarding_completed(verdict, || host.has_store_method("getOnboardingStatus").then(|| host.store_call("getOnboardingStatus", json!([]))));
    if completed && !force {
        return false;
    }
    host.onboarding().started = true;
    host.set_onboarding_active(true);
    true
}

// ---- persistence -------------------------------------------------------------------------------------------------------

/// A store call that may be absent (`store.method?.()`): an absent method answers nothing.
fn optional_call(host: &mut dyn ProviderHost, method: &str, args: Value) -> Result<Value, String> {
    if host.has_store_method(method) { host.store_call(method, args) } else { Ok(Value::Null) }
}

/// `onboardingWarnReopen`: Esc or cancel on any step is a confirmed skip.
pub fn onboarding_cancel(host: &mut dyn ProviderHost) {
    host.set_onboarding_active(false);
    match optional_call(host, "skipOnboarding", json!([])) {
        Ok(_) => host.push_notice("Setup skipped. Run `mixdog --onboarding` to set up later.", Tone::Info),
        Err(error) => host.push_notice(&format!("Couldn\u{2019}t save skip: {error}"), Tone::Error),
    }
}

/// `finishOnboarding`: persists whatever was configured and marks onboarding complete. Agents without an explicit override
/// are left out so the session never overwrites them (they follow the Main Model dynamically); with the Main Model unset only
/// the explicit Web Search and agent picks are sent. Nothing configured marks it done and leaves the config alone.
pub fn finish_onboarding(host: &mut dyn ProviderHost) {
    let state = host.onboarding();
    let (default_route, web_search_route, overrides) = (state.default_route.clone(), state.web_search_route.clone(), state.agent_routes.clone());
    let claim = host.claim_surface(SurfaceKind::Picker);
    host.close_surface(claim);
    host.set_onboarding_active(false);
    let configured = default_route.is_some() || web_search_route.is_some() || !overrides.is_empty();
    let result = if configured {
        let mut payload = Map::new();
        if let Some(route) = default_route {
            payload.insert("defaultRoute".to_owned(), route);
        }
        if !overrides.is_empty() {
            payload.insert("agentRoutes".to_owned(), Value::Object(overrides));
        }
        if let Some(route) = web_search_route {
            payload.insert("webSearchRoute".to_owned(), route);
        }
        optional_call(host, "completeOnboarding", json!([Value::Object(payload)]))
    } else {
        optional_call(host, "skipOnboarding", json!([]))
    };
    match result {
        Ok(_) => host.push_notice("First-run setup complete.", Tone::Info),
        Err(error) => host.push_notice(&format!("Couldn\u{2019}t save setup: {error}"), Tone::Error),
    }
}

// ---- Step 2 data -------------------------------------------------------------------------------------------------------

fn roster_entry(agent: &Value) -> AgentEntry {
    let text = |key: &str| agent.get(key).filter(|value| truthy(value)).map(value_text).unwrap_or_default();
    let id = text("id");
    let label = text("label");
    AgentEntry { label: if label.is_empty() { id.clone() } else { label }, description: text("description"), id }
}

fn roster_of(list: &Value) -> Vec<AgentEntry> {
    list.as_array().map(|agents| agents.iter().map(roster_entry).collect()).unwrap_or_default()
}

/// On-entry load of the provider models; a failure leaves the list empty and notices.
fn load_provider_models(host: &mut dyn ProviderHost) {
    match host.store_call("listProviderModels", json!([])) {
        Ok(models) => {
            let models = models.as_array().cloned().unwrap_or_default();
            host.onboarding().provider_models.clone_from(&models);
            let now = host.now_ms();
            host.set_provider_models_cache(&models, now);
        }
        Err(error) => {
            host.onboarding().provider_models.clear();
            host.push_notice(&format!("could not list models: {error}"), Tone::Warn);
        }
    }
}

/// On-entry load of the agent roster (the fixed Maintainer service plus the active starter and custom agents).
fn load_agents(host: &mut dyn ProviderHost) {
    match optional_call(host, "listAgents", json!([])) {
        Ok(list) => host.onboarding().agents = roster_of(&list),
        Err(error) => {
            host.onboarding().agents.clear();
            host.push_notice(&format!("could not list agents: {error}"), Tone::Warn);
        }
    }
}

/// What a Step 2 prefetch has to read, and the generation it belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prefetch {
    pub provider_models: bool,
    pub agents: bool,
    pub seq: u64,
}

/// `prefetchOnboardingStep2`: what is still missing, so advancing renders instantly instead of flashing an empty panel.
fn prefetch_step2(host: &mut dyn ProviderHost) -> Prefetch {
    let state = host.onboarding();
    Prefetch { provider_models: !state.has_provider_models(), agents: !state.has_agents(), seq: state.prefetch_seq }
}

/// A prefetched provider model list arrived. A result of a superseded generation (the provider cache was invalidated by an
/// auth change while it was in flight) is dropped; so is an error or an empty list: Step 2 falls back to its own load.
pub fn prefetched_provider_models(host: &mut dyn ProviderHost, seq: u64, result: Result<Value, String>) {
    if seq != host.onboarding().prefetch_seq {
        return;
    }
    let Some(models) = result.ok().and_then(|models| models.as_array().cloned()).filter(|models| !models.is_empty()) else {
        return;
    };
    host.onboarding().provider_models.clone_from(&models);
    let now = host.now_ms();
    host.set_provider_models_cache(&models, now);
}

/// A prefetched agent roster arrived; an error or an empty roster is ignored (Step 2 retries on entry).
pub fn prefetched_agents(host: &mut dyn ProviderHost, result: Result<Value, String>) {
    if let Ok(list) = result {
        let roster = roster_of(&list);
        if !roster.is_empty() {
            host.onboarding().agents = roster;
        }
    }
}

// ---- Step 1 ------------------------------------------------------------------------------------------------------------

/// `openOnboardingAuthStep`: the provider setup with the wizard's title and a Next button. The provider setup is read before
/// anything is painted so Step 1 renders the real list in one frame; on failure the picker's own loading path takes over.
pub fn open_auth_step(host: &mut dyn ProviderHost) {
    let wants = prefetch_step2(host);
    host.start_step2_prefetch(wants);
    // The wizard is reachable while a normal surface is on screen (`/onboarding`, Step 1 re-entry): Esc during the wait must
    // leave that surface alone instead of dropping Step 1 on it.
    let claim = host.claim_surface(SurfaceKind::Picker);
    let preloaded = if host.has_store_method("getProviderSetup") { host.store_call("getProviderSetup", json!([])).ok().filter(Value::is_object) } else { None };
    if !host.owns_surface(claim) {
        return;
    }
    open_provider_setup(
        host,
        SetupOptions {
            title: "First Run \u{b7} Step 1/4 \u{b7} Provider Auth".to_owned(),
            return_to: Some(Callback::OnboardingAuthStep),
            preloaded_setup: preloaded,
            confirm_bar: Some(ConfirmBarSpec { buttons: vec![ConfirmButton::new("next", "Next \u{25b6}")], on_confirm: Callback::OnboardingModelsStep }),
            on_cancel: Some(Callback::OnboardingSkip),
            ..SetupOptions::default()
        },
    );
}

// ---- Step 2 ------------------------------------------------------------------------------------------------------------

fn follows_main_parts() -> Vec<MetaPart> {
    vec![MetaPart { text: "(follows main)".to_owned(), width: 17 }, MetaPart { text: String::new(), width: 6 }, MetaPart { text: String::new(), width: 4 }]
}

fn slot_row(host: &dyn ProviderHost, value: &str, label: &str, route: Option<&Value>, description: &str, target: &str) -> PanelRow {
    let mut item = PickerItem::new(value, label);
    item.meta_parts = Some(host.agent_model_parts(route));
    item.description = description.to_owned();
    PanelRow::new(item, RowKind::Slot(target.to_owned()))
}

fn models_step_rows(host: &dyn ProviderHost, state: &OnboardingState) -> Vec<PanelRow> {
    let mut rows = vec![slot_row(host, "main-model", "Main", state.default_route.as_ref(), "main chat, planning, and agent default", "lead")];
    let mut web = slot_row(host, "web-search-model", "Web Search", state.web_search_route.as_ref(), "native web-search model", "webSearch");
    // The marker route means follow Main Model: a hint, not default/default.
    if state.web_search_route.as_ref().is_some_and(is_web_search_default_route) {
        web.item.meta_parts = Some(follows_main_parts());
    }
    rows.push(web);
    for agent in &state.agents {
        rows.push(slot_row(host, &format!("agent:{}", agent.id), &agent.label, state.agent_routes.get(&agent.id), &agent.description, &agent.id));
    }
    rows
}

/// `openOnboardingWorkflowStep`: one row per routing slot showing its effective route, Enter opening that slot's picker.
pub fn open_models_step(host: &mut dyn ProviderHost) {
    let claim = host.claim_surface(SurfaceKind::Picker);
    if !host.onboarding().has_provider_models() {
        load_provider_models(host);
    }
    if host.onboarding().provider_models.is_empty() {
        let state = host.onboarding();
        state.default_route = None;
        state.agent_routes = Map::new();
        host.push_notice("no provider models available; open /providers to sign in", Tone::Warn);
        // The empty-model fallback hands the surface to Step 1: same ownership rule as the paint below.
        if host.owns_surface(claim) {
            open_auth_step(host);
        }
        return;
    }
    // Main Model stays unset until the user picks one; no auto-recommendation. Each agent defaults to Main unless overridden.
    if !host.onboarding().has_agents() {
        load_agents(host);
    }
    if !host.owns_surface(claim) {
        return;
    }
    host.set_prompt(PromptSurface::Provider, None);
    host.set_prompt(PromptSurface::Settings, None);
    let state = host.onboarding().clone();
    let rows = models_step_rows(&*host, &state);
    let mut panel = ProviderPanel::new(PanelOwner::OnboardingModels, "First Run \u{b7} Step 2/4 \u{b7} Models", "", rows);
    panel.description = "Set the Main Model; each agent inherits it unless changed.".to_owned();
    panel.index_mode = IndexMode::Always;
    panel.label_width = Some(18);
    panel.meta_width = Some(33);
    panel.confirm_bar = Some(ConfirmBar { buttons: vec![ConfirmButton::new("back", "\u{25c0} Back"), ConfirmButton::new("next", "Next \u{25b6}")] });
    paint_step(host, claim, panel);
}

/// Paints a wizard panel under `claim` and keeps the claim and the panel for the keys that follow.
fn paint_step(host: &mut dyn ProviderHost, claim: SurfaceClaim, panel: ProviderPanel) {
    if let Some(claim) = host.paint_provider_panel(claim, Some(panel.clone())) {
        let state = host.onboarding();
        state.claim = Some(claim);
        state.panel = Some(panel);
    }
}

fn step_row(host: &mut dyn ProviderHost, index: usize) -> Option<PanelRow> {
    host.onboarding().panel.as_ref().and_then(|panel| panel.items.get(index)).cloned()
}

pub(super) fn models_select(host: &mut dyn ProviderHost, index: usize) {
    if let Some(PanelRow { kind: RowKind::Slot(target), .. }) = step_row(host, index) {
        open_role_model_picker(host, &target);
    }
}

pub(super) fn models_cancel(host: &mut dyn ProviderHost) {
    if let Some(claim) = host.onboarding().claim {
        host.close_surface(claim);
    }
    onboarding_cancel(host);
}

pub(super) fn models_confirm(host: &mut dyn ProviderHost, button: &str) {
    // Step 2 stays visible until the next picker replaces it: Step 1 preloads provider setup, so clearing now would flash a
    // blank frame.
    if button == "back" {
        open_auth_step(host);
    } else {
        open_theme_step(host);
    }
}

// ---- Step 2's model pickers --------------------------------------------------------------------------------------------

fn route_matches_model(route: Option<&Value>, model: &Value) -> bool {
    route.is_some_and(|route| route.get("provider") == model.get("provider") && route.get("model") == model.get("id"))
}

/// The current effective route for pre-marking: Main and Web Search show their own stored route (or none); agents show their
/// explicit override only (unset is none, so an untouched agent never falsely marks the Main Model row).
fn current_route<'a>(state: &'a OnboardingState, target: &str) -> Option<&'a Value> {
    match target {
        "lead" => state.default_route.as_ref(),
        "webSearch" => state.web_search_route.as_ref(),
        _ => state.agent_routes.get(target),
    }
}

fn target_label(state: &OnboardingState, target: &str) -> String {
    match target {
        "lead" => "Main".to_owned(),
        "webSearch" => "Web Search".to_owned(),
        _ => state.agents.iter().find(|agent| agent.id == target).map_or_else(|| target.to_owned(), |agent| agent.label.clone()),
    }
}

/// `routeFromModel(model)`.
fn route_from_model(model: &Value) -> Value {
    json!({"provider": model.get("provider").cloned().unwrap_or(Value::Null), "model": model.get("id").cloned().unwrap_or(Value::Null)})
}

/// The picker panel of one target. Non-lead targets get a leading "Default" row that makes the target follow the Main Model at
/// run time; it is pre-marked when the target is unset (agent) or on the web-search marker route.
fn role_model_panel(host: &dyn ProviderHost, state: &OnboardingState, target: &str, models: &[Value]) -> ProviderPanel {
    let is_lead = target == "lead";
    let is_web = target == "webSearch";
    let current = current_route(state, target);
    let is_unset = if is_web { current.is_none_or(is_web_search_default_route) } else { current.is_none() };
    let success = Some(theme_color(Key::Success));
    let model_rows: Vec<PanelRow> = models
        .iter()
        .map(|model| {
            let provider = value_text(model.get("provider").unwrap_or(&Value::Null));
            let id = value_text(model.get("id").unwrap_or(&Value::Null));
            let display = model.get("display").filter(|d| truthy(d)).map(value_text).unwrap_or_else(|| id.clone());
            let mut item = PickerItem::new(&format!("{provider}:{id}"), &display);
            if route_matches_model(current, model) {
                item.marker = "\u{2713}".to_owned();
            }
            item.marker_color = success;
            item.description = host.model_description(model);
            PanelRow::new(item, RowKind::Model(model.clone()))
        })
        .collect();
    let mut default_item = PickerItem::new("__default__", "Default");
    if is_unset {
        default_item.marker = "\u{2713}".to_owned();
    }
    default_item.marker_color = success;
    default_item.description = if is_web { "follows Main Model" } else { "same as Main Model" }.to_owned();
    let match_index = models.iter().position(|model| route_matches_model(current, model));
    let mut initial = if is_unset || match_index.is_none() { 0 } else { match_index.map_or(0, |at| at + 1) };
    if is_lead {
        initial = match_index.unwrap_or(0);
    }
    let label = target_label(state, target);
    let description = if is_lead {
        "Pick the main model. Agents inherit this unless individually changed.".to_owned()
    } else if is_web {
        "Pick the native web-search model, or Default to follow the Main Model.".to_owned()
    } else {
        format!("Pick the model for {label}, or Default to follow the Main Model.")
    };
    let mut rows = Vec::new();
    if !is_lead {
        rows.push(PanelRow::new(default_item, RowKind::DefaultRoute));
    }
    rows.extend(model_rows);
    let mut panel = ProviderPanel::new(PanelOwner::OnboardingRoleModel(target.to_owned()), &format!("First Run \u{b7} {label}"), "", rows);
    panel.description = description;
    panel.initial_index = initial;
    panel
}

/// Records the pick on the wizard state. "Default" clears an agent override, or for Web Search stores the marker route so
/// finish persists it and the runtime follows the Main Model (not a null that drops the field). False when the row carried no
/// model.
fn apply_role_selection(state: &mut OnboardingState, target: &str, kind: &RowKind) -> bool {
    match kind {
        RowKind::DefaultRoute => {
            if target == "webSearch" {
                state.web_search_route = Some(web_search_default_route());
            } else {
                state.agent_routes.remove(target);
            }
            true
        }
        RowKind::Model(model) => {
            let next = route_from_model(model);
            match target {
                "lead" => state.default_route = Some(next),
                "webSearch" => state.web_search_route = Some(next),
                _ => {
                    state.agent_routes.insert(target.to_owned(), next);
                }
            }
            true
        }
        _ => false,
    }
}

/// `openOnboardingRoleModelPicker(target)`: the model picker of the pseudo slot `lead` (Main Model), `webSearch`, or an agent
/// id. No recommendation logic: the current effective route is pre-highlighted and the plain model list is shown.
pub fn open_role_model_picker(host: &mut dyn ProviderHost, target: &str) {
    let claim = host.claim_surface(SurfaceKind::Picker);
    let models = if target == "webSearch" { web_search_models(host, claim) } else { provider_models(host, claim) };
    let Some(models) = models else { return };
    if !host.owns_surface(claim) {
        return;
    }
    let state = host.onboarding().clone();
    let panel = role_model_panel(&*host, &state, target, &models);
    paint_step(host, claim, panel);
}

/// Web Search uses the web-search-capable model list. An empty list hands the surface back to Step 2: a paint by proxy, so
/// ownership is proven first.
fn web_search_models(host: &mut dyn ProviderHost, claim: SurfaceClaim) -> Option<Vec<Value>> {
    let listed = match optional_call(host, "listWebSearchModels", json!([])) {
        Ok(list) => list.as_array().cloned().unwrap_or_default(),
        Err(error) => {
            host.push_notice(&format!("could not list web-search models: {error}"), Tone::Warn);
            Vec::new()
        }
    };
    let models = host.normalize_model_options(&listed);
    if models.is_empty() {
        host.push_notice("no native web-search models available; connect OpenAI, Grok, Gemini, or Anthropic", Tone::Warn);
        if host.owns_surface(claim) {
            open_models_step(host);
        }
        return None;
    }
    Some(models)
}

/// Lead and agents use the provider models Step 2 loaded; none goes back to Step 1.
fn provider_models(host: &mut dyn ProviderHost, claim: SurfaceClaim) -> Option<Vec<Value>> {
    let loaded = host.onboarding().provider_models.clone();
    let models = host.normalize_model_options(&loaded);
    if models.is_empty() {
        host.push_notice("no provider models available; open /providers to sign in", Tone::Warn);
        if host.owns_surface(claim) {
            open_auth_step(host);
        }
        return None;
    }
    Some(models)
}

pub(super) fn role_model_select(host: &mut dyn ProviderHost, target: &str, index: usize) {
    let kind = step_row(host, index).map(|row| row.kind);
    let applied = kind.is_some_and(|kind| apply_role_selection(host.onboarding(), target, &kind));
    if !applied {
        host.push_notice("select a provider model first", Tone::Warn);
    }
    open_models_step(host);
}

// ---- Steps 3 and 4 -----------------------------------------------------------------------------------------------------

fn open_theme_step(host: &mut dyn ProviderHost) {
    open_step_picker(host, Opener::Theme, json!({"onboarding": {}}));
}

fn open_output_style_step(host: &mut dyn ProviderHost) {
    open_step_picker(host, Opener::OutputStyle, json!({"onboarding": {"isLastStep": true}}));
}

fn open_step_picker(host: &mut dyn ProviderHost, opener: Opener, options: Value) {
    if let Err(error) = host.open(opener, options) {
        host.push_notice(&error, Tone::Error);
    }
}

/// Next on the theme step.
pub fn theme_advance(host: &mut dyn ProviderHost) {
    open_output_style_step(host);
}

/// Back on the theme step.
pub fn theme_back(host: &mut dyn ProviderHost) {
    open_models_step(host);
}

/// Finish on the output style step (the last step).
pub fn output_style_advance(host: &mut dyn ProviderHost) {
    finish_onboarding(host);
}

/// Back on the output style step.
pub fn output_style_back(host: &mut dyn ProviderHost) {
    open_theme_step(host);
}
