//! A setup owner whose parts are built after the setup service: the route actions need the route service and the
//! built directory, and the setup service is composed (with every owner's action names) before either exists. The
//! service registers this cell by the names it will serve; the owner is bound once it is built.

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_ports::ports::setup_actions::SetupActions;
use mixdog_core_ports::ports::setup_actions::SetupCall;
use mixdog_core_session::session::route_setup::CoreCalls;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

use crate::compose_domains::LateDomains;

pub struct LateSetupActions {
    actions: &'static [&'static str],
    owner: OnceLock<Arc<dyn SetupActions>>,
}

impl LateSetupActions {
    pub fn new(actions: &'static [&'static str]) -> Arc<Self> {
        Arc::new(Self { actions, owner: OnceLock::new() })
    }

    /// Binds the built owner; a second bind is refused.
    pub fn bind(&self, owner: Arc<dyn SetupActions>) -> Result<(), &'static str> {
        self.owner.set(owner).map_err(|_| "setup actions")
    }
}

#[async_trait]
impl SetupActions for LateSetupActions {
    fn actions(&self) -> &'static [&'static str] {
        self.actions
    }

    async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
        match self.owner.get() {
            Some(owner) => owner.run(call).await,
            None => Err(PortError::Unavailable { capability: "setup".to_owned(), message: format!("setup {} was called before its owner was bound", call.action) }),
        }
    }
}

/// The configure lane of the route actions (`CoreCalls`): one core method on another thread, over the registered services.
pub struct DomainCoreCalls(pub Arc<LateDomains>);

#[async_trait]
impl CoreCalls for DomainCoreCalls {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        self.0.call(method, params).await
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::ids::ThreadId;
    use serde_json::json;

    use super::*;

    struct Owner;

    #[async_trait]
    impl SetupActions for Owner {
        fn actions(&self) -> &'static [&'static str] {
            &["set_route"]
        }

        async fn run(&self, call: &SetupCall<'_>) -> Result<Value, PortError> {
            Ok(json!({ "ran": call.action }))
        }
    }

    /// The cell serves its names from the start, refuses a call until its owner is bound, and takes one owner.
    #[tokio::test]
    async fn a_call_reaches_the_owner_once_it_is_bound() {
        let cell = LateSetupActions::new(&["set_route"]);
        assert_eq!(cell.actions(), ["set_route"]);
        let (args, thread) = (json!({}), ThreadId::from("sess_a"));
        let call = SetupCall { action: "set_route", args: &args, thread: &thread };
        assert!(matches!(cell.run(&call).await, Err(PortError::Unavailable { .. })));
        cell.bind(Arc::new(Owner)).unwrap();
        assert_eq!(cell.run(&call).await.unwrap(), json!({ "ran": "set_route" }));
        assert!(cell.bind(Arc::new(Owner)).is_err());
    }
}
