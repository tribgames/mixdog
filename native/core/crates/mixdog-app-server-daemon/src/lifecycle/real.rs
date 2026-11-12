//! The real lifecycle ports (LR §5.3): the core's feed, connections, extension host and data
//! handles; the discovery file; the process exit. WP-INTEGRATE composes them.
//!
//! The release steps run on `mixdog-release-<step>` threads (one per step, under the release
//! supervisor), never on a runtime worker, so
//! `RuntimeCore::close_ext_host` can block on the extension host's async close through a runtime
//! handle without stalling the runtime.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::mpsc;

use bytes::Bytes;
use mixdog_app_protocol::v2::host::CoreDrainParams;
use mixdog_app_protocol::v2::host::DrainRunning;
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
///
/// An abort can run between `begin_activity` and `track`: it lists the activity but finds no
/// token, and a second abort is refused once the first one started. So the first abort marks the
/// registry, and a `track` that comes after the mark cancels its token at once.
#[derive(Default)]
pub struct CancelRegistry {
    state: Mutex<Tokens>,
}

#[derive(Default)]
struct Tokens {
    by_activity: HashMap<u64, CancellationToken>,
    aborting: bool,
}

impl CancelRegistry {
    pub fn track(self: &Arc<Self>, activity_id: u64, token: CancellationToken) -> Tracked {
        let mut state = locked(&self.state);
        if state.aborting {
            token.cancel();
        }
        state.by_activity.insert(activity_id, token);
        drop(state);
        Tracked {
            registry: Arc::clone(self),
            activity_id,
        }
    }

