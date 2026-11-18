//! The definition actions of the three kinds: what each asks of the agent store, the workflow
//! service and the skills service, and what it answers.

use std::sync::Mutex;

use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use serde_json::Value;
use serde_json::json;

use super::*;

/// The workflow and skills services: a canned world, every call logged.
struct Services {
    workflows: Value,
    skills: Value,
    log: Mutex<Vec<(String, Value)>>,
}

impl Services {
    fn calls(&self) -> Vec<String> {
        self.log.lock().unwrap().iter().map(|(method, _)| method.clone()).collect()
    }
    fn last(&self) -> (String, Value) {
        self.log.lock().unwrap().last().cloned().unwrap()
    }
}

fn domain(message: String) -> CoreError {
    CoreError::DomainError { domain: "canned".into(), code: None, message: Some(message.into()), detail: None }
}

#[async_trait]
impl DomainService for Services {
    fn methods(&self) -> &'static [&'static str] {
        &[]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let p = req.params.clone();
        self.log.lock().unwrap().push((req.method.as_str().to_owned(), p.clone()));
        let text = |key: &str| p[key].as_str().unwrap_or_default().to_owned();
        let value = match req.method.as_str() {
            "config/getWorkflowPack" => {
                let id = text("workflowId");
                self.workflows.get(&id).cloned().ok_or_else(|| domain(format!("workflow \"{id}\" not found")))?
            }
            "config/createWorkflow" | "config/saveWorkflowPack" | "skills/addSkill" | "skills/saveSkill" => json!({ "sent": p }),
            "config/deleteWorkflow" => json!({ "id": p["workflowId"], "deleted": true, "revertedToBuiltIn": false }),
            "skills/skillContent" => {
                let name = text("name");
                let skill = self.skills.get(&name).ok_or_else(|| domain(format!("skill not found: {name}")))?;
                json!({ "content": skill["content"] })
            }
            "skills/skillsStatus" => json!({ "skills": self.skills.as_object().unwrap().values().map(|s| s["row"].clone()).collect::<Vec<_>>() }),
            other => panic!("{other}"),
        };
        Ok(Reply::Value(value))
    }

    fn notify(&self, _: mixdog_core_api::ids::Method, _: Value, _: mixdog_core_api::ids::ConnectionId) -> mixdog_core_api::service::Admit {
        unreachable!("no notifications")
    }
}

fn world_services() -> Arc<Services> {
    Arc::new(Services {
        workflows: json!({
            "mine": { "id": "mine", "originalName": "x", "name": "mine", "description": "d", "body": "old", "extra": 1 },
        }),
        skills: json!({
            "tidy": { "content": "Tidy body", "row": { "name": "tidy", "description": "Cleans", "whenToUse": "after edits", "toolDependencies": ["shell"], "editable": false } },
            "mine": { "content": "Mine body", "row": { "name": "mine", "description": "Mine d", "whenToUse": "w", "toolDependencies": ["shell"], "editable": true } },
        }),
        log: Mutex::default(),
    })
}

struct Rig {
    _dir: tempfile::TempDir,
    setup: DefinitionSetup,
    agents: Arc<AgentDefinitions>,
    services: Arc<Services>,
}

async fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = Arc::new(
        AgentDefinitions::new(dir.path().join("shipped"), dir.path().join("data"), tokens.interactive_io, AgentRoutes::new(config, dir.path().join("data")), Arc::new(NoEvidence), Arc::new(|| Value::Null), dir.path().join("task"))
            .with_writes(tokens.durability_io, Arc::new(NoEffects::default()), Arc::new(String::new)),
    );
    let services = world_services();
    let setup = DefinitionSetup::new(agents.clone(), Arc::new(Callers), services.clone(), services.clone());
    Rig { _dir: dir, setup, agents, services }
}

/// The answer of `args` as run from chat `thread`: the result, or the refusal's text.
async fn act(rig: &Rig, thread: &str, args: Value) -> Result<Value, String> {
    let thread = ThreadId::from(thread);
    let call = SetupCall { action: args["action"].as_str().unwrap(), args: &args, thread: &thread };
    match rig.setup.run(&call).await {
        Ok(value) => Ok(value),
        Err(PortError::Failed { message, .. } | PortError::Denied(message)) => Err(message),
        Err(other) => panic!("{other:?}"),
    }
}

const TASK: &str = "sess_task_1";
const MIXY: &str = "sess_mixy";
const ADA: &str = "sess_home_ada";

