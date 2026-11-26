//! The `hop_host` seam of `SessionSeams`: [`HopHost`] over the route facts and the wires,
//! the way Node's `advanceAgentRoute` (`session/loop/route-fallback.mjs`) resolves the next
//! provider.
//!
//! What it reads: the next provider comes from the route facts after `initProviders(
//! ensureProviderEnabled(config, name))`; a model's window from `resolveSessionContextMeta`; its
//! name in a notice from `displayModelName`. What it writes goes through [`HopSession`], the
//! session's own side (WP-SESSION): one header update carrying the new route and the four
//! `routeFallback*` fields, then the wire pin (`pinSessionWireRoute`) and, for a Lead-class
//! session, the tool surface rebuild, in Node's order.
//!
//! `error_text` (`presentErrorText`) and `wiring` (`prepareTurnEffortConfiguration` and the
//! text-only input) have no Rust implementation of their own yet; they are the two seams of
//! [`HopDeps`], and `wiring` must be the very factory the turn start uses for `RunSettings`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::effort::EffortWiring;
use mixdog_agent::text_only::TextOnlyInput;
use mixdog_ai::catalog::CatalogService;
use mixdog_ai::service::admin_route::ensure_provider_enabled;
use mixdog_core_api::domain::provider::{ProviderAdapter, ProviderError, WireRouteContext};
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::{Value, json};

use super::model_display::display_model_name;
use super::route_chain::BotRoutes;
use super::route_fallback::{HopHost, HopWrite, RouteEligibility, Runner};
use super::session_context_meta::session_context_meta;
use mixdog_core_ports::ports::domain_sessions::Obj;
use mixdog_core_ports::ports::route_facts::{RouteFacts, RouteSender};

/// The session side of a hop, bound to one thread. Owner: WP-SESSION.
#[async_trait]
pub trait HopSession: Send + Sync {
    /// The session's latest acked header; `None` once the session is closed.
    fn header(&self) -> Option<Arc<Header>>;
    /// `updateSessionRoute(id, route, { crossProvider: true, session })` followed by the hop's
    /// fields (`routeFallbacks`, `routeFallbackPrimary` when `write.primary` is set,
    /// `routeFallbackIndex`, `routeFallbackFailures`) and `activeTurnCheckpoint.routeChanged =
    /// true` when `write.checkpoint_route_changed`, all in the one header update. The route
    /// change leaves `wireRoute` null. Returns the updated header, `None` when the session is
    /// closed or gone.
    async fn write_hop(&self, route: Obj, write: &HopWrite) -> Result<Option<Header>, PortError>;
    /// Sets `wireRoute` on the header.
    async fn write_wire_pin(&self, pin: Value) -> Result<(), PortError>;
    /// `rebuildToolSurfaceForProviderWithMigration(session, provider, liveMessages)`: the
    /// session re-derives its deferred tool surface from its header, which names the new provider.
    async fn rebuild_tool_surface(&self, provider: &str) -> Result<(), PortError>;
}

/// The sessions a hop can write: one handle per open thread.
pub trait HopSessions: Send + Sync {
    fn open(&self, thread: &ThreadId) -> Option<Arc<dyn HopSession>>;
}

/// The route's effort projection inputs and text-only input handling (`wiring`).
pub trait HopWiring: Send + Sync {
    fn wiring(&self, updated: &Value, provider: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>);
}

/// `getConfigSnapshot({ secrets: false })`.
pub type ConfigSnapshot = Arc<dyn Fn() -> Obj + Send + Sync>;
/// `presentErrorText(error)`.
pub type ErrorText = Arc<dyn Fn(&ProviderError) -> String + Send + Sync>;

/// Everything a hop reads that is not the session.
#[derive(Clone)]
pub struct HopDeps {
    /// What a route's provider is, an agent's route included: the hop reaches no provider but through these.
    pub facts: Arc<dyn RouteFacts>,
    pub catalog: Arc<CatalogService>,
    pub config: ConfigSnapshot,
    pub bots: Arc<dyn BotRoutes + Send + Sync>,
    pub errors: ErrorText,
    pub wiring: Arc<dyn HopWiring>,
}

/// Whether a route can be sent on now. Owner: the quota, admission and dispatch layer, which holds the accounts,
/// credentials and quota readings; the hop asks it and keeps none of that evidence itself.
#[async_trait]
pub trait RouteEligibilitySource: Send + Sync {
    async fn eligibility(&self, provider: &str, model: &str) -> RouteEligibility;
}

/// Read the same adapter and account selection policy that would send the route. A cold or
/// superseded registration is not evidence about the configured destination, and a route an agent
/// serves has no adapter to read.
pub struct RegisteredEligibility(pub Arc<dyn RouteFacts>);

