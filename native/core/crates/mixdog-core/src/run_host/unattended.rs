//! The gate's two process-service seams: the unattended run that owns a thread
//! (`unattendedRunOf`, `session-runtime/held-requests.mjs:59`) and the contact bots
//! (`isContactAgentId(id, readAgentDefinitionKind(id))`).

use mixdog_core_ports::ports::run_stamps::RunStamps;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::policy::RunKind;
use serde_json::Value;

use super::mcp_seams::ContactBots;
use super::mcp_seams::UnattendedRuns;
use mixdog_core_agents::agents::ContactIds;
use mixdog_core_ports::ports::gate::GateRun;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_config::workflow::ids::truthy;

#[async_trait]
impl ContactBots for ContactIds {
    async fn is_contact_bot(&self, agent_id: &str) -> bool {
        ContactIds::is_contact_bot(self, agent_id).await
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
struct Marked {
    kind: RunKind,
    agent_id: String,
    name: String,
}

/// The unattended runs of the process: the schedule and webhook runs marked while they run, plus
/// what a session's own record says.
pub struct UnattendedRunRegistry {
    marked: Mutex<HashMap<String, Arc<Marked>>>,
    stamps: Arc<dyn RunStamps>,
}

/// A marked run. Dropping it unmarks the session, unless a later run has marked it since.
pub struct RunMark {
    registry: Arc<UnattendedRunRegistry>,
    thread: String,
    run: Arc<Marked>,
}

impl Drop for RunMark {
    fn drop(&mut self) {
        let mut marked = self.registry.marked.lock().unwrap_or_else(PoisonError::into_inner);
        if marked.get(&self.thread).is_some_and(|current| Arc::ptr_eq(current, &self.run)) {
            marked.remove(&self.thread);
        }
    }
}

impl UnattendedRunRegistry {
    pub fn new(stamps: Arc<dyn RunStamps>) -> Arc<Self> {
        Arc::new(Self { marked: Mutex::new(HashMap::new()), stamps })
    }

    /// `markUnattendedRun(sessionId, { kind, agentId, name })`: `kind` other than a webhook is a
    /// schedule, an empty owner is Mixy. An empty session id marks nothing.
    pub fn mark(self: &Arc<Self>, thread: &str, kind: RunKind, agent_id: &str, name: &str) -> Option<RunMark> {
        if thread.is_empty() {
            return None;
        }
        let kind = if kind == RunKind::Webhook { RunKind::Webhook } else { RunKind::Schedule };
        let agent_id = if agent_id.is_empty() { MIXY_AGENT_ID } else { agent_id };
        let run = Arc::new(Marked { kind, agent_id: agent_id.to_owned(), name: name.to_owned() });
        self.marked.lock().unwrap_or_else(PoisonError::into_inner).insert(thread.to_owned(), run.clone());
        Some(RunMark { registry: self.clone(), thread: thread.to_owned(), run })
    }
}

#[async_trait]
impl UnattendedRuns for UnattendedRunRegistry {
    /// A marked run; else a room member's own session (the room is the run's name); else the
    /// schedule or webhook run stamped on the session's record, with an owner.
    async fn run_of(&self, thread: &ThreadId) -> Option<GateRun> {
        let id = thread.as_str();
        if let Some(run) = self.marked.lock().unwrap_or_else(PoisonError::into_inner).get(id) {
            return Some(GateRun { kind: run.kind, agent_id: run.agent_id.clone() });
        }
        if let Some(member) = room_member_of_session(id) {
            return Some(GateRun { kind: RunKind::Room, agent_id: member.agent_id });
        }
        let stamp = self.stamps.stamp_of(thread).await?;
        let kind = match stamp.get("kind").and_then(Value::as_str)? {
            "schedule" => RunKind::Schedule,
            "webhook" => RunKind::Webhook,
            _ => return None,
        };
        // `stamped.agentId` is any truthy value, read as `String(stamped.agentId)`.
        let owner = stamp.get("agentId").filter(|owner| truthy(Some(owner)))?;
        Some(GateRun { kind, agent_id: mixdog_js::value_to_string(owner) })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;

    struct Stamped(HashMap<&'static str, Value>);
    #[async_trait]
    impl RunStamps for Stamped {
        async fn stamp_of(&self, thread: &ThreadId) -> Option<Value> {
            self.0.get(thread.as_str()).cloned()
        }
    }

    fn registry() -> Arc<UnattendedRunRegistry> {
        UnattendedRunRegistry::new(Arc::new(Stamped(HashMap::from([
            ("sess_child", json!({ "kind": "webhook", "agentId": "mailer", "name": "Hook" })),
            ("sess_noowner", json!({ "kind": "schedule", "agentId": "" })),
            ("sess_odd", json!({ "kind": "room", "agentId": "mailer" })),
            ("sess_num", json!({ "kind": "schedule", "agentId": 123 })),
            ("sess_zero", json!({ "kind": "schedule", "agentId": 0 })),
        ]))))
    }

    async fn run(registry: &UnattendedRunRegistry, id: &str) -> Option<(RunKind, String)> {
        registry.run_of(&ThreadId::from(id.to_owned())).await.map(|run| (run.kind, run.agent_id))
    }

    #[tokio::test]
    async fn a_session_is_the_run_node_says_it_is() {
        let registry = registry();
        assert_eq!(run(&registry, "sess_plain").await, None, "an attended session");
        // A marked run: a schedule unless a webhook, Mixy when no owner is given.
        let daily = registry.mark("sess_home_mailer", RunKind::Schedule, "mailer", "Daily").unwrap();
        let hook = registry.mark("sess_hook", RunKind::Webhook, "", "Hook").unwrap();
        let odd = registry.mark("sess_odd_mark", RunKind::Room, "mailer", "").unwrap();
        assert_eq!(run(&registry, "sess_home_mailer").await, Some((RunKind::Schedule, "mailer".into())));
        assert_eq!(run(&registry, "sess_hook").await, Some((RunKind::Webhook, "lead".into())));
        assert_eq!(run(&registry, "sess_odd_mark").await, Some((RunKind::Schedule, "mailer".into())), "only a webhook stays a webhook");
        assert!(registry.mark("", RunKind::Schedule, "mailer", "").is_none());
        // A room member's own session is a room run of its agent.
        let member = mixdog_core_base::rooms::ids::room_member_session_id("abc123", "ann").unwrap();
        assert_eq!(run(&registry, &member).await, Some((RunKind::Room, "ann".into())));
        // Work a run started carries the run on its own record, if it names a schedule or webhook with an owner.
        assert_eq!(run(&registry, "sess_child").await, Some((RunKind::Webhook, "mailer".into())));
        assert_eq!(run(&registry, "sess_noowner").await, None);
        assert_eq!(run(&registry, "sess_odd").await, None, "a stamp is never a room run");
        // Any truthy owner is read as `String(owner)`; a falsy one is no owner.
        assert_eq!(run(&registry, "sess_num").await, Some((RunKind::Schedule, "123".into())));
        assert_eq!(run(&registry, "sess_zero").await, None);
        drop((daily, hook, odd));
        assert_eq!(run(&registry, "sess_home_mailer").await, None, "ending the run unmarks it");
    }

    #[tokio::test]
    async fn an_older_marks_end_does_not_unmark_a_newer_run() {
        let registry = registry();
        let first = registry.mark("sess_a", RunKind::Schedule, "mailer", "one").unwrap();
        let second = registry.mark("sess_a", RunKind::Webhook, "mailer", "two").unwrap();
        drop(first);
        assert_eq!(run(&registry, "sess_a").await, Some((RunKind::Webhook, "mailer".into())));
        drop(second);
        assert_eq!(run(&registry, "sess_a").await, None);
    }
}