fn agent(action: &str, definition: Value) -> Value {
    json!({ "action": action, "definitionKind": "agent", "definition": definition })
}

#[tokio::test]
async fn an_agent_is_created_as_a_bot_only_from_mixys_chat_unless_a_kind_is_given() {
    let rig = rig().await;
    let made = |name: &str| agent("create_definition", json!({ "name": name, "body": "Do the job" }));
    assert_eq!(act(&rig, TASK, made("From Task")).await.unwrap()["kind"], "agent", "a coding task's agent is a workflow agent");
    assert_eq!(act(&rig, MIXY, made("From Mixy")).await.unwrap()["kind"], "bot", "Mixy's agent-mode chat makes bots");
    assert_eq!(act(&rig, ADA, made("From Ada")).await.unwrap()["kind"], "agent", "another bot's chat is not Mixy");
    let given = agent("create_definition", json!({ "name": "Given", "body": "b", "kind": "bot" }));
    assert_eq!(act(&rig, TASK, given).await.unwrap()["kind"], "bot", "the kind asked for wins");
    let created = act(&rig, MIXY, made("Scout")).await.unwrap();
    assert_eq!((created["id"].clone(), created["name"].clone(), created["body"].clone()), (json!("scout"), json!("Scout"), json!("Do the job")));
}

#[tokio::test]
async fn a_definition_names_only_its_kinds_fields_and_needs_a_body() {
    let rig = rig().await;
    let refused = |args: Value| {
        let rig = &rig;
        async move { act(rig, TASK, args).await.unwrap_err() }
    };
    assert_eq!(refused(agent("create_definition", json!({ "name": "X", "body": "b", "color": "red" }))).await, "color is not a agent definition field");
    assert_eq!(
        refused(json!({ "action": "create_definition", "definitionKind": "workflow", "definition": { "name": "X", "body": "b", "kind": "bot" } })).await,
        "kind is not a workflow definition field"
    );
    assert_eq!(refused(json!({ "action": "create_definition", "definitionKind": "skill", "definition": { "id": "x", "body": "b" } })).await, "id is not a skill definition field");
    assert_eq!(refused(agent("create_definition", json!({ "name": "X" }))).await, "definition.body must not be empty");
    assert_eq!(refused(agent("create_definition", json!({ "name": "X", "body": "   " }))).await, "definition.body must not be empty");
}

#[tokio::test]
async fn an_agent_cannot_be_created_under_an_id_that_is_taken_including_a_built_in_service() {
    let rig = rig().await;
    act(&rig, TASK, agent("create_definition", json!({ "id": "scout", "body": "b" }))).await.unwrap();
    for id in ["scout", "maintainer"] {
        let error = act(&rig, TASK, agent("create_definition", json!({ "id": id, "body": "b" }))).await.unwrap_err();
        assert_eq!(error, format!("agent \"{id}\" already exists"));
    }
}

#[tokio::test]
async fn saving_an_agent_keeps_what_the_edit_does_not_name_and_cannot_change_its_kind() {
    let rig = rig().await;
    act(&rig, MIXY, agent("create_definition", json!({ "name": "Scout", "description": "Finds things", "body": "Look around" }))).await.unwrap();

    let edited = act(&rig, TASK, agent("save_definition", json!({ "id": "scout", "body": "Look harder" }))).await.unwrap();
    assert_eq!(
        (edited["body"].clone(), edited["name"].clone(), edited["description"].clone(), edited["kind"].clone()),
        (json!("Look harder"), json!("Scout"), json!("Finds things"), json!("bot"))
    );
    let described = act(&rig, TASK, agent("save_definition", json!({ "id": "scout", "description": "Finds more" }))).await.unwrap();
    assert_eq!((described["body"].clone(), described["description"].clone()), (json!("Look harder"), json!("Finds more")));

    let kind = act(&rig, TASK, agent("save_definition", json!({ "id": "scout", "kind": "agent" }))).await.unwrap_err();
    assert_eq!(kind, "an agent's kind is set when it is created and cannot change");
    assert_eq!(act(&rig, TASK, agent("save_definition", json!({ "id": "scout", "body": " " }))).await.unwrap_err(), "definition.body must not be empty");
    assert_eq!(act(&rig, TASK, agent("save_definition", json!({ "body": "x" }))).await.unwrap_err(), "An existing definition identity is required");
    assert_eq!(act(&rig, TASK, agent("save_definition", json!({ "id": "ghost", "body": "x" }))).await.unwrap_err(), "agent \"ghost\" not found");
}

