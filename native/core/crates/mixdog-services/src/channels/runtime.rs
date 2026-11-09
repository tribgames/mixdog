//! The owned-runtime lifecycle (owned-runtime/*.mjs): bridge activation, the automation
//! runtime (scheduler + webhook receiver) and config reload. In the core these run in-process,
//! so there is no worker to attach to; the scheduler and the receiver live exactly as long as
//! an automation or the bridge is started.

use std::future::Future;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_rt::Gate;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::ports::{AgentRuntime, AutomationServices};
use super::tools::ChannelLifecycle;
use crate::scheduler::{Schedule, ScheduleError, ScheduleRecords, ScheduleStatus, Scheduler};

#[derive(Default)]
struct State {
    bridge_active: bool,
    bridge_connected: bool,
    bridge_starting: bool,
    automation_running: bool,
    /// An automation start is between its first await and the sync (`automationStartPromise`): a stop
    /// counts it as in flight, as Node's `stopOwnedRuntime` does.
    automation_starting: bool,
    stop_requested: bool,
    /// Ends every start and reload that began before the last stop: a stop never waits behind
    /// a start or reload that is stuck, it cancels it (the gates drop the stuck section).
    epoch: CancellationToken,
    /// The deferred automation start (`state.channelStartTimer` / `channelStartPromise`): one at a
    /// time, owned here so a shutdown can end and join it.
    scheduled_start: Option<tokio::task::JoinHandle<()>>,
}

/// Clears `bridge_starting` however the start ends; a start cut short also drops the
/// `bridge_connected` it had claimed.
struct StartFlag<'a> {
    state: &'a Mutex<State>,
    finished: bool,
}

impl Drop for StartFlag<'_> {
    fn drop(&mut self) {
        let mut st = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        st.bridge_starting = false;
        if !self.finished {
            st.bridge_connected = false;
        }
    }
}

/// Clears `automation_starting` however the automation start ends (a cancelled one included).
struct AutomationStartFlag<'a>(&'a Mutex<State>);

impl Drop for AutomationStartFlag<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).automation_starting = false;
    }
}

/// Why a background job must wait for an idle runtime, or `None` when idle (`timer-arm.mjs` `busyReason`).
pub type BusyProbe = Arc<dyn Fn() -> Option<&'static str> + Send + Sync>;

/// `onChannelStartTimer`'s `hasActiveAutomation()`, asked afresh each time the deferred start runs.
pub type ActiveProbe = Arc<dyn Fn() -> std::pin::Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

pub struct ChannelRuntime {
    scheduler: Scheduler,
    schedules: Arc<dyn ScheduleRecords>,
    services: Arc<dyn AutomationServices>,
    agent: Arc<dyn AgentRuntime>,
    state: Mutex<State>,
    /// One start at a time: a second caller joins the first.
    start_gate: Gate,
    /// Reloads apply in the order they were asked, each reading the stores afresh, so the last
    /// one applied is the newest.
    reload_gate: Gate,
    /// Node's `closeRequested` for the channel start: once cancelled (by `shutdown_scheduled_start`)
    /// no deferred start runs or is scheduled.
    shutdown: CancellationToken,
    /// `busyReason()`: bound by the composition once the session directory exists.
    busy: std::sync::OnceLock<BusyProbe>,
    /// `wakeDeferredWarmups()`: wakes the deferred start that parked on a busy runtime.
    start_wake: tokio::sync::Notify,
}

/// What the app shows as the worker's state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeStatus {
    pub running: bool,
    pub pid: u32,
}

impl RuntimeStatus {
    pub fn to_json(&self) -> Value {
        json!({"running": self.running, "pid": self.pid, "pending": 0, "mode": "core"})
    }
}

impl ChannelRuntime {
    pub fn new(
        scheduler: Scheduler,
        schedules: Arc<dyn ScheduleRecords>,
        services: Arc<dyn AutomationServices>,
        agent: Arc<dyn AgentRuntime>,
    ) -> Arc<Self> {
        Arc::new(Self {
            scheduler,
            schedules,
            services,
            agent,
            state: Mutex::new(State::default()),
            start_gate: Gate::new(),
            reload_gate: Gate::new(),
            shutdown: CancellationToken::new(),
            busy: std::sync::OnceLock::new(),
            start_wake: tokio::sync::Notify::new(),
        })
    }

