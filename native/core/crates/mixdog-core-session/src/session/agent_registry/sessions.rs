//! The agent tool's session side (`Sessions`): the agent tree's handoff read, close and
//! descendants (1.4.5 `agent-tree.mjs`, `session-close.mjs`, `lifecycle-barriers.mjs`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::{CancelAll, CancelNotice, JobBoard};
use mixdog_agent::agent_tool::dispatch::{CloseParts, close_resolved};
use mixdog_tools::orch::agent::ClosedView;
use mixdog_agent::agent_tool::host::CloseOptions;
use mixdog_agent::agent_tool::host::Registry;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::host::Sessions;
use mixdog_core_api::ids::ThreadId;
use serde_json::Map;
use serde_json::Value;

use super::AgentRegistry;
use crate::session::shell_jobs::OwnedShells;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_tools::fs::ReadState;
use crate::session::Clock;
use crate::session::SessionDirectory;

/// The statusline's per-agent route (`clearAgentStatuslineRoute`).
pub trait AgentStatusline: Send + Sync {
    fn clear(&self, session: &str);
}

pub struct AgentSessions {
    directory: Arc<SessionDirectory>,
    threads: Arc<dyn ThreadState>,
    registry: Arc<AgentRegistry>,
    statusline: Arc<dyn AgentStatusline>,
    clock: Arc<dyn Clock>,
    /// The shells a closing session owns.
    shells: Arc<dyn OwnedShells>,
    /// The one read state of the read, edit and apply_patch tools.
    read_state: Arc<ReadState>,
}

impl AgentSessions {
    pub fn new(
        directory: Arc<SessionDirectory>,
        threads: Arc<dyn ThreadState>,
        registry: Arc<AgentRegistry>,
        statusline: Arc<dyn AgentStatusline>,
        clock: Arc<dyn Clock>,
        shells: Arc<dyn OwnedShells>,
        read_state: Arc<ReadState>,
    ) -> Self {
        Self { directory, threads, registry, statusline, clock, shells, read_state }
    }
}

/// `lastStoredAgentHandoff`: the header's `lastHandoff`, else the last assistant message
/// with content (a string as is, anything else as its JSON), else empty.
fn last_handoff(header: &Map<String, Value>, messages: &[Value]) -> String {
    if let Some(Value::String(handoff)) = header.get("lastHandoff") {
        return handoff.clone();
    }
    let has_content = |content: Option<&Value>| match content {
        Some(Value::String(text)) => !mixdog_js::js_trim(text).is_empty(),
        other => super::rows::truthy(other),
    };
    messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(Value::as_str) == Some("assistant") && has_content(m.get("content")))
        .map(|m| match &m["content"] {
            Value::String(text) => text.clone(),
            other => mixdog_js::json_stringify(other),
        })
        .unwrap_or_default()
}

