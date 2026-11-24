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
use mixdog_core_session::session::StartHold;
use tokio::sync::watch;

use super::grace::ThreadTimer;
use super::machine::Machine;
use super::model::ActivityInfo;
use super::model::Blocked;
use super::model::ClientGrace;
use super::model::ClientKind;
use super::model::CommandError;
use super::model::CoreStatus;
use super::model::DiscoveryPhase;
use super::model::Effect;
use super::model::FenceReason;
use super::model::Migration;
use super::model::ReleaseCause;
use super::model::StopMode;
use super::model::StopReason;
use super::ports::CorePort;
use super::ports::GraceTimer;
use super::ports::ManagedDrain;
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
    hold_tx: watch::Sender<StartHold>,
    ports: Ports,
    cfg: LifecycleConfig,
    budgets: ReleaseBudgets,
    #[cfg(test)]
    pub(super) test_backstop: Mutex<Option<TestBackstop>>,
    stalled_ms: AtomicU64,
    /// See [`Lifecycle::note_trigger`].
    trigger: Mutex<Option<String>>,
    timer: Arc<dyn GraceTimer>,
    /// The pending no-clients grace; dropping it cancels the timer.
    grace_timer: Mutex<Option<Box<dyn Send>>>,
    /// The pending hold TTL; dropping it cancels the timer.
    hold_timer: Mutex<Option<Box<dyn Send>>>,
}

/// The backstop's wait taken over by a test: `armed` is told the deadline the release armed, and the backstop fires when `expire` is sent to.
#[cfg(test)]
pub(super) struct TestBackstop {
    pub armed: std::sync::mpsc::Sender<Duration>,
    pub expire: std::sync::mpsc::Receiver<()>,
}

/// The longest [`Lifecycle::release`] waits on its steps, each given its whole budget: the final barriers, the stop steps, the withdrawal, the
/// connections and the extension host once each, and the exit record three times at most (after the stop steps, again after a later step
/// that is stuck, and the log flush, which runs under the same budget). The backstop is due only past it, so it never ends a step that is
/// inside its own budget: Node's 15 s whole-shutdown ceiling (`SHUTDOWN_BUDGET_MS`) is shorter than the budgets the durable steps here have.
fn release_bound(budgets: &ReleaseBudgets) -> Duration {
    [
        budgets.final_barriers,
        budgets.close_data_handles,
        budgets.withdraw_discovery,
        budgets.close_connections,
        budgets.close_ext_host,
        budgets.record_exit,
        budgets.record_exit,
        budgets.record_exit,
    ]
    .into_iter()
    .fold(Duration::ZERO, Duration::saturating_add)
}

/// The exit status of a core the stall watchdog ended: a failure, as a launcher reads every status but 0 (`ensure-core.mjs`
/// `endedBeforeServing`).
const STALLED_EXIT_CODE: i32 = 1;

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn drain_exit(drain: &ManagedDrain, cause: ReleaseCause) -> (&'static str, i32) {
    use mixdog_spawn::ShutdownOutcome;

    let code = cause.exit_code();
    match drain.get() {
        Some(ShutdownOutcome::ConfirmedFailure) => (" (managed process drain failed)", if code == 0 { 1 } else { code }),
        Some(ShutdownOutcome::Unverified) => (" (managed process drain coverage unverified)", code),
        Some(ShutdownOutcome::Clean) | None => ("", code),
    }
}

impl Lifecycle {
    pub fn new(cfg: LifecycleConfig, ports: Ports) -> Arc<Self> {
        Self::with_budgets(cfg, ports, ReleaseBudgets::default())
    }

    pub fn with_budgets(cfg: LifecycleConfig, ports: Ports, budgets: ReleaseBudgets) -> Arc<Self> {
        Self::with_grace(cfg, ports, budgets, ClientGrace::node(), Arc::new(ThreadTimer))
    }