#[async_trait]
impl RouteEligibilitySource for RegisteredEligibility {
    async fn eligibility(&self, provider: &str, model: &str) -> RouteEligibility {
        let Some(adapter) = self.0.registered(provider) else {
            return RouteEligibility::Unknown;
        };
        let verdict = adapter.quota_eligibility(model).await;
        if !self.0.registered(provider).is_some_and(|current| Arc::ptr_eq(&current, &adapter)) {
            return RouteEligibility::Unknown;
        }
        match verdict {
            Some(true) => RouteEligibility::Eligible,
            Some(false) => RouteEligibility::Exhausted,
            None => RouteEligibility::Unknown,
        }
    }
}

/// `SessionSeams::hop_host`.
pub struct HopFactory {
    deps: HopDeps,
    sessions: Arc<dyn HopSessions>,
    eligibility: Option<Arc<dyn RouteEligibilitySource>>,
}

impl HopFactory {
    pub fn new(deps: HopDeps, sessions: Arc<dyn HopSessions>) -> Self {
        Self { deps, sessions, eligibility: None }
    }

    /// The source of route eligibility the hops of this factory ask; without one a hop reconsiders nothing.
    pub fn with_eligibility(mut self, source: Arc<dyn RouteEligibilitySource>) -> Self {
        self.eligibility = Some(source);
        self
    }

    /// The hop host of `thread`; `None` when the thread has no open session.
    pub fn hop_host(&self, thread: &ThreadId, _header: &Header) -> Option<Arc<dyn HopHost>> {
        let session = self.sessions.open(thread)?;
        Some(Arc::new(RegistryHopHost { deps: self.deps.clone(), session, eligibility: self.eligibility.clone() }))
    }
}

pub struct RegistryHopHost {
    deps: HopDeps,
    session: Arc<dyn HopSession>,
    eligibility: Option<Arc<dyn RouteEligibilitySource>>,
}

fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => mixdog_js::value_to_string(v),
    }
}

/// The message of the `Error` a failed port step stands for.
pub fn port_message(error: &PortError) -> String {
    match error {
        PortError::Invalid { reason, .. } => reason.clone(),
        PortError::Denied(message)
        | PortError::Refused { message, .. }
        | PortError::Unavailable { message, .. }
        | PortError::NotFound { message, .. }
        | PortError::Failed { message, .. } => message.clone(),
        PortError::Cancelled => "cancelled".to_owned(),
    }
}

/// `isAgentOwner(session)`.
fn is_agent_owner(session: &Value) -> bool {
    session.get("owner").is_some_and(|o| mixdog_js::js_trim(&mixdog_js::value_to_string(o)).to_lowercase() == "agent")
}

impl RegistryHopHost {
    /// `pinSessionWireRoute` for the session a hop just routed: the wire the new provider reaches
    /// the model on, `None` when the session is already pinned to this route, the provider has a
    /// single wire, the model has no wire (or an unknown one), resolving failed, or the route
    /// moved while resolving. The hop's route change always leaves `wireRoute` null, so the
    /// session is never a legacy one.
    async fn wire_pin(&self, updated: &Value, adapter: &dyn ProviderAdapter) -> Option<Value> {
        let (provider, model) = (text(updated.get("provider")), text(updated.get("model")));
        if provider.is_empty() || model.is_empty() {
            return None;
        }
        let pin = resolve_pin(adapter, updated.get("wireRoute"), &provider, &model, false).await?;
        let live = self.session.header()?;
        if text(live.get("provider")) != provider || text(live.get("model")) != model {
            return None;
        }
        Some(pin)
    }
}

/// The part of `pinSessionWireRoute` before its last check: `None` when `current` already pins this route, the
/// provider has a single wire, resolving failed, or the model has no known wire. `legacy` is a session that
/// predates the wire table and already talked to its model.
pub async fn resolve_pin(adapter: &dyn ProviderAdapter, current: Option<&Value>, provider: &str, model: &str, legacy: bool) -> Option<Value> {
    if let Some(current) = current.filter(|c| c.is_object())
        && text(current.get("provider")) == provider
        && text(current.get("model")) == model
    {
        return None;
    }
    let routing = adapter.wire_routing()?;
    let context = WireRouteContext { agent: true, legacy, ..WireRouteContext::default() };
    let route = routing.resolve_wire_route(model, &context).await.ok()??;
    if route.source == "unknown" {
        return None;
    }
    Some(json!({
        "provider": provider, "model": model,
        "wire": route.wire, "source": route.source, "profileId": route.profile_id,
    }))
}

#[async_trait]
impl HopHost for RegistryHopHost {
    async fn route_eligibility(&self, route: &Value) -> RouteEligibility {
        match &self.eligibility {
            Some(source) => source.eligibility(&text(route.get("provider")), &text(route.get("model"))).await,
            None => RouteEligibility::Unknown,
        }
    }

