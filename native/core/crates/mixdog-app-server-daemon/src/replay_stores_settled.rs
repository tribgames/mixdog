//! Replay-only (`replay-controls`, refused in a release build by build.rs): `replay/storesSettled`, the barrier the lone-surrogate
//! wire replay (`benchmarks/rust-core/recorders/lib/lone-surrogate-wire-replay.mjs`) takes before it reads the core's files. It
//! waits for every write-behind writer under the core's folders to have written what it accepted before the call, and nothing
//! accepted after: each writer numbers its writes ([`mixdog_rt::WriteMarks`]), the call takes every writer's accepted count
//! as it arrives, every one before it waits for any, then waits for all of them at once, each writer's committed count to
//! reach its own: the agent index's row writes (`StoreWorkers::marks`), each thread loaded at the call (every durable record
//! its actor accepted before the call committed, and every prompt-history append pushed before it written:
//! `SessionDirectory::durability_settled`), the read-state snapshots (`ReadState::marks`, their debounce cut short), the
//! gateway usage events (`GatewayUsage::marks`, then the compaction their appends scheduled, run now) and the usage ledger,
//! when open (`UsageWriter::marks`). It answers how many threads were asked. A write from before the call that
//! failed answers an error naming its store, as does a thread that ended with something unwritten; a wait past [`DEADLINE`]
//! answers an error naming each store (and thread) still pending; no path leaves the call unanswered.
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
        // Every writer's accepted count as the call arrives, all of them before any wait: a write accepted while one store
        // is still being waited for is not the call's, whichever store takes it.
        let threads = self.directory.durability_settled();
        let ledger = self.ledgers.if_open();
        let mut stores = vec![self.writers.workers.marks(), self.writers.read_state.marks(), self.gateway_usage.marks()];
        stores.extend(ledger.as_ref().map(|ledger| ledger.writer.marks()));
        let stores: Vec<(&mixdog_rt::WriteMarks, u64)> = stores.into_iter().map(|marks| (marks, marks.accepted())).collect();
        self.writers.read_state.flush_pending();
        self.gateway_usage.flush();
        // Then every store is waited for at once. A worker row is a header patch answered once its record is durable, so a
        // row write from before the call is committed on its own thread whenever the agent index counts it written.
        let wait = async {
            let (threads, _) = futures::try_join!(threads.wait(), futures::future::try_join_all(stores.iter().map(|(marks, mark)| marks.reached(*mark))))?;
            // The compaction the gateway usage appends scheduled, run now.
            self.gateway_usage.compact_scheduled_now().await;
            Ok(threads)
        };
        match tokio::time::timeout(DEADLINE, wait).await {
            Ok(answer) => answer,
            Err(_) => {
                let mut pending = threads.pending();
                pending.extend(stores.iter().filter(|(marks, mark)| marks.check(*mark).is_none()).map(|(marks, _)| marks.store().to_owned()));
                if pending.is_empty() {
                    pending.push("the gateway usage compaction".to_owned());
                }
                Err(format!("the core's write-behind writers had not all written within {DEADLINE:?}; still pending: {}", pending.join(", ")))
            }
        }
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
        match self.settle().await {
            Ok(threads) => Ok(Reply::Value(json!({ "threads": threads }))),
            Err(detail) => Err(failed(detail)),
        }
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
#[path = "replay_stores_settled_tests.rs"]
mod tests;
