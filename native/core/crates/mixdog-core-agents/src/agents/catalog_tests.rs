//! The agent catalog the rooms and the setup actions read: the agent rows (fixed services, then
//! the custom agents), the contacts, Mixy's route, her status and whether she exists, the
//! custom-agent roster and the names archived agents left.

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_rooms::rooms::home::Presence;
use mixdog_core_rooms::rooms::sessions::AgentCatalog;
use serde_json::Value;
use serde_json::json;

use super::*;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;

/// What the sessions and the automation store say: who greeted, whether the user wrote to Mixy,
/// and whether a routine of hers exists (or the answer that could not be read).
struct Facts {
    greeted: Vec<&'static str>,
    chatted: bool,
    owns: Result<bool, String>,
}

impl Default for Facts {
    fn default() -> Self {
        Self { greeted: Vec::new(), chatted: false, owns: Ok(false) }
    }
}

#[async_trait]
impl AgentEvidence for Facts {
    async fn home_greeted(&self, agent_id: &str) -> bool {
        self.greeted.contains(&agent_id)
    }
    async fn home_chatted(&self, _: &str) -> bool {
        self.chatted
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        self.owns.clone()
    }
}

fn put(root: &Path, rel: &str, text: &str) {
    let file = root.join(rel);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, text).unwrap();
}

const GPT_MAIN: &str = "gpt-main";

/// Definitions over a fresh `shipped/` and `data/`; `agent` is the config's agent section (its
/// `disabledAgents` is the whole list of agents that are off) and Main runs on `gpt-main`.
async fn world(agent: Value, facts: Facts) -> (tempfile::TempDir, AgentDefinitions) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&mixdog_core_config::config::agent_routes::stored_file_of(&agent)).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let data = dir.path().join("data");
    let agents = AgentDefinitions::new(
        dir.path().join("shipped"),
        &data,
        tokens.interactive_io,
        AgentRoutes::new(config, &data),
        Arc::new(facts),
        Arc::new(|| json!({ "provider": "openai", "model": GPT_MAIN })),
        dir.path().join("task"),
    );
    (dir, agents)
}

fn agent_md(kind: &str) -> String {
    format!("---\nkind: {kind}\n---\nBody\n")
}

#[tokio::test]
async fn the_rows_list_the_fixed_services_then_the_custom_agents_with_their_route_and_state() {
    let (dir, agents) = world(
        json!({
            "agents": { "ann": { "provider": "openai", "model": "gpt-ann" } },
            "disabledAgents": ["bob"],
        }),
        Facts::default(),
    )
    .await;
    let (data, shipped) = (dir.path().join("data"), dir.path().join("shipped"));
    put(&shipped, "agents/worker/AGENT.md", "---\nname: Worker\n---\nShipped body\n");
    put(&data, "agents/ann/AGENT.md", &agent_md("bot"));
    put(&data, "agents/ann/agent.json", r#"{"name":"Ann Lee","description":"Writes letters"}"#);
    put(&data, "agents/bob/AGENT.md", &agent_md("agent"));

    let rows = agents.rows().await.unwrap();
    let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids, ["maintainer", "explore", "worker", "ann", "bob"], "the services first, the shipped starter before the others, then by id");

    let maintainer = &rows[0];
    assert_eq!((maintainer.label.as_str(), maintainer.description.as_str()), ("Maintainer", "Memory and upkeep"));
    assert!(maintainer.fixed && !maintainer.user_override && maintainer.kind.is_none());
    assert_eq!(maintainer.avatar, Value::Null, "a fixed service lists no avatar");
    assert!(maintainer.definition.is_none(), "no file, no definition");

    let worker = &rows[2];
    assert!(!worker.fixed && !worker.user_override, "a shipped role has no user copy");
    assert_eq!(worker.label, "worker", "the label is the manifest's name, else the id");

    let ann = &rows[3];
    assert_eq!((ann.label.as_str(), ann.description.as_str(), ann.kind.as_deref()), ("Ann Lee", "Writes letters", Some("bot")));
    assert!(ann.user_override && ann.route_configured && !ann.disabled);
    assert_eq!(ann.route["model"], "gpt-ann", "an agent's own route wins");

    let bob = &rows[4];
    assert_eq!(bob.label, "bob", "no name in the manifest: the id");
    assert!(bob.disabled && !bob.route_configured);
    assert_eq!(bob.route["model"], GPT_MAIN, "no route of its own: Main's");
}

