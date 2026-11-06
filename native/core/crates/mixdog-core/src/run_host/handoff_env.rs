//! The real [`HandoffEnv`]: what a `handoff_user` call touches besides the approval gate and the
//! desktop's page commands.
//!
//! - `human_needed`: the unattended port's `humanNeeded` (`failRunForHuman`,
//!   `session-runtime/held-requests.mjs`): a marked schedule or webhook run ends now.
//! - `record_decision`: `recordHumanDecision(gate, { response, device })` for a gate that offers no
//!   grant (`human-gate/gate.mjs`): one audit line for the agent the session acts for.
//! - `computer_bind` / `computer_input`: the Computer Use secret bind and fill, which the desktop
//!   served over the computer bridge (`computer-bridge/client.mjs` `computerSecretBind`,
//!   `computerSecretInput`); the value is the one `approval/provideSecret` put in the shared
//!   [`SecretRequests`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_session::session::SessionDirectory;
use mixdog_tools::policy::AuditEntry;
use mixdog_tools::policy::GrantStore;
use mixdog_tools::state::handoff::GateRecord;
use mixdog_tools::state::handoff::HandoffEnv;
use mixdog_tools::state::secrets::ComputerBinding;
use mixdog_tools::state::secrets::ComputerSecretHost;
use mixdog_tools::state::secrets::SecretRequests;
use mixdog_tools::state::secrets::type_computer_secret;

use super::mcp_seams::UnattendedRuns;
use super::unattended::UnattendedRunRegistry;

/// `abortSessionTurn(id, reason)`.
pub trait TurnAborts: Send + Sync {
    fn abort_session_turn(&self, thread: &ThreadId, reason: &str) -> bool;
}

impl TurnAborts for SessionDirectory {
    fn abort_session_turn(&self, thread: &ThreadId, reason: &str) -> bool {
        SessionDirectory::abort_session_turn(self, thread, reason)
    }
}

/// The computer helper of a thread's session; `None` when no desktop control is attached to it
/// (the bridge had no discovery file).
pub trait ComputerHosts: Send + Sync {
    fn secret_host(&self, thread: &ThreadId) -> Option<Arc<dyn ComputerSecretHost>>;
}

pub struct SessionHandoffEnv {
    runs: Arc<UnattendedRunRegistry>,
    store: Arc<dyn GrantStore>,
    secrets: Arc<SecretRequests>,
    computers: Arc<dyn ComputerHosts>,
    aborts: Arc<dyn TurnAborts>,
}

impl SessionHandoffEnv {
    pub fn new(
        runs: Arc<UnattendedRunRegistry>,
        store: Arc<dyn GrantStore>,
        secrets: Arc<SecretRequests>,
        computers: Arc<dyn ComputerHosts>,
        aborts: Arc<dyn TurnAborts>,
    ) -> Self {
        Self { runs, store, secrets, computers, aborts }
    }

    /// `agentIdForSession`: the unattended run's owner, a room member, a home thread's agent,
    /// else Mixy.
    async fn agent_id(&self, thread: &ThreadId) -> String {
        if let Some(run) = self.runs.run_of(thread).await.filter(|run| !run.agent_id.is_empty()) {
            return run.agent_id;
        }
        let id = thread.as_str();
        room_member_of_session(id)
            .map(|member| member.agent_id)
            .or_else(|| agent_id_of_home_session(id))
            .filter(|agent| !agent.is_empty())
            .unwrap_or_else(|| MIXY_AGENT_ID.to_owned())
    }
}

#[async_trait]
impl HandoffEnv for SessionHandoffEnv {
    async fn human_needed(&self, thread: &ThreadId, outcome: &str, site: &str) -> bool {
        if !self.runs.fail_for_human(thread.as_str(), outcome, site) {
            return false;
        }
        self.aborts.abort_session_turn(thread, "login-required");
        true
    }

    async fn record_decision(&self, thread: &ThreadId, gate: &GateRecord, response: &str, device: &str) -> Result<(), String> {
        let entry = AuditEntry {
            agent_id: self.agent_id(thread).await,
            kind: gate.kind.to_owned(),
            tool: gate.tool.clone(),
            target: gate.target.clone(),
            decision: response.to_owned(),
            device: device.to_owned(),
            ..AuditEntry::default()
        };
        self.store.record_audit(entry).await.map_err(|error| error.0)
    }

