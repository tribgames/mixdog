//! The session side of the agent tool's host traits (`mixdog_agent::agent_tool::host`).

use mixdog_agent::agent_tool::host::CallerScopes;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::scope::positive_int;
use mixdog_core_api::ids::ThreadId;

use super::SessionDirectory;

/// A call's scope is its own session and the host process that session runs under
/// (`call-prep.mjs:88-103`: `callerSessionId` is the session, `clientHostPid` its
/// `sessionRef.clientHostPid`; `normalizeToolNotifyContext` keeps a positive pid only).
impl CallerScopes for SessionDirectory {
    fn scope_of(&self, thread: &ThreadId) -> Scope {
        let host_pid = self
            .handle(thread)
            .and_then(|handle| positive_int(handle.cell.header.load().get("clientHostPid")));
        Scope {
            caller_session_id: Some(thread.as_str().to_owned()),
            host_pid,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::session::testing::Rig;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_calls_scope_is_its_session_and_that_sessions_host_pid() {
        let rig = Rig::new();
        let directory = SessionDirectory::new(rig.deps());
        let handle = crate::session::tests::start_thread(&directory).await;
        let mut header = (**handle.cell.header.load()).clone();
        header.insert("clientHostPid".into(), json!(4242));
        handle.cell.header.store(std::sync::Arc::new(header));
        assert_eq!(
            directory.scope_of(&handle.id),
            Scope { caller_session_id: Some(handle.id.as_str().to_owned()), host_pid: Some(4242) }
        );
        let gone = ThreadId::from("sess_gone");
        assert_eq!(
            directory.scope_of(&gone),
            Scope { caller_session_id: Some("sess_gone".into()), host_pid: None }
        );
    }
}
