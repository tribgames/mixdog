//! The agent tool's session side (`Sessions`): the agent tree's handoff read, close and
//! descendants (1.4.5 `agent-tree.mjs`, `session-close.mjs`, `lifecycle-barriers.mjs`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::board::{CancelAll, JobBoard};
use mixdog_agent::agent_tool::host::CloseOptions;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::host::Sessions;
use mixdog_core_api::ids::ThreadId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

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

    /// Node's only caller of `cancelAgentDescendants` is the runtime teardown of a Lead
    /// (`__close_all`, `daemon-agent-control.mjs:75-82`, from `teardown.mjs:231`): every Lead
    /// the process hosts has its agents cancelled with `agent owner closed`. A Lead is a loaded
    /// thread that is not itself an agent session.
    pub async fn cancel_all_owners(&self, board: &JobBoard) {
        for handle in self.directory.loaded_handles() {
            let header = handle.cell.header.load();
            let agent_owned = header.get("owner").and_then(Value::as_str) == Some("agent") || header.get("visibility").and_then(Value::as_str) == Some("agent-only");
            if !agent_owned {
                self.cancel_descendants(handle.id.as_str(), "agent owner closed", board).await;
            }
        }
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
    /// (`bumpSessionGenerationAttempt`: `updatedAt`, `detachedReason`, and `ownerClosedAt` on an
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
        let now = self.clock.now_ms();
        let mut set = Map::new();
        set.insert("updatedAt".into(), json!(now));
        set.insert("detachedReason".into(), Value::String(reason.to_owned()));
        if options.owner_close {
            set.insert("ownerClosedAt".into(), json!(now));
        }
        if self.threads.patch_header(&thread, set, Vec::new()).await.is_err() {
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
}
