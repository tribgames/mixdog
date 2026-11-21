//! The agent and project-connector setup actions: a chat may narrow an agent's authority at once but
//! widens it only through a card a person answers.

use std::sync::{Arc, Mutex, PoisonError};

use mixdog_core_ports::ports::setup_actions::{SetupActions, SetupCall};
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::FileGrantStore;
use serde_json::{Value, json};

use super::*;
use crate::agents::tests::writable;
use crate::agents::{ConnectorCatalog, NO_WIDEN};

mod approved;

struct Catalog;

#[async_trait]
impl ConnectorCatalog for Catalog {
    async fn installed(&self) -> Result<Vec<String>, String> {
        Ok(vec!["gmail".into()])
    }
    async fn tool_names(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(vec!["send".into()])
    }
    fn connector_of(&self, server: &str) -> Option<String> {
        (server == "gmail").then(|| "gmail".to_owned())
    }
}

/// One registered project and the connectors it switches off.
struct Project {
    off: Mutex<Vec<String>>,
}

impl Project {
    fn switches(&self) -> Value {
        let off = self.off.lock().unwrap_or_else(PoisonError::into_inner);
        json!([{ "id": "gmail", "enabled": !off.iter().any(|id| id == "gmail") }])
    }
}

#[async_trait]
impl ProjectSwitches for Project {
    async fn get(&self, project_path: &str) -> Result<Value, String> {
        if project_path != "/project" {
            return Err(format!("project not registered: {project_path}"));
        }
        Ok(self.switches())
    }

    async fn set_enabled(&self, _: &str, connector_id: &str, enabled: &Value) -> Result<Value, String> {
        let Value::Bool(enabled) = *enabled else { return Err("enabled must be a boolean".to_owned()) };
        let mut off = self.off.lock().unwrap_or_else(PoisonError::into_inner);
        if enabled && off.iter().any(|id| id == connector_id) {
            return Err(NO_WIDEN.to_owned());
        }
        off.retain(|id| id != connector_id);
        if !enabled {
            off.push(connector_id.to_owned());
        }
        drop(off);
        Ok(self.switches())
    }
}

/// The person at the card: the outcome they are scripted to give, and the cards they were shown.
struct Person {
    outcome: Mutex<CardOutcome>,
    cards: Mutex<Vec<WidenCard>>,
}