    /// As [`Lifecycle::with_budgets`], with the no-clients grace durations and the clock that runs them.
    pub fn with_grace(cfg: LifecycleConfig, ports: Ports, budgets: ReleaseBudgets, grace: ClientGrace, timer: Arc<dyn GraceTimer>) -> Arc<Self> {
        let machine = Machine::new(cfg.instance_id.clone(), cfg.version.clone()).with_client_grace(grace);
        let status = ArcSwap::from_pointee(machine.status());
        let (state_tx, _) = watch::channel(machine.core_state());
        let (hold_tx, _) = watch::channel(StartHold::Open);
        Arc::new(Self {
            machine: Mutex::new(machine),
            emit: Mutex::new(Emit::default()),
            status,
            state_tx,
            hold_tx,
            ports,
            cfg,
            budgets,
            #[cfg(test)]
            test_backstop: Mutex::new(None),
            stalled_ms: AtomicU64::new(0),
            trigger: Mutex::new(None),
            timer,
            grace_timer: Mutex::new(None),
            hold_timer: Mutex::new(None),
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

    /// The hold on turn starts as the sessions read it: a client's start is refused and an in-core start waits while it is held (Node's work gate), and once
    /// the drain commit dropped it what it held is refused until the drain is cancelled; a confirmed abort closes the starts
    /// too. Decided with each move, under the machine lock, so a reader that wakes once after several moves reads the last of them.
    pub fn hold_gate(&self) -> watch::Receiver<StartHold> {
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

    /// As [`Lifecycle::begin_call`], for a new-task request: it holds a self-shutdown as a call does, and no longer holds the drain
    /// once a stop is requested (its attempt is cut then).
    pub fn begin_new_task(self: &Arc<Self>) -> NewTaskGuard {
        self.apply(Machine::new_task_started);
        NewTaskGuard { lifecycle: Arc::clone(self) }
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

    /// The discovery file could not be published (after the replace's retries): leave through the release with exit code 2.
    pub fn fail_boot(self: &Arc<Self>) {
        self.apply(Machine::fail_boot);
    }

    /// [`Lifecycle::fence`] for a lost owner lock: Node words it with the lock file's path (`daemon.mjs:655`,
    /// `owner lock file ${OWNER_LOCK_PATH} was deleted or replaced`), which only the caller knows.
    pub fn fence_lock_file(self: &Arc<Self>, lock_file: &std::path::Path) {
        self.note_trigger(&format!("owner lock file {} was deleted or replaced", lock_file.display()));
        self.fence(FenceReason::LockFileReplaced);
    }

    // ---- management commands (LR §6.1) ------------------------------------------------

    pub fn hold(self: &Arc<Self>, on: bool, ttl: Option<std::time::Duration>) -> Result<(), CommandError> {
        self.apply(|m| m.hold(on, ttl))
    }

    pub fn stop(self: &Arc<Self>, mode: StopMode, reason: StopReason, confirm_token: Option<&str>) -> Result<(), CommandError> {
        self.apply(|m| m.stop(mode, reason, confirm_token))
    }

    /// A `Quit` request over the control listener to stop the core ([`Machine::defers_stop`]): put off while a client is attached, as
    /// Node's `/shutdown` is (`daemon.mjs:508-529`); the core then stops when the last client leaves. Everything else is [`Lifecycle::stop`].
    pub fn request_stop(self: &Arc<Self>, mode: StopMode, reason: StopReason, confirm_token: Option<&str>) -> Result<(), CommandError> {
        if mode == StopMode::Force {
            return self.stop_noting(mode, reason, confirm_token, super::model::FORCED_STOP_TEXT);
        }
        self.apply(|m| {
            if m.defers_stop(mode, reason) {
                tracing::info!(?reason, "stop deferred: clients are still attached");
                return Ok(());
            }
            m.stop(mode, reason, confirm_token)
        })
    }

    /// [`Lifecycle::stop`] with Node's text of this request (`daemon.mjs:272` `shutdown(reason)`), noted before the machine decides so a
    /// release that starts inside the call already has it; a refused stop takes it back.
    pub fn stop_noting(self: &Arc<Self>, mode: StopMode, reason: StopReason, confirm_token: Option<&str>, node_reason: &str) -> Result<(), CommandError> {
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

    pub fn release_decision(self: &Arc<Self>, pid: u32, confirm_token: &str) -> Result<(), CommandError> {
        self.apply(|m| m.release_decision(pid, confirm_token))
    }

    /// The stalled-core exit (LR §6.1). It touches nothing the runtime owns: it checks the
    /// token, records the exit, lets the caller answer, and calls the exiter. Storage
    /// consistency is the crash case of the store invariants.
    pub fn terminate(&self, confirm_token: &str, acknowledge: impl FnOnce()) -> Result<(), CommandError> {
        locked(&self.machine).check_terminate(confirm_token)?;
        self.leave_stalled("userTerminated");
        acknowledge();
        self.ports.exiter.exit(0);
        Ok(())
    }

    /// The stall monitor's end of a core whose runtime answered nothing for the stall limit (LR §5.4): the stalled-core exit of
    /// [`Self::terminate`], recorded as the watchdog's and ending with a failure status, since nobody asked for it.
    pub fn end_stalled(&self) {
        self.leave_stalled("watchdogTerminated");
        self.ports.exiter.exit(crate::crash_record::settle_exit("the stall watchdog ended a runtime that answered nothing", STALLED_EXIT_CODE));
    }

    /// What the stalled-core exit does before the process ends, touching nothing the runtime owns: `last-exit.json` names `reason` and the
    /// stall, and the discovery file no longer names this core.
    fn leave_stalled(&self, reason: &str) {
        let record = LastExit { reason: reason.to_owned(), instance_id: self.cfg.instance_id.clone(), stalled_ms: Some(self.stalled_ms()), stuck_step: None };
        if let Err(error) = write_last_exit(&self.cfg.runtime_root, &record) {
            tracing::error!(%error, "last-exit.json was not written");
        }
        // A controlled exit, unlike a kill: the file does not keep naming a core that is gone. The file operation is made
        // here, not through the discovery thread, which may be the stalled part.
        if let Err(error) = crate::discovery::withdraw(&self.cfg.runtime_root, &self.cfg.instance_id) {
            tracing::error!(%error, "discovery was not withdrawn");
        }
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
        let hold = if machine.hold_on() { StartHold::Held } else { machine.starts_closed().map_or(StartHold::Open, StartHold::Closed) };
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
            Effect::Discovery(state) => {
                self.ports.discovery.publish(&state);
                if state.phase == DiscoveryPhase::Serving {
                    self.ports.core.serving();
                }
            }
            Effect::DrainNotice(notice) => self.ports.core.drain_notice(&notice),
            Effect::CancelRunning(running) => self.ports.core.cancel_running(&running),
            Effect::CutNewTasks => self.ports.core.cut_new_tasks(),
            Effect::ReopenNewTasks => self.ports.core.reopen_new_tasks(),
            Effect::ReleaseDecision { pid } => self.ports.core.release_decision(pid),
            Effect::NodeTrigger(text) => self.note_trigger(text),
            Effect::ArmGrace { generation, delay } => {
                let lifecycle = Arc::downgrade(self);
                let pending = self.timer.after(
                    delay,
                    Box::new(move || {
                        if let Some(lifecycle) = lifecycle.upgrade() {
                            lifecycle.apply(|m| m.grace_expired(generation));
                        }
                    }),
                );
                *locked(&self.grace_timer) = Some(pending);
            }
            Effect::CancelGrace => drop(locked(&self.grace_timer).take()),
            Effect::ArmHold { generation, delay } => {
                let lifecycle = Arc::downgrade(self);
                let pending = self.timer.after(
                    delay,
                    Box::new(move || {
                        if let Some(lifecycle) = lifecycle.upgrade() {
                            lifecycle.apply(|m| m.hold_expired(generation));
                        }
                    }),
                );
                *locked(&self.hold_timer) = Some(pending);
            }
            Effect::CancelHold => drop(locked(&self.hold_timer).take()),
            Effect::BeginRelease(cause) => {
                let lifecycle = Arc::clone(self);
                std::thread::Builder::new().name("mixdog-release".into()).spawn(move || lifecycle.release(cause)).expect("the OS refused a release thread");
            }
        }
    }

    fn release(self: &Arc<Self>, cause: ReleaseCause) {
        let budgets = self.budgets;
        let core = &self.ports.core;
        // Before any step: the stop steps (run inside `closeDataHandles`) abort the agent runs with Node's text of this stop.
        let node_reason = locked(&self.trigger).take().unwrap_or_else(|| cause.node_text());
        let drain = Arc::new(ManagedDrain::new());
        let finished = self.arm_backstop(&node_reason, &drain, cause);
        core.release_started(&node_reason);
        type Step = (&'static str, Duration, fn(&dyn CorePort));
        // What must not be lost comes first and waits behind nothing that can take long: the stop steps (Node's order: the sessions' teardown, which
        // cancels the live runs and commits them as interrupted and closes the agents, then the records and the database) run right after the final
        // barriers. Connections and the extension host, which Node closed after its sessions and last of all, follow.
        let mut stuck = None;
        let barriers = Arc::clone(core);
        if supervise("finalBarriers", budgets.final_barriers, move || barriers.final_barriers()) == StepEnd::OverBudget {
            stuck = Some("finalBarriers");
        } else {
            let core = Arc::clone(core);
            let drain = Arc::clone(&drain);
            if supervise("closeDataHandles", budgets.close_data_handles, move || core.close_data_handles(&drain)) == StepEnd::OverBudget {
                stuck = Some("closeDataHandles");
            }
        }
        let rest: [Step; 2] = [
            ("closeConnections", budgets.close_connections, |core| core.close_connections()),
            ("closeExtHost", budgets.close_ext_host, |core| core.close_ext_host()),
        ];
        let run = |steps: [Step; 2], stuck: &mut Option<&'static str>| {
            for (name, budget, step) in steps {
                let core = Arc::clone(core);
                if supervise(name, budget, move || step(&*core)) == StepEnd::OverBudget {
                    *stuck = Some(name);
                    break;
                }
            }
        };
        let (detail, code) = drain_exit(&drain, cause);
        let reason = format!("{}{detail}", cause.text());
        self.record_exit(&reason, stuck);
        let discovery = Arc::clone(&self.ports.discovery);
        if supervise("withdrawDiscovery", budgets.withdraw_discovery, move || discovery.withdraw()) == StepEnd::OverBudget {
            stuck.get_or_insert("withdrawDiscovery");
            self.record_exit(&reason, stuck);
        }
        if stuck.is_none() {
            run(rest, &mut stuck);
            if stuck.is_some() {
                self.record_exit(&reason, stuck);
            }
        }
        // Node's exit hook writes the queued log tail on every exit, a forced one included (`daemon.mjs:153`); the stop steps are skipped
        // when an earlier step was stuck, so the flush has its own step. It goes through the log's own queue and lane, under the
        // supervisor's existing record budget: a disk that never answers cannot hold the exit.
        let flush = Arc::clone(core);
        supervise("flushLog", budgets.record_exit, move || flush.flush_log());
        self.apply(Machine::mark_stopped);
        drop(finished);
        self.ports.exiter.exit(crate::crash_record::settle_exit(&format!("{node_reason}{detail}"), code));
    }

    fn arm_backstop(self: &Arc<Self>, node_reason: &str, drain: &Arc<ManagedDrain>, cause: ReleaseCause) -> std::sync::mpsc::Sender<()> {
        let (finished, backstop) = std::sync::mpsc::channel::<()>();
        let lifecycle = Arc::clone(self);
        let node_reason = node_reason.to_owned();
        let drain = Arc::clone(drain);
        let deadline = release_bound(&self.budgets);
        #[cfg(test)]
        let test_backstop = locked(&self.test_backstop).take();
        let spawned = std::thread::Builder::new().name("mixdog-release-backstop".into()).spawn(move || {
            let wait_for_budget = || backstop.recv_timeout(deadline) == Err(std::sync::mpsc::RecvTimeoutError::Timeout);
            #[cfg(not(test))]
            let expired = wait_for_budget();
            #[cfg(test)]
            let expired = match &test_backstop {
                Some(test) => {
                    let _ = test.armed.send(deadline);
                    test.expire.recv().is_ok()
                }
                None => wait_for_budget(),
            };
            if expired {
                tracing::error!("shutdown budget exceeded, forcing exit");
                let (detail, code) = drain_exit(&drain, cause);
                // On disk before the process ends: the write is bounded by its own budget.
                lifecycle.record_exit(&format!("{}{detail}", cause.text()), Some("shutdownBudget"));
                let reason = format!("{node_reason}{detail} (budget exceeded, forced exit)");
                lifecycle.ports.exiter.exit(crate::crash_record::settle_exit(&reason, code));
            }
        });
        if let Err(error) = spawned {
            tracing::error!(%error, "the release backstop did not start");
        }
        finished
    }

    fn record_exit(&self, reason: &str, stuck_step: Option<&'static str>) {
        let record =
            LastExit { reason: reason.to_owned(), instance_id: self.cfg.instance_id.clone(), stalled_ms: None, stuck_step: stuck_step.map(str::to_owned) };
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

/// One new-task request in flight; see [`Lifecycle::begin_new_task`].
pub struct NewTaskGuard {
    lifecycle: Arc<Lifecycle>,
}

impl Drop for NewTaskGuard {
    fn drop(&mut self) {
        self.lifecycle.apply(Machine::new_task_ended);
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