    /// Binds the busy probe the deferred start parks on (a turn running, a session being created).
    pub fn bind_busy(&self, probe: BusyProbe) {
        let _ = self.busy.set(probe);
    }

    /// The runtime's busy state changed (`wakeDeferredWarmups`): a parked start checks again.
    pub fn wake_parked_start(&self) {
        self.start_wake.notify_waiters();
    }

    /// The token a start or reload runs under: the current epoch, ended by the next stop.
    fn epoch(&self) -> CancellationToken {
        self.state.lock().unwrap().epoch.clone()
    }

    pub fn scheduler(&self) -> &Scheduler {
        &self.scheduler
    }

    pub fn status(&self) -> RuntimeStatus {
        let st = self.state.lock().unwrap();
        RuntimeStatus { running: st.automation_running || st.bridge_connected, pid: std::process::id() }
    }

    /// Whether the scheduler is armed by this process (schedules then move through it).
    pub fn automation_running(&self) -> bool {
        self.state.lock().unwrap().automation_running
    }

    /// The enabled, unfinished schedules (`loadConfig`: done one-shots never re-arm).
    async fn armed_schedules(&self) -> Result<Vec<Schedule>, ScheduleError> {
        Ok(self.schedules.list().await?.into_iter().filter(|s| s.enabled && s.status != ScheduleStatus::Done).collect())
    }

    async fn init_providers(&self) {
        // The provider registry must be populated before the scheduler's first fire;
        // a failure is non-fatal: the runtime keeps going without it.
        if let Err(error) = self.agent.init_providers().await {
            mixdog_rt::node_stderr!("mixdog: initProviders failed (non-fatal): {error}");
        }
    }

    /// Scheduler + webhook receiver, without activating the channel bridge. Loads the
    /// schedules first, as the worker's config load does.
    pub async fn start_automation(&self) -> Result<(), String> {
        self.start_automation_under(&self.epoch()).await
    }

    async fn start_automation_under(&self, epoch: &CancellationToken) -> Result<(), String> {
        // A start a stop cut short has nothing left to do: the stop tears everything down.
        self.start_gate.run(epoch, self.start_automation_turn()).await.unwrap_or(Ok(()))
    }

    /// `scheduleChannelStart` / `onChannelStartTimer`: returns at once and starts the automation
    /// afterwards, when `active` (Node's `hasActiveAutomation`, asked when the deferred callback
    /// runs, not now) says something is enabled. A start already scheduled or running, or a
    /// shutdown, schedules nothing. The task is bound to the epoch current now, so a stop
    /// ends it wherever it is, and to the shutdown, which cancels and joins it.
    ///
    /// `busy_aware` is `scheduleChannelStart` (a save): a turn running or a session being created
    /// parks the start until the next wake (`channel-start.mjs:50-56`, `timer-arm.mjs` `park`/`wake`),
    /// then the whole callback runs again. The boot autostart (`scheduleAutomationAutostart`,
    /// `channel-start.mjs:75-95`) does not look at the busy state.
    pub fn schedule_automation_start(self: &Arc<Self>, closing: &CancellationToken, active: ActiveProbe, busy_aware: bool) {
        let mut st = self.state.lock().unwrap();
        if closing.is_cancelled() || self.shutdown.is_cancelled() || st.scheduled_start.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let (runtime, epoch, closing) = (Arc::clone(self), st.epoch.clone(), closing.clone());
        st.scheduled_start = Some(tokio::spawn(async move {
            let start = async {
                loop {
                    // The wake is registered before the busy state is read, so a wake in between is not lost.
                    let woke = runtime.start_wake.notified();
                    tokio::pin!(woke);
                    woke.as_mut().enable();
                    // `isCloseRequested()` is checked again once the probe has answered.
                    if !active().await || closing.is_cancelled() || runtime.shutdown.is_cancelled() {
                        return;
                    }
                    if busy_aware && runtime.busy.get().is_some_and(|busy| busy().is_some()) {
                        woke.await;
                        // `wake()` re-arms the parked job as `arm(key, 0, run)` (`warmup/timer-arm.mjs:19-27`):
                        // a zero-delay timer, so the whole callback runs again on its own tick, not inline.
                        tokio::time::sleep(std::time::Duration::ZERO).await;
                        continue;
                    }
                    break;
                }
                if let Err(error) = runtime.start_automation_under(&epoch).await {
                    tracing::warn!("mixdog channels: automation start failed: {error}");
                }
            };
            tokio::select! {
                () = epoch.cancelled() => {}
                () = closing.cancelled() => {}
                () = runtime.shutdown.cancelled() => {}
                () = start => {}
            }
        }));
    }

