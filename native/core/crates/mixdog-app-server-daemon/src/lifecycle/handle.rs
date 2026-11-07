//! [`Lifecycle`]: the machine behind a lock, its published views, and the effect runner.
//!
//! One short `std::sync::Mutex` guards the machine. It is taken for map and counter updates
//! only — never across I/O, an await or a port call — so unrelated sessions and clients meet
//! it for microseconds at turn start/end and at connect/disconnect, and nothing else. Effects
//! are queued under it, so they keep transition order, and run after it is released.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use arc_swap::ArcSwap;
use mixdog_core_api::CoreState;
use tokio::sync::watch;

use super::machine::Machine;
use super::model::ActivityInfo;
use super::model::Blocked;
use super::model::ClientKind;
use super::model::CommandError;
use super::model::CoreStatus;
use super::model::Effect;
use super::model::FenceReason;
use super::model::Migration;
use super::model::ReleaseCause;
use super::model::StopMode;
use super::model::StopReason;
use super::ports::CorePort;
use super::ports::Ports;
use super::release::LastExit;
use super::release::write_last_exit;
use super::supervisor::ReleaseBudgets;
use super::supervisor::StepEnd;
use super::supervisor::supervise;

#[derive(Debug, Clone)]
pub struct LifecycleConfig {
    pub instance_id: String,
    pub version: String,
    /// `<runtime root>`: where `last-exit.json` goes.
    pub runtime_root: PathBuf,
}

#[derive(Default)]
struct Emit {
    queue: VecDeque<Effect>,
    active: bool,
}

/// A fresh 128-bit instance id (LR §4 `core.instanceId`).
pub fn new_instance_id() -> String {
    super::machine::hex(&rand::random::<[u8; 16]>())
}

