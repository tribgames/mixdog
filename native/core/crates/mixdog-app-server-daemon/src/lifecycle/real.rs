//! The real lifecycle ports (LR §5.3): the core's feed, connections, extension host and data
//! handles; the discovery file; the process exit. WP-INTEGRATE composes them.
//!
//! The release steps run on the `mixdog-release` thread, never on a runtime worker, so
//! `RuntimeCore::close_ext_host` can block on the extension host's async close through a runtime
//! handle without stalling the runtime.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use bytes::Bytes;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_core_api::StatePublisher;
use mixdog_core_api::state::SectionChange;
use mixdog_exthost::ExtHostPool;
use mixdog_protocol::SectionName;
use tokio_util::sync::CancellationToken;

use super::DiscoveryPhase;
use super::DiscoveryState;
use super::DrainNotice;
use super::Running;
use super::ports::CorePort;
use super::ports::Exiter;
use super::ports::Publication;
use crate::discovery;
use crate::discovery::CoreState;
use crate::discovery::Discovery;

/// A blocking step the composition supplies: the session actors' final barriers, or closing the
/// data handles (store logs, the data-dir handle).
pub type Hook = Arc<dyn Fn() + Send + Sync>;

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Cancellation tokens of registered work, by activity id. A registrant calls
/// [`CancelRegistry::track`] with its guard's id and the token its work observes; the entry goes
/// when the returned [`Tracked`] drops.
#[derive(Default)]
pub struct CancelRegistry {
    tokens: Mutex<HashMap<u64, CancellationToken>>,
}

impl CancelRegistry {
    pub fn track(self: &Arc<Self>, activity_id: u64, token: CancellationToken) -> Tracked {
        locked(&self.tokens).insert(activity_id, token);
        Tracked {
            registry: Arc::clone(self),
            activity_id,
        }
    }

    fn cancel(&self, running: &[Running]) {
        let tokens = locked(&self.tokens);
        for work in running {
            if let Some(token) = tokens.get(&work.id) {
                token.cancel();
            }
        }
    }
}

pub struct Tracked {
    registry: Arc<CancelRegistry>,
    activity_id: u64,
}

impl Drop for Tracked {
    fn drop(&mut self) {
        locked(&self.registry.tokens).remove(&self.activity_id);
    }
}

/// What the core port acts on.
pub struct CoreWiring {
    /// The app-feed section publisher (`SectionFeedState`).
    pub state: Arc<dyn StatePublisher>,
    pub connections: Arc<ConnectionHub>,
    /// `None` when no JavaScript runtime is installed.
    pub ext_host: Option<Arc<ExtHostPool>>,
    /// The core's runtime, to await the extension host's close from the release thread.
    pub runtime: tokio::runtime::Handle,
    pub cancel: Arc<CancelRegistry>,
    pub final_barriers: Hook,
    /// The user's `release{pid}` decision on an undecidable prior owner (the verdict gate).
    pub release_decision: Arc<dyn Fn(u32) + Send + Sync>,
    pub close_data_handles: Hook,
}

/// [`CorePort`] over the running core.
pub struct RuntimeCore {
    wiring: CoreWiring,
}

impl RuntimeCore {
    pub fn new(wiring: CoreWiring) -> Self {
        Self { wiring }
    }

    fn publish(&self, section: SectionName, value: &serde_json::Value) {
        match serde_json::to_vec(value) {
            Ok(bytes) => self.wiring.state.publish(section, None, SectionChange::Set(Bytes::from(bytes))),
            Err(error) => tracing::error!(%error, "a lifecycle section was not encoded"),
        }
    }
}

impl CorePort for RuntimeCore {
    /// The `core` section carrying `draining`, with the drain's id, running list and token.
    fn drain_notice(&self, notice: &DrainNotice) {
        self.publish(
            SectionName::Core,
            &serde_json::json!({
                "state": "draining",
                "reason": notice.reason,
                "drainId": notice.drain_id,
                "running": notice.running,
                "confirmToken": notice.confirm_token,
            }),
        );
    }

    fn health(&self, stalled_ms: u64) {
        self.publish(SectionName::CoreHealth, &serde_json::json!({ "stalledMs": stalled_ms }));
    }

    fn cancel_running(&self, running: &[Running]) {
        self.wiring.cancel.cancel(running);
    }

    fn release_decision(&self, pid: u32) {
        (self.wiring.release_decision)(pid);
    }

    fn final_barriers(&self) {
        (self.wiring.final_barriers)();
    }

    fn close_connections(&self) {
        self.wiring.connections.close_all();
    }

    fn close_ext_host(&self) {
        if let Some(pool) = &self.wiring.ext_host {
            self.wiring.runtime.block_on(pool.close());
        }
    }

    fn close_data_handles(&self) {
        (self.wiring.close_data_handles)();
    }
}

/// [`Publication`] over `<runtime root>/daemon.json`: the lifecycle contributes the phase, the
/// blocked record and the drain id; the rest of the document is the template.
pub struct DiscoveryPublication {
    root: PathBuf,
    base: Discovery,
    /// The RPC port, published only while serving.
    rpc: Mutex<Option<discovery::Port>>,
}

impl DiscoveryPublication {
    /// `base` carries the pid, endpoints and the core section with its control port; its
    /// `state`, `blocked`, `drain` and `rpc` are replaced on every publish.
    pub fn new(root: PathBuf, base: Discovery) -> Self {
        Self {
            root,
            base,
            rpc: Mutex::new(None),
        }
    }

    /// Records the bound RPC listener; the next `serving` publish names it.
    pub fn set_rpc_port(&self, port: u16) {
        *locked(&self.rpc) = Some(discovery::Port { port });
    }
}

impl Publication for DiscoveryPublication {
    fn publish(&self, state: &DiscoveryState) {
        let mut document = self.base.clone();
        document.core.state = match state.phase {
            DiscoveryPhase::Booting => CoreState::Booting,
            DiscoveryPhase::Blocked => CoreState::Blocked,
            DiscoveryPhase::Migrating => CoreState::Migrating,
            DiscoveryPhase::Serving => CoreState::Serving,
            DiscoveryPhase::Draining => CoreState::Draining,
        };
        document.core.blocked = state.blocked.as_ref().and_then(|blocked| serde_json::to_value(blocked).ok());
        document.core.drain = state.drain_id.as_ref().map(|id| serde_json::json!({ "drainId": id }));
        document.core.rpc = match state.phase {
            DiscoveryPhase::Serving => locked(&self.rpc).clone(),
            _ => None,
        };
        if let Err(error) = discovery::publish(&self.root, &document) {
            tracing::error!(%error, "discovery was not published");
        }
    }

    fn withdraw(&self) {
        if let Err(error) = discovery::withdraw(&self.root, &self.base.core.instance_id) {
            tracing::error!(%error, "discovery was not withdrawn");
        }
    }
}

/// [`Exiter`] that ends the process once the release has finished.
pub struct ProcessExiter;

impl Exiter for ProcessExiter {
    #[allow(clippy::disallowed_methods, reason = "this is the one place the core ends its process")]
    fn exit(&self) {
        std::process::exit(0);
    }
}

#[cfg(test)]
#[path = "real_tests.rs"]
mod tests;
