//! The real [`HandoffEnv`]: what a `handoff_user` call touches besides the approval gate and the
//! desktop's page commands.
//!
//! - `human_needed`: the unattended port's `humanNeeded` (`failRunForHuman`,
//!   `session-runtime/held-requests.mjs`): a marked schedule or webhook run ends now.
//! - `record_decision`: `recordHumanDecision(gate, { response, device })` for a gate that offers no
//!   grant (`human-gate/gate.mjs`): one audit line for the agent the session acts for.
//! - `computer_bind` / `computer_input`: the Computer Use secret bind and fill, which the desktop
//!   served over the computer bridge (`computer-bridge/client.mjs` `computerSecretBind`,
//!   `computerSecretInput`); the value is the one `approval/provideSecret` put in the one secret
//!   store, [`SecretFill`]'s slots, and the fill is that store's.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_member_of_session;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::secret_input::SecretFill;
use mixdog_tools::policy::AuditEntry;
use mixdog_tools::policy::GrantStore;
use mixdog_tools::state::handoff::GateRecord;
use mixdog_tools::state::handoff::HandoffEnv;
use mixdog_tools::state::secrets::ComputerSecretHost;

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
    fill: Arc<SecretFill>,
    computers: Arc<dyn ComputerHosts>,
    aborts: Arc<dyn TurnAborts>,
}

impl SessionHandoffEnv {
    pub fn new(
        runs: Arc<UnattendedRunRegistry>,
        store: Arc<dyn GrantStore>,
        fill: Arc<SecretFill>,
        computers: Arc<dyn ComputerHosts>,
        aborts: Arc<dyn TurnAborts>,
    ) -> Self {
        Self { runs, store, fill, computers, aborts }
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
        self.fill.computer_bind(thread, request_id, window_id, reference)
    }

    async fn computer_input(&self, thread: &ThreadId, request_id: &str, window_id: &str, reference: &str) -> String {
        if thread.as_str().is_empty() || request_id.is_empty() || self.computers.secret_host(thread).is_none() {
            return "blocked".to_owned();
        }
        self.fill.computer_input(thread, request_id, window_id, reference).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::value;
    use mixdog_core_ports::ports::run_stamps::RunStamps;
    use mixdog_core_session::session::secret_input::ComputerCommands;
    use mixdog_core_session::session::secret_input::FillGates;
    use mixdog_core_session::session::secret_input::SECRET_INPUT_TIMEOUT;
    use mixdog_core_session::session::secret_input::SecretInputService;
    use mixdog_core_session::session::secret_input::SecretSlots;
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

    /// The fill's commands, onto the session's helper: what the production adapter does.
    struct HelperCommands(Arc<Helper>);
    #[async_trait]
    impl ComputerCommands for HelperCommands {
        async fn execute(&self, _: &ThreadId, command: Value) -> Result<Value, String> {
            let Value::Object(command) = command else { return Err("not an object".to_owned()) };
            self.0.execute(command).await.map(Value::Object)
        }
    }

    /// No takeover or human-only approval is pending.
    struct NothingHeld;
    impl FillGates for NothingHeld {
        fn browser_free(&self, _: &ThreadId) -> bool {
            true
        }
        fn computer_free(&self) -> bool {
            true
        }
    }

    /// A computer fill never asks the desktop.
    struct NoDesktop;

    #[async_trait]
    impl mixdog_core_api::HostChannel for NoDesktop {
        async fn request(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<Value, mixdog_core_api::HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
        fn notify(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(), mixdog_core_api::CoreError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
    }

    #[async_trait]
    impl mixdog_core_api::ClaimedHostChannel for NoDesktop {
        async fn request_claimed(&self, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<(mixdog_core_api::HostClaim, Value), mixdog_core_api::HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
        async fn request_to(&self, _: &mixdog_core_api::HostClaim, _: mixdog_core_api::HostCapability, _: mixdog_core_api::ids::Method, _: Value) -> Result<Value, mixdog_core_api::HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
    }

    /// The one place that builds the fill.
    fn fill_over(slots: &Arc<SecretSlots>, helper: &Arc<Helper>) -> Arc<SecretFill> {
        Arc::new(SecretFill::new(slots.clone(), Arc::new(NothingHeld), Arc::new(HelperCommands(helper.clone())), Arc::new(NoDesktop)))
    }

    struct Rig {
        env: SessionHandoffEnv,
        runs: Arc<UnattendedRunRegistry>,
        store: Arc<MemoryGrantStore>,
        slots: Arc<SecretSlots>,
        fill: Arc<SecretFill>,
        aborts: Arc<Aborts>,
        helper: Arc<Helper>,
    }

    fn rig() -> Rig {
        let runs = UnattendedRunRegistry::new(Arc::new(NoStamps));
        let store = Arc::new(MemoryGrantStore::default());
        let slots = Arc::new(SecretSlots::new(SECRET_INPUT_TIMEOUT));
        let aborts = Arc::new(Aborts::default());
        let helper = Arc::new(Helper::default());
        let fill = fill_over(&slots, &helper);
        let computers = Arc::new(Computers(HashMap::from([("sess_pc".to_owned(), helper.clone())])));
        let env = SessionHandoffEnv::new(runs.clone(), store.clone(), fill.clone(), computers, aborts.clone());
        Rig { env, runs, store, slots, fill, aborts, helper }
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
        assert!(rig.slots.provide("secret_abcdefgh", "pw"));
        assert_eq!(rig.env.computer_input(&thread("sess_none"), "secret_abcdefgh", "w1", "e1").await, "blocked");
        assert_eq!(rig.env.computer_input(&pc, "secret_abcdefgh", "w2", "e1").await, "page_changed");
        assert_eq!(rig.env.computer_input(&pc, "secret_abcdefgh", "w1", "e1").await, "expired", "a refused fill dropped the value");
        assert!(rig.helper.0.lock().unwrap().is_empty());
        assert_eq!(rig.env.computer_bind(&pc, "secret_abcdefgh", "w1", "e1").await, "bound");
        assert!(rig.slots.provide("secret_abcdefgh", "pw"));
        assert_eq!(rig.env.computer_input(&pc, "secret_abcdefgh", "w1", "e1").await, "entered");
        assert_eq!(rig.helper.0.lock().unwrap().len(), 2, "the write and the read-back of a two-character value");
        assert_eq!(rig.fill.redact(&pc, "the pw"), "the [redacted]");
    }

    /// The value the card hands `approval/provideSecret` is the one the bound field is typed with:
    /// one store, no copy between the request and the fill.
    #[tokio::test]
    async fn a_value_provided_through_provide_secret_is_the_one_computer_input_types() {
        let rig = rig();
        let pc = thread("sess_pc");
        let provide = SecretInputService::new(rig.slots.clone());
        assert_eq!(rig.env.computer_bind(&pc, "secret_abcdefgh", "w1", "e1").await, "bound");
        let params = json!({ "opId": "x", "requestId": "secret_abcdefgh", "secret": "pw" });
        assert_eq!(value(&provide, request("approval/provideSecret", params, Some(1))).await.unwrap(), json!({}));
        assert_eq!(rig.env.computer_input(&pc, "secret_abcdefgh", "w1", "e1").await, "entered");
        let sent = rig.helper.0.lock().unwrap().clone();
        assert_eq!(sent[0], json!({ "action": "type", "text": "pw", "session_id": "sess_pc", "ref": "e1", "window_id": "w1" }));
        assert!(!rig.slots.has("secret_abcdefgh"), "the value is taken once");
        assert_eq!(rig.fill.redact(&pc, "the pw"), "the [redacted]");
    }
}
