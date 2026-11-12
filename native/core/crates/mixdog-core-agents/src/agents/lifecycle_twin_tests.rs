//! The agent home lifecycle and the greetings against what Node's host code did
//! (`benchmarks/rust-core/recorders/record-agent-lifecycle.mjs` → `agent-lifecycle-twin.json`): `retire`, `reconcile` and
//! `restore` of `agent-home-sessions.ts`, `createAgentGreetings` of `mixy-first.ts` and `agentGreetingKickoff`. Every
//! scenario's result or error, and the dependency calls made, in order, must equal Node's.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_rooms::rooms::home::Presence;
use serde_json::Value;
use serde_json::json;

use super::*;

fn twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/desktop/settings/agent-lifecycle-twin.json")).unwrap()
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

fn toggle(list: &mut Vec<String>, id: &str, on: bool) {
    let at = list.iter().position(|item| item == id);
    match (on, at) {
        (true, None) => list.push(id.to_owned()),
        (false, Some(at)) => {
            list.remove(at);
        }
        _ => {}
    }
}

fn message(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { message, .. } => message.as_deref().unwrap_or("").to_owned(),
        other => panic!("not a domain error: {other:?}"),
    }
}

/// The outcome as the recorder wrote it: `result: null` or `error`.
fn check(label: &str, got: Result<(), CoreError>, op: &Value) {
    match (got, op.get("error")) {
        (Ok(()), None) => assert_eq!(op["result"], Value::Null, "{label}"),
        (Err(error), Some(want)) => assert_eq!(&Value::String(message(&error)), want, "{label}"),
        (got, want) => panic!("{label}: got {got:?}, Node {want:?}"),
    }
}

// ---- the home world -----------------------------------------------------------------------------

struct World {
    sessions: Vec<String>,
    archived: Vec<String>,
    retired: Vec<String>,
    presence: HashMap<String, Presence>,
    fail_presence: bool,
    log: Vec<Value>,
}

struct Homes(Mutex<World>);

fn presence_of(value: &Value) -> HashMap<String, Presence> {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, state)| {
            let state = match state.as_str().unwrap() {
                "present" => Presence::Present,
                "deleted" => Presence::Deleted,
                _ => Presence::Unknown,
            };
            (id.clone(), state)
        })
        .collect()
}

impl Homes {
    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.0.lock().unwrap()
    }
}

/// `NAMES` of the recorder: the name a deleted agent left.
fn left_name(agent_id: &str) -> &'static str {
    match agent_id {
        "ada" => "Ada",
        "cy" => "Cy the bot",
        "dee" => "Dee",
        "a.b" => "Dotted",
        _ => "",
    }
}

#[async_trait]
impl HomeDeps for Homes {
    async fn list_agents(&self) -> Result<Value, DepError> {
        Ok(json!([]))
    }
    async fn mixy_route(&self) -> Result<Value, DepError> {
        Ok(Value::Null)
    }
    async fn mixy_created(&self) -> Result<bool, DepError> {
        Ok(true)
    }
    async fn read_session(&self, session_id: &str) -> Result<Value, DepError> {
        Ok(json!({ "id": session_id }))
    }
    async fn create_session(&self, _: &str, _: &Value) -> Result<(), DepError> {
        Ok(())
    }
    async fn set_route(&self, _: &str, _: &Value) -> Result<(), DepError> {
        Ok(())
    }
    async fn set_archived(&self, session_id: &str, archived: bool) -> Result<(), DepError> {
        let mut world = self.world();
        world.log.push(json!(["setArchived", session_id, archived]));
        toggle(&mut world.archived, session_id, archived);
        Ok(())
    }
    async fn set_retired(&self, session_id: &str, retired: bool) -> Result<(), DepError> {
        let mut world = self.world();
        world.log.push(json!(["setRetired", session_id, retired]));
        toggle(&mut world.retired, session_id, retired);
        Ok(())
    }
    async fn task_workspace(&self) -> Result<String, DepError> {
        Ok("/work".into())
    }
    async fn clear_session(&self, _: &str, _: &str) -> Result<(), DepError> {
        Ok(())
    }
    fn mint_archive_id(&self) -> String {
        "sess_archive_1".into()
    }
    async fn is_retired(&self, session_id: &str) -> Result<bool, DepError> {
        let mut world = self.world();
        world.log.push(json!(["isRetired", session_id]));
        Ok(world.retired.iter().any(|id| id == session_id))
    }
    async fn name_retired(&self, session_id: &str, name: &str) -> Result<(), DepError> {
        self.world().log.push(json!(["nameRetired", session_id, name]));
        Ok(())
    }
    async fn archived_agent_name(&self, agent_id: &str) -> Result<String, DepError> {
        self.world().log.push(json!(["archivedAgentName", agent_id]));
        Ok(left_name(agent_id).to_owned())
    }
    async fn known_session_ids(&self) -> Result<Vec<String>, DepError> {
        Ok(self.world().sessions.clone())
    }
    async fn agent_presence(&self, agent_ids: &[String]) -> Result<HashMap<String, Presence>, DepError> {
        let mut world = self.world();
        world.log.push(json!(["agentPresence", agent_ids]));
        if world.fail_presence {
            return Err(DepError::new("presence unreadable"));
        }
        Ok(world.presence.clone())
    }
    async fn forget_room_member(&self, agent_id: &str) -> Result<(), DepError> {
        self.world().log.push(json!(["forgetRoomMember", agent_id]));
        Ok(())
    }
}