#[tokio::test]
async fn reading_an_agent_gives_its_definition_and_an_unknown_one_is_not_found() {
    let rig = rig().await;
    act(&rig, TASK, agent("create_definition", json!({ "name": "Scout", "body": "Look around" }))).await.unwrap();
    let read = act(&rig, TASK, json!({ "action": "read_definition", "definitionKind": "agent", "name": "scout" })).await.unwrap();
    assert_eq!((read["id"].clone(), read["body"].clone(), read["custom"].clone()), (json!("scout"), json!("Look around"), json!(true)));
    let missing = act(&rig, TASK, json!({ "action": "read_definition", "definitionKind": "agent", "name": "ghost" })).await.unwrap_err();
    assert_eq!(missing, "agent \"ghost\" not found");
}

#[tokio::test]
async fn deleting_an_agent_archives_it_and_restoring_brings_it_back() {
    let rig = rig().await;
    act(&rig, MIXY, agent("create_definition", json!({ "name": "Scout", "body": "Look around" }))).await.unwrap();
    let ids = ["scout".to_owned()];
    assert_eq!(rig.agents.presence(&ids).await.unwrap()["scout"], mixdog_core_rooms::rooms::home::Presence::Present);

    let deleted = act(&rig, MIXY, json!({ "action": "delete_definition", "definitionKind": "agent", "name": "scout" })).await.unwrap();
    assert_eq!((deleted["id"].clone(), deleted["deleted"].clone(), deleted["revertedToBuiltIn"].clone()), (json!("scout"), json!(true), json!(false)));
    assert!(deleted["recovery"].as_str().unwrap().starts_with("A custom agent or bot is archived with its chat; its schedules and webhooks are paused and hidden, unchanged."));
    assert_eq!(rig.agents.presence(&ids).await.unwrap()["scout"], mixdog_core_rooms::rooms::home::Presence::Deleted);

    let restored = act(&rig, MIXY, json!({ "action": "restore_definition", "definitionKind": "agent", "name": " scout " })).await.unwrap();
    assert_eq!(restored, json!({ "restored": "scout", "note": "Its chat is back, and its routines run again as they were." }));
    assert_eq!(rig.agents.presence(&ids).await.unwrap()["scout"], mixdog_core_rooms::rooms::home::Presence::Present);
}

#[tokio::test]
async fn restoring_needs_a_name_and_an_agent_kind() {
    let rig = rig().await;
    assert_eq!(act(&rig, MIXY, json!({ "action": "restore_definition", "definitionKind": "agent" })).await.unwrap_err(), "name is required");
    assert_eq!(act(&rig, MIXY, json!({ "action": "restore_definition", "definitionKind": "agent", "name": "  " })).await.unwrap_err(), "name is required");
    for kind in ["workflow", "skill"] {
        let error = act(&rig, MIXY, json!({ "action": "restore_definition", "definitionKind": kind, "name": "x" })).await.unwrap_err();
        assert_eq!(error, "Only an archived agent or bot can be restored; a deleted workflow is gone", "{kind}");
    }
}

// ---- workflow -------------------------------------------------------------------------------

#[tokio::test]
async fn a_workflow_is_read_created_saved_and_deleted_through_the_workflow_service() {
    let rig = rig().await;
    let workflow = |action: &str, extra: Value| {
        let mut args = json!({ "action": action, "definitionKind": "workflow" });
        args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        args
    };
    let read = act(&rig, TASK, workflow("read_definition", json!({ "name": "mine" }))).await.unwrap();
    assert_eq!(read["body"], "old");
    assert_eq!(rig.services.last(), ("config/getWorkflowPack".to_owned(), json!({ "workflowId": "mine" })));

    // A new workflow is sent as given.
    act(&rig, TASK, workflow("create_definition", json!({ "definition": { "id": "fresh", "name": "Fresh", "body": "b" } }))).await.unwrap();
    assert_eq!(rig.services.last(), ("config/createWorkflow".to_owned(), json!({ "payload": { "id": "fresh", "name": "Fresh", "body": "b" } })));

    // An edit is the stored pack's definition fields under the edit, saved under the pack's own id.
    rig.services.log.lock().unwrap().clear();
    act(&rig, TASK, workflow("save_definition", json!({ "definition": { "name": "mine", "body": "new" } }))).await.unwrap();
    assert_eq!(rig.services.calls(), ["config/getWorkflowPack", "config/saveWorkflowPack"]);
    assert_eq!(
        rig.services.last().1,
        json!({ "payload": { "id": "mine", "originalName": "x", "name": "mine", "description": "d", "body": "new" } }),
        "`extra` is no definition field and is not carried"
    );
}