    fn cancel(&self, running: &[Running]) {
        let mut state = locked(&self.state);
        state.aborting = true;
        for work in running {
            if let Some(token) = state.by_activity.get(&work.id) {
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
        locked(&self.registry.state).by_activity.remove(&self.activity_id);
    }
}

/// What the core port acts on.
pub struct CoreWiring {
    /// The app-feed section publisher (`SectionFeedState`).
    pub state: Arc<dyn StatePublisher>,
    pub connections: Arc<ConnectionHub>,
    pub ext_host: Arc<ExtHostPool>,
    /// The core's runtime, to await the extension host's close from the release thread.
    pub runtime: tokio::runtime::Handle,
    pub cancel: Arc<CancelRegistry>,
    /// Ends the new-task attempts in flight at a stop request (`SessionDirectory::cut_new_tasks`).
    pub cut_new_tasks: Hook,
    pub final_barriers: Hook,
    /// The user's `release{pid}` decision on an undecidable prior owner (the verdict gate).
    pub release_decision: Arc<dyn Fn(u32) + Send + Sync>,
    /// The core's stop steps (`ComposedCore::run_stop_steps`, wired in `serving.rs`). Product limit: the stopped core still holds `state/core.sqlite` and
    /// `index/store.sqlite` open in this process (the parts holding them outlive the stop and the runtime); only the process exit that ends the
    /// release (`ProcessExiter::exit`) closes them.
    pub close_data_handles: Hook,
    /// The release's Node-text reason (`CorePort::release_started`), kept for the stop steps.
    pub release_started: Arc<dyn Fn(&str) + Send + Sync>,
    /// Writes out the queued daemon-log lines (`DaemonLog::flush`), right before the process ends.
    pub flush_log: Hook,
    /// Sends the `core/drain` notification to every connected client. It is a notification, not
    /// a section, and `StatePublisher` carries sections only, so the composition supplies the
    /// app-feed sender.
    pub drain_feed: Arc<dyn Fn(CoreDrainParams) + Send + Sync>,
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
    /// The `core` section as `CoreState::Draining{reason}` (`protocol.md:298`,
    /// `mixdog-app-protocol/src/v1.rs:98`); the drain's id, running list and token go out as the
    /// separate `core/drain` notification (`lifecycle-remote.md:288`).
    fn drain_notice(&self, notice: &DrainNotice) {
        self.publish(SectionName::Core, &serde_json::json!({ "state": "draining", "reason": notice.reason }));
        (self.wiring.drain_feed)(CoreDrainParams {
            drain_id: notice.drain_id.clone(),
            running: notice
                .running
                .iter()
                .map(|work| DrainRunning {
                    thread_id: work.thread_id.clone(),
                    turn_id: work.turn_id.clone(),
                    kind: work.kind,
                    title: work.title.clone(),
                })
                .collect(),
            confirm_token: notice.confirm_token.clone(),
        });
    }

    /// The `core` section as `CoreState::Serving` (`mixdog-app-protocol/src/v1.rs`).
    fn serving(&self) {
        self.publish(SectionName::Core, &serde_json::json!({ "state": "serving" }));
    }

    fn health(&self, stalled_ms: u64) {
        self.publish(SectionName::CoreHealth, &serde_json::json!({ "stalledMs": stalled_ms }));
    }

    fn cancel_running(&self, running: &[Running]) {
        self.wiring.cancel.cancel(running);
    }

    fn cut_new_tasks(&self) {
        (self.wiring.cut_new_tasks)();
    }

    fn release_decision(&self, pid: u32) {
        (self.wiring.release_decision)(pid);
    }

    fn release_started(&self, reason: &str) {
        (self.wiring.release_started)(reason);
    }

    fn final_barriers(&self) {
        (self.wiring.final_barriers)();
    }

    fn close_connections(&self) {
        self.wiring.connections.close_all();
    }

    fn close_ext_host(&self) {
        self.wiring.runtime.block_on(self.wiring.ext_host.close());
    }

    fn close_data_handles(&self) {
        (self.wiring.close_data_handles)();
    }

    fn flush_log(&self) {
        (self.wiring.flush_log)();
    }
}

enum Job {
    Publish(Box<Discovery>),
    /// Everything queued before it has been written; `withdraw` removes the file as well.
    Barrier { withdraw: bool, done: mpsc::Sender<()> },
}

type WriteDocument = Box<dyn Fn(&Path, &Discovery) -> std::io::Result<()> + Send>;

/// What a publication that still fails after the replace's retries does. Boot-path states (`booting`, `blocked`, `migrating`,
/// `serving`) are fatal as Node's initial publication is (`daemon.mjs`: the awaited `publishDaemonDiscovery` rejects into
/// `main().catch`, which shuts down with code 2): a daemon whose discovery file never names it is one no client can reach.
/// A `draining` state is logged only, as Node logs a failed later republish.
pub type OnFatal = Box<dyn Fn(&std::io::Error) + Send>;

/// [`Publication`] over `<runtime root>/daemon.json`: the lifecycle contributes the phase, the
/// blocked record and the drain id; the rest of the document is the template.
///
/// `publish` is called inline from `Lifecycle::apply`, which can run on a runtime worker, and the
/// write syncs to disk. So the document is built on the caller and written by one
/// `mixdog-discovery` thread, in the order published: the last state wins.
pub struct DiscoveryPublication {
    base: Discovery,
    /// The RPC port, published only while serving.
    rpc: Mutex<Option<discovery::Port>>,
    jobs: Mutex<mpsc::Sender<Job>>,
}

impl DiscoveryPublication {
    /// `base` carries the pid, endpoints and the core section with its control port; its
    /// `state`, `blocked`, `drain` and `rpc` are replaced on every publish.
    pub fn new(root: PathBuf, base: Discovery, on_fatal: OnFatal) -> Self {
        let write: WriteDocument = Box::new(discovery::publish);
        Self::with_writer(root, base, write, on_fatal)
    }

    fn with_writer(root: PathBuf, base: Discovery, write: WriteDocument, on_fatal: OnFatal) -> Self {
        let (jobs, inbox) = mpsc::channel::<Job>();
        let instance_id = base.core.instance_id.clone();
        std::thread::Builder::new()
            .name("mixdog-discovery".into())
            .spawn(move || {
                for job in inbox {
                    match job {
                        Job::Publish(document) => {
                            if let Err(error) = write(&root, &document) {
                                tracing::error!(%error, "discovery was not published");
                                if document.core.state != CoreState::Draining {
                                    on_fatal(&error);
                                }
                            }
                        }
                        Job::Barrier { withdraw, done } => {
                            if withdraw && let Err(error) = discovery::withdraw(&root, &instance_id) {
                                tracing::error!(%error, "discovery was not withdrawn");
                            }
                            let _ = done.send(());
                        }
                    }
                }
            })
            .expect("the OS refused a discovery thread");
        Self {
            base,
            rpc: Mutex::new(None),
            jobs: Mutex::new(jobs),
        }
    }

    /// Records the bound RPC listener; the next `serving` publish names it.
    pub fn set_rpc_port(&self, port: u16) {
        *locked(&self.rpc) = Some(discovery::Port { port });
    }

    /// The bound RPC listener's port, once `set_rpc_port` has recorded it.
    pub fn rpc_port(&self) -> Option<u16> {
        locked(&self.rpc).as_ref().map(|port| port.port)
    }

    /// Blocks until every state published so far is on disk. Never call it from a runtime worker.
    pub fn flush(&self) {
        self.barrier(false);
    }

    fn barrier(&self, withdraw: bool) {
        let (done, wait) = mpsc::channel();
        if locked(&self.jobs).send(Job::Barrier { withdraw, done }).is_ok() {
            let _ = wait.recv();
        }
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
        // Sent under the sender's lock, so concurrent publishes keep the order `apply` decided.
        let _ = locked(&self.jobs).send(Job::Publish(Box::new(document)));
    }

    /// Runs on the release thread, after every queued state.
    fn withdraw(&self) {
        self.barrier(true);
    }
}

/// [`Exiter`] that ends the process once the release has finished.
pub struct ProcessExiter;

impl Exiter for ProcessExiter {
    #[allow(clippy::disallowed_methods, reason = "this is the one place the core ends its process")]
    fn exit(&self, code: i32) {
        crate::crash_record::record_exit(code);
        std::process::exit(code);
    }
}

#[cfg(test)]
#[path = "real_tests.rs"]
mod tests;
