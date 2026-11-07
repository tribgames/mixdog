//! The runtime's side of the code-graph prewarm timer (`PrewarmWorld`, flip-ce-12): the settings of
//! `runtime-tunables.mjs`, the busy reason of `timer-arm.mjs:29`, the current folder, and the graph
//! build of `CodeGraphTool::prewarm_if_project`.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core::run_host::code_graph_prewarm::PrewarmWorld;
use mixdog_core::run_host::compose_parts::LateDirectory;
use mixdog_services::task_reports::runtime_state::RuntimeLiveness;
use mixdog_tools::code_graph::CodeGraphTool;
use tokio_util::sync::CancellationToken;

use crate::compose_domains::EnvReader;

pub struct DaemonPrewarmWorld {
    pub tool: Arc<CodeGraphTool>,
    pub io: mixdog_rt::MaintenanceIo,
    /// `rt.closeRequested` (cancelled by the first stop step).
    pub close_requested: CancellationToken,
    /// Ends an in-flight build with the process.
    pub cancel: CancellationToken,
    pub liveness: Arc<RuntimeLiveness>,
    /// `getSessionCreatePromise()` through the verified late directory.
    pub directory: Arc<LateDirectory>,
    /// `rt.currentCwd`: the startup folder until a session moves it (`set_runtime_cwd`, flip-ce-5).
    pub cwd: Arc<Mutex<String>>,
    pub env: EnvReader,
}

impl DaemonPrewarmWorld {
    /// `envFlag(name)`: unset, empty or a typo is off.
    fn flag(&self, name: &str) -> bool {
        mixdog_services::memory::cycles::config::env_flag((self.env)(name).as_deref(), false)
    }

    /// `codeGraphPrewarmLazy` (`runtime-tunables.mjs`): `codeGraphPrewarmEnabled && !codeGraphPrewarmEager`. A cwd applied before the first turn does not warm.
    pub fn lazy(&self) -> bool {
        self.enabled() && !self.flag("MIXDOG_CODE_GRAPH_PREWARM_EAGER")
    }
}

#[async_trait]
impl PrewarmWorld for DaemonPrewarmWorld {
    /// `!envFlag('MIXDOG_DISABLE_CODE_GRAPH_PREWARM') && (envFlag('MIXDOG_ENABLE_CODE_GRAPH_PREWARM') || envFlag('MIXDOG_CODE_GRAPH_PREWARM_EAGER'))`.
    fn enabled(&self) -> bool {
        !self.flag("MIXDOG_DISABLE_CODE_GRAPH_PREWARM") && (self.flag("MIXDOG_ENABLE_CODE_GRAPH_PREWARM") || self.flag("MIXDOG_CODE_GRAPH_PREWARM_EAGER"))
    }

    /// `envDelayMs('MIXDOG_CODE_GRAPH_PREWARM_DELAY_MS', 250, { min: 0, max: 60_000 })`.
    fn delay(&self) -> Duration {
        let parsed = (self.env)("MIXDOG_CODE_GRAPH_PREWARM_DELAY_MS").filter(|raw| !raw.is_empty()).map(|raw| mixdog_js::string_to_number(&raw)).filter(|n| n.is_finite());
        Duration::from_millis(parsed.map_or(250.0, |n| n.floor().clamp(0.0, 60_000.0)) as u64)
    }

    fn close_requested(&self) -> bool {
        self.close_requested.is_cancelled()
    }

    /// `getActiveTurnCount() > 0` -> `turn-active`; `getSessionCreatePromise()` -> `session-create`.
    fn busy(&self) -> Option<&'static str> {
        if !self.liveness.in_flight_session_activity().working.is_empty() {
            return Some("turn-active");
        }
        let directory = self.directory.directory().expect("session directory bound (compose::verify_bound)");
        directory.creating().then_some("session-create")
    }

    fn current_cwd(&self) -> String {
        self.cwd.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    async fn prewarm(&self, cwd: &str) -> Result<bool, String> {
        Ok(self.tool.prewarm_if_project(std::path::Path::new(cwd), self.io, &self.cancel).await)
    }

    /// `bootProfile(event, detail)`.
    fn profile(&self, event: &str, detail: &str) {
        tracing::debug!(event, detail, "boot profile");
    }
}