//! The write side of the live route (Node's `rt.route` writes): `setRouteState`, and
//! `refreshRouteEffort` (route-resolution.mjs:36), which fills the effort, Fast, context and
//! display fields of the route once the provider and the model row are known. Adopting a route
//! (`route/set`, `fast/set`) uses it; what an adopted route does to the thread is
//! [`super::route::SessionRoutes`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::{CatalogService, ProviderReadiness};
use mixdog_ai::service::admin_route::{Obj, ensure_provider_enabled, refresh_route_fields};
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

use super::route::{LiveRoute, Route, RouteSession};
use mixdog_core_config::config::Config;

/// The runtime's route cell per thread. The session owner implements it: the route is replaced
/// whole, and every replacement advances the route generation (Node compared object identity;
/// the generation is what a refresh that began earlier checks before it writes).
pub trait RouteCell: LiveRoute {
    /// `setRouteState(route)`: replaces the route and advances its generation.
    fn set_route_state(&self, thread: &ThreadId, route: Route);
    /// Advanced by every [`Self::set_route_state`].
    fn route_generation(&self, thread: &ThreadId) -> u64;
}

/// `refreshStatuslineUsageSnapshot(route)`: the usage service's reading for the statusline.
pub trait StatuslineUsage: Send + Sync {
    fn refresh(&self, thread: &ThreadId, route: &Route);
}

/// What route adoption does to the live route.
#[async_trait]
pub trait RouteWriter: Send + Sync {
    fn route(&self, thread: &ThreadId) -> Route;
    fn set_route_state(&self, thread: &ThreadId, route: Route);
    /// The session generation a lease holds (`getSessionGeneration()`).
    fn generation(&self, thread: &ThreadId) -> u64;
    /// `refreshRouteEffort(modelMeta, expectedRoute, null, lease)`. `meta` is the model row the
    /// caller already holds (else it is looked up). With `guard_supersede`, the route that stands
    /// when this call began must still stand when it writes (`rt.route !== expectedRoute`), and
    /// a lease whose session generation moved ends it: both answer `None`.
    async fn refresh_route_effort(
        &self,
        thread: &ThreadId,
        meta: Option<Value>,
        guard_supersede: bool,
        lease: Option<u64>,
    ) -> Result<Option<Route>, PortError>;
    fn refresh_statusline_usage(&self, thread: &ThreadId, route: &Route);
}

/// [`RouteWriter`] over the session's route cell, the config, and the catalog.
pub struct LiveRouteWriter {
    pub cell: Arc<dyn RouteCell>,
    pub session: Arc<dyn RouteSession>,
    pub config: Config,
    pub catalog: Arc<CatalogService>,
    pub readiness: Arc<ProviderReadiness>,
    pub usage: Arc<dyn StatuslineUsage>,
}

#[async_trait]
impl RouteWriter for LiveRouteWriter {
    fn route(&self, thread: &ThreadId) -> Route {
        self.cell.route(thread)
    }

    fn set_route_state(&self, thread: &ThreadId, route: Route) {
        self.cell.set_route_state(thread, route);
    }

    fn generation(&self, thread: &ThreadId) -> u64 {
        self.session.generation(thread)
    }

    async fn refresh_route_effort(
        &self,
        thread: &ThreadId,
        meta: Option<Value>,
        guard_supersede: bool,
        lease: Option<u64>,
    ) -> Result<Option<Route>, PortError> {
        let target = self.cell.route(thread);
        let began = self.cell.route_generation(thread);
        let config: Obj = self.config.agent();
        let provider = target.get("provider").and_then(Value::as_str).unwrap_or("").trim().to_owned();
        let model = target.get("model").and_then(Value::as_str).unwrap_or("").trim().to_owned();
        self.readiness
            .ensure_providers_ready(Some(ensure_provider_enabled(&config, &provider)))
            .await
            .map_err(|e| PortError::Failed { capability: "providers".into(), message: e.message })?;
        let meta = match meta {
            Some(meta) => meta,
            None => self.catalog.model_meta(&provider, &model),
        };
        // A rapid second resume or model change can replace the route while provider metadata is
        // loading; an older completion never overwrites it, nor does one whose session was replaced.
        if guard_supersede && self.cell.route_generation(thread) != began {
            return Ok(None);
        }
        if lease.is_some_and(|token| self.session.generation(thread) != token) {
            return Ok(None);
        }
        let live_provider = self.cell.route(thread).get("provider").and_then(Value::as_str).unwrap_or("").to_owned();
        let fast = |provider: &str, meta: &Value, effort: Option<&str>, params: &Value| self.catalog.fast_capable(provider, meta, effort, params);
        let route = refresh_route_fields(&config, &target, Some(&meta), &live_provider, &fast);
        self.cell.set_route_state(thread, route.clone());
        Ok(Some(route))
    }

    fn refresh_statusline_usage(&self, thread: &ThreadId, route: &Route) {
        self.usage.refresh(thread, route);
    }
}
