//! A session the directory loads while the core is still composed (the rooms' start-up recovery, a restored turn) reads its late cells
//! before they are bound: the read waits for the bind and answers what the bound seam answers.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ThreadAgents;
use mixdog_app_server_daemon::late_session::LateAgentStatus;
use mixdog_app_server_daemon::late_session::LateLiveWorkspace;
use mixdog_core::run_host::late::Bound;
use mixdog_core_session::session::agent_activity::AgentStatus;
use mixdog_core_session::session::worktree::LiveWorkspace;
use mixdog_protocol::ThreadId;
use serde_json::json;

struct Workspace;

#[async_trait]
impl LiveWorkspace for Workspace {
    async fn live(&self, session: &str) -> Option<serde_json::Value> {
        Some(json!({ "session": session }))
    }
}

struct Status;

#[async_trait]
impl AgentStatus for Status {
    async fn status(&self, thread: &ThreadId) -> ThreadAgents {
        ThreadAgents { agent_workers: vec![json!(thread.as_str())], ..ThreadAgents::default() }
    }
}

#[tokio::test]
async fn a_live_workspace_read_before_the_bind_waits_for_it() {
    let cell = LateLiveWorkspace::default();
    let mut read = std::pin::pin!(cell.live("s1"));
    assert!(futures::poll!(read.as_mut()).is_pending(), "unbound, the read waits");
    assert!(!cell.is_bound());
    cell.bind(Arc::new(Workspace)).expect("the first bind");
    assert_eq!(read.await, Some(json!({ "session": "s1" })));
    assert_eq!(cell.bind(Arc::new(Workspace)), Err("live workspace"), "a second bind is refused");
    assert_eq!(cell.live("s2").await, Some(json!({ "session": "s2" })), "bound, a read answers at once");
}

#[tokio::test]
async fn an_agent_status_read_before_the_bind_waits_for_it() {
    let cell = LateAgentStatus::default();
    let thread = ThreadId::from("t1");
    let mut read = std::pin::pin!(cell.status(&thread));
    assert!(futures::poll!(read.as_mut()).is_pending(), "unbound, the read waits");
    cell.bind(Arc::new(Status)).expect("the first bind");
    assert_eq!(read.await.agent_workers, vec![json!("t1")]);
    assert_eq!(cell.bind(Arc::new(Status)), Err("agent status"), "a second bind is refused");
}
