//! Replay-only (`replay-controls`, refused in a release build by build.rs): `replay/storesSettled`, the barrier the lone-surrogate
//! wire replay (`benchmarks/rust-core/recorders/lib/lone-surrogate-wire-replay.mjs`) takes before it reads the core's files. It
//! answers once every loaded thread's session durability task has nothing pending (every record accepted before the call is
//! committed or failed, and released: `SessionDirectory::durability_settled`), with how many threads were loaded. A thread that
//! ends first, or a wait past [`DEADLINE`], answers an error that says which; no path leaves the call unanswered.
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

pub(crate) struct StoresSettled {
    directory: Arc<SessionDirectory>,
}

impl StoresSettled {
    pub(crate) fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
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
        match tokio::time::timeout(DEADLINE, self.directory.durability_settled()).await {
            Ok(Ok(threads)) => Ok(Reply::Value(json!({ "threads": threads }))),
            Ok(Err(detail)) => Err(failed(detail)),
            Err(_) => Err(failed(format!("the loaded threads' session records were not all durable within {DEADLINE:?}"))),
        }
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
