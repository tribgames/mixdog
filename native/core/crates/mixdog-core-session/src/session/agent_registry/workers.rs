//! The agent tool's worker sessions (`Workers`): a worker's record as the job views read it
//! (`mgr.getSession`, `job-lookup.mjs`, `agent-list.mjs`), its live progress from the session
//! cell, and the tag-bound sessions (`agentSessionEntries`) from the registry.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::scope::Scope;
use mixdog_agent::agent_tool::views::Stamp;
use mixdog_agent::agent_tool::views::WorkerFacts;
use mixdog_agent::agent_tool::views::WorkerLive;
use mixdog_agent::agent_tool::views::Workers;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

use super::AgentRegistry;
use super::Row;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_run::run_host::progress::WaitedJobs;
use crate::session::Clock;
use crate::session::SessionDirectory;

/// `workerResultText`'s placeholder.
const NO_OUTPUT: &str = "(worker session has no assistant output yet)";

pub struct AgentWorkers {
    directory: Arc<SessionDirectory>,
    threads: Arc<dyn ThreadState>,
    registry: Arc<AgentRegistry>,
    jobs: Arc<dyn WaitedJobs>,
    clock: Arc<dyn Clock>,
}

impl AgentWorkers {
    pub fn new(
        directory: Arc<SessionDirectory>,
        threads: Arc<dyn ThreadState>,
        registry: Arc<AgentRegistry>,
        jobs: Arc<dyn WaitedJobs>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self { directory, threads, registry, jobs, clock }
    }

    /// Whether the worker's turn waits on a user approval (`runtime.awaitingUser`).
    fn awaiting_user(&self, id: &str) -> bool {
        self.directory.handle(&ThreadId::from(id)).is_some_and(|handle| !handle.cell.approvals.load().is_empty())
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// `session.field || null` of a text field: a stamp may be stored as epoch milliseconds.
fn text(session: &Row, key: &str) -> Option<String> {
    session.get(key).filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string)
}

/// A clock of the record, as stored: epoch milliseconds stay a number, text stays text.
fn stamp(session: &Row, key: &str) -> Option<Stamp> {
    match session.get(key)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).map(Stamp::Ms),
        Value::String(s) => Some(Stamp::Text(s.clone())),
        _ => None,
    }
}

/// `workerResultText`: the last non-empty assistant message, else the last handoff, else a
/// placeholder.
fn worker_result_text(session: &Row, messages: &[Value]) -> String {
    let has_content = |content: Option<&Value>| match content {
        Some(Value::String(text)) => !mixdog_js::js_trim(text).is_empty(),
        other => truthy(other),
    };
    let last = messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(Value::as_str) == Some("assistant") && has_content(m.get("content")));
    if let Some(message) = last {
        return match &message["content"] {
            Value::String(text) => text.clone(),
            other => mixdog_js::json_stringify(other),
        };
    }
    match session.get("lastHandoff") {
        Some(Value::String(handoff)) if !mixdog_js::js_trim(handoff).is_empty() => handoff.clone(),
        _ => NO_OUTPUT.to_owned(),
    }
}

/// What the views read of a session record.
fn facts_of(id: &str, session: &Row, awaiting_user: bool, result_text: String) -> WorkerFacts {
    WorkerFacts {
        id: id.to_owned(),
        agent: text(session, "agent"),
        tag: text(session, "tag"),
        provider: text(session, "provider"),
        model: text(session, "model"),
        preset: text(session, "presetName"),
        effort: text(session, "effort"),
        fast: session.get("fast") == Some(&Value::Bool(true)),
        auto_effort_off: session.get("autoEffort") == Some(&Value::Bool(false)),
        status: text(session, "status"),
        closed: session.get("closed") == Some(&Value::Bool(true)),
        stage: text(session, "stage"),
        awaiting_user,
        created_at: stamp(session, "createdAt"),
        updated_at: stamp(session, "updatedAt"),
        last_used_at: stamp(session, "lastUsedAt"),
        client_host_pid: session.get("clientHostPid").and_then(Value::as_u64).filter(|pid| *pid > 0),
        result_text,
    }
}

#[async_trait]
impl Workers for AgentWorkers {
    /// `mgr.getSession(id)`: the stored session (opened when not loaded) and its conversation.
    async fn session(&self, session_id: &str) -> Option<WorkerFacts> {
        let thread = ThreadId::from(session_id);
        let header = self.threads.header(&thread).await.ok()?;
        let messages: Vec<Value> = self
            .directory
            .model_context(&thread)
            .read()
            .await
            .map(|rows| rows.into_iter().map(|(_, message)| message).collect())
            .unwrap_or_default();
        let result = worker_result_text(&header, &messages);
        Some(facts_of(session_id, &header, self.awaiting_user(session_id), result))
    }

    fn live(&self, session_id: &str) -> WorkerLive {
        self.directory.worker_live(&ThreadId::from(session_id), self.clock.now_ms(), &*self.jobs)
    }

    /// `agentSessionEntries`: index rows and live sessions as the registry holds them; the list
    /// never reads a worker's result.
    async fn entries(&self, scan_sessions: bool, scope: &Scope) -> Vec<(String, WorkerFacts)> {
        self.registry
            .session_entries(scan_sessions, scope)
            .into_iter()
            .map(|(tag, session)| {
                let id = mixdog_js::js_trim(session.get("id").and_then(Value::as_str).unwrap_or_default()).to_owned();
                let awaiting = self.awaiting_user(&id);
                let facts = facts_of(&id, &session, awaiting, NO_OUTPUT.to_owned());
                (tag, facts)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(value: Value) -> Row {
        value.as_object().cloned().unwrap()
    }

    /// `workerResultText` and the record fields `job-lookup.mjs` / `agent-list.mjs` read.
    #[test]
    fn a_workers_record_reads_as_the_job_views_read_it() {
        let session = row(json!({
            "agent": "reviewer", "tag": "rev", "provider": "openai", "model": "gpt-a", "presetName": "p",
            "effort": "", "fast": true, "autoEffort": false, "status": "running", "createdAt": 1000,
            "updatedAt": "2026-01-01T00:00:00.000Z", "clientHostPid": 0, "lastHandoff": "handed",
        }));
        let messages = [
            json!({ "role": "assistant", "content": [{ "type": "text", "text": "parts" }] }),
            json!({ "role": "assistant", "content": "   " }),
            json!({ "role": "user", "content": "q" }),
        ];
        assert_eq!(worker_result_text(&session, &messages), "[{\"type\":\"text\",\"text\":\"parts\"}]");
        assert_eq!(worker_result_text(&session, &[]), "handed");
        assert_eq!(worker_result_text(&row(json!({ "lastHandoff": " " })), &[]), NO_OUTPUT);
        let facts = facts_of("sess_w", &session, true, "r".into());
        assert_eq!((facts.preset.as_deref(), facts.effort.as_deref(), facts.fast, facts.auto_effort_off), (Some("p"), None, true, true));
        assert_eq!((facts.created_at.as_ref().and_then(Stamp::shown).as_deref(), facts.client_host_pid, facts.closed), (Some("1000"), None, false));
        assert_eq!((facts.status.as_deref(), facts.awaiting_user), (Some("running"), true));
    }
}