    /// The scheduled start, finished or ended: lets a caller wait for it.
    pub async fn scheduled_start_settled(&self) {
        let task = self.state.lock().unwrap().scheduled_start.take();
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    /// The close of the app: ends the scheduled start wherever it is (probe, provider init,
    /// sync) and waits for it, so nothing starts after the teardown that follows.
    pub async fn shutdown_scheduled_start(&self) {
        self.shutdown.cancel();
        self.scheduled_start_settled().await;
    }

    async fn start_automation_turn(&self) -> Result<(), String> {
        let running = self.state.lock().unwrap().automation_running;
        if running {
            return self.services.sync(false).await;
        }
        {
            let mut st = self.state.lock().unwrap();
            if !st.bridge_starting {
                st.stop_requested = false;
            }
        }
        self.state.lock().unwrap().automation_starting = true;
        let _starting = AutomationStartFlag(&self.state);
        self.init_providers().await;
        if self.state.lock().unwrap().stop_requested {
            return Ok(());
        }
        let rows = self.armed_schedules().await.map_err(|e| e.to_string())?;
        self.scheduler.reload_config(rows, false);
        self.scheduler.start();
        // Node's `syncWebhookAndEventRuntime()` is synchronous: the runtime counts as up as the sync is
        // launched, before the listener has bound (`automation-start.mjs:30-42`).
        self.state.lock().unwrap().automation_running = true;
        mixdog_rt::node_stderr!("mixdog: automation runtime up");
        self.services.sync(false).await
    }

    /// Activation after an automation-only start must not double-arm the scheduler; the
    /// webhook sync is idempotent.
    async fn arm_automation(&self) -> Result<(), String> {
        let already = self.state.lock().unwrap().automation_running;
        if !already {
            let rows = self.armed_schedules().await.map_err(|e| e.to_string())?;
            self.scheduler.reload_config(rows, false);
            self.scheduler.start();
        }
        let synced = self.services.sync(false).await;
        self.state.lock().unwrap().automation_running = true;
        synced
    }

    async fn activate_bridge(&self) -> Result<(), String> {
        self.state.lock().unwrap().bridge_connected = true;
        self.init_providers().await;
        {
            let mut st = self.state.lock().unwrap();
            if st.stop_requested {
                st.bridge_connected = false;
                st.stop_requested = false;
                return Ok(());
            }
        }
        self.arm_automation().await
    }

    async fn start_bridge_turn(&self) -> Result<(), String> {
        {
            let mut st = self.state.lock().unwrap();
            if st.bridge_connected || st.bridge_starting || !st.bridge_active {
                return Ok(());
            }
            st.bridge_starting = true;
            st.stop_requested = false;
        }
        let mut flag = StartFlag { state: &self.state, finished: false };
        // A start error is non-fatal: it rolls back the connected state and degrades to
        // automation-only mode.
        if let Err(error) = self.activate_bridge().await {
            mixdog_rt::node_stderr!("mixdog: bridge start failed (non-fatal): {error}");
            self.state.lock().unwrap().bridge_connected = false;
        }
        flag.finished = true;
        Ok(())
    }

    /// Re-reads the stores and re-arms the scheduler (and the receiver) when the runtime is
    /// supposed to be running; otherwise tears the receiver down.
    pub async fn reload_runtime(&self) -> Result<(), String> {
        // A reload a stop cut short is moot: the stop tore the receiver down.
        self.reload_gate.run(&self.epoch(), self.reload_turn()).await.unwrap_or(Ok(()))
    }

    async fn reload_turn(&self) -> Result<(), String> {
        let rows = self.armed_schedules().await.map_err(|e| e.to_string())?;
        let live = {
            let st = self.state.lock().unwrap();
            st.automation_running || st.bridge_connected
        };
        // The scheduler must be RE-ARMED by the reload whenever it is supposed to be running:
        // otherwise every saved or edited schedule would stay silently disarmed.
        self.scheduler.reload_config(rows, live);
        if live {
            self.services.sync(true).await
        } else {
            self.services.stop().await;
            Ok(())
        }
    }
}

#[async_trait]
impl ChannelLifecycle for ChannelRuntime {
    fn bridge_active(&self) -> bool {
        self.state.lock().unwrap().bridge_active
    }

