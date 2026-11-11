//! Replay-only (`replay-controls`, refused in a release build by build.rs): `replay/storesSettled`, the barrier the lone-surrogate
//! wire replay (`benchmarks/rust-core/recorders/lib/lone-surrogate-wire-replay.mjs`) takes before it reads the core's files. It
//! waits for every write-behind writer under the core's folders to have written what it accepted before the call, and nothing
//! accepted after: each writer numbers its writes ([`mixdog_rt::WriteMarks`]), the call takes every writer's accepted count
//! as it arrives and waits for that writer's committed count to reach it. In order: the agent index's row writes
//! (`StoreWorkers::marks`, which hand header changes to the threads), then each thread loaded at the call (every record
//! accepted before it committed and every prompt-history append pushed before it written, counted at the moment the thread
//! is asked: `SessionDirectory::durability_settled`), the read-state snapshots (`ReadState::marks`, their debounce cut
//! short), the gateway usage events (`GatewayUsage::marks`, then the compaction their appends scheduled, run now) and the
//! usage ledger, when open (`UsageWriter::marks`). It answers how many threads were asked. A write from before the call that
//! failed answers an error naming its store, as does a thread that ended with something unwritten or a wait past
//! [`DEADLINE`]; no path leaves the call unanswered.
//!
//! The other stores a call writes need no control of their own: the config file and the MCP server list in it are written through
//! the config's one writer, which the replay's `config/setTheme` waits for; a secret is written on the durability lane inside the
//! call that writes it (mixdog-secrets `on_lane`), before that call answers.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_session::session::SessionDirectory;
use serde_json::Value;
use serde_json::json;

/// Longer than any group commit of a replay's world takes; past it the call fails, naming the wait.
const DEADLINE: Duration = Duration::from_secs(20);

/// The write-behind writers the composition hands this control besides the session directory.
#[derive(Clone)]
pub(crate) struct WriteBehind {
    pub(crate) workers: Arc<mixdog_core_session::session::agent_registry::StoreWorkers>,
    pub(crate) read_state: Arc<mixdog_tools::fs::ReadState>,
}

pub(crate) struct StoresSettled {
    directory: Arc<SessionDirectory>,
    writers: WriteBehind,
    gateway_usage: mixdog_core_session::session::gateway_usage::GatewayUsage,
    ledgers: Arc<mixdog_core::run_host::ledger_source::LedgerSource>,
}

impl StoresSettled {
    pub(crate) fn new(
        directory: Arc<SessionDirectory>,
        writers: WriteBehind,
        gateway_usage: mixdog_core_session::session::gateway_usage::GatewayUsage,
        ledgers: Arc<mixdog_core::run_host::ledger_source::LedgerSource>,
    ) -> Self {
        Self { directory, writers, gateway_usage, ledgers }
    }

    async fn settle(&self) -> Result<usize, String> {
        // Every writer's accepted count as the call arrives; each is then awaited to that count only.
        let workers = self.writers.workers.marks().accepted();
        let read_state = self.writers.read_state.marks().accepted();
        let gateway = self.gateway_usage.marks().accepted();
        let ledger = self.ledgers.if_open().map(|ledger| {
            let mark = ledger.writer.marks().accepted();
            (ledger, mark)
        });
        self.writers.workers.marks().reached(workers).await?;
        let threads = self.directory.durability_settled().await?;
        self.writers.read_state.flush_pending();
        self.writers.read_state.marks().reached(read_state).await?;
        self.gateway_usage.flush();
        self.gateway_usage.marks().reached(gateway).await?;
        self.gateway_usage.compact_scheduled_now().await;
        if let Some((ledger, mark)) = ledger {
            ledger.writer.marks().reached(mark).await?;
        }
        Ok(threads)
    }
}

fn failed(detail: String) -> CoreError {
    CoreError::CapabilityUnavailable { capability: mixdog_app_server::REPLAY_STORES_SETTLED.into(), detail: detail.into() }
}

#[async_trait]
impl DomainService for StoresSettled {
    fn methods(&self) -> &'static [&'static str] {
        &[mixdog_app_server::REPLAY_STORES_SETTLED]
    }

    async fn call(&self, _req: CoreRequest) -> Result<Reply, CoreError> {
        match tokio::time::timeout(DEADLINE, self.settle()).await {
            Ok(Ok(threads)) => Ok(Reply::Value(json!({ "threads": threads }))),
            Ok(Err(detail)) => Err(failed(detail)),
            Err(_) => Err(failed(format!("the core's write-behind writers had not all written within {DEADLINE:?}"))),
        }
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
