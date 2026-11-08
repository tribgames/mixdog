//! The owned-runtime lifecycle (owned-runtime/*.mjs): bridge activation, the automation
//! runtime (scheduler + webhook receiver) and config reload. In the core these run in-process,
//! so there is no worker to attach to; the scheduler and the receiver live exactly as long as
//! an automation or the bridge is started.

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
    stop_requested: bool,
    /// Ends every start and reload that began before the last stop: a stop never waits behind
    /// a start or reload that is stuck, it cancels it (the gates drop the stuck section).
    epoch: CancellationToken,
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
        })
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

    /// The start's first step (ahead of the provider init): the receiver's local identity write,
    /// under the epoch a stop ends. A failure is logged; the start goes on, as Node's does.
    pub async fn prepare_automation(&self) {
        if let Err(error) = self.services.prepare(&self.epoch()).await {
            tracing::warn!("mixdog channels: automation prepare failed: {error}");
        }
    }

    /// Scheduler + webhook receiver, without activating the channel bridge. Loads the
    /// schedules first, as the worker's config load does.
    pub async fn start_automation(&self) -> Result<(), String> {
        // A start a stop cut short has nothing left to do: the stop tears everything down.
        self.start_gate.run(&self.epoch(), self.start_automation_turn()).await.unwrap_or(Ok(()))
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
        self.prepare_automation().await;
        self.init_providers().await;
        if self.state.lock().unwrap().stop_requested {
            return Ok(());
        }
        let rows = self.armed_schedules().await.map_err(|e| e.to_string())?;
        self.scheduler.reload_config(rows, false);
        self.scheduler.start();
        let synced = self.services.sync(false).await;
        self.state.lock().unwrap().automation_running = true;
        mixdog_rt::node_stderr!("mixdog: automation runtime up");
        synced
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
            if !st.bridge_connected && !st.bridge_starting && !st.automation_running {
                return Ok(());
            }
            // Signal an in-flight start to abort at its next checkpoint.
            if st.bridge_starting {
                st.stop_requested = true;
            }
            // Cut short every start and reload in flight, stuck or not, so the teardown never
            // waits behind one.
            st.epoch.cancel();
            st.epoch = CancellationToken::new();
            st.epoch.clone()
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
