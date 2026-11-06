//! The agent tool's session side (`Sessions`): the agent tree's handoff read, close and
//! descendants (1.4.5 `agent-tree.mjs`, `session-close.mjs`, `lifecycle-barriers.mjs`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::host::CloseOptions;
use mixdog_agent::agent_tool::host::Sessions;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::AgentRegistry;
use mixdog_core_ports::ports::threads::ThreadState;
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
}

impl AgentSessions {
    pub fn new(
        directory: Arc<SessionDirectory>,
        threads: Arc<dyn ThreadState>,
        registry: Arc<AgentRegistry>,
        statusline: Arc<dyn AgentStatusline>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { directory, threads, registry, statusline, clock }
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
        let Some(handle) = self.directory.handle(&thread) else { return true };
        if let Some(run) = handle.cell.run.load_full() {
            let _ = handle.cell.abort(&run.turn, &mixdog_agent::cancel::close_session_reason(session_id, reason));
        }
        let queued: Vec<String> = handle.cell.queued.load().iter().cloned().collect();
        for qid in queued {
            let request = CoreRequest {
                method: Method("thread/queue/delete"),
                params: json!({ "threadId": thread, "queuedId": qid }),
                op: None,
                ctx: CallContext::internal("agent-close"),
            };
            let _ = handle.request(request).await;
        }
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