#[tokio::test]
async fn retire_reconcile_and_restore_do_what_nodes_host_did() {
    let twin = twin();
    let mut ran = 0;
    for (index, scenario) in twin["lifecycle"].as_array().unwrap().iter().enumerate() {
        let start = &scenario["world"];
        let deps = std::sync::Arc::new(Homes(Mutex::new(World {
            sessions: strings(&start["sessions"]),
            archived: strings(&start["archived"]),
            retired: strings(&start["retired"]),
            presence: presence_of(&start["presence"]),
            fail_presence: start["failPresence"].as_bool().unwrap(),
            log: Vec::new(),
        })));
        let homes = AgentHomeSessions::new(deps.clone());
        for (step, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            let label = format!("scenario {index} step {step}");
            let got = match op["op"].as_str().unwrap() {
                "world" => {
                    let mut world = deps.world();
                    world.presence = presence_of(&op["patch"]["presence"]);
                    world.fail_presence = op["patch"]["failPresence"].as_bool().unwrap();
                    continue;
                }
                "retire" => homes.retire(&strings(&op["ids"])).await,
                "reconcile" => homes.reconcile().await,
                "restore" => homes.restore(op["agent"].as_str().unwrap()).await,
                other => panic!("unknown op {other}"),
            };
            ran += 1;
            check(&label, got, op);
            assert_eq!(Value::Array(std::mem::take(&mut deps.world().log)), op["log"], "{label}: dependency calls");
        }
    }
    assert!(ran > 100, "the twin ran {ran} calls");
}

// ---- the greetings ------------------------------------------------------------------------------

struct Seen {
    stored: Option<Vec<String>>,
    catalog: Value,
    fail: Vec<String>,
    log: Vec<Value>,
}

struct Greeting(Mutex<Seen>);

#[async_trait]
impl GreetingDeps for Greeting {
    async fn read(&self) -> Result<Option<Vec<String>>, DepError> {
        let mut seen = self.0.lock().unwrap();
        seen.log.push(json!(["read"]));
        Ok(seen.stored.clone())
    }
    async fn write(&self, ids: &[String]) -> Result<(), DepError> {
        let mut seen = self.0.lock().unwrap();
        seen.log.push(json!(["write", ids]));
        seen.stored = Some(ids.to_vec());
        Ok(())
    }
    async fn list_agents(&self) -> Result<Value, DepError> {
        let mut seen = self.0.lock().unwrap();
        seen.log.push(json!(["listAgents"]));
        Ok(seen.catalog.clone())
    }
    async fn greet(&self, agent: &GreetAgent) -> Result<(), DepError> {
        let mut seen = self.0.lock().unwrap();
        seen.log.push(json!(["greet", { "id": agent.id, "name": agent.name, "description": agent.description }]));
        if seen.fail.contains(&agent.id) {
            return Err(DepError::new("home thread unavailable"));
        }
        Ok(())
    }
}

