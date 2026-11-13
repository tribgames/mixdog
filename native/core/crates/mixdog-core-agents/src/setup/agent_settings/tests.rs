//! The six agent and project-connector setup actions against the answers of Node's real handlers
//! (`fixtures/desktop/settings/agent-settings-setup-twin.json`, from
//! `benchmarks/rust-core/recorders/record-agent-settings-setup.mjs`): one script of calls over a
//! fresh data folder, the widening cards answered the way the script's person answers them. Each
//! call answers what Node's did, raises the card Node raised, and leaves the files Node left
//! (definitions, grants, audit). The project switches are a model of the registered project: the
//! real `ProjectConnectors` has its own goldens in `mixdog-core-session`.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use futures::FutureExt as _;
use mixdog_core_ports::ports::setup_actions::{SetupActions, SetupCall};
use mixdog_protocol::ThreadId;
use mixdog_rt::{DurabilityIo, InLane, LaneToken as _};
use mixdog_tools::orch::util::PortError;
use mixdog_tools::policy::FileGrantStore;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::*;
use crate::agents::tests::writable;
use crate::agents::{ConnectorCatalog, NO_WIDEN};

const TWIN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/desktop/settings/agent-settings-setup-twin.json");

struct Catalog {
    servers: Vec<String>,
    tools: Vec<(String, String)>,
}

#[async_trait]
impl ConnectorCatalog for Catalog {
    async fn installed(&self) -> Result<Vec<String>, String> {
        Ok(self.servers.clone())
    }
    async fn tool_names(&self, connector_id: &str) -> Result<Vec<String>, String> {
        Ok(self.tools.iter().filter(|(server, _)| server == connector_id).map(|(_, tool)| tool.clone()).collect())
    }
    fn connector_of(&self, server: &str) -> Option<String> {
        (server == "gmail" || server == "gmail-2").then(|| "gmail".to_owned())
    }
}

/// The one registered project and the connectors it switches off.
struct Project {
    path: String,
    installed: Vec<String>,
    off: Mutex<Vec<String>>,
}

impl Project {
    fn switches(&self) -> Value {
        let off = self.off.lock().unwrap_or_else(PoisonError::into_inner);
        Value::Array(self.installed.iter().map(|id| json!({ "id": id, "enabled": !off.contains(id) })).collect())
    }

    fn registered(&self, path: &str) -> Result<(), String> {
        if path == self.path { Ok(()) } else { Err(format!("project not registered: {path}")) }
    }
}

#[async_trait]
impl ProjectSwitches for Project {
    async fn get(&self, project_path: &str) -> Result<Value, String> {
        self.registered(project_path)?;
        Ok(self.switches())
    }

    async fn set_enabled(&self, project_path: &str, connector_id: &str, enabled: &Value) -> Result<Value, String> {
        let Value::Bool(enabled) = *enabled else { return Err("enabled must be a boolean".to_owned()) };
        self.registered(project_path)?;
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

/// The person at the card: what the script has them do, and the cards they were shown.
struct Person {
    connectors: Arc<AgentConnectors>,
    ask: Mutex<Option<String>>,
    cards: Mutex<Vec<WidenCard>>,
}

#[async_trait]
impl WidenCards for Person {
    async fn ask(&self, _: &ThreadId, card: &WidenCard) -> CardOutcome {
        let Some(ask) = self.ask.lock().unwrap_or_else(PoisonError::into_inner).clone() else { return CardOutcome::NoHook };
        self.cards.lock().unwrap_or_else(PoisonError::into_inner).push(card.clone());
        let pick = |scope: &str| CardAnswer { approved: true, scope: Some(scope.to_owned()), response: Some("approve".into()), device: Some("phone".into()), ..CardAnswer::default() };
        // A change lands on the stored policy while the card waits, then the person picks.
        let meanwhile = |permission: &'static str, then: &'static str| {
            let (connectors, agent, name, tool) = (self.connectors.clone(), card.agent.clone(), card.args["name"].clone(), card.tool.clone());
            async move {
                connectors.set_tool_permission(&agent, &name, &Value::String(tool), &Value::String(permission.into()), false).await.unwrap();
                pick(then)
            }
        };
        CardOutcome::Settled(match ask.as_str() {
            "deny" => Some(CardAnswer { response: Some("deny".into()), device: Some("desktop".into()), ..CardAnswer::default() }),
            "timeout" => Some(CardAnswer { timed_out: true, response: Some("deny".into()), device: Some(String::new()), ..CardAnswer::default() }),
            "silent" => None,
            "narrowed-then-auto" => Some(meanwhile("disabled", "auto").await),
            "widened-then-needs_approval" => Some(meanwhile("auto", "needs_approval").await),
            scope => Some(pick(scope)),
        })
    }
}

fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&CancellationToken::new(), job).unwrap())
        .now_or_never()
        .expect("the test backend runs the job inline")
        .unwrap()
}

