//! `DomainSeams.live_route` before the session directory exists.
//!
//! The `model` and `summary` status readers are built with the domains (`compose_domains_pre`),
//! and the live route they print is `SessionLiveRoute`, which reads the held sessions' headers
//! through `SessionRoutePositions::new(directory, ..)`: a true cycle through the directory, as for
//! `LateSessionFacts`. The cell is bound once, right after `TurnPath::new`, to
//! `Arc::new(SessionLiveRoute::new(positions, routes))`, and the composition verifies it
//! before the listener accepts. A status request comes from a client, so none reads it earlier;
//! unbound it answers as a runtime with nothing set.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use mixdog_core::run_host::late::Bound;
use mixdog_core_agents::setup::LiveRoute;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::{Map, Value};

/// The setup tool's live route, bound to `SessionLiveRoute`.
#[derive(Default)]
pub struct LateLiveRoute(OnceLock<Arc<dyn LiveRoute>>);

impl LateLiveRoute {
    /// Binds the route; a second bind is refused.
    pub fn bind(&self, route: Arc<dyn LiveRoute>) -> Result<(), Arc<dyn LiveRoute>> {
        self.0.set(route)
    }
}

#[async_trait]
impl LiveRoute for LateLiveRoute {
    /// Unbound, no property is set.
    fn route(&self, thread: &ThreadId) -> Value {
        match self.0.get() {
            Some(route) => route.route(thread),
            None => Value::Object(Map::new()),
        }
    }

    /// Unbound, the Lead preset is unread: its chain is absent.
    fn lead_fallbacks(&self) -> Value {
        match self.0.get() {
            Some(route) => route.lead_fallbacks(),
            None => Value::Null,
        }
    }

    /// Unbound, the held sessions cannot be read, which is this method's error.
    async fn positions(&self, thread: &ThreadId, lead: bool) -> Result<Value, PortError> {
        match self.0.get() {
            Some(route) => route.positions(thread, lead).await,
            None => Err(PortError::Unavailable { capability: "live route".into(), message: "the session layer is not up yet".into() }),
        }
    }
}

impl Bound for LateLiveRoute {
    fn cell(&self) -> &'static str {
        "live route"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// Every answer is the opposite of the unbound one.
    struct Held;

    #[async_trait]
    impl LiveRoute for Held {
        fn route(&self, _: &ThreadId) -> Value {
            json!({ "provider": "anthropic", "model": "claude" })
        }

        fn lead_fallbacks(&self) -> Value {
            json!([{ "provider": "openai", "model": "gpt" }])
        }

        async fn positions(&self, _: &ThreadId, lead: bool) -> Result<Value, PortError> {
            Ok(json!({ "sessions": [], "lead": lead }))
        }
    }

    #[tokio::test]
    async fn the_route_is_empty_until_bound_then_the_sessions() {
        let late = LateLiveRoute::default();
        let thread = ThreadId::from("t");
        assert!(!late.is_bound());
        assert_eq!(late.route(&thread), json!({}));
        assert_eq!(late.lead_fallbacks(), Value::Null);
        assert!(matches!(late.positions(&thread, true).await, Err(PortError::Unavailable { .. })));
        assert!(late.bind(Arc::new(Held)).is_ok());
        assert!(late.is_bound());
        assert_eq!(late.route(&thread)["model"], "claude");
        assert_eq!(late.lead_fallbacks()[0]["model"], "gpt");
        assert_eq!(late.positions(&thread, true).await.unwrap()["lead"], true);
        assert!(late.bind(Arc::new(Held)).is_err(), "a second bind is refused");
    }
}
