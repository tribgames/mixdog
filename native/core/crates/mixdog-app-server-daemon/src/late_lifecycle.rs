//! The lifecycle, for the parts of the composition that run before it exists. `serving::start` builds the `Lifecycle` after `compose()`
//! (it needs the ports the composed core provides), and three consumers of it are made inside `compose()`: the service-call count
//! (`CoreHandle::request_started`, Node's `inFlightWork().activeCalls`, `daemon.mjs:444-449`), the memory-agent run watch
//! (`busyMemoryAgents`, `:449`, `:1064`) and the fencing ownership (`Ownership::revalidate` failing moves the core to `Fenced`, LR §2.4).
//! They read it through this cell, which `serving::start` binds once, before the listener accepts.
//!
//! Node's `activeCalls` also counts the model-proxy bridge's active requests (`modelProxyBridgeActive`, set by `trackWork`,
//! `daemon.mjs:743-752`, `createModelProxyBridgeServer`). Rust has no server of that bridge (no `ModelProxyBridge` in any crate), so
//! there is nothing to count yet; the port of it takes `ComposedCore::request_started` for its `trackWork`.

use std::sync::Arc;
use std::sync::OnceLock;

use mixdog_core::run_host::late::Bound;

use crate::lifecycle::Lifecycle;

#[derive(Default)]
pub struct LateLifecycle(OnceLock<Arc<Lifecycle>>);

impl LateLifecycle {
    pub fn bind(&self, lifecycle: Arc<Lifecycle>) -> Result<(), &'static str> {
        self.0.set(lifecycle).map_err(|_| "lifecycle")
    }

    /// `None` before the bind: a startup bug (the listener accepts only after it), which each reader reports in its own words.
    pub fn get(&self) -> Option<&Arc<Lifecycle>> {
        self.0.get()
    }
}

impl Bound for LateLifecycle {
    fn cell(&self) -> &'static str {
        "lifecycle"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::ClientKind;
    use crate::lifecycle::testing::fixture;

    #[test]
    fn a_call_in_flight_keeps_an_unattended_core_alive_and_the_last_one_ends_it_with_nodes_text() {
        let fx = fixture();
        fx.lifecycle.set_serving().unwrap();
        let late = LateLifecycle::default();
        assert!(late.get().is_none());
        late.bind(fx.lifecycle.clone()).unwrap();
        assert!(late.bind(fx.lifecycle.clone()).is_err(), "bound once");
        let client = fx.lifecycle.connection(ClientKind::Session);
        let call = late.get().unwrap().begin_call();
        drop(client);
        assert!(!fx.recorder.has_exited(), "the call keeps the core alive");
        drop(call);
        fx.recorder.wait_exit();
        let events = fx.recorder.events();
        assert!(events.iter().any(|e| e == "release_started:service calls settled"), "{events:?}");
    }
}