#[tokio::test]
async fn the_contacts_are_the_enabled_user_agents_marked_bot_or_greeted_in_their_chat() {
    let (dir, agents) = world(
        json!({ "agents": { "ann": { "provider": "openai", "model": "gpt-ann" } }, "disabledAgents": ["bob"] }),
        Facts { greeted: vec!["dan"], ..Facts::default() },
    )
    .await;
    let (data, shipped) = (dir.path().join("data"), dir.path().join("shipped"));
    put(&data, "agents/ann/AGENT.md", &agent_md("bot"));
    put(&data, "agents/bob/AGENT.md", &agent_md("bot"));
    put(&data, "agents/cat/AGENT.md", &agent_md("agent"));
    put(&data, "agents/dan/AGENT.md", "---\nname: Dan\n---\nBody\n");
    put(&data, "agents/eve/AGENT.md", "---\nname: Eve\n---\nBody\n");
    put(&data, "agents/writer/AGENT.md", &agent_md("bot"));
    put(&shipped, "agents/worker/AGENT.md", "---\nname: Worker\n---\nBody\n");

    let contacts = agents.contacts().await.unwrap();
    let seen: Vec<(&str, &str)> = contacts.iter().map(|c| (c.id.as_str(), c.route["model"].as_str().unwrap())).collect();
    // bob is off, cat is a workflow agent, eve was never greeted, writer and worker are shipped roles.
    assert_eq!(seen, [("ann", "gpt-ann"), ("dan", GPT_MAIN)]);
    let catalog: &dyn AgentCatalog = &agents;
    let in_rooms: Vec<(String, Value)> = catalog.agents().await.unwrap().into_iter().map(|c| (c.id, c.route)).collect();
    let direct: Vec<(String, Value)> = contacts.into_iter().map(|c| (c.id, c.route)).collect();
    assert_eq!(in_rooms, direct, "the rooms see the same contacts");
}

#[tokio::test]
async fn the_custom_agent_roster_skips_mixy_roles_internal_agents_tombstones_and_folders_without_a_definition() {
    let (dir, agents) = world(json!({ "disabledAgents": ["zed"] }), Facts::default()).await;
    let (data, shipped) = (dir.path().join("data"), dir.path().join("shipped"));
    for id in ["writer", "worker", "reviewer"] {
        put(&shipped, &format!("agents/{id}/AGENT.md"), "---\nname: X\n---\nBody\n");
    }
    // The user deleted the shipped reviewer: its tombstone hides the packaged copy.
    put(&data, &format!("agents/reviewer/{DELETED_MARKER}"), "");
    for id in ["ann", "zed", "lead", "maintainer", "title-agent"] {
        put(&data, &format!("agents/{id}/AGENT.md"), "---\nname: X\n---\nBody\n");
    }
    put(&data, "agents/empty/notes.txt", "no definition here");

    let all = agents.custom_agent_ids().await.unwrap();
    assert_eq!(all, ["worker", "writer", "ann", "zed"], "starters in their order, then by id");
    let delegatable = agents.delegatable_agent_ids().await.unwrap();
    assert_eq!(delegatable, ["worker", "writer", "ann"], "an agent that is switched off cannot be delegated to");
}