#[tokio::test]
async fn deleting_a_workflow_checks_it_exists_first() {
    let rig = rig().await;
    let delete = |name: &str| json!({ "action": "delete_definition", "definitionKind": "workflow", "name": name });
    assert_eq!(act(&rig, TASK, delete("ghost")).await.unwrap_err(), "workflow \"ghost\" not found");
    assert_eq!(rig.services.calls(), ["config/getWorkflowPack"], "nothing was deleted");
    let deleted = act(&rig, TASK, delete("mine")).await.unwrap();
    assert_eq!(deleted["deleted"], true);
    assert_eq!(deleted["recovery"], "User-authored definition files are deleted. A built-in override may revert to its built-in definition.");
    assert_eq!(rig.services.calls().last().unwrap(), "config/deleteWorkflow");
}

// ---- skills -----------------------------------------------------------------------------------

#[tokio::test]
async fn a_skill_is_read_as_its_catalog_row_with_its_body() {
    let rig = rig().await;
    let read = act(&rig, TASK, json!({ "action": "read_definition", "definitionKind": "skill", "name": "mine" })).await.unwrap();
    assert_eq!(
        read,
        json!({ "name": "mine", "originalName": "mine", "description": "Mine d", "whenToUse": "w", "body": "Mine body", "toolDependencies": ["shell"], "editable": true })
    );
    let builtin = act(&rig, TASK, json!({ "action": "read_definition", "definitionKind": "skill", "name": "tidy" })).await.unwrap();
    assert_eq!(builtin["editable"], false);
}

#[tokio::test]
async fn a_skill_of_the_user_is_added_and_saved_but_never_deleted() {
    let rig = rig().await;
    let skill = |action: &str, definition: Value| json!({ "action": action, "definitionKind": "skill", "definition": definition });
    act(&rig, TASK, skill("create_definition", json!({ "name": "fresh", "body": "b", "description": "d" }))).await.unwrap();
    assert_eq!(rig.services.last(), ("skills/addSkill".to_owned(), json!({ "input": { "name": "fresh", "body": "b", "description": "d" } })));

    act(&rig, TASK, skill("save_definition", json!({ "name": "mine", "body": "b2" }))).await.unwrap();
    assert_eq!(
        rig.services.last(),
        (
            "skills/saveSkill".to_owned(),
            json!({ "input": { "originalName": "mine", "name": "mine", "description": "Mine d", "body": "b2", "whenToUse": "w", "toolDependencies": ["shell"] } })
        )
    );
    rig.services.log.lock().unwrap().clear();
    let error = act(&rig, TASK, json!({ "action": "delete_definition", "definitionKind": "skill", "name": "mine" })).await.unwrap_err();
    assert_eq!(error, "Skill deletion is not supported; use set_disabled_skills");
    assert!(rig.services.calls().is_empty());
}

#[tokio::test]
async fn a_built_in_skill_accepts_only_its_tool_dependencies() {
    let rig = rig().await;
    let skill = |definition: Value| json!({ "action": "save_definition", "definitionKind": "skill", "definition": definition });
    let only = "Built-in and plugin skills accept only toolDependencies edits";
    assert_eq!(act(&rig, TASK, skill(json!({ "name": "tidy", "body": "x" }))).await.unwrap_err(), only);
    assert_eq!(act(&rig, TASK, skill(json!({ "name": "tidy", "toolDependencies": ["a"], "description": "x" }))).await.unwrap_err(), only);
    assert_eq!(act(&rig, TASK, skill(json!({ "name": "tidy", "whenToUse": "always" }))).await.unwrap_err(), only);
    assert_eq!(act(&rig, TASK, skill(json!({ "originalName": "tidy", "name": "renamed", "toolDependencies": [] }))).await.unwrap_err(), only, "a rename is refused");
    assert!(!rig.services.calls().contains(&"skills/saveSkill".to_owned()));

    // The one allowed edit: the same name may be sent along.
    act(&rig, TASK, skill(json!({ "name": "tidy", "toolDependencies": ["a"] }))).await.unwrap();
    assert_eq!(
        rig.services.last(),
        ("skills/saveSkill".to_owned(), json!({ "input": { "originalName": "tidy", "dependenciesOnly": true, "toolDependencies": ["a"] } }))
    );
}