    async fn computer_bind(&self, thread: &ThreadId, request_id: &str, window_id: &str, reference: &str) -> String {
        if thread.as_str().is_empty() || request_id.is_empty() || self.computers.secret_host(thread).is_none() {
            return "blocked".to_owned();
        }
        let binding = ComputerBinding { session: thread.as_str().to_owned(), window_id: window_id.to_owned(), reference: reference.to_owned() };
        if self.secrets.bind_computer(request_id, binding) { "bound" } else { "no_field" }.to_owned()
    }

    async fn computer_input(&self, thread: &ThreadId, request_id: &str, window_id: &str, reference: &str) -> String {
        if thread.as_str().is_empty() || request_id.is_empty() {
            return "blocked".to_owned();
        }
        let Some(host) = self.computers.secret_host(thread) else { return "blocked".to_owned() };
        type_computer_secret(&self.secrets, &*host, thread.as_str(), request_id, reference, window_id).await.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use mixdog_core_ports::ports::run_stamps::RunStamps;
    use mixdog_tools::policy::MemoryGrantStore;
    use mixdog_tools::policy::RunKind;
    use serde_json::Map;
    use serde_json::Value;
    use serde_json::json;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/handoff-env/golden.json"))).expect("golden")
    }

    struct NoStamps;
    #[async_trait]
    impl RunStamps for NoStamps {
        async fn stamp_of(&self, _: &ThreadId) -> Option<Value> {
            None
        }
    }

    #[derive(Default)]
    struct Aborts(Mutex<Vec<(String, String)>>);
    impl TurnAborts for Aborts {
        fn abort_session_turn(&self, thread: &ThreadId, reason: &str) -> bool {
            self.0.lock().unwrap().push((thread.as_str().to_owned(), reason.to_owned()));
            true
        }
    }

    /// A computer helper that accepts every command.
    #[derive(Default)]
    struct Helper(Mutex<Vec<Value>>);
    #[async_trait]
    impl ComputerSecretHost for Helper {
        async fn execute(&self, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
            self.0.lock().unwrap().push(Value::Object(command));
            Ok(Map::new())
        }
        fn arm_focus(&self) {}
    }

    struct Computers(HashMap<String, Arc<Helper>>);
    impl ComputerHosts for Computers {
        fn secret_host(&self, thread: &ThreadId) -> Option<Arc<dyn ComputerSecretHost>> {
            self.0.get(thread.as_str()).map(|helper| helper.clone() as Arc<dyn ComputerSecretHost>)
        }
    }

    struct Rig {
        env: SessionHandoffEnv,
        runs: Arc<UnattendedRunRegistry>,
        store: Arc<MemoryGrantStore>,
        secrets: Arc<SecretRequests>,
        aborts: Arc<Aborts>,
        helper: Arc<Helper>,
    }

    fn rig() -> Rig {
        let runs = UnattendedRunRegistry::new(Arc::new(NoStamps));
        let store = Arc::new(MemoryGrantStore::default());
        let secrets = Arc::new(SecretRequests::new());
        let aborts = Arc::new(Aborts::default());
        let helper = Arc::new(Helper::default());
        let computers = Arc::new(Computers(HashMap::from([("sess_pc".to_owned(), helper.clone())])));
        let env = SessionHandoffEnv::new(runs.clone(), store.clone(), secrets.clone(), computers, aborts.clone());
        Rig { env, runs, store, secrets, aborts, helper }
    }

    fn thread(id: &str) -> ThreadId {
        ThreadId::from(id.to_owned())
    }

    /// Every recorded `recordHumanDecision` of a handoff gate: one audit line for the agent the
    /// session acts for, the answer as its decision and the answering device.
    #[tokio::test]
    async fn an_answered_gate_is_one_audit_line_for_the_agent_the_session_acts_for() {
        let golden = golden();
        for case in golden["audit"].as_array().expect("cases") {
            let rig = rig();
            let _run = rig.runs.mark("sess_run_ann", RunKind::Webhook, "ann", "Hook");
            let session = match case["session"].as_str().expect("session") {
                "sess_plain" => "sess_plain",
                id if id == golden["memberSession"] => golden["memberSession"].as_str().unwrap(),
                id if id == golden["homeSession"] => golden["homeSession"].as_str().unwrap(),
                other => other,
            };
            let gate = GateRecord {
                kind: if case["gate"]["kind"] == "secret" { "secret" } else { "takeover" },
                tool: case["gate"]["tool"].as_str().unwrap().to_owned(),
                target: case["gate"]["target"].as_str().unwrap().to_owned(),
            };
            let approval = &case["approval"];
            // A device that is no string is none (Node `typeof device === 'string'`).
            let device = approval["device"].as_str().unwrap_or_default();
            rig.env.record_decision(&thread(session), &gate, approval["response"].as_str().unwrap(), device).await.unwrap();
            let rows: Vec<Value> = rig
                .store
                .audit()
                .into_iter()
                .map(|row| json!({"agentId": row.agent_id, "decision": row.decision, "device": row.device, "kind": row.kind, "target": row.target, "tool": row.tool}))
                .collect();
            assert_eq!(Value::Array(rows), case["rows"], "{}", case["name"]);
        }
    }