    async fn set_bridge_active(&self, active: bool) {
        self.state.lock().unwrap().bridge_active = active;
    }

    async fn start_bridge(&self) -> Result<(), String> {
        // A start a stop cut short has nothing left to do: the stop tears everything down.
        self.start_gate.run(&self.epoch(), self.start_bridge_turn()).await.unwrap_or(Ok(()))
    }

    async fn stop_owned_runtime(&self, reason: &str) -> Result<(), String> {
        let epoch = {
            let mut st = self.state.lock().unwrap();
            if !st.bridge_connected && !st.bridge_starting && !st.automation_running && !st.automation_starting {
                return Ok(());
            }
            // Signal an in-flight start to abort at its next checkpoint.
            if st.bridge_starting || st.automation_starting {
                st.stop_requested = true;
            }
            if st.automation_starting {
                // Node awaits `automationStartPromise` before tearing down (`owned-stop.mjs`, the
                // `await state.automationStartPromise`): the start sees `stop_requested` at its next
                // checkpoint and arms nothing, and the teardown below queues behind it on the start gate.
                st.epoch.clone()
            } else {
                // Cut short every start and reload in flight, stuck or not, so the teardown never
                // waits behind one.
                st.epoch.cancel();
                st.epoch = CancellationToken::new();
                st.epoch.clone()
            }
        };
        let Ok(_start) = self.start_gate.enter(&epoch).await else {
            // A later stop superseded this one and does the teardown.
            return Ok(());
        };
        self.scheduler.stop();
        self.services.stop().await;
        {
            let mut st = self.state.lock().unwrap();
            st.automation_running = false;
            st.bridge_connected = false;
            st.stop_requested = false;
        }
        tracing::info!("mixdog channels: standby: {reason}");
        Ok(())
    }

    async fn reload_config(&self) -> Result<String, String> {
        self.reload_runtime().await?;
        // `tool-dispatch.mjs:66`: the agent reload runs only when `MIXDOG_STANDALONE !== '1'`; the channel worker is always spawned
        // with it (`channel-worker/daemon-spawn.mjs:32`), so the reply never names it.
        Ok(String::new())
    }

    /// Rename and re-arm under one reservation: the scheduler is reloaded from the renamed
    /// row (timers and one-shots of the old name cleared) before the name is released.
    async fn rename_schedule(&self, name: &str, def: &Value, timing_changed: bool) -> Result<Value, ScheduleError> {
        let def: Schedule = serde_json::from_value(def.clone())
            .map_err(|e| ScheduleError::Store(format!("rename_schedule: the schedule definition is invalid: {e}")))?;
        let renamed = self
            .scheduler
            .rename_locked(
                name,
                || self.schedules.rename(name, &def, timing_changed),
                || async { self.reload_runtime().await },
            )
            .await?;
        Ok(serde_json::to_value(renamed).unwrap_or(Value::Null))
    }
}
