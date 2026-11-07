//! `ChatRouteSetter` in production: how a bot's saved route reaches one of its chats
//! (`standalone/session-service/agent-route-follow.mjs` `apply`: `entry.runtime.setRoute(pick)`).
//!
//! `runtime.setRoute(pick)` is the session route API (`tui/session/session-api/routes-write.mjs`
//! `createRouteWrite`) that `route/set` also reaches, so the pick goes through the same
//! [`plan`] (a session-only pick completed against the chat's live route, the options split off
//! the selection) and the same [`RouteService::set_route`]. A pick the chat already runs is a
//! no-op, as in the route API. The follow options of the write are the ones the plan derives
//! (`switchEstablished`, `deferUntilNextTurn`): the chat takes the route from its next turn.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::ChatRouteSetter;
use mixdog_core_ports::ports::route::FollowOptions;
use mixdog_core_ports::ports::route::Route;
use mixdog_core_ports::ports::route_write::RouteWriter;
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