/// The definition files and the permission files under `data`, as the recorder lists them.
fn files_of(data: &Path) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    let mut pending = vec![data.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let dir_for_job = dir.clone();
        let Some(entries) = on_lane(move |lane| {
            let names = mixdog_statefile::list_dir(lane, &dir_for_job).ok()?;
            Some(names.into_iter().map(|name| (dir_for_job.join(&name), mixdog_statefile::metadata(lane, &dir_for_job.join(&name)).unwrap().is_dir())).collect::<Vec<_>>())
        }) else {
            continue;
        };
        for (path, is_dir) in entries {
            if is_dir {
                pending.push(path);
                continue;
            }
            let rel = path.strip_prefix(data).unwrap().to_string_lossy().replace('\\', "/");
            let parts: Vec<&str> = rel.split('/').collect();
            let name = parts.get(2).copied().unwrap_or("");
            let kept = name.split(".mixdog-tmp-").next().unwrap_or("").trim_end_matches(".bak");
            let definition = parts.len() == 3 && parts[0] == "agents" && (kept == "AGENT.md" || kept == "agent.json");
            if definition || rel.starts_with("human-gate/") {
                files.insert(rel, String::from_utf8(mixdog_statefile::read_content(&path).unwrap().unwrap()).unwrap());
            }
        }
    }
    files
}

fn replaced(value: &Value, from: &str, to: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace(from, to)),
        Value::Array(items) => Value::Array(items.iter().map(|item| replaced(item, from, to)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), replaced(item, from, to))).collect()),
        other => other.clone(),
    }
}