    fn session(&self) -> Option<Value> {
        self.session.header().map(|h| Value::Object((*h).clone()))
    }

    fn config(&self) -> Obj {
        (self.deps.config)()
    }

    fn bots(&self) -> &dyn BotRoutes {
        &*self.deps.bots
    }

    fn model_label(&self, _provider: &str, model: &str) -> String {
        display_model_name(model, "")
    }

    fn provider_label(&self, provider: &str) -> String {
        let meta = self.deps.facts.model_meta(provider, "");
        if let Some(label) = meta.get("agentLabel").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return label.to_owned();
        }
        if meta.get("runner").and_then(Value::as_str) == Some("acp")
            && let Some(display) = meta.get("display").and_then(Value::as_str).filter(|s| !s.is_empty())
        {
            return display.split(" · ").next().unwrap_or(display).to_owned();
        }
        mixdog_ai::service::error_text::provider_display_name(provider)
    }

    fn error_text(&self, error: &ProviderError) -> String {
        (self.deps.errors)(error)
    }

    /// `await initProviders(...)` (`route-fallback.mjs:78,107`) has no catch: its error escapes. A route an agent serves
    /// is the agent's: its facts answer it before anything is initialized.
    async fn runner(&self, provider: &str) -> Result<Option<Runner>, String> {
        let providers = ensure_provider_enabled(&self.config(), provider);
        Ok(self.deps.facts.sender(Some(&providers), provider).await?.map(|sender| match sender {
            RouteSender::Provider(adapter) => Runner::Loop(adapter),
            RouteSender::Agent(_) => Runner::Agent,
        }))
    }

    /// The agent's readiness as a pick of its route reads it: model admission, and once the check of its program that
    /// runs, or that this starts, has ended, whether a turn on it can start, and in the agent's words why not.
    async fn agent_ready(&self, provider: &str, model: &str) -> Result<(), String> {
        self.deps.facts.ensure_route_ready(&self.config(), provider, model).await
    }

    async fn unavailable_cause(&self, provider: &str) -> (Option<String>, bool) {
        (self.deps.facts.init_error(provider), mixdog_ai::service::admin_route::provider_switched_off(&self.config(), provider))
    }

    fn raw_context_window(&self, provider: &str, model: &str, route: &Value) -> Option<u64> {
        let model_meta = self.deps.facts.model_meta(provider, model);
        let mut seed = route.clone();
        if let Some(window_meta) = self.deps.facts.window_meta(provider, model, &model_meta) {
            let reported = ["maxContextWindow", "contextWindow", "max_context_window", "context_window"]
                .iter()
                .find_map(|key| window_meta.get(*key).and_then(Value::as_f64).filter(|w| w.is_finite() && *w >= 1.0).map(|w| w.floor() as u64));
            if let Some(reported) = reported
                && let Some(obj) = seed.as_object_mut()
                && obj.get("rawContextWindow").and_then(Value::as_f64).is_none_or(|w| !w.is_finite() || w < 1.0)
            {
                obj.insert("rawContextWindow".into(), json!(reported));
            }
        }
        let meta = session_context_meta(&self.deps.catalog, provider, model, &seed)?;
        meta.raw_context_window.as_f64().filter(|w| *w > 0.0).map(|w| w as u64)
    }

    /// `None` is `updateSessionRoute` answering nothing (`route-fallback.mjs:147` throws "agent
    /// session closed during model fallback" for it). None of the steps has a catch (`:131-158`),
    /// so a step's failure escapes with its own message, the surface rebuild's included.
    async fn apply_hop(&self, route: Obj, write: HopWrite) -> Result<Option<Value>, String> {
        let provider = text(route.get("provider"));
        let Some(written) = self.session.write_hop(route, &write).await.map_err(|e| port_message(&e))? else {
            return Ok(None);
        };
        let mut updated = Value::Object(written);
        if let Some(adapter) = self.deps.facts.registered(&provider)
            && let Some(pin) = self.wire_pin(&updated, &*adapter).await
        {
            self.session.write_wire_pin(pin.clone()).await.map_err(|e| port_message(&e))?;
            updated["wireRoute"] = pin;
        }
        if !is_agent_owner(&updated) {
            self.session.rebuild_tool_surface(&provider).await.map_err(|e| port_message(&e))?;
        }
        Ok(Some(self.session().unwrap_or(updated)))
    }

    fn wiring(&self, updated: &Value, provider: &Arc<dyn ProviderAdapter>) -> (Option<EffortWiring>, Option<TextOnlyInput>) {
        self.deps.wiring.wiring(updated, provider)
    }
}

#[cfg(test)]
#[path = "hop_host_tests.rs"]
mod tests;
