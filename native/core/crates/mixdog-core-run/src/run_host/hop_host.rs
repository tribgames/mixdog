//! The `hop_host` seam of `SessionSeams`: [`HopHost`] over the provider registry and the wires,
//! the way Node's `advanceAgentRoute` (`session/loop/route-fallback.mjs`) resolves the next
//! provider.
//!
//! What it reads: the next provider comes from the registry after `initProviders(
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
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::admin_route::ensure_provider_enabled;
use mixdog_core_api::domain::provider::{ProviderAdapter, ProviderError, WireRouteContext};
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::util::PortError;
use serde_json::{json, Value};

use super::model_display::display_model_name;
use super::route_chain::BotRoutes;
use mixdog_core_ports::ports::domain_sessions::Obj;
use super::route_fallback::{HopHost, HopWrite};
use super::session_context_meta::session_context_meta;

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
    pub registry: Arc<ProviderRegistry>,
    pub catalog: Arc<CatalogService>,
    pub config: ConfigSnapshot,
    pub bots: Arc<dyn BotRoutes + Send + Sync>,
    pub errors: ErrorText,
    pub wiring: Arc<dyn HopWiring>,
}

/// `SessionSeams::hop_host`.
pub struct HopFactory {
    deps: HopDeps,
    sessions: Arc<dyn HopSessions>,
}

impl HopFactory {
    pub fn new(deps: HopDeps, sessions: Arc<dyn HopSessions>) -> Self {
        Self { deps, sessions }
    }

    /// The hop host of `thread`; `None` when the thread has no open session.
    pub fn hop_host(&self, thread: &ThreadId, _header: &Header) -> Option<Arc<dyn HopHost>> {
        let session = self.sessions.open(thread)?;
        Some(Arc::new(RegistryHopHost { deps: self.deps.clone(), session }))
    }
}

pub struct RegistryHopHost {
    deps: HopDeps,
    session: Arc<dyn HopSession>,
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
        if let Some(current) = updated.get("wireRoute").filter(|c| c.is_object())
            && text(current.get("provider")) == provider
            && text(current.get("model")) == model
        {
            return None;
        }
        let routing = adapter.wire_routing()?;
        let context = WireRouteContext { agent: true, legacy: false, ..WireRouteContext::default() };
        let route = routing.resolve_wire_route(&model, &context).await.ok()??;
        if route.source == "unknown" {
            return None;
        }
        let live = self.session.header()?;
        if text(live.get("provider")) != provider || text(live.get("model")) != model {
            return None;
        }
        Some(json!({
            "provider": provider, "model": model,
            "wire": route.wire, "source": route.source, "profileId": route.profile_id,
        }))
    }
}

#[async_trait]
impl HopHost for RegistryHopHost {
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

    fn error_text(&self, error: &ProviderError) -> String {
        (self.deps.errors)(error)
    }

    /// `await initProviders(...)` (`route-fallback.mjs:78,107`) has no catch: its error escapes.
    async fn provider(&self, provider: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, String> {
        let providers = ensure_provider_enabled(&self.config(), provider);
        self.deps.registry.init_providers(&providers).await.map_err(|e| e.message)?;
        Ok(self.deps.registry.get(provider).await)
    }

    fn raw_context_window(&self, provider: &str, model: &str, route: &Value) -> Option<u64> {
        let meta = session_context_meta(&self.deps.catalog, provider, model, route)?;
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
        if let Some(adapter) = self.deps.registry.registered(&provider)
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
