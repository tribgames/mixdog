//! The agent homes and the greetings: opening and resetting a home chat, archiving the chat of a deleted agent,
//! and greeting a new agent once.

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

mod lead_status;
mod service;

fn message(error: &CoreError) -> String {
    match error {
        CoreError::DomainError { message, .. } => message.as_deref().unwrap_or("").to_owned(),
        other => panic!("not a domain error: {other:?}"),
    }
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

fn session_missing(id: &str) -> DepError {
    DepError { message: format!("Session {id} is not available"), code: Some("SESSION_NOT_AVAILABLE".into()) }
}

// ---- the home world -----------------------------------------------------------------------------

#[derive(Default)]
struct World {
    /// Agent catalog rows.
    agents: Vec<Value>,
    mixy_created: bool,
    /// Session id to its route snapshot, and whether it holds a conversation.
    sessions: HashMap<String, (Value, bool)>,
    archived: Vec<String>,
    retired: Vec<String>,
    presence: HashMap<String, Presence>,
    running: bool,
    log: Vec<Value>,
}

#[derive(Default)]
struct Homes(Mutex<World>);

impl Homes {
    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.0.lock().unwrap()
    }

    fn take_log(&self) -> Vec<Value> {
        std::mem::take(&mut self.world().log)
    }
}

fn contact(id: &str) -> Value {
    json!({ "id": id, "custom": true, "kind": "bot", "route": { "provider": "p", "model": "m" } })
}