#[tokio::test]
async fn new_agents_are_greeted_once_as_nodes_host_greeted_them() {
    let twin = twin();
    let mut ran = 0;
    for (index, scenario) in twin["greetings"].as_array().unwrap().iter().enumerate() {
        let start = &scenario["initial"];
        let deps = std::sync::Arc::new(Greeting(Mutex::new(Seen {
            stored: (!start["stored"].is_null()).then(|| strings(&start["stored"])),
            catalog: start["catalog"].clone(),
            fail: Vec::new(),
            log: Vec::new(),
        })));
        let greetings = AgentGreetings::new(deps.clone());
        for (step, op) in scenario["ops"].as_array().unwrap().iter().enumerate() {
            let label = format!("scenario {index} step {step}");
            let got = match op["op"].as_str().unwrap() {
                "world" => {
                    let mut seen = deps.0.lock().unwrap();
                    seen.catalog = op["catalog"].clone();
                    seen.fail = strings(&op["fail"]);
                    continue;
                }
                "noteCreated" => greetings.note_created(op["agent"].as_str().unwrap()).await,
                "reconcile" => greetings.reconcile(&op["agents"]).await,
                other => panic!("unknown op {other}"),
            };
            ran += 1;
            check(&label, got, op);
            assert_eq!(Value::Array(std::mem::take(&mut deps.0.lock().unwrap().log)), op["log"], "{label}: dependency calls");
        }
    }
    assert!(ran > 80, "the twin ran {ran} calls");
}

/// A catalog read that arrives while a dialog's save is in flight (the save itself rebuilds the pushed catalog) must not greet the agent
/// being saved: Node's `noteCreated` is awaited before the save's reply (`session-host-lifecycle.ts:1181`), its catalog read comes after.
#[tokio::test]
async fn a_catalog_read_during_a_save_does_not_greet_the_saved_agent() {
    let bot = json!({ "id": "new-bot", "custom": true, "kind": "bot", "label": "New Bot", "route": { "provider": "p", "model": "m" } });
    let deps = std::sync::Arc::new(Greeting(Mutex::new(Seen { stored: Some(vec!["old".into()]), catalog: json!([bot]), fail: Vec::new(), log: Vec::new() })));
    let greetings = AgentGreetings::new(deps.clone());
    let read = greetings.clone();
    let catalog = json!([bot]);
    let reading = std::sync::Arc::new(Mutex::new(None));
    let started = reading.clone();
    greetings
        .saving(
            async move {
                // The signal is the read's first poll having returned: `reconcile` takes its place in the queue synchronously in
                // that poll, so with the hold it is now waiting behind the save, and without the hold it has already run.
                let (polled, first_poll) = tokio::sync::oneshot::channel();
                *started.lock().unwrap() = Some(tokio::spawn(async move {
                    let mut polled = Some(polled);
                    let mut read = Box::pin(read.reconcile(&catalog));
                    std::future::poll_fn(|cx| {
                        let state = read.as_mut().poll(cx);
                        if let Some(polled) = polled.take() {
                            let _ = polled.send(());
                        }
                        state
                    })
                    .await
                }));
                tokio::time::timeout(std::time::Duration::from_secs(10), first_poll)
                    .await
                    .expect("the catalog read never made its first poll while the save was in flight")
                    .expect("the catalog read was dropped before its first poll");
                Ok::<_, CoreError>(json!({ "id": "new-bot" }))
            },
            |saved| saved["id"].as_str().map(str::to_owned),
        )
        .await
        .unwrap();
    let handle = reading.lock().unwrap().take().unwrap();
    handle.await.unwrap().unwrap();
    let log = deps.0.lock().unwrap().log.clone();
    assert!(!log.iter().any(|entry| entry[0] == "greet"), "the saved agent was greeted: {log:?}");
    assert_eq!(deps.0.lock().unwrap().stored.clone().unwrap(), ["old", "new-bot"].map(String::from).to_vec());
}
#[test]
fn the_greeting_text_is_what_node_sends() {
    for case in twin()["kickoff"].as_array().unwrap() {
        let got = agent_greeting_kickoff(case["name"].as_str().unwrap(), case["description"].as_str().unwrap());
        assert_eq!(Value::String(got), case["text"], "{case}");
    }
}

// ---- no lifecycle ---------------------------------------------------------------------------------

/// A home world with nothing in it, for the tests of other methods that do not look at the lifecycle: no home is known, no
/// agent is proven deleted, nobody is greeted.
pub(super) struct Quiet {
    gates: Option<Arc<Gates>>,
}