impl AgentSessions {
    /// `cancelAgentDescendants(parentSessionId, reason)` (`agent-cancel.mjs:152-170`): the parent
    /// refuses admission while it runs; the agent jobs it started are cancelled
    /// (`cancelBackgroundTasks({ surface: 'agent', callerSessionId })`, the owner told as the
    /// board's default says); then every child's tree is cancelled, together. Whether any child
    /// was there to cancel.
    pub async fn cancel_descendants(&self, parent: &str, reason: &str, board: &JobBoard) -> bool {
        let parent = mixdog_js::js_trim(parent).to_owned();
        let _cancelling = self.registry.begin_cancellation(std::slice::from_ref(&parent));
        board.cancel_all(&CancelAll {
            reason: reason.to_owned(),
            scope: Scope { caller_session_id: Some(parent.clone()), host_pid: None },
            ..CancelAll::default()
        });
        let children = self.registry.children_of(&parent);
        if children.is_empty() {
            return false;
        }
        futures::future::join_all(children.iter().map(|child| self.close_session(child, reason, CloseOptions::default()))).await;
        true
    }

/// `closeAll(reason, { callerSessionId: owner, processExit })` (`close-flow/close-all.mjs:48-70`):
    /// every worker of `owner` is closed through the same close `agent close` runs, each failure
    /// kept (a worker that cannot close never stops the rest); then the owner's agent jobs still
    /// running are cancelled with `reason`; and unless `keep_rows` (a process exit leaves the rows
    /// for the next process) the owner's worker rows, and those of the sessions just closed, are
    /// purged, except a Lead's pool row and a row whose owner is still owed its restart failure.
    /// Node's unscoped form (no owner: every worker, the local tag maps reset) has no caller in
    /// the daemon and is not ported.
    pub async fn close_all(&self, owner: &str, reason: &str, keep_rows: bool, board: &JobBoard) -> Result<CloseAllReport, String> {
        let owner = mixdog_js::js_trim(owner).to_owned();
        if owner.is_empty() {
            return Err("agent close all: an owner session is required".into());
        }
        let scope = Scope { caller_session_id: Some(owner.clone()), host_pid: None };
        self.registry.refresh_tags_from_sessions(false, &scope).await;
        let mut report = CloseAllReport::default();
        let parts = CloseParts { registry: &*self.registry, sessions: self, tasks: board };
        for (tag, row) in self.registry.session_entries(false, &scope) {
            let id = mixdog_js::js_trim(row.get("id").and_then(Value::as_str).unwrap_or_default()).to_owned();
            match close_resolved(parts, &id, &id, &scope, None, keep_rows).await {
                Ok(view) => report.closed.push(view),
                Err(error) => report.failed.push((tag, error)),
            }
        }
        for job in board.list_jobs(&scope) {
            if job.status != "running" {
                continue;
            }
            board.cancel(&job.task_id, reason, CancelNotice::Default);
            report.closed.push(ClosedView { closed: true, tag: job.meta.tag.clone(), session_id: job.meta.session_id.clone(), task_id: Some(job.task_id.clone()), forgotten: false });
        }
        if !keep_rows {
            let closed: std::collections::HashSet<String> = report.closed.iter().filter_map(|view| view.session_id.clone()).collect();
            self.registry.purge_owner_rows(&owner, &closed);
        }
        Ok(report)
    }

    /// What `__close_all` does for an owner (`daemon-agent-control.mjs:75-82`): `closeAll` with
    /// the process-exit scope, and only then `cancelAgentDescendants`, so a worker closed by the
    /// first is not cancelled a second time under it.
    pub async fn teardown_owner(&self, owner: &str, reason: &str, board: &JobBoard) {
        teardown_in_order(
            async {
                if let Err(error) = self.close_all(owner, reason, true, board).await {
                    tracing::warn!(owner, %error, "agent close all failed");
                }
            },
            self.cancel_descendants(owner, reason, board),
        )
        .await;
    }
}

/// The two steps of `__close_all` in Node's order: the workers close first, the descendants are
/// cancelled once that has settled.
async fn teardown_in_order(close_all: impl std::future::Future<Output = ()>, cancel_descendants: impl std::future::Future<Output = bool>) -> bool {
    close_all.await;
    cancel_descendants.await
}

/// What `closeAll` closed and what it could not.
#[derive(Default)]
pub struct CloseAllReport {
    pub closed: Vec<ClosedView>,
    /// `(tag, error)` of each worker whose close failed.
    pub failed: Vec<(String, String)>,
}

/// The directory's `OwnerTeardown` over the agent sessions and the job board: a session's
/// teardown on a process exit (`SessionDirectory::set_owner_teardown`).
pub struct AgentOwnerTeardown {
    pub sessions: Arc<AgentSessions>,
    pub board: JobBoard,
}

