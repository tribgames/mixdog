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

use crate::lifecycle::CorePort;
use crate::lifecycle::DiscoveryState;
use crate::lifecycle::DrainNotice;
use crate::lifecycle::Exiter;
use crate::lifecycle::Lifecycle;
use crate::lifecycle::LifecycleConfig;
use crate::lifecycle::Ports;
use crate::lifecycle::Publication;
use crate::lifecycle::Running;
use crate::lifecycle::new_instance_id;

/// The ports of [`LateLifecycle::bind_in_process`]: nothing to publish to, cancel or leave.
struct Inert;

impl CorePort for Inert {
    fn drain_notice(&self, _: &DrainNotice) {}
    fn health(&self, _: u64) {}
    fn cancel_running(&self, _: &[Running]) {}
    fn cut_new_tasks(&self) {}
    fn release_decision(&self, _: u32) {}
    fn final_barriers(&self) {}
    fn close_connections(&self) {}
    fn close_ext_host(&self) {}
    fn close_data_handles(&self) {}
}

impl Publication for Inert {
    fn publish(&self, _: &DiscoveryState) {}
    fn withdraw(&self) {}
}

impl Exiter for Inert {
    fn exit(&self, _: i32) {}
}

#[derive(Default)]
pub struct LateLifecycle(OnceLock<Arc<Lifecycle>>);

impl LateLifecycle {
    pub fn bind(&self, lifecycle: Arc<Lifecycle>) -> Result<(), &'static str> {
        self.0.set(lifecycle).map_err(|_| "lifecycle")
    }

    /// The lifecycle of a core that serves no daemon (`mixdog exec` composes its core in its own process): it counts the calls in flight,
    /// while nothing publishes, cancels, exits or withdraws on its behalf: the process ends when the exec does.
    pub fn bind_in_process(&self) -> Result<(), &'static str> {
        let ports = Ports { core: Arc::new(Inert), discovery: Arc::new(Inert), exiter: Arc::new(Inert) };
        let config = LifecycleConfig { instance_id: new_instance_id(), version: env!("CARGO_PKG_VERSION").to_owned(), runtime_root: std::path::PathBuf::new() };
        self.bind(Lifecycle::new(config, ports))
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