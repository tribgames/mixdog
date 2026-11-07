//! DRAFT (harness only): the production `HeldHome` (Node `session-runtime/held-requests.mjs` `unattendedRunOf` / `defaultDeliver` /
//! `defaultAgentName` / the gate's "no approval UI attached" test, and `held-request-host.mjs` `notifyHeldRequest`).
//!
//! The setup tool reads this home before the session directory exists, and the delivery it posts through (`AgentHomeDelivery`) is built over the
//! directory: a true cycle, so the delivery is a late cell (`bind_delivery`, a `Bound` for `verify_bound`). The run registry is the one the path takes
//! (run-host-29).
use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_core::run_host::late::Bound;
use mixdog_core::run_host::unattended::UnattendedRunRegistry;
use mixdog_core_ports::ports::gate::GateRun;
use mixdog_protocol::{HeldRequest, HeldRunKind, ThreadId};
use mixdog_services::bots::delivery::home::AgentHomeDelivery;
use mixdog_tools::policy::RunKind;

use crate::held_requests::{HeldHome, HeldPush, RunInfo};
// flip-home-1: the one trait, in mixdog-core-api (Node: the run has a `toolApprovalHook`).
use mixdog_core_api::ApprovalSurfaces;


/// The sanitized phone push (`notifyHeldRequest`: ids and the agent's name only).
pub type HeldNotifier = Arc<dyn Fn(&HeldPush) + Send + Sync>;

pub struct ProcessHeldHome {
    runs: Arc<UnattendedRunRegistry>,
    delivery: OnceLock<Arc<AgentHomeDelivery>>,
    surfaces: Arc<dyn ApprovalSurfaces>,
    /// `mixyDisplayName()` is read on this lane under a proof (`defaultAgentName`, run-host-32).
    interactive: mixdog_rt::InteractiveIo,
    data_dir: std::path::PathBuf,
    notifier: HeldNotifier,
}

impl ProcessHeldHome {
    pub fn new(runs: Arc<UnattendedRunRegistry>, surfaces: Arc<dyn ApprovalSurfaces>, interactive: mixdog_rt::InteractiveIo, data_dir: std::path::PathBuf, notifier: HeldNotifier) -> Arc<Self> {
        Arc::new(Self { runs, delivery: OnceLock::new(), surfaces, interactive, data_dir, notifier })
    }

    /// Binds the home delivery once the directory exists; a second bind is refused.
    pub fn bind_delivery(&self, delivery: Arc<AgentHomeDelivery>) -> Result<(), Arc<AgentHomeDelivery>> {
        self.delivery.set(delivery)
    }
}

impl Bound for ProcessHeldHome {
    fn cell(&self) -> &'static str {
        "held request home delivery"
    }

    fn is_bound(&self) -> bool {
        self.delivery.get().is_some()
    }
}

fn kind_of(run: &GateRun) -> HeldRunKind {
    match run.kind {
        RunKind::Schedule => HeldRunKind::Schedule,
        RunKind::Webhook => HeldRunKind::Webhook,
        RunKind::Room => HeldRunKind::Room,
    }
}

#[async_trait]
impl HeldHome for ProcessHeldHome {
    async fn run_of(&self, thread: &ThreadId) -> Option<RunInfo> {
        let (run, name) = self.runs.named_run_of(thread).await?;
        Some(RunInfo { kind: kind_of(&run), agent_id: run.agent_id, name })
    }

    fn ui_attached(&self, thread: &ThreadId) -> bool {
        self.surfaces.attached(thread)
    }

    /// `deliverHeldRequest(agentId, held)` -> `enqueueHeld`. Unbound (before the directory), the hold logs the failure and goes on, as a failed delivery does.
    async fn deliver(&self, agent_id: &str, held: &HeldRequest) -> Result<(), String> {
        let Some(delivery) = self.delivery.get() else { return Err("the held request home is not bound yet".to_owned()) };
        let row = serde_json::to_value(held).map_err(|error| error.to_string())?;
        delivery.enqueue_held(agent_id, row).await.map(|_| ())
    }

    fn push(&self, event: &HeldPush) {
        (self.notifier)(event);
    }

    async fn agent_name(&self, agent_id: &str) -> Result<String, String> {
        if agent_id != mixdog_core_base::rooms::ids::MIXY_AGENT_ID {
            return Ok(agent_id.to_owned());
        }
        let dir = self.data_dir.clone();
        mixdog_core_base::support::on_lane(self.interactive, &mixdog_rt::CancellationToken::new(), move |lane| mixdog_core_config::config::mixy_display_name(lane, &dir))
            .await
            .map_err(|error| error.to_string())
    }
    /// `randomUUID()`; the id is `held_` + this.
    fn new_id(&self) -> String {
        mixdog_ai::registry::accounting::random_uuid()
    }
}