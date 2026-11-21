//! `ChatRouteSetter` in production: a bot's saved route reaches one of its chats through the same
//! [`plan`] and [`RouteService::set_route`] as `route/set`. A pick the chat already runs is a no-op; the
//! chat takes the route from its next turn (`switchEstablished`, `deferUntilNextTurn`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::ChatRouteSetter;
use mixdog_core_ports::ports::route::FollowOptions;
use mixdog_core_ports::ports::route::Route;
use mixdog_tools::orch::util::PortError;

use super::route_service::RouteService;
use super::route_set_service::Plan;
use super::route_set_service::plan;

/// The chats' route setter: the daemon's one [`RouteService`].
pub struct ChatRoutes {
    routes: Arc<RouteService>,
}

impl ChatRoutes {
    pub fn new(routes: Arc<RouteService>) -> Self {
        Self { routes }
    }
}

#[async_trait]
impl ChatRouteSetter for ChatRoutes {
    /// `_options` is what `AgentRouteFollow` names for every pick; the write's own follow options
    /// are the plan's, as the route API derives them from the pick (the same two flags).
    async fn set_route(&self, thread: &ThreadId, pick: Route, _options: FollowOptions) -> Result<(), PortError> {
        match plan(&pick, &self.routes.writer.route(thread)) {
            Plan::Unchanged => Ok(()),
            Plan::Write(requested, options) => self
                .routes
                .set_route(thread, &requested, &options)
                .await
                .map(|_| ())
                .map_err(|message| PortError::Failed { capability: "route".into(), message }),
        }
    }
}
