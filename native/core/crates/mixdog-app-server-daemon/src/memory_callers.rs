//! Whose memory a calling thread reads and writes (`memoryCallerScope`,
//! `session-runtime/services/memory-access.mjs`), the `memory_caller` the `memory` and `recall`
//! tools hand the memory runtime. The provenance rules are the setup callers' own
//! (`scheduleCallerScope`); this adds the agent each scope names.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::setup_actions::SetupCallers;
use mixdog_js::js_trim;
use mixdog_protocol::ThreadId;
use mixdog_services::memory::tool::MemoryCallers;
use serde_json::Value;
use serde_json::json;

use crate::compose_mcp::CallerSessions;
use crate::held_requests::HeldHome;

pub struct ThreadMemoryCallers {
    sessions: Arc<dyn CallerSessions>,
    scopes: Arc<dyn SetupCallers>,
    runs: Arc<dyn HeldHome>,
}

impl ThreadMemoryCallers {
    /// `scopes` is the one `SetupCallers` of `McpComposed::callers`; `sessions` and `runs` are the
    /// ones it was built over (`SetupSeams`).
    pub fn new(sessions: Arc<dyn CallerSessions>, scopes: Arc<dyn SetupCallers>, runs: Arc<dyn HeldHome>) -> Self {
        Self { sessions, scopes, runs }
    }
}

fn caller(kind: &str, agent_id: &str) -> Value {
    json!({ "kind": kind, "agentId": agent_id })
}

/// `validAgentId`: a string that names an agent, else empty.
fn valid_agent_id(value: Option<&Value>) -> String {
    let id = value.and_then(Value::as_str).map(js_trim).unwrap_or_default();
    if agent_home_session_id(id).is_some() { id.to_owned() } else { String::new() }
}

#[async_trait]
impl MemoryCallers for ThreadMemoryCallers {
    async fn memory_caller(&self, thread: &ThreadId) -> Value {
        // A caller whose record cannot be read counts as an unattended run without an agent.
        let Some(header) = self.sessions.header(thread).await else { return caller("headless", "") };
        match self.scopes.scope(thread).await {
            CallerScope::Human => caller("human", MIXY_AGENT_ID),
            CallerScope::Agent { agent_id, .. } => caller("agent", &agent_id),
            CallerScope::RoomMember => {
                let agent_id = match room_member_of_session(thread.as_str()) {
                    Some(member) => member.agent_id,
                    None => self.runs.run_of(thread).await.map(|run| run.agent_id).unwrap_or_default(),
                };
                caller("room-member", &agent_id)
            }
            CallerScope::Headless => {
                let owner = header.get("owner").and_then(Value::as_str).map(|owner| js_trim(owner).to_lowercase());
                let delegated = owner.as_deref() == Some("agent") || truthy(header.get("parentSessionId"));
                let owner_agent = valid_agent_id(header.get("ownerAgentId"));
                let agent_id = if owner_agent.is_empty() && delegated { valid_agent_id(header.get("agent")) } else { owner_agent };
                caller("headless", &agent_id)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::CoreError;
    use mixdog_protocol::HeldRunKind;
    use serde_json::Map;

    use super::*;
    use crate::held_requests::RunInfo;

    struct Fixed {
        header: Option<Map<String, Value>>,
        scope: CallerScope,
        run: Option<RunInfo>,
    }

    #[async_trait]
    impl CallerSessions for Fixed {
        async fn header(&self, _: &ThreadId) -> Option<Map<String, Value>> {
            self.header.clone()
        }
        async fn acting_agent(&self, _: &ThreadId) -> Result<String, CoreError> {
            Ok(String::new())
        }
    }

    #[async_trait]
    impl SetupCallers for Fixed {
        async fn scope(&self, _: &ThreadId) -> CallerScope {
            self.scope.clone()
        }
        async fn is_heartbeat(&self, _: &ThreadId) -> bool {
            false
        }
    }

    #[async_trait]
    impl HeldHome for Fixed {
        async fn run_of(&self, _: &ThreadId) -> Option<RunInfo> {
            self.run.clone()
        }
        fn ui_attached(&self, _: &ThreadId) -> bool {
            false
        }
        async fn deliver(&self, _: &str, _: &mixdog_protocol::HeldRequest) -> Result<(), String> {
            Ok(())
        }
        fn push(&self, _: &crate::held_requests::HeldPush) {}
        async fn agent_name(&self, id: &str) -> Result<String, String> {
            Ok(id.to_owned())
        }
        fn new_id(&self) -> String {
            "1".into()
        }
    }

    async fn caller_of(thread: &str, header: Option<Value>, scope: CallerScope, run: Option<RunInfo>) -> Value {
        let fixed = Arc::new(Fixed { header: header.map(|header| header.as_object().cloned().expect("object")), scope, run });
        ThreadMemoryCallers::new(fixed.clone(), fixed.clone(), fixed).memory_caller(&ThreadId::from(thread)).await
    }

    /// `memoryCallerScope`: the user's sessions act as Mixy, an agent's home as that agent, a room
    /// member as its agent (also for a room's unattended run), a delegated run as its owner's agent.
    #[tokio::test]
    async fn each_scope_names_the_agent_node_gives_it() {
        let header = || Some(json!({}));
        assert_eq!(caller_of("t", header(), CallerScope::Human, None).await, json!({ "kind": "human", "agentId": "lead" }));
        let agent = CallerScope::Agent { agent_id: "ana".into(), unattended: true };
        assert_eq!(caller_of("t", header(), agent, None).await, json!({ "kind": "agent", "agentId": "ana" }));
        let run = RunInfo { kind: HeldRunKind::Room, agent_id: "bo".into(), name: "room1".into() };
        assert_eq!(caller_of("t", header(), CallerScope::RoomMember, Some(run)).await, json!({ "kind": "room-member", "agentId": "bo" }));
        assert_eq!(caller_of("t", None, CallerScope::Human, None).await, json!({ "kind": "headless", "agentId": "" }));
    }

    #[tokio::test]
    async fn a_headless_run_acts_for_its_owner_agent_or_its_delegate() {
        let scope = || CallerScope::Headless;
        let owned = Some(json!({ "ownerAgentId": " ana ", "agent": "worker" }));
        assert_eq!(caller_of("t", owned, scope(), None).await, json!({ "kind": "headless", "agentId": "ana" }));
        let delegated = Some(json!({ "owner": "Agent", "agent": "worker" }));
        assert_eq!(caller_of("t", delegated, scope(), None).await, json!({ "kind": "headless", "agentId": "worker" }));
        let child = Some(json!({ "parentSessionId": "sess_x", "agent": "Not An Id" }));
        assert_eq!(caller_of("t", child, scope(), None).await, json!({ "kind": "headless", "agentId": "" }));
        let plain = Some(json!({ "agent": "worker" }));
        assert_eq!(caller_of("t", plain, scope(), None).await, json!({ "kind": "headless", "agentId": "" }));
    }
}