#[tokio::test]
async fn the_setup_actions_answer_what_the_recorded_node_handlers_answered() {
    let twin: Value = serde_json::from_str(&TWIN).unwrap();
    let strings = |key: &str| -> Vec<String> { twin[key].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect() };
    let tools = twin["tools"].as_array().unwrap().iter().map(|pair| (pair[0].as_str().unwrap().to_owned(), pair[1].as_str().unwrap().to_owned())).collect();
    let (dir, agents) = writable(json!({})).await;
    let agents = Arc::new(agents);
    let tokens = mixdog_rt::testing::tokens();
    let data = dir.path().join("data");
    let project_path = dir.path().join("project").to_string_lossy().into_owned();
    let connectors = Arc::new(AgentConnectors::new(agents.clone(), Arc::new(Catalog { servers: strings("servers"), tools })));
    let now = twin["now"].as_i64().unwrap();
    let grants = FileGrantStore::with_clock(data.join("human-gate"), tokens.interactive_io, tokens.durability_io, Arc::new(move || now));
    let person = Arc::new(Person { connectors: connectors.clone(), ask: Mutex::new(None), cards: Mutex::default() });
    let project = Arc::new(Project { path: project_path.clone(), installed: strings("servers"), off: Mutex::default() });
    let setup = AgentSettingsSetup::new(connectors.clone(), Arc::new(AgentPermissions::new(grants.clone())), project, person.clone(), grants);
    let thread = ThreadId::from("thread-1");
    let data_text = data.to_string_lossy().into_owned();
    let unmasked = |value: &Value| replaced(&replaced(value, "<project>", &project_path), "<data>", &data_text);
    let masked = |value: &Value| replaced(&replaced(value, &project_path, "<project>"), &data_text, "<data>");

    for (index, step) in twin["steps"].as_array().unwrap().iter().enumerate() {
        match step["seed"].as_str() {
            Some("save") => {
                agents.save(step["payload"].as_object().unwrap()).await.unwrap();
                continue;
            }
            Some("tool") => {
                let tool = (&step["connector"], &step["tool"], &step["permission"]);
                connectors.set_tool_permission(step["agent"].as_str().unwrap(), tool.0, tool.1, tool.2, false).await.unwrap();
                continue;
            }
            Some("enable") => {
                connectors.set_enabled(step["agent"].as_str().unwrap(), &step["name"], &step["enabled"], false).await.unwrap();
                continue;
            }
            _ => {}
        }
        let action = step["action"].as_str().unwrap();
        let args = unmasked(&step["args"]);
        let mut full = args.as_object().unwrap().clone();
        full.insert("action".into(), action.into());
        let full = Value::Object(full);
        *person.ask.lock().unwrap() = step["ask"].as_str().map(str::to_owned);
        person.cards.lock().unwrap().clear();
        let got = setup.run(&SetupCall { action, args: &full, thread: &thread }).await;
        let label = format!("step {index} {action} {}", step["args"]);
        match (&got, step.get("error")) {
            (Err(PortError::Failed { message, .. }), Some(want)) => assert_eq!(masked(&Value::String(message.clone())), *want, "{label}: error"),
            (Ok(answer), None) => assert_eq!(masked(answer), step["ok"], "{label}: answer"),
            (other, want) => panic!("{label}: got {other:?}, Node {want:?} / {}", step["ok"]),
        }
        let cards: Vec<Value> = person
            .cards
            .lock()
            .unwrap()
            .iter()
            .map(|card| {
                json!({
                    "agentId": card.agent,
                    "connector": {
                        "server": card.server, "tool": card.tool, "from": card.from.name(),
                        "requested": card.requested, "choices": card.choices.iter().map(|level| level.name()).collect::<Vec<_>>(),
                    },
                    "args": card.args,
                    "reason": card.reason,
                })
            })
            .collect();
        let asked: Vec<Value> = step["asked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|card| json!({ "agentId": card["agentId"], "connector": card["connector"], "args": card["args"], "reason": card["reason"] }))
            .collect();
        assert_eq!(masked(&Value::Array(cards)), Value::Array(asked), "{label}: cards");
        let want: BTreeMap<String, String> = step["files"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(name, _)| name.as_str() != "project-connectors.json")
            .map(|(name, text)| (name.clone(), text.as_str().unwrap().to_owned()))
            .collect();
        assert_eq!(files_of(&data), want, "{label}: files");
    }
}

/// The calling turn's approval gate: keeps each request and answers with the scripted resolution.
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

/// `GateWidenCards` hands the turn's gate the request Node's `askToWidenConnectorTool` handed
/// `requestApproval` (every card of the recording, whole), and reads the settlement back as Node's
/// answer: the picked level is the decision's `scope`.
#[tokio::test]
async fn a_widening_card_is_the_recorded_request_on_the_turns_approval_gate() {
    use mixdog_protocol::{ApprovalResolution, ConnectionKind, HumanGateResponse, ToolApprovalDecision, ToolCallId};
    use mixdog_tools::orch::service::{CallApprovals, with_call_approvals};

    let twin: Value = serde_json::from_str(&TWIN).unwrap();
    let thread = ThreadId::from("thread-1");
    let card_of = |asked: &Value| WidenCard {
        agent: asked["agentId"].as_str().unwrap().to_owned(),
        server: asked["connector"]["server"].as_str().unwrap().to_owned(),
        tool: asked["connector"]["tool"].as_str().unwrap().to_owned(),
        from: Permission::parse(asked["connector"]["from"].as_str().unwrap()).unwrap(),
        requested: asked["connector"]["requested"].clone(),
        choices: asked["connector"]["choices"].as_array().unwrap().iter().map(|level| Permission::parse(level.as_str().unwrap()).unwrap()).collect(),
        args: asked["args"].clone(),
        reason: asked["reason"].as_str().unwrap().to_owned(),
    };
    let decided = |approved: bool, scope: Option<&str>, response: HumanGateResponse| ApprovalResolution::Decided {
        decision: ToolApprovalDecision { approved, reason: None, answers: None, reply: None, response: Some(response), edited_args: None, remember: None, scope: scope.map(str::to_owned) },
        device: "phone".into(),
        connection_kind: ConnectionKind::Phone,
        at: 1,
    };
    let mut replayed = 0;
    for asked in twin["steps"].as_array().unwrap().iter().flat_map(|step| step["asked"].as_array().into_iter().flatten()) {
        let gate = Arc::new(Gate { asks: Mutex::default(), answer: decided(true, Some("auto"), HumanGateResponse::Approve) });
        let card = card_of(asked);
        let outcome = with_call_approvals(CallApprovals { gate: gate.clone(), call_id: ToolCallId::from("call-1") }, GateWidenCards.ask(&thread, &card)).await;
        assert_eq!(
            outcome,
            CardOutcome::Settled(Some(CardAnswer { approved: true, scope: Some("auto".into()), timed_out: false, response: Some("approve".into()), device: Some("phone".into()) }))
        );
        let asks = gate.asks.lock().unwrap();
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0].payload, *asked, "the request Node raised");
        assert_eq!(asks[0].call_id, Some(ToolCallId::from("call-1")));
        assert_eq!(asks[0].tool.as_deref(), Some("setup"));
        assert!(asks[0].remember.is_empty() && asks[0].action_kind.is_none(), "nothing is remembered");
        replayed += 1;
    }
    assert!(replayed > 0, "the recording raises cards");

    let asked = twin["steps"].as_array().unwrap().iter().find_map(|step| step["asked"].get(0)).unwrap();
    let card = card_of(asked);
    // Outside a turn's tool call there is no approval hook (`typeof requestApproval !== 'function'`).
    assert_eq!(GateWidenCards.ask(&thread, &card).await, CardOutcome::NoHook);
    let settle = |answer: ApprovalResolution| {
        let (card, thread) = (card.clone(), thread.clone());
        async move {
            let gate = Arc::new(Gate { asks: Mutex::default(), answer });
            with_call_approvals(CallApprovals { gate, call_id: ToolCallId::from("call-1") }, GateWidenCards.ask(&thread, &card)).await
        }
    };
    assert_eq!(settle(ApprovalResolution::Unavailable { at: 1 }).await, CardOutcome::NoHook, "a session with no approval surface asked nobody");
    assert_eq!(settle(ApprovalResolution::TimedOut { at: 1 }).await, CardOutcome::Settled(Some(CardAnswer { timed_out: true, ..CardAnswer::default() })));
    assert_eq!(settle(ApprovalResolution::Withdrawn { at: 1 }).await, CardOutcome::Settled(None));
    assert_eq!(
        settle(decided(false, None, HumanGateResponse::Deny)).await,
        CardOutcome::Settled(Some(CardAnswer { approved: false, scope: None, timed_out: false, response: Some("deny".into()), device: Some("phone".into()) }))
    );
}