#[async_trait]
impl crate::session::directory::OwnerTeardown for AgentOwnerTeardown {
    async fn teardown(&self, owner: &ThreadId, reason: &str) {
        self.sessions.teardown_owner(owner.as_str(), reason, &self.board).await;
    }
}
#[async_trait]
impl Sessions for AgentSessions {
    /// Stored agent sessions open on demand, so there is nothing to load ahead: the registry's
    /// refresh that follows rereads the index (`rehydrateAgentSessions` then
    /// `refreshTagsFromSessions({scanSessions: true})`).
    async fn rehydrate_agent_sessions(&self) -> bool {
        true
    }

    async fn read_session_handoff(&self, session_id: &str) -> Option<String> {
        if session_id.is_empty() {
            return None;
        }
        let thread = ThreadId::from(session_id);
        let header = self.threads.header(&thread).await.ok()?;
        if header.get("lastHandoff").is_some_and(Value::is_string) {
            return Some(last_handoff(&header, &[]));
        }
        let rows = self.directory.model_context(&thread).read().await.ok()?;
        let messages: Vec<Value> = rows.into_iter().map(|(_, body)| body).collect();
        Some(last_handoff(&header, &messages))
    }

    /// `closeSession(id, reason, {tombstone: false, ownerClose})`: the durable stamp first
    /// (`bumpSessionGenerationAttempt`: `generation`, `updatedAt`, `detachedReason`, and `ownerClosedAt` on an
    /// owner close), then the running turn is cancelled and the queued input dropped. The
    /// session stays open and resumable. A tombstoning close is not served here.
    async fn close_session(&self, session_id: &str, reason: &str, options: CloseOptions) -> bool {
        if options.tombstone || session_id.is_empty() {
            return false;
        }
        // `cancelAgentTree` (`agent-cancel.mjs:111-114`): the session and its descendants refuse
        // admission (a spawn or send under them) until the close has ended.
        let mut covered = self.registry.descendants(session_id);
        covered.push(session_id.to_owned());
        let _cancelling = self.registry.begin_cancellation(&covered);
        let thread = ThreadId::from(session_id);
        if !matches!(crate::session::close::write_detach(&*self.threads, &thread, reason, options.owner_close, self.clock.now_ms()).await, Ok(true)) {
            return false;
        }
        crate::session::close::stop_session_work(&self.directory, &*self.shells, &self.read_state, &thread, reason, "agent-close").await;
        true
    }

    fn descendant_session_ids(&self, session_id: &str) -> Vec<String> {
        self.registry.descendants(session_id)
    }

    fn clear_statusline_route(&self, session_id: &str) {
        if !session_id.is_empty() {
            self.statusline.clear(session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `lastStoredAgentHandoff`.
    #[test]
    fn the_handoff_is_the_saved_one_else_the_last_assistant_message() {
        let saved = serde_json::from_value(json!({ "lastHandoff": "" })).unwrap();
        assert_eq!(last_handoff(&saved, &[json!({ "role": "assistant", "content": "x" })]), "");
        let none = Map::new();
        let messages = [
            json!({ "role": "assistant", "content": "first" }),
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "parts" }] }),
            json!({ "role": "assistant", "content": "  " }),
            json!({ "role": "user", "content": "later" }),
        ];
        assert_eq!(last_handoff(&none, &messages), r#"[{"type":"text","text":"parts"}]"#);
        assert_eq!(last_handoff(&none, &messages[..1]), "first");
        assert_eq!(last_handoff(&none, &[]), "");
    }

    /// `__close_all` (`daemon-agent-control.mjs:75-82`): the workers close first, the descendants
    /// are cancelled after that has settled.
    #[tokio::test]
    async fn a_teardown_closes_the_workers_before_it_cancels_the_descendants() {
        let log = std::sync::Mutex::new(Vec::new());
        let cancelled = teardown_in_order(
            async {
                tokio::task::yield_now().await;
                log.lock().unwrap().push("close_all");
            },
            async {
                log.lock().unwrap().push("cancel_descendants");
                true
            },
        )
        .await;
        assert!(cancelled);
        assert_eq!(*log.lock().unwrap(), ["close_all", "cancel_descendants"]);
    }
}