/// Two reconciles that can only both finish if both are in flight at once: each opens the gate the other waits at.
#[derive(Default)]
struct Gates {
    presence_entered: tokio::sync::Notify,
    read_entered: tokio::sync::Notify,
    presence_finished: tokio::sync::Notify,
    read_finished: tokio::sync::Notify,
}

#[async_trait]
impl HomeDeps for Quiet {
    async fn list_agents(&self) -> Result<Value, DepError> {
        Ok(json!([]))
    }
    async fn mixy_route(&self) -> Result<Value, DepError> {
        Ok(Value::Null)
    }
    async fn mixy_created(&self) -> Result<bool, DepError> {
        Ok(false)
    }
    async fn read_session(&self, session_id: &str) -> Result<Value, DepError> {
        Err(DepError { message: format!("Session {session_id} is not available"), code: Some("SESSION_NOT_AVAILABLE".into()) })
    }
    async fn create_session(&self, _: &str, _: &Value) -> Result<(), DepError> {
        Ok(())
    }
    async fn set_route(&self, _: &str, _: &Value) -> Result<(), DepError> {
        Ok(())
    }
    async fn set_archived(&self, _: &str, _: bool) -> Result<(), DepError> {
        Ok(())
    }
    async fn set_retired(&self, _: &str, _: bool) -> Result<(), DepError> {
        Ok(())
    }
    async fn task_workspace(&self) -> Result<String, DepError> {
        Ok("/work".into())
    }
    async fn clear_session(&self, _: &str, _: &str) -> Result<(), DepError> {
        Ok(())
    }
    fn mint_archive_id(&self) -> String {
        "sess_archive_1".into()
    }
    async fn is_retired(&self, _: &str) -> Result<bool, DepError> {
        Ok(false)
    }
    async fn name_retired(&self, _: &str, _: &str) -> Result<(), DepError> {
        Ok(())
    }
    async fn archived_agent_name(&self, _: &str) -> Result<String, DepError> {
        Ok(String::new())
    }
    async fn known_session_ids(&self) -> Result<Vec<String>, DepError> {
        Ok(if self.gates.is_some() { vec!["sess_home_ada".to_owned()] } else { Vec::new() })
    }
    async fn agent_presence(&self, _: &[String]) -> Result<HashMap<String, Presence>, DepError> {
        if let Some(gates) = &self.gates {
            gates.presence_entered.notify_one();
            gates.read_entered.notified().await;
            gates.presence_finished.notify_one();
        }
        Ok(HashMap::new())
    }
    async fn forget_room_member(&self, _: &str) -> Result<(), DepError> {
        Ok(())
    }
}

#[async_trait]
impl GreetingDeps for Quiet {
    async fn read(&self) -> Result<Option<Vec<String>>, DepError> {
        if let Some(gates) = &self.gates {
            gates.read_entered.notify_one();
            gates.presence_entered.notified().await;
            gates.read_finished.notify_one();
        }
        Ok(Some(Vec::new()))
    }
    async fn write(&self, _: &[String]) -> Result<(), DepError> {
        Ok(())
    }
    async fn list_agents(&self) -> Result<Value, DepError> {
        Ok(json!([]))
    }
    async fn greet(&self, _: &GreetAgent) -> Result<(), DepError> {
        Ok(())
    }
}

/// The lifecycle of a service whose test does not look at it.
pub(super) fn quiet_lifecycle() -> AgentLifecycle {
    let quiet = std::sync::Arc::new(Quiet { gates: None });
    AgentLifecycle::new(AgentHomeSessions::new(quiet.clone()), AgentGreetings::new(quiet))
}

/// Node's list read starts `reconcile` and the greetings together and holds neither (two `void` calls): both are in flight at
/// once. A lifecycle that ran one after the other would wait at its first gate for ever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_read_starts_the_reconcile_and_the_greetings_together() {
    // `listed` spawns both starts on the runtime, which is installed before anything spawns.
    mixdog_rt::testing::tokens();
    let gates = std::sync::Arc::new(Gates::default());
    let quiet = std::sync::Arc::new(Quiet { gates: Some(gates.clone()) });
    let lifecycle = AgentLifecycle::new(AgentHomeSessions::new(quiet.clone()), AgentGreetings::new(quiet));
    lifecycle.listed(json!([]));
    gates.presence_finished.notified().await;
    gates.read_finished.notified().await;
}
