//! `RoutePositions` of the `agents` status reader before the session directory exists.
//!
//! `AgentsStatus` is registered with the setup service (`mcp_services`), which is built before the
//! directory, and its production positions are `SessionRoutePositions::new(directory, ..)`: a true
//! cycle through the directory, as for [`LateLiveRoute`](crate::late_live_route::LateLiveRoute).
//! The cell is bound once, right after `TurnPath::new`, and the composition verifies it before the
//! listener accepts. A status request comes from a client, so none reads it earlier; unbound, the
//! held sessions cannot be read, which is this method's error.

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use mixdog_core::run_host::late::Bound;
use mixdog_core_agents::setup::RoutePositions;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

/// The `agents` status reader's positions, bound to `SessionRoutePositions`.
#[derive(Default)]
pub struct LateRoutePositions(OnceLock<Arc<dyn RoutePositions>>);

impl LateRoutePositions {
    /// Binds the positions; a second bind is refused.
    pub fn bind(&self, positions: Arc<dyn RoutePositions>) -> Result<(), Arc<dyn RoutePositions>> {
        self.0.set(positions)
    }
}

#[async_trait]
impl RoutePositions for LateRoutePositions {
    async fn others(&self, caller: &ThreadId) -> Result<Vec<Value>, PortError> {
        match self.0.get() {
            Some(positions) => positions.others(caller).await,
            None => Err(PortError::Unavailable { capability: "route positions".into(), message: "the session layer is not up yet".into() }),
        }
    }
}

impl Bound for LateRoutePositions {
    fn cell(&self) -> &'static str {
        "route positions"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Held;

    #[async_trait]
    impl RoutePositions for Held {
        async fn others(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(vec![json!({ "sessionId": "bot-1" })])
        }
    }

    #[tokio::test]
    async fn the_positions_are_refused_until_bound_then_the_held_sessions() {
        let late = LateRoutePositions::default();
        let caller = ThreadId::from("lead");
        assert!(!late.is_bound());
        assert!(matches!(late.others(&caller).await, Err(PortError::Unavailable { .. })));
        assert!(late.bind(Arc::new(Held)).is_ok());
        assert!(late.is_bound());
        assert_eq!(late.others(&caller).await.unwrap()[0]["sessionId"], "bot-1");
        assert!(late.bind(Arc::new(Held)).is_err(), "a second bind is refused");
    }
}
