//! The `AgentPort` the orchestration tools take, before the agent runtime exists.
//!
//! The tool pool holds the `agent` tool, which needs the [`AgentPort`] of `assemble(AgentParts{..})`
//! (`Assembled::port`); `AgentParts` needs the session directory, which is built from the pool.
//! The cell is bound once with `assemble(..).port()` after the directory exists, and the
//! composition verifies it with `require` before the listener accepts, so a call never reaches an
//! unbound cell (the same rule as every late cell: `late.rs`).

use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use mixdog_tools::orch::agent::{AgentPort, AgentReply, AgentRequest};
use mixdog_tools::orch::util::PortError;

use super::late::Bound;

#[derive(Default)]
pub struct LateAgentPort(OnceLock<Arc<dyn AgentPort>>);

impl LateAgentPort {
    /// Binds the assembled runtime's port; a second bind is refused.
    pub fn bind(&self, port: Arc<dyn AgentPort>) -> Result<(), Arc<dyn AgentPort>> {
        self.0.set(port)
    }
}

#[async_trait]
impl AgentPort for LateAgentPort {
    async fn execute(&self, request: AgentRequest<'_>) -> Result<AgentReply, PortError> {
        self.0.get().expect("the agent port is bound before the server accepts").execute(request).await
    }
}

impl Bound for LateAgentPort {
    fn cell(&self) -> &'static str {
        "agent port"
    }

    fn is_bound(&self) -> bool {
        self.0.get().is_some()
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_protocol::ToolCallId;
    use mixdog_core_api::ids::ThreadId;
    use tokio_util::sync::CancellationToken;

    use super::*;
    use crate::run_host::late::{Unbound, require};

    struct Says(&'static str);

    #[async_trait]
    impl AgentPort for Says {
        async fn execute(&self, _: AgentRequest<'_>) -> Result<AgentReply, PortError> {
            Ok(AgentReply::Text(self.0.to_owned()))
        }
    }

    #[tokio::test]
    async fn the_cell_is_unbound_until_bound_then_delegates_once() {
        let late = LateAgentPort::default();
        assert_eq!(require(&[&late]), Err(Unbound { cell: "agent port" }));
        assert!(late.bind(Arc::new(Says("first"))).is_ok());
        assert_eq!(require(&[&late]), Ok(()));
        assert!(late.bind(Arc::new(Says("second"))).is_err(), "a second bind is refused");
        let (thread, call, cwd, cancel) = (ThreadId::from("t"), ToolCallId::from("c"), AbsPath::new(std::env::temp_dir()).unwrap(), CancellationToken::new());
        let reply = late.execute(AgentRequest { thread: &thread, call: &call, args: serde_json::json!({}), attachment_parts: Vec::new(), cwd: &cwd, cancel: &cancel }).await;
        assert_eq!(reply.unwrap(), AgentReply::Text("first".into()));
    }
}