pub struct Lifecycle {
    machine: Mutex<Machine>,
    emit: Mutex<Emit>,
    status: ArcSwap<CoreStatus>,
    state_tx: watch::Sender<CoreState>,
    hold_tx: watch::Sender<bool>,
    ports: Ports,
    cfg: LifecycleConfig,
    budgets: ReleaseBudgets,
    stalled_ms: AtomicU64,
    /// See [`Lifecycle::note_trigger`].
    trigger: Mutex<Option<String>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Lifecycle {
    pub fn new(cfg: LifecycleConfig, ports: Ports) -> Arc<Self> {
        Self::with_budgets(cfg, ports, ReleaseBudgets::default())
    }

    pub fn with_budgets(cfg: LifecycleConfig, ports: Ports, budgets: ReleaseBudgets) -> Arc<Self> {
        let machine = Machine::new(cfg.instance_id.clone(), cfg.version.clone());
        let status = ArcSwap::from_pointee(machine.status());
        let (state_tx, _) = watch::channel(machine.core_state());
        let (hold_tx, _) = watch::channel(false);
        Arc::new(Self {
            machine: Mutex::new(machine),
            emit: Mutex::new(Emit::default()),
            status,
            state_tx,
            hold_tx,
            ports,
            cfg,
            budgets,
            stalled_ms: AtomicU64::new(0),
            trigger: Mutex::new(None),
        })
    }

    /// The text Node's `shutdown(reason)` carries for the trigger that is about to stop the core, when the cause enum cannot say it (a signal's
    /// name: `SIGTERM`, `SIGINT`, `SIGHUP`, `SIGBREAK`, `daemon.mjs:1298-1308`). The first note wins; the release hands it to the core.
    pub fn note_trigger(&self, text: &str) {
        locked(&self.trigger).get_or_insert_with(|| text.to_owned());
    }

    // ---- views ------------------------------------------------------------------------

    /// The snapshot the control thread serves; reading it takes no lock.
    pub fn status(&self) -> Arc<CoreStatus> {
        self.status.load_full()
    }

    /// `CoreHandle::lifecycle()`: admission reads it.
    pub fn state(&self) -> watch::Receiver<CoreState> {
        self.state_tx.subscribe()
    }

    /// Turn starts wait while this is `true` (LR §5.1 step 1: deferred, not refused).
    pub fn hold_gate(&self) -> watch::Receiver<bool> {
        self.hold_tx.subscribe()
    }

    pub fn stalled_ms(&self) -> u64 {
        self.stalled_ms.load(Ordering::Relaxed)
    }

    pub(crate) fn set_stalled_ms(&self, value: u64) {
        self.stalled_ms.store(value, Ordering::Relaxed);
    }

    // ---- registrations by the running core --------------------------------------------

    /// Registers a unit of work until the guard drops. A guard of a kind that blocks idle
    /// holds a stop's idle wait; goals, schedules and channels only keep the core alive.
    pub fn begin_activity(self: &Arc<Self>, info: ActivityInfo) -> ActivityGuard {
        let id = self.apply(|m| m.begin_activity(info));
        ActivityGuard { lifecycle: Arc::clone(self), id }
    }

    /// As [`Lifecycle::begin_activity`], for work whose end lets the core stop with a Node text of its own
    /// ([`super::model::SERVICE_CALLS_SETTLED`], [`super::model::MEMORY_AGENT_ACTIVITY_CHANGED`]).
    pub fn begin_activity_settling(self: &Arc<Self>, info: ActivityInfo, settled: &'static str) -> ActivityGuard {
        let id = self.apply(|m| m.begin_activity_settling(info, settled));
        ActivityGuard { lifecycle: Arc::clone(self), id }
    }

    /// Counts one service call in flight until the guard drops (Node's `activeCalls`, `daemon.mjs:444-449`): with nobody attached the
    /// core does not stop itself while one runs, and the last one ending reads 'service calls settled' (`:543`).
    pub fn begin_call(self: &Arc<Self>) -> CallGuard {
        self.apply(Machine::call_started);
        CallGuard { lifecycle: Arc::clone(self) }
    }

    /// Registers one open client connection (any origin) until the guard drops; `kind` is the registry it is in, which names Node's
    /// self-shutdown text when it is the last one to leave.
    pub fn connection(self: &Arc<Self>, kind: ClientKind) -> ConnectionGuard {
        self.apply(Machine::client_opened);
        ConnectionGuard { lifecycle: Arc::clone(self), kind }
    }

    // ---- boot (LR §3) -----------------------------------------------------------------

    pub fn set_blocked(self: &Arc<Self>, blocked: Blocked) -> Result<(), CommandError> {
        self.apply(|m| m.set_blocked(blocked))
    }

    pub fn set_migrating(self: &Arc<Self>, migration: Migration) -> Result<(), CommandError> {
        self.apply(|m| m.set_migrating(migration))
    }

    pub fn set_serving(self: &Arc<Self>) -> Result<(), CommandError> {
        self.apply(Machine::set_serving)
    }

    /// Revalidation failed: close admission and leave (LR §2.4).
    pub fn fence(self: &Arc<Self>, reason: FenceReason) {
        self.apply(|m| m.fence(reason));
    }

    /// [`Lifecycle::fence`] for a lost owner lock: Node words it with the lock file's path (`daemon.mjs:655`,
    /// `owner lock file ${OWNER_LOCK_PATH} was deleted or replaced`), which only the caller knows.
    pub fn fence_lock_file(self: &Arc<Self>, lock_file: &std::path::Path) {
        self.note_trigger(&format!("owner lock file {} was deleted or replaced", lock_file.display()));
        self.fence(FenceReason::LockFileReplaced);
    }

    // ---- management commands (LR §6.1) ------------------------------------------------

    pub fn hold(self: &Arc<Self>, on: bool) -> Result<(), CommandError> {
        self.apply(|m| m.hold(on))
    }

    pub fn stop(
        self: &Arc<Self>,
        mode: StopMode,
        reason: StopReason,
        confirm_token: Option<&str>,
    ) -> Result<(), CommandError> {
        self.apply(|m| m.stop(mode, reason, confirm_token))
    }

    /// [`Lifecycle::stop`] with Node's text of this request (`daemon.mjs:272` `shutdown(reason)`), noted before the machine decides so a
    /// release that starts inside the call already has it; a refused stop takes it back.
    pub fn stop_noting(
        self: &Arc<Self>,
        mode: StopMode,
        reason: StopReason,
        confirm_token: Option<&str>,
        node_reason: &str,
    ) -> Result<(), CommandError> {
        let fresh = locked(&self.trigger).is_none();
        self.note_trigger(node_reason);
        let result = self.stop(mode, reason, confirm_token);
        if result.is_err() && fresh {
            locked(&self.trigger).take();
        }
        result
    }

    pub fn cancel_drain(self: &Arc<Self>, drain_id: &str) -> Result<(), CommandError> {
        self.apply(|m| m.cancel_drain(drain_id))
    }

    pub fn release_decision(
        self: &Arc<Self>,
        pid: u32,
        confirm_token: &str,
    ) -> Result<(), CommandError> {
        self.apply(|m| m.release_decision(pid, confirm_token))
    }

    /// The stalled-core exit (LR §6.1). It touches nothing the runtime owns: it checks the
    /// token, records the exit, lets the caller answer, and calls the exiter. Storage
    /// consistency is the crash case of the store invariants.
    pub fn terminate(
        &self,
        confirm_token: &str,
        acknowledge: impl FnOnce(),
    ) -> Result<(), CommandError> {
        locked(&self.machine).check_terminate(confirm_token)?;
        let record = LastExit {
            reason: "userTerminated".to_owned(),
            instance_id: self.cfg.instance_id.clone(),
            stalled_ms: Some(self.stalled_ms()),
            stuck_step: None,
        };
        if let Err(error) = write_last_exit(&self.cfg.runtime_root, &record) {
            tracing::error!(%error, "last-exit.json was not written");
        }
        acknowledge();
        self.ports.exiter.exit();
        Ok(())
    }

    // ---- internals --------------------------------------------------------------------

    fn apply<R>(self: &Arc<Self>, change: impl FnOnce(&mut Machine) -> R) -> R {
        let mut machine = locked(&self.machine);
        let out = change(&mut machine);
        self.status.store(Arc::new(machine.status()));
        let state = machine.core_state();
        self.state_tx.send_if_modified(|current| {
            let changed = *current != state;
            if changed {
                *current = state;
            }
            changed
        });
        let hold = machine.hold_on();
        self.hold_tx.send_if_modified(|current| {
            let changed = *current != hold;
            *current = hold;
            changed
        });
        let effects = machine.take_effects();
        if effects.is_empty() {
            return out;
        }
        // Queued under the machine lock, so the queue is in transition order. One caller at a
        // time drains it; a port that calls back into the lifecycle only enqueues.
        let drive = {
            let mut emit = locked(&self.emit);
            emit.queue.extend(effects);
            !std::mem::replace(&mut emit.active, true)
        };
        drop(machine);
        if drive {
            loop {
                let next = {
                    let mut emit = locked(&self.emit);
                    match emit.queue.pop_front() {
                        Some(effect) => effect,
                        None => {
                            emit.active = false;
                            break;
                        }
                    }
                };
                self.run(next);
            }
        }
        out
    }

    fn run(self: &Arc<Self>, effect: Effect) {
        match effect {
            Effect::Discovery(state) => self.ports.discovery.publish(&state),
            Effect::DrainNotice(notice) => self.ports.core.drain_notice(&notice),
            Effect::CancelRunning(running) => self.ports.core.cancel_running(&running),
            Effect::ReleaseDecision { pid } => self.ports.core.release_decision(pid),
            Effect::NodeTrigger(text) => self.note_trigger(text),
            Effect::BeginRelease(cause) => {
                let lifecycle = Arc::clone(self);
                std::thread::Builder::new()
                    .name("mixdog-release".into())
                    .spawn(move || lifecycle.release(cause))
                    .expect("the OS refused a release thread");
            }
        }
    }

    /// LR §5.3: final barriers, close connections, close the extension host, record the exit,
    /// withdraw discovery, close data handles, release `L` by leaving.
    ///
    /// Each step runs under the supervisor with its budget. A step over its budget is abandoned
    /// on its thread and named in `last-exit.json` (`stuckStep`); the release then skips the
    /// rest of the closing steps, records, withdraws discovery and exits anyway.
    fn release(self: &Arc<Self>, cause: ReleaseCause) {
        let budgets = self.budgets;
        let core = &self.ports.core;
        // Before any step: the stop steps (run inside `closeDataHandles`) abort the agent runs with Node's text of this stop.
        let node_reason = locked(&self.trigger).take().unwrap_or_else(|| cause.node_text());
        core.release_started(&node_reason);
        let closing: [(&'static str, Duration, fn(&dyn CorePort)); 3] = [
            ("finalBarriers", budgets.final_barriers, |core| core.final_barriers()),
            ("closeConnections", budgets.close_connections, |core| core.close_connections()),
            ("closeExtHost", budgets.close_ext_host, |core| core.close_ext_host()),
        ];
        let mut stuck = None;
        for (name, budget, step) in closing {
            let core = Arc::clone(core);
            if supervise(name, budget, move || step(&*core)) == StepEnd::OverBudget {
                stuck = Some(name);
                break;
            }
        }
        let closed = stuck.is_none();
        let reason = cause.text();
        self.record_exit(&reason, stuck);
        let discovery = Arc::clone(&self.ports.discovery);
        if supervise("withdrawDiscovery", budgets.withdraw_discovery, move || discovery.withdraw()) == StepEnd::OverBudget {
            stuck.get_or_insert("withdrawDiscovery");
            self.record_exit(&reason, stuck);
        }
        if closed {
            let core = Arc::clone(core);
            if supervise("closeDataHandles", budgets.close_data_handles, move || core.close_data_handles()) == StepEnd::OverBudget {
                self.record_exit(&reason, stuck.or(Some("closeDataHandles")));
            }
        }
        // Node's exit hook writes the queued log tail on every exit, a forced one included (`daemon.mjs:153`); `closeDataHandles` is skipped
        // when an earlier step was stuck, so the flush has its own step. It goes through the log's own queue and lane, under the
        // supervisor's existing record budget: a disk that never answers cannot hold the exit.
        let flush = Arc::clone(core);
        supervise("flushLog", budgets.record_exit, move || flush.flush_log());
        self.apply(Machine::mark_stopped);
        self.ports.exiter.exit();
    }

    fn record_exit(&self, reason: &str, stuck_step: Option<&'static str>) {
        let record = LastExit {
            reason: reason.to_owned(),
            instance_id: self.cfg.instance_id.clone(),
            stalled_ms: None,
            stuck_step: stuck_step.map(str::to_owned),
        };
        let root = self.cfg.runtime_root.clone();
        supervise("recordExit", self.budgets.record_exit, move || {
            if let Err(error) = write_last_exit(&root, &record) {
                tracing::error!(%error, "last-exit.json was not written");
            }
        });
    }
}

pub struct ActivityGuard {
    lifecycle: Arc<Lifecycle>,
    id: u64,
}

impl ActivityGuard {
    /// The id `Running` carries, which `cancel_running` names the unit of work by.
    pub fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.lifecycle.apply(|m| m.end_activity(self.id));
    }
}

/// One service call in flight; see [`Lifecycle::begin_call`].
pub struct CallGuard {
    lifecycle: Arc<Lifecycle>,
}

impl Drop for CallGuard {
    fn drop(&mut self) {
        self.lifecycle.apply(Machine::call_ended);
    }
}

pub struct ConnectionGuard {
    lifecycle: Arc<Lifecycle>,
    kind: ClientKind,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.lifecycle.apply(|m| m.client_closed(self.kind));
    }
}