    /// `failRunForHuman`: only a marked run ends, its turn is aborted as `login-required` and what
    /// it needs is readable until the run is unmarked.
    #[tokio::test]
    async fn only_a_marked_run_ends_for_a_human_and_remembers_why() {
        let golden = golden();
        let rig = rig();
        let mark = rig.runs.mark("sess_human", RunKind::Schedule, "ann", "Daily");
        for case in golden["human"].as_array().expect("cases") {
            let Some(want) = case.get("result") else {
                drop(mark);
                assert_eq!(rig.runs.human_needed_of("sess_human"), None, "{}", case["name"]);
                break;
            };
            let session = case["session"].as_str().unwrap();
            let session = if session == "sess_rmem_abc123_ann" { golden["memberSession"].as_str().unwrap() } else { session };
            let before = rig.aborts.0.lock().unwrap().len();
            let got = rig.env.human_needed(&thread(session), "login_required", "example.com").await;
            assert_eq!(json!(got), *want, "{}", case["name"]);
            let aborted: Vec<String> = rig.aborts.0.lock().unwrap()[before..].iter().map(|(id, reason)| {
                assert_eq!(reason, "login-required");
                id.clone()
            }).collect();
            assert_eq!(json!(aborted), case["aborted"], "{}", case["name"]);
            let needed = rig.runs.human_needed_of(session).map(|(outcome, site)| json!({"outcome": outcome, "site": site})).unwrap_or(Value::Null);
            assert_eq!(needed, case["humanNeeded"], "{}", case["name"]);
        }
    }

    #[tokio::test]
    async fn a_computer_secret_is_bound_then_typed_once_into_the_bound_field() {
        let rig = rig();
        let pc = thread("sess_pc");
        // No computer helper for the session: blocked, nothing held.
        assert_eq!(rig.env.computer_bind(&thread("sess_none"), "secret_abcdefgh", "w1", "e1").await, "blocked");
        assert_eq!(rig.env.computer_bind(&pc, "", "w1", "e1").await, "blocked");
        // A target that is no plain token has no field.
        assert_eq!(rig.env.computer_bind(&pc, "secret_abcdefgh", "a b", "e1").await, "no_field");
        assert_eq!(rig.env.computer_bind(&pc, "not-a-request", "w1", "e1").await, "no_field");
        assert_eq!(rig.env.computer_bind(&pc, "secret_abcdefgh", "w1", "e1").await, "bound");
        // The card's value arrives through `approval/provideSecret`.
        assert!(rig.secrets.provide("secret_abcdefgh", "pw"));
        assert_eq!(rig.env.computer_input(&thread("sess_none"), "secret_abcdefgh", "w1", "e1").await, "blocked");
        assert_eq!(rig.env.computer_input(&pc, "secret_abcdefgh", "w2", "e1").await, "page_changed");
        assert_eq!(rig.env.computer_input(&pc, "secret_abcdefgh", "w1", "e1").await, "expired", "a refused fill dropped the value");
        assert!(rig.helper.0.lock().unwrap().is_empty());
        assert_eq!(rig.env.computer_bind(&pc, "secret_abcdefgh", "w1", "e1").await, "bound");
        assert!(rig.secrets.provide("secret_abcdefgh", "pw"));
        assert_eq!(rig.env.computer_input(&pc, "secret_abcdefgh", "w1", "e1").await, "entered");
        assert_eq!(rig.helper.0.lock().unwrap().len(), 2, "the write and the read-back of a two-character value");
        assert_eq!(rig.secrets.redact("sess_pc", "the pw"), "the [redacted]");
    }
}