#[async_trait]
impl WidenCards for Person {
    async fn ask(&self, _: &ThreadId, card: &WidenCard) -> CardOutcome {
        self.cards.lock().unwrap_or_else(PoisonError::into_inner).push(card.clone());
        self.outcome.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

struct World {
    _dir: tempfile::TempDir,
    setup: AgentSettingsSetup,
    person: Arc<Person>,
    grants: Arc<FileGrantStore>,
}

/// An agent `ada` whose `send` tool of `gmail` needs approval.
async fn world() -> World {
    let (dir, agents) = writable(json!({})).await;
    let agents = Arc::new(agents);
    agents.save(json!({ "name": "Ada", "body": "Body" }).as_object().unwrap()).await.unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let connectors = Arc::new(AgentConnectors::new(agents, Arc::new(Catalog)));
    connectors.set_tool_permission("ada", &json!("gmail"), &json!("send"), &json!("needs_approval"), false).await.unwrap();
    let grants = FileGrantStore::with_clock(dir.path().join("data/human-gate"), tokens.interactive_io, tokens.durability_io, Arc::new(|| 1));
    let person = Arc::new(Person { outcome: Mutex::new(CardOutcome::NoHook), cards: Mutex::default() });
    let projects = Arc::new(Project { off: Mutex::new(vec!["gmail".into()]) });
    let setup = AgentSettingsSetup::new(connectors, Arc::new(AgentPermissions::new(grants.clone())), projects, person.clone(), grants.clone());
    World { _dir: dir, setup, person, grants }
}

async fn run(world: &World, action: &str, args: Value) -> Result<Value, PortError> {
    let mut full = args.as_object().unwrap().clone();
    full.insert("action".into(), action.into());
    let full = Value::Object(full);
    world.setup.run(&SetupCall { action, args: &full, thread: &ThreadId::from("thread-1") }).await
}

fn message(error: PortError) -> String {
    match error {
        PortError::Failed { message, .. } => message,
        other => panic!("not a failure: {other:?}"),
    }
}

fn tool_args(permission: &str) -> Value {
    json!({ "agent": "ada", "name": "gmail", "tool": "send", "permission": permission })
}

#[tokio::test]
async fn a_chat_narrowing_a_connector_tool_needs_no_card() {
    let world = world().await;
    let done = run(&world, "set_agent_connector_tool", tool_args("disabled")).await.unwrap();
    assert_eq!(done, json!({ "agent": "ada", "connector": "gmail", "tool": "send", "permission": "disabled" }));
    assert!(world.person.cards.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_widening_where_nobody_can_be_asked_is_refused() {
    let world = world().await;
    assert_eq!(message(run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap_err()), NO_WIDEN);
}

#[tokio::test]
async fn a_widening_raises_a_card_with_the_levels_above_the_current_one() {
    let world = world().await;
    *world.person.outcome.lock().unwrap() =
        CardOutcome::Settled(Some(CardAnswer { response: Some("deny".into()), device: Some("phone".into()), ..CardAnswer::default() }));
    let receipt = run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
    assert_eq!(
        receipt,
        json!({
            "agent": "ada", "connector": "gmail", "tool": "send", "requested": "auto", "saved": false, "approved": false,
            "permission": "needs_approval", "note": "The user did not approve this change; nothing changed.",
        })
    );
    let cards = world.person.cards.lock().unwrap();
    assert_eq!(cards.len(), 1);
    assert_eq!((cards[0].agent.as_str(), cards[0].server.as_str(), cards[0].tool.as_str()), ("ada", "gmail", "send"));
    assert_eq!((cards[0].from, cards[0].choices.clone()), (Permission::NeedsApproval, vec![Permission::Auto]));
    assert_eq!(cards[0].reason, "Bot \"ada\" asks to change the permission of send (gmail, all its accounts) from needs_approval to auto.");
}

#[tokio::test]
async fn a_card_nobody_answered_in_time_changes_nothing_and_says_so() {
    let world = world().await;
    *world.person.outcome.lock().unwrap() = CardOutcome::Settled(Some(CardAnswer { timed_out: true, ..CardAnswer::default() }));
    let receipt = run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
    assert_eq!(receipt["note"], "The approval card timed out; nothing changed.");
    assert_eq!((receipt["saved"].clone(), receipt["permission"].clone()), (json!(false), json!("needs_approval")));
    *world.person.outcome.lock().unwrap() = CardOutcome::Settled(None);
    let receipt = run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
    assert_eq!(receipt["note"], "The user did not approve this change; nothing changed.");
}

#[tokio::test]
async fn reading_an_agents_settings_needs_the_agent_and_a_project_needs_its_path() {
    let world = world().await;
    assert_eq!(message(run(&world, "read_agent_settings", json!({})).await.unwrap_err()), "agent is required");
    assert_eq!(message(run(&world, "read_project_connectors", json!({ "projectPath": "  " })).await.unwrap_err()), "projectPath is required");
    let settings = run(&world, "read_agent_settings", json!({ "agent": "ada" })).await.unwrap();
    assert_eq!(settings["agent"], "ada");
    assert_eq!(settings["connectors"], json!([{ "id": "gmail", "enabled": true }]));
}

#[tokio::test]
async fn a_project_connector_switches_off_at_once_but_switching_on_is_refused() {
    let world = world().await;
    let args = |enabled: bool| json!({ "projectPath": "/project", "name": "gmail", "enabled": enabled });
    // The project starts with gmail off: turning it on would widen.
    assert_eq!(message(run(&world, "set_project_connector", args(true)).await.unwrap_err()), NO_WIDEN);
    let listed = run(&world, "read_project_connectors", json!({ "projectPath": "/project" })).await.unwrap();
    assert_eq!(listed["connectors"], json!([{ "id": "gmail", "enabled": false }]));
    assert!(run(&world, "set_project_connector", args(false)).await.is_ok());
}

#[tokio::test]
async fn an_action_that_is_not_an_agent_settings_action_is_unavailable() {
    let world = world().await;
    assert!(matches!(run(&world, "read_models", json!({})).await.unwrap_err(), PortError::Unavailable { .. }));
}

/// The turn's approval gate: keeps each request and answers with the scripted resolution.
struct Gate {
    asks: Mutex<Vec<mixdog_core_api::domain::approval::ApprovalAsk>>,
    answer: mixdog_protocol::ApprovalResolution,
}

#[async_trait]
impl mixdog_core_api::domain::approval::ApprovalGate for Gate {
    async fn request(&self, ask: mixdog_core_api::domain::approval::ApprovalAsk) -> mixdog_protocol::ApprovalResolution {
        self.asks.lock().unwrap_or_else(PoisonError::into_inner).push(ask);
        self.answer.clone()
    }
}

fn widen_card() -> WidenCard {
    WidenCard {
        agent: "ada".into(),
        server: "gmail".into(),
        tool: "send".into(),
        from: Permission::NeedsApproval,
        requested: json!("auto"),
        choices: vec![Permission::Auto],
        args: json!({ "action": "set_agent_connector_tool" }),
        reason: "why".into(),
    }
}

fn decided(approved: bool, scope: Option<&str>, response: mixdog_protocol::HumanGateResponse) -> mixdog_protocol::ApprovalResolution {
    mixdog_protocol::ApprovalResolution::Decided {
        decision: mixdog_protocol::ToolApprovalDecision {
            approved,
            reason: None,
            answers: None,
            reply: None,
            response: Some(response),
            edited_args: None,
            remember: None,
            scope: scope.map(str::to_owned),
        },
        device: "phone".into(),
        connection_kind: mixdog_protocol::ConnectionKind::Phone,
        at: 1,
    }
}

async fn settle(answer: mixdog_protocol::ApprovalResolution) -> CardOutcome {
    use mixdog_protocol::ToolCallId;
    use mixdog_tools::orch::service::{CallApprovals, with_call_approvals};

    let gate = Arc::new(Gate { asks: Mutex::default(), answer });
    with_call_approvals(CallApprovals { gate, call_id: ToolCallId::from("call-1") }, GateWidenCards.ask(&ThreadId::from("thread-1"), &widen_card())).await
}

#[tokio::test]
async fn a_widening_card_is_an_approval_request_on_the_turns_gate_and_its_answer_is_read_back() {
    use mixdog_protocol::{HumanGateResponse, ToolCallId};
    use mixdog_tools::orch::service::{CallApprovals, with_call_approvals};

    let thread = ThreadId::from("thread-1");
    let card = widen_card();
    let gate = Arc::new(Gate { asks: Mutex::default(), answer: decided(true, Some("auto"), HumanGateResponse::Approve) });
    let outcome = with_call_approvals(CallApprovals { gate: gate.clone(), call_id: ToolCallId::from("call-1") }, GateWidenCards.ask(&thread, &card)).await;
    assert_eq!(
        outcome,
        CardOutcome::Settled(Some(CardAnswer {
            approved: true,
            scope: Some("auto".into()),
            timed_out: false,
            response: Some("approve".into()),
            device: Some("phone".into())
        }))
    );
    let asks = gate.asks.lock().unwrap();
    assert_eq!(asks.len(), 1);
    assert_eq!(asks[0].call_id, Some(ToolCallId::from("call-1")));
    assert_eq!(asks[0].tool.as_deref(), Some("setup"));
    assert_eq!(asks[0].payload["connector"], json!({ "server": "gmail", "tool": "send", "from": "needs_approval", "requested": "auto", "choices": ["auto"] }));
    assert_eq!(asks[0].payload["agentId"], "ada");
    assert!(asks[0].remember.is_empty() && asks[0].action_kind.is_none(), "nothing is remembered");
}

#[tokio::test]
async fn outside_a_turns_tool_call_a_widening_card_has_no_approval_hook() {
    assert_eq!(GateWidenCards.ask(&ThreadId::from("thread-1"), &widen_card()).await, CardOutcome::NoHook);
}

#[tokio::test]
async fn a_session_with_no_approval_surface_asked_nobody() {
    assert_eq!(settle(mixdog_protocol::ApprovalResolution::Unavailable { at: 1 }).await, CardOutcome::NoHook);
}

#[tokio::test]
async fn a_timed_out_card_settles_as_timed_out() {
    assert_eq!(
        settle(mixdog_protocol::ApprovalResolution::TimedOut { at: 1 }).await,
        CardOutcome::Settled(Some(CardAnswer { timed_out: true, ..CardAnswer::default() }))
    );
}

#[tokio::test]
async fn a_withdrawn_card_settles_without_an_answer() {
    assert_eq!(settle(mixdog_protocol::ApprovalResolution::Withdrawn { at: 1 }).await, CardOutcome::Settled(None));
}

#[tokio::test]
async fn a_denied_card_settles_as_denied_with_the_answering_device() {
    assert_eq!(
        settle(decided(false, None, mixdog_protocol::HumanGateResponse::Deny)).await,
        CardOutcome::Settled(Some(CardAnswer { approved: false, scope: None, timed_out: false, response: Some("deny".into()), device: Some("phone".into()) }))
    );
}