#[tokio::test]
async fn mixys_home_route_is_her_own_complete_route_else_mains() {
    let (dir, agents) = world(json!({}), Facts::default()).await;
    let data = dir.path().join("data");
    assert_eq!(agents.mixy_route().await.unwrap(), None);
    assert_eq!(agents.mixy_home_route().await.unwrap()["model"], GPT_MAIN);
    let catalog: &dyn AgentCatalog = &agents;
    assert_eq!(catalog.mixy_route().await["model"], GPT_MAIN);

    // A route that names no model is no route.
    put(&data, "bots/mixy/agent.json", r#"{"route":{"provider":"openai"}}"#);
    assert_eq!(agents.mixy_route().await.unwrap(), None);
    assert_eq!(agents.mixy_home_route().await.unwrap()["model"], GPT_MAIN);

    let own = json!({ "provider": "anthropic", "model": "claude-x" });
    put(&data, "bots/mixy/agent.json", &json!({ "route": own }).to_string());
    assert_eq!(agents.mixy_route().await.unwrap(), Some(own.clone()));
    assert_eq!(agents.mixy_home_route().await.unwrap(), own);
    assert_eq!(catalog.mixy_route().await, own);
}

#[tokio::test]
async fn mixys_status_reads_her_identity_folder_and_the_old_created_flag_after_the_split() {
    let (dir, agents) = world(json!({}), Facts { chatted: true, ..Facts::default() }).await;
    let data = dir.path().join("data");
    let blank = agents.lead_status().await.unwrap();
    assert_eq!((blank.created, blank.name.as_str(), blank.avatar.clone(), blank.home_chatted), (None, "", Value::Null, true));

    // Before the split her identity is `agents/lead`.
    let mascot = json!({ "kind": "mascot", "species": "corgi", "color": "#5b9bff" });
    put(&data, "agents/lead/agent.json", &json!({ "created": true, "name": "  Mixy\n the  Bot ", "avatar": mascot }).to_string());
    let before = agents.lead_status().await.unwrap();
    assert_eq!((before.created, before.name.as_str()), (Some(true), "Mixy the Bot"), "the name is one line");
    assert_eq!(before.avatar["kind"], "mascot");

    // Once the bot store is active her identity is `bots/mixy`; a `created` flag only the old
    // folder holds still counts, a name only the old folder holds does not.
    put(&data, "bots/migration.json", r#"{"version":1}"#);
    put(&data, "bots/mixy/agent.json", r#"{"name":"Mix"}"#);
    put(&data, "agents/lead/agent.json", r#"{"created":false,"name":"Old"}"#);
    let after = agents.lead_status().await.unwrap();
    assert_eq!((after.created, after.name.as_str(), after.avatar), (Some(false), "Mix", Value::Null));
    assert_eq!(after.route, None);
}

#[tokio::test]
async fn mixy_exists_when_not_declined_and_named_or_written_to_or_running_a_routine() {
    let cases = [
        // (manifest, the user wrote in her thread, her routines, expected)
        (r#"{"created":false,"name":"Mixy"}"#, true, Ok(true), false),
        (r#"{"name":"Mixy"}"#, false, Ok(false), true),
        (r#"{}"#, true, Ok(false), true),
        (r#"{"created":true}"#, false, Ok(true), true),
        (r#"{}"#, false, Ok(false), false),
    ];
    for (manifest, chatted, owns, expected) in cases {
        let (dir, agents) = world(json!({}), Facts { chatted, owns, ..Facts::default() }).await;
        put(&dir.path().join("data"), "agents/lead/agent.json", manifest);
        assert_eq!(agents.mixy_exists().await.unwrap(), expected, "{manifest} chatted={chatted}");
        let catalog: &dyn AgentCatalog = &agents;
        assert_eq!(catalog.mixy_created().await, expected);
    }
}

#[tokio::test]
async fn when_the_routines_cannot_be_read_mixy_is_an_error_and_the_rooms_see_no_mixy() {
    let (_dir, agents) = world(json!({}), Facts { owns: Err("store unreadable".into()), ..Facts::default() }).await;
    let error = agents.mixy_exists().await.unwrap_err();
    assert_eq!(error.to_string(), "store unreadable");
    let catalog: &dyn AgentCatalog = &agents;
    assert!(!catalog.mixy_created().await);
}

#[tokio::test]
async fn an_archived_agent_leaves_its_name_else_its_id_and_a_live_or_unknown_one_leaves_nothing() {
    let (dir, agents) = world(json!({}), Facts::default()).await;
    let data = dir.path().join("data");
    put(&data, &format!("agents/named/{DELETED_MARKER}"), "");
    put(&data, "agents/named/agent.json", r#"{"name":"Nora\nNamed"}"#);
    put(&data, &format!("agents/nameless/{DELETED_MARKER}"), "");
    put(&data, "agents/live/AGENT.md", "---\nname: Live\n---\nBody\n");
    put(&data, "agents/live/agent.json", r#"{"name":"Live"}"#);

    let catalog: &dyn AgentCatalog = &agents;
    assert_eq!(catalog.archived_name("named").await, "Nora Named");
    assert_eq!(catalog.archived_name("nameless").await, "nameless");
    for id in ["live", "ghost", " named", "Named"] {
        assert_eq!(catalog.archived_name(id).await, "", "{id:?}");
        assert!(agents.archived_identity(id).await.unwrap().is_none(), "{id:?}");
    }
    let ids = ["named".to_owned(), "live".to_owned(), "ghost".to_owned()];
    let presence = catalog.presence(&ids).await.unwrap();
    assert_eq!((presence["named"], presence["live"], presence["ghost"]), (Presence::Deleted, Presence::Present, Presence::Deleted));
}