#[async_trait]
impl HomeDeps for Homes {
    async fn list_agents(&self) -> Result<Value, DepError> {
        Ok(Value::Array(self.world().agents.clone()))
    }
    async fn mixy_route(&self) -> Result<Value, DepError> {
        Ok(json!({ "provider": "p", "model": "mixy" }))
    }
    async fn mixy_created(&self) -> Result<bool, DepError> {
        Ok(self.world().mixy_created)
    }
    async fn read_session(&self, session_id: &str) -> Result<Value, DepError> {
        self.world().sessions.get(session_id).map(|(route, _)| route.clone()).ok_or_else(|| session_missing(session_id))
    }
    async fn create_session(&self, session_id: &str, params: &Value) -> Result<(), DepError> {
        let mut world = self.world();
        world.log.push(json!(["createSession", session_id, params]));
        world.sessions.insert(session_id.to_owned(), (json!({ "provider": params["provider"], "model": params["model"] }), false));
        Ok(())
    }
    async fn set_route(&self, session_id: &str, route: &Value) -> Result<(), DepError> {
        self.world().log.push(json!(["setRoute", session_id, route]));
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
    async fn clear_session(&self, session_id: &str, archive_as: &str) -> Result<(), DepError> {
        let mut world = self.world();
        if world.running {
            return Err(DepError::new("The session is running a turn."));
        }
        if let Some((route, true)) = world.sessions.get(session_id).cloned() {
            world.sessions.insert(archive_as.to_owned(), (route.clone(), true));
            world.sessions.insert(session_id.to_owned(), (route, false));
        }
        Ok(())
    }
    fn mint_archive_id(&self) -> String {
        "sess_archive_1".into()
    }
    async fn is_retired(&self, session_id: &str) -> Result<bool, DepError> {
        Ok(self.world().retired.iter().any(|id| id == session_id))
    }
    async fn name_retired(&self, session_id: &str, name: &str) -> Result<(), DepError> {
        self.world().log.push(json!(["nameRetired", session_id, name]));
        Ok(())
    }
    async fn archived_agent_name(&self, agent_id: &str) -> Result<String, DepError> {
        Ok(if agent_id == "ada" { "Ada".to_owned() } else { String::new() })
    }
    async fn known_session_ids(&self) -> Result<Vec<String>, DepError> {
        Ok(self.world().sessions.keys().cloned().collect())
    }
    async fn agent_presence(&self, agent_ids: &[String]) -> Result<HashMap<String, Presence>, DepError> {
        let world = self.world();
        Ok(agent_ids.iter().filter_map(|id| world.presence.get(id).map(|presence| (id.clone(), *presence))).collect())
    }
    async fn forget_room_member(&self, agent_id: &str) -> Result<(), DepError> {
        self.world().log.push(json!(["forgetRoomMember", agent_id]));
        Ok(())
    }
}

fn world_of(setup: impl FnOnce(&mut World)) -> (Arc<Homes>, AgentHomeSessions) {
    mixdog_rt::testing::tokens();
    let homes = Arc::new(Homes::default());
    setup(&mut homes.world());
    (homes.clone(), AgentHomeSessions::new(homes))
}

#[tokio::test]
async fn opening_a_contacts_home_creates_its_thread_once_on_the_agents_route() {
    let (deps, homes) = world_of(|world| world.agents = vec![contact("ada")]);
    assert_eq!(homes.open("ada").await.unwrap(), json!({ "sessionId": "sess_home_ada" }));
    let log = deps.take_log();
    let create = log.iter().find(|entry| entry[0] == "createSession").unwrap();
    assert_eq!(create[1], "sess_home_ada");
    assert_eq!((&create[2]["provider"], &create[2]["model"], &create[2]["cwd"]), (&json!("p"), &json!("m"), &json!("/work")));
    assert_eq!(create[2]["sessionProfile"], json!({ "homeAgent": "ada" }));
    // The thread exists now: opening again creates nothing.
    assert_eq!(homes.open("ada").await.unwrap(), json!({ "sessionId": "sess_home_ada" }));
    assert!(!deps.take_log().iter().any(|entry| entry[0] == "createSession"));
}

#[tokio::test]
async fn opening_an_agent_that_is_no_contact_or_has_a_bad_id_is_refused() {
    let (_deps, homes) = world_of(|world| world.agents = vec![json!({ "id": "plain", "custom": true, "kind": "agent" })]);
    assert_eq!(message(&homes.open("plain").await.unwrap_err()), "Agent \"plain\" is not available.");
    assert_eq!(message(&homes.open("ghost").await.unwrap_err()), "Agent \"ghost\" is not available.");
    assert_eq!(message(&homes.open("Bad Id").await.unwrap_err()), "agent id is invalid.");
}

#[tokio::test]
async fn a_mixy_nobody_created_gets_no_chat_and_a_created_one_follows_her_own_route() {
    let (deps, homes) = world_of(|_| {});
    assert_eq!(message(&homes.open("lead").await.unwrap_err()), "Create the representative bot first.");
    deps.world().mixy_created = true;
    let opened = homes.open("lead").await.unwrap();
    let log = deps.take_log();
    let create = log.iter().find(|entry| entry[0] == "createSession").unwrap();
    assert_eq!(create[1], opened["sessionId"]);
    assert_eq!(create[2]["model"], "mixy");
}

#[tokio::test]
async fn reopening_a_thread_whose_definition_changed_model_moves_it_to_the_new_route() {
    let (deps, homes) = world_of(|world| {
        world.agents = vec![contact("ada")];
        world.sessions.insert("sess_home_ada".into(), (json!({ "provider": "p", "model": "old" }), true));
        world.archived.push("sess_home_ada".into());
    });
    homes.open("ada").await.unwrap();
    let log = deps.take_log();
    assert!(log.contains(&json!(["setRoute", "sess_home_ada", { "provider": "p", "model": "m" }])), "{log:?}");
    assert!(!deps.world().archived.contains(&"sess_home_ada".to_owned()), "reopening brings the thread back from the archive");
}

#[tokio::test]
async fn calls_for_one_agent_made_together_share_one_resolution() {
    let (deps, homes) = world_of(|world| world.agents = vec![contact("ada")]);
    let (first, second) = tokio::join!(homes.open("ada"), homes.open("ada"));
    assert_eq!(first.unwrap(), second.unwrap());
    let creates = deps.take_log().iter().filter(|entry| entry[0] == "createSession").count();
    assert_eq!(creates, 1);
}

#[tokio::test]
async fn resetting_moves_the_conversation_to_an_archived_copy_and_keeps_the_home_id() {
    let (deps, homes) = world_of(|world| {
        world.agents = vec![contact("ada")];
        world.sessions.insert("sess_home_ada".into(), (json!({ "provider": "p", "model": "m" }), true));
    });
    assert_eq!(homes.reset("ada").await.unwrap(), json!({ "sessionId": "sess_home_ada", "archivedSessionId": "sess_archive_1" }));
    assert!(deps.world().archived.contains(&"sess_archive_1".to_owned()));
    // The home is empty now: a second reset has nothing to keep and leaves no archive behind.
    deps.world().archived.clear();
    deps.world().sessions.remove("sess_archive_1");
    assert_eq!(homes.reset("ada").await.unwrap(), json!({ "sessionId": "sess_home_ada", "archivedSessionId": null }));
    assert!(deps.world().archived.is_empty());
}

#[tokio::test]
async fn a_reset_while_the_thread_runs_a_turn_fails_and_leaves_no_archive_mark() {
    let (deps, homes) = world_of(|world| {
        world.agents = vec![contact("ada")];
        world.sessions.insert("sess_home_ada".into(), (json!({ "provider": "p", "model": "m" }), true));
        world.running = true;
    });
    assert_eq!(message(&homes.reset("ada").await.unwrap_err()), "The session is running a turn.");
    assert!(deps.world().archived.is_empty());
}

#[tokio::test]
async fn an_explicit_delete_archives_the_home_of_a_proven_deleted_agent_only() {
    let (deps, homes) = world_of(|world| {
        world.presence = HashMap::from([("ada".to_owned(), Presence::Deleted), ("bob".to_owned(), Presence::Present), ("cy".to_owned(), Presence::Unknown)]);
    });
    homes.retire(&["ada".into(), "bob".into(), "cy".into(), "lead".into(), "Bad Id".into(), "ada".into()]).await.unwrap();
    let world = deps.world();
    assert_eq!(world.archived, ["sess_home_ada"]);
    assert_eq!(world.retired, ["sess_home_ada"]);
    assert!(world.log.contains(&json!(["nameRetired", "sess_home_ada", "Ada"])), "the chat lists under the name the agent left");
    assert!(world.log.contains(&json!(["forgetRoomMember", "ada"])));
    assert!(!world.log.iter().any(|entry| entry[1] == "bob" || entry[1] == "sess_home_bob" || entry[1] == "lead"));
}

#[tokio::test]
async fn a_reconcile_archives_a_new_deletion_once_and_leaves_a_hand_restored_chat_restored() {
    let (deps, homes) = world_of(|world| {
        world.sessions.insert("sess_home_ada".into(), (json!({}), true));
        world.presence = HashMap::from([("ada".to_owned(), Presence::Deleted)]);
    });
    homes.reconcile().await.unwrap();
    assert_eq!(deps.world().archived, ["sess_home_ada"]);
    // The user restores the chat by hand; the agent is still deleted, but that deletion was already acted on.
    deps.world().archived.clear();
    homes.reconcile().await.unwrap();
    assert!(deps.world().archived.is_empty());
    // The agent exists again: the record clears, so its next deletion archives anew.
    deps.world().presence.insert("ada".into(), Presence::Present);
    homes.reconcile().await.unwrap();
    assert!(deps.world().retired.is_empty());
    deps.world().presence.insert("ada".into(), Presence::Deleted);
    homes.reconcile().await.unwrap();
    assert_eq!(deps.world().archived, ["sess_home_ada"]);
}

#[tokio::test]
async fn a_failed_presence_read_archives_nothing_and_a_restored_agent_gets_its_chat_back() {
    struct Failing(Homes);
    #[async_trait]
    impl HomeDeps for Failing {
        async fn list_agents(&self) -> Result<Value, DepError> { self.0.list_agents().await }
        async fn mixy_route(&self) -> Result<Value, DepError> { self.0.mixy_route().await }
        async fn mixy_created(&self) -> Result<bool, DepError> { self.0.mixy_created().await }
        async fn read_session(&self, id: &str) -> Result<Value, DepError> { self.0.read_session(id).await }
        async fn create_session(&self, id: &str, params: &Value) -> Result<(), DepError> { self.0.create_session(id, params).await }
        async fn set_route(&self, id: &str, route: &Value) -> Result<(), DepError> { self.0.set_route(id, route).await }
        async fn set_archived(&self, id: &str, archived: bool) -> Result<(), DepError> { self.0.set_archived(id, archived).await }
        async fn set_retired(&self, id: &str, retired: bool) -> Result<(), DepError> { self.0.set_retired(id, retired).await }
        async fn task_workspace(&self) -> Result<String, DepError> { self.0.task_workspace().await }
        async fn clear_session(&self, id: &str, to: &str) -> Result<(), DepError> { self.0.clear_session(id, to).await }
        fn mint_archive_id(&self) -> String { self.0.mint_archive_id() }
        async fn is_retired(&self, id: &str) -> Result<bool, DepError> { self.0.is_retired(id).await }
        async fn name_retired(&self, id: &str, name: &str) -> Result<(), DepError> { self.0.name_retired(id, name).await }
        async fn archived_agent_name(&self, id: &str) -> Result<String, DepError> { self.0.archived_agent_name(id).await }
        async fn known_session_ids(&self) -> Result<Vec<String>, DepError> { self.0.known_session_ids().await }
        async fn agent_presence(&self, _: &[String]) -> Result<HashMap<String, Presence>, DepError> { Err(DepError::new("presence unreadable")) }
        async fn forget_room_member(&self, id: &str) -> Result<(), DepError> { self.0.forget_room_member(id).await }
    }
    mixdog_rt::testing::tokens();
    let failing = Arc::new(Failing(Homes::default()));
    let homes = AgentHomeSessions::new(failing.clone());
    assert_eq!(message(&homes.retire(&["ada".into()]).await.unwrap_err()), "presence unreadable");
    assert!(failing.0.world().archived.is_empty());
    // Restoring brings the chat out of the archive and clears the deletion record; Mixy's is never touched.
    failing.0.world().archived.push("sess_home_ada".into());
    failing.0.world().retired.push("sess_home_ada".into());
    homes.restore("ada").await.unwrap();
    homes.restore("lead").await.unwrap();
    assert!(failing.0.world().archived.is_empty() && failing.0.world().retired.is_empty());
}

#[tokio::test]
async fn a_home_is_known_when_its_session_is() {
    let (_deps, homes) = world_of(|world| {
        world.sessions.insert("sess_home_ada".into(), (json!({}), false));
    });
    assert!(homes.has_home("ada").await.unwrap());
    assert!(!homes.has_home("bob").await.unwrap());
    assert!(!homes.has_home("Bad Id").await.unwrap());
}

// ---- the greetings ------------------------------------------------------------------------------

struct Seen {
    stored: Option<Vec<String>>,
    catalog: Value,
    fail: Vec<String>,
    log: Vec<Value>,
}

struct Greeting(Mutex<Seen>);

fn greeting(stored: Option<&[&str]>, catalog: Value) -> Arc<Greeting> {
    Arc::new(Greeting(Mutex::new(Seen { stored: stored.map(|ids| ids.iter().map(|id| (*id).to_owned()).collect()), catalog, fail: Vec::new(), log: Vec::new() })))
}

impl Greeting {
    fn greeted(&self) -> Vec<String> {
        self.0.lock().unwrap().log.iter().filter(|entry| entry[0] == "greet").map(|entry| entry[1]["id"].as_str().unwrap().to_owned()).collect()
    }
}

#[async_trait]
impl GreetingDeps for Greeting {
    async fn read(&self) -> Result<Option<Vec<String>>, DepError> {
        Ok(self.0.lock().unwrap().stored.clone())
    }
    async fn write(&self, ids: &[String]) -> Result<(), DepError> {
        self.0.lock().unwrap().stored = Some(ids.to_vec());
        Ok(())
    }
    async fn list_agents(&self) -> Result<Value, DepError> {
        Ok(self.0.lock().unwrap().catalog.clone())
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

fn bot(id: &str, label: &str) -> Value {
    json!({ "id": id, "custom": true, "kind": "bot", "label": label, "description": "Helps", "route": { "provider": "p", "model": "m" } })
}

#[tokio::test]
async fn the_first_catalog_read_records_the_existing_agents_without_greeting_them() {
    let deps = greeting(None, json!([bot("old", "Old")]));
    let greetings = AgentGreetings::new(deps.clone());
    greetings.reconcile(&json!([bot("old", "Old")])).await.unwrap();
    assert!(deps.greeted().is_empty());
    assert_eq!(deps.0.lock().unwrap().stored.clone().unwrap(), ["old"]);
}

#[tokio::test]
async fn a_new_contact_with_a_model_is_greeted_once_by_its_label_and_job() {
    let deps = greeting(Some(&["old"]), json!([]));
    let greetings = AgentGreetings::new(deps.clone());
    let catalog = json!([bot("old", "Old"), bot("new", "New Bot")]);
    greetings.reconcile(&catalog).await.unwrap();
    greetings.reconcile(&catalog).await.unwrap();
    assert_eq!(deps.greeted(), ["new"]);
    let first = deps.0.lock().unwrap().log[0].clone();
    assert_eq!(first[1], json!({ "id": "new", "name": "New Bot", "description": "Helps" }));
    assert_eq!(deps.0.lock().unwrap().stored.clone().unwrap(), ["old", "new"]);
}

#[tokio::test]
async fn an_agent_without_a_model_is_recorded_but_not_greeted_and_a_failed_greeting_does_not_stop_the_rest() {
    let deps = greeting(Some(&[]), json!([]));
    deps.0.lock().unwrap().fail.push("a".into());
    let greetings = AgentGreetings::new(deps.clone());
    let no_model = json!({ "id": "bare", "custom": true, "kind": "bot", "route": { "provider": "p" } });
    greetings.reconcile(&json!([no_model, bot("a", "A"), bot("b", "B")])).await.unwrap();
    assert_eq!(deps.greeted(), ["a", "b"]);
    assert_eq!(deps.0.lock().unwrap().stored.clone().unwrap(), ["bare", "a", "b"]);
}

#[test]
fn the_greeting_turn_names_the_agent_and_its_one_line_job() {
    let text = agent_greeting_kickoff("Ada \"the\"\nBot", "Reads mail\r\nand answers");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "[mixdog-runtime] The user just created you as a new agent named \"Ada  the  Bot\".");
    assert_eq!(lines[1], "Your job, as the user described it: Reads mail and answers");
    assert!(lines.last().unwrap().starts_with("Do not call any tools"));
    assert!(!agent_greeting_kickoff("Ada", "").contains("Your job"));
}

/// A catalog read that arrives while a dialog's save is in flight (the save itself rebuilds the pushed catalog) must not
/// greet the agent being saved: the dialog records it as seen before any later catalog read is looked at.
#[tokio::test]
async fn a_catalog_read_during_a_save_does_not_greet_the_saved_agent() {
    let new_bot = bot("new-bot", "New Bot");
    let deps = greeting(Some(&["old"]), json!([new_bot]));
    let greetings = AgentGreetings::new(deps.clone());
    let read = greetings.clone();
    let catalog = json!([new_bot]);
    let reading = Arc::new(Mutex::new(None));
    let started = reading.clone();
    greetings
        .saving(
            async move {
                // The signal is the read's first poll having returned: `reconcile` takes its place in the queue in that
                // poll, so it is now waiting behind the save.
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
                first_poll.await.expect("the catalog read was dropped before its first poll");
                Ok::<_, CoreError>(json!({ "id": "new-bot" }))
            },
            |saved| saved["id"].as_str().map(str::to_owned),
        )
        .await
        .unwrap();
    let handle = reading.lock().unwrap().take().unwrap();
    handle.await.unwrap().unwrap();
    assert!(deps.greeted().is_empty(), "the saved agent was greeted");
    assert_eq!(deps.0.lock().unwrap().stored.clone().unwrap(), ["old", "new-bot"]);
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
        Err(session_missing(session_id))
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
    let quiet = Arc::new(Quiet { gates: None });
    AgentLifecycle::new(AgentHomeSessions::new(quiet.clone()), AgentGreetings::new(quiet))
}

/// A catalog read starts the reconcile and the greetings together and holds neither: both are in flight at once.
/// A lifecycle that ran one after the other would wait at its first gate for ever.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_list_read_starts_the_reconcile_and_the_greetings_together() {
    // `listed` spawns both starts on the runtime, which is installed before anything spawns.
    mixdog_rt::testing::tokens();
    let gates = Arc::new(Gates::default());
    let quiet = Arc::new(Quiet { gates: Some(gates.clone()) });
    let lifecycle = AgentLifecycle::new(AgentHomeSessions::new(quiet.clone()), AgentGreetings::new(quiet));
    lifecycle.listed(json!([]));
    gates.presence_finished.notified().await;
    gates.read_finished.notified().await;
}
