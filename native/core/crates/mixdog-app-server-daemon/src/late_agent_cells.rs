//! The two cycles of production `AgentEffects`.
//!
//! The agent definitions (`build_agents`) are built before everything else, and their effects
//! reach two things that are built from them or after the session directory:
//! - the channel stack: `DefinitionAgents::new(agents)` is inside `RoutineRuntime`'s host, and
//!   `ServiceChannels { admin, runtime }` is what `DaemonAgentEffects` reloads and purges through;
//! - the route service: `ChatRoutes::new(route_service)` is the setter `AgentRouteFollow` hands a
//!   saved bot route to, and `RouteService` needs the built directory (`SessionRouteAdapter`).
//!
//! Each cell is bound once, when what it waits for exists, and the composition verifies both
//! before the listener accepts. A change of the definitions comes from a client request, so none
//! reaches an unbound cell; unbound, a call is refused with the reason.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use mixdog_core::run_host::late::Bound;
use mixdog_core_agents::agents::OwnedRoutines;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::route::{ChatRouteSetter, FollowOptions, Route};
use mixdog_tools::orch::util::PortError;

use crate::domain_seams::agent_effects::RoutineChannels;

const CHANNELS_DOWN: &str = "the channel stack is not up yet";

/// `DaemonAgentEffects.channels`, bound to `ServiceChannels { admin, runtime }`.
#[derive(Default)]
pub struct LateRoutineChannels(OnceLock<Arc<dyn RoutineChannels>>);

impl LateRoutineChannels {
    /// Binds the channels; a second bind is refused.
    pub fn bind(&self, channels: Arc<dyn RoutineChannels>) -> Result<(), Arc<dyn RoutineChannels>> {
        self.0.set(channels)
    }
}

#[async_trait]
impl RoutineChannels for LateRoutineChannels {
    async fn delete_owned(&self, agent_id: &str) -> Result<OwnedRoutines, String> {
        match self.0.get() {
            Some(channels) => channels.delete_owned(agent_id).await,
            None => Err(CHANNELS_DOWN.to_owned()),
        }
    }

    async fn reload(&self) -> Result<(), String> {
        match self.0.get() {
            Some(channels) => channels.reload().await,
            None => Err(CHANNELS_DOWN.to_owned()),
        }
    }

    fn reload_soon(&self) {
        match self.0.get() {
            Some(channels) => channels.reload_soon(),
            None => tracing::warn!("[channels] schedule reload skipped: {CHANNELS_DOWN}"),
        }
    }
}

impl Bound for LateRoutineChannels {
    fn cell(&self) -> &'static str {
        "agent routine channels"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

/// `ChatRoutes::new(route_service)` for the `AgentRouteFollow` of the agent route setter.
#[derive(Default)]
pub struct LateChatRoutes(OnceLock<Arc<dyn ChatRouteSetter>>);

impl LateChatRoutes {
    /// Binds the setter; a second bind is refused.
    pub fn bind(&self, setter: Arc<dyn ChatRouteSetter>) -> Result<(), Arc<dyn ChatRouteSetter>> {
        self.0.set(setter)
    }
}

#[async_trait]
impl ChatRouteSetter for LateChatRoutes {
    async fn set_route(&self, thread: &ThreadId, pick: Route, options: FollowOptions) -> Result<(), PortError> {
        match self.0.get() {
            Some(setter) => setter.set_route(thread, pick, options).await,
            None => Err(PortError::Unavailable { capability: "route".into(), message: "the route service is not up yet".into() }),
        }
    }
}

impl Bound for LateChatRoutes {
    fn cell(&self) -> &'static str {
        "agent chat routes"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Channels(Mutex<Vec<&'static str>>);

    #[async_trait]
    impl RoutineChannels for Channels {
        async fn delete_owned(&self, _: &str) -> Result<OwnedRoutines, String> {
            self.0.lock().unwrap().push("delete");
            Ok(OwnedRoutines { schedules: vec!["nightly".into()], webhooks: Vec::new() })
        }

        async fn reload(&self) -> Result<(), String> {
            self.0.lock().unwrap().push("reload");
            Ok(())
        }

        fn reload_soon(&self) {
            self.0.lock().unwrap().push("soon");
        }
    }

    struct Setter(Mutex<Vec<String>>);

    #[async_trait]
    impl ChatRouteSetter for Setter {
        async fn set_route(&self, thread: &ThreadId, _: Route, _: FollowOptions) -> Result<(), PortError> {
            self.0.lock().unwrap().push(thread.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn the_channels_refuse_until_bound_then_answer_and_refuse_a_second_bind() {
        let late = LateRoutineChannels::default();
        assert!(!late.is_bound());
        assert_eq!(late.reload().await, Err(CHANNELS_DOWN.to_owned()));
        assert_eq!(late.delete_owned("bot").await.unwrap_err(), CHANNELS_DOWN);
        let channels = Arc::new(Channels(Mutex::new(Vec::new())));
        assert!(late.bind(channels.clone()).is_ok());
        assert!(late.is_bound());
        assert_eq!(late.delete_owned("bot").await.unwrap().schedules, ["nightly"]);
        late.reload().await.unwrap();
        late.reload_soon();
        assert_eq!(*channels.0.lock().unwrap(), ["delete", "reload", "soon"]);
        assert!(late.bind(channels).is_err());
    }

    #[tokio::test]
    async fn a_route_pick_is_refused_until_the_route_service_is_bound() {
        let late = LateChatRoutes::default();
        let thread = ThreadId::from("home");
        assert!(!late.is_bound());
        assert!(matches!(late.set_route(&thread, Route::new(), FollowOptions::default()).await, Err(PortError::Unavailable { .. })));
        let setter = Arc::new(Setter(Mutex::new(Vec::new())));
        assert!(late.bind(setter.clone()).is_ok());
        late.set_route(&thread, Route::new(), FollowOptions::default()).await.unwrap();
        assert_eq!(*setter.0.lock().unwrap(), ["home"]);
        assert!(late.bind(setter).is_err());
    }
}
