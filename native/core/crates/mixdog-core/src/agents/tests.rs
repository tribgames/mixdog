use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::config::Config;
use crate::config::ConfigLanes;

/// What the sessions and the automation store know, as the recorder measured it.
struct Evidence {
    greeted: HashMap<String, bool>,
    chatted: HashMap<String, bool>,
    owns: bool,
}

#[async_trait]
impl AgentEvidence for Evidence {
    async fn home_greeted(&self, agent_id: &str) -> bool {
        self.greeted.get(agent_id).copied().unwrap_or(false)
    }
    async fn home_chatted(&self, agent_id: &str) -> bool {
        self.chatted.get(agent_id).copied().unwrap_or(false)
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(self.owns)
    }
}

fn write_files(base: &Path, files: &Value) {
    for (rel, content) in files.as_object().unwrap() {
        let file = base.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content.as_str().unwrap()).unwrap();
    }
}

fn presence_text(presence: Presence) -> &'static str {
    match presence {
        Presence::Present => "present",
        Presence::Deleted => "deleted",
        Presence::Unknown => "unknown",
    }
}

fn definition_json(definition: &Option<AgentDefinition>) -> Value {
    let Some(d) = definition else { return Value::Null };
    json!({
        "id": d.id, "name": d.name, "description": d.description, "permission": d.permission,
        "frontmatter": d.frontmatter, "kind": d.kind, "body": d.body, "persona": d.persona,
    })
}

/// One recorded world opened as the loader reads it.
async fn open_world(world: &Value) -> (tempfile::TempDir, AgentDefinitions) {
    let dir = tempfile::tempdir().unwrap();
    let (shipped, data) = (dir.path().join("shipped"), dir.path().join("data"));
    std::fs::create_dir_all(&shipped).unwrap();
    std::fs::create_dir_all(&data).unwrap();
    write_files(&shipped, &world["shipped"]);
    write_files(&data, &world["data"]);

    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let config_path = dir.path().join("mixdog-config.json");
    std::fs::write(&config_path, serde_json::to_vec(&json!({ "agent": world["config"] })).unwrap()).unwrap();
    let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let evidence_of = |field: &str| -> HashMap<String, bool> {
        world["evidence"].as_object().unwrap().iter().map(|(id, e)| (id.clone(), e[field].as_bool().unwrap())).collect()
    };
    let main = world["main"].clone();
    let agents = AgentDefinitions::new(
        &shipped,
        &data,
        tokens.interactive_io,
        AgentRoutes::new(config, &data),
        Arc::new(Evidence { greeted: evidence_of("greeted"), chatted: evidence_of("chatted"), owns: world["owns"].as_bool().unwrap() }),
        Arc::new(move || main.clone()),
        dir.path().join("task"),
    );
    (dir, agents)
}

/// The rooms module reads the same recorded worlds through `AgentCatalog`: contacts, Mixy's home
/// route and existence, presence, and the name an archived agent left (`""` when none).
#[tokio::test]
async fn the_room_catalog_answers_what_the_recorded_node_functions_answered() {
    use crate::rooms::sessions::AgentCatalog;
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/agent-definitions-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    for world in twin["worlds"].as_array().unwrap() {
        let name = world["name"].as_str().unwrap();
        let (_dir, agents) = open_world(world).await;
        let catalog: &dyn AgentCatalog = &agents;
        let want = &world["expect"];
        let queries: Vec<String> = world["queries"].as_array().unwrap().iter().map(|q| q.as_str().unwrap().to_owned()).collect();
        let mut check = |what: &str, got: Value, want: &Value| {
            if &got != want {
                failures.push(format!("{name} {what}: {got} != {want}"));
            }
        };
        let contacts: Vec<Value> = catalog.agents().await.unwrap().iter().map(|c| json!({ "id": c.id, "route": c.route })).collect();
        check("contacts", json!(contacts), &want["contacts"]);
        check("mixyRoute", catalog.mixy_route().await, &want["leadHomeRoute"]);
        check("mixyCreated", json!(catalog.mixy_created().await), &want["mixyExists"]);
        let presence: serde_json::Map<String, Value> =
            catalog.presence(&queries).await.unwrap().into_iter().map(|(id, p)| (id, json!(presence_text(p)))).collect();
        check("presence", Value::Object(presence), &want["presence"]);
        for id in &queries {
            let node = want["archived"][id]["name"].as_str().unwrap_or_default();
            check(&format!("archived {id:?}"), json!(catalog.archived_name(id).await), &json!(node));
        }
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.iter().take(40).cloned().collect::<Vec<_>>().join("\n"));
}
#[tokio::test]
async fn the_loader_answers_what_the_recorded_node_functions_answered() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/agent-definitions-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let worlds = twin["worlds"].as_array().unwrap();
    assert_eq!(worlds.len(), 80);

    let mut failures = Vec::new();
    for world in worlds {
        let name = world["name"].as_str().unwrap();
        let (_dir, agents) = open_world(world).await;

        let want = &world["expect"];
        let queries: Vec<String> = world["queries"].as_array().unwrap().iter().map(|q| q.as_str().unwrap().to_owned()).collect();
        let mut check = |what: &str, got: Value, want: &Value| {
            if &got != want {
                failures.push(format!("{name} {what}: {got} != {want}"));
            }
        };

        check("customIds", json!(agents.custom_agent_ids().await.unwrap()), &want["customIds"]);
        check("delegatable", json!(agents.delegatable_agent_ids().await.unwrap()), &want["delegatable"]);
        for id in &queries {
            let got = definition_json(&agents.load(id).await.unwrap());
            check(&format!("definition {id:?}"), got, &want["definitions"][id]);
        }
        let rows: Vec<Value> = agents
            .rows()
            .await
            .unwrap()
            .iter()
            .map(|row| {
                json!({
                    "id": row.id, "label": row.label, "description": row.description, "fixed": row.fixed,
                    "userOverride": row.user_override, "route": row.route, "routeConfigured": row.route_configured,
                    "kind": row.kind, "disabled": row.disabled, "avatar": row.avatar, "hasDefinition": row.definition.is_some(),
                })
            })
            .collect();
        check("rows", json!(rows), &want["rows"]);
        let contacts: Vec<Value> = agents.contacts().await.unwrap().iter().map(|c| json!({ "id": c.id, "route": c.route })).collect();
        check("contacts", json!(contacts), &want["contacts"]);
        let presence: serde_json::Map<String, Value> =
            agents.presence(&queries).await.unwrap().into_iter().map(|(id, p)| (id, json!(presence_text(p)))).collect();
        check("presence", Value::Object(presence), &want["presence"]);
        let mut archived = serde_json::Map::new();
        for id in &queries {
            archived.insert(id.clone(), json!(agents.archived_identity(id).await.unwrap().map(|who| json!({ "name": who.name, "avatar": who.avatar }))));
        }
        check("archived", Value::Object(archived), &want["archived"]);
        let status = agents.lead_status().await.unwrap();
        check(
            "lead",
            json!({ "created": status.created, "name": status.name, "avatar": status.avatar, "route": status.route }),
            &want["lead"],
        );
        check("leadHomeRoute", agents.mixy_home_route().await.unwrap(), &want["leadHomeRoute"]);
        check("mixyExists", json!(agents.mixy_exists().await.unwrap()), &want["mixyExists"]);
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.iter().take(40).cloned().collect::<Vec<_>>().join("\n"));
}

#[tokio::test]
async fn the_task_workspace_is_made_and_named_by_its_real_path() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = AgentDefinitions::new(
        dir.path(),
        dir.path(),
        tokens.interactive_io,
        AgentRoutes::new(config, dir.path()),
        Arc::new(Evidence { greeted: HashMap::new(), chatted: HashMap::new(), owns: false }),
        Arc::new(|| Value::Null),
        dir.path().join("workspace").join("unclassified"),
    );
    let made = agents.task_workspace().await.unwrap();
    assert!(Path::new(&made).is_dir());
    assert!(made.ends_with("unclassified"));
    assert!(!made.starts_with(r"\\?\"));
    assert_eq!(agents.task_workspace().await.unwrap(), made);
}

#[tokio::test]
async fn only_the_shipped_internal_agents_are_hidden() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = AgentDefinitions::new(
        dir.path(),
        dir.path(),
        tokens.interactive_io,
        AgentRoutes::new(config, dir.path()),
        Arc::new(Evidence { greeted: HashMap::new(), chatted: HashMap::new(), owns: false }),
        Arc::new(|| Value::Null),
        dir.path().join("workspace"),
    );
    assert!(agents.hidden_agent(Some("title-agent")));
    assert!(!agents.hidden_agent(Some("worker")));
    assert!(!agents.hidden_agent(Some("")));
    assert!(!agents.hidden_agent(None));
}

struct NoEffects;

#[async_trait]
impl AgentEffects for NoEffects {
    async fn agents_changed(&self) {}
    async fn reload_routines(&self) -> Result<(), String> {
        Ok(())
    }
    async fn set_agent_route(&self, _: &str, _: &Value) -> Result<(), String> {
        Ok(())
    }
}

/// An editor over a fresh data folder whose config file holds `agent`.
async fn writable(agent: Value) -> (tempfile::TempDir, AgentDefinitions) {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": agent })).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = AgentDefinitions::new(
        dir.path().join("shipped"),
        dir.path().join("data"),
        tokens.interactive_io,
        AgentRoutes::new(config, dir.path().join("data")),
        Arc::new(Evidence { greeted: HashMap::new(), chatted: HashMap::new(), owns: false }),
        Arc::new(|| Value::Null),
        dir.path().join("workspace"),
    )
    .with_writes(tokens.durability_io, Arc::new(NoEffects), Arc::new(String::new));
    (dir, agents)
}

#[tokio::test]
async fn the_id_of_an_unnamed_create_is_fixed_before_it_queues() {
    let (_dir, agents) = writable(json!({})).await;
    let payload = json!({ "name": "Concurrent", "body": "Body" }).as_object().unwrap().clone();
    let first = agents.job({ let p = payload.clone(); move |f, l| edit::plan_save(f, l, &p, None) }).await.unwrap().unwrap();
    let second = agents.job({ let p = payload.clone(); move |f, l| edit::plan_save(f, l, &p, None) }).await.unwrap().unwrap();
    // Two creates that are both waiting have not written yet: both name the same id.
    assert_eq!((first.id.as_str(), second.id.as_str()), ("concurrent", "concurrent"));
    agents.save(&payload).await.unwrap();
    // After the first wrote, the one queued behind it still saves to the id it was queued under.
    let queued = agents.job({ let p = payload.clone(); move |f, l| edit::plan_save(f, l, &p, Some("concurrent")) }).await.unwrap().unwrap();
    assert_eq!(queued.id, "concurrent");
    let late = agents.job({ let p = payload.clone(); move |f, l| edit::plan_save(f, l, &p, None) }).await.unwrap().unwrap();
    assert_eq!(late.id, "concurrent-2");
}

#[tokio::test]
async fn the_id_keeps_its_turn_until_the_write_job_has_finished() {
    let (dir, agents) = writable(json!({})).await;
    let data = dir.path().join("data");
    let writes = agents.writes().unwrap();
    let turn = lifecycle(&data, "held").await;
    let probe_data = data.clone();
    let (busy_inside, turn) = agents
        .write_job(&writes, turn, move |_, _| futures::FutureExt::now_or_never(lifecycle(&probe_data, "held")).is_none())
        .await
        .unwrap();
    assert!(busy_inside, "another change of the id started beside the write");
    assert!(futures::FutureExt::now_or_never(lifecycle(&data, "held")).is_none(), "the caller still holds the turn");
    drop(turn);
    assert!(futures::FutureExt::now_or_never(lifecycle(&data, "held")).is_some());
}

#[tokio::test]
async fn hidden_frontmatter_is_written_with_integer_like_keys_first() {
    let (dir, agents) = writable(json!({})).await;
    let folder = dir.path().join("data").join("agents").join("keyed");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("AGENT.md"), "---\nname: Keyed\nzeta: z\n2: two\n1: one\n---\n\nBody\n").unwrap();
    let payload = json!({ "id": "keyed", "name": "Keyed", "body": "Body" }).as_object().unwrap().clone();
    agents.save(&payload).await.unwrap();
    let text = std::fs::read_to_string(folder.join("AGENT.md")).unwrap();
    assert!(text.starts_with("---\n1: one\n2: two\nname: Keyed\nzeta: z\n---"), "{text}");
}

#[tokio::test]
async fn a_config_route_resolves_a_role_alias_and_a_preset_name() {
    let (_dir, agents) = writable(json!({
        "default": "mine",
        "presets": [{ "id": "mine", "provider": "openai", "model": "gpt-x" }],
        "agents": { "maintainer": "mine", "worker": { "provider": "openai", "model": "gpt-y" } },
    }))
    .await;
    let routes = &agents.routes;
    assert_eq!(routes.config_route("maint").unwrap()["model"], "gpt-x");
    assert_eq!(routes.config_route("maintainer").unwrap()["model"], "gpt-x");
    assert_eq!(routes.config_route("Worker").unwrap()["model"], "gpt-y");
    assert_eq!(routes.config_route("ghost"), None);
    assert_eq!(routes.config_route(""), None);
}

#[tokio::test]
async fn the_catalog_shows_the_avatars_of_rows_lead_and_archived_agents() {
    let (dir, agents) = writable(json!({})).await;
    let data = dir.path().join("data");
    let mascot = r##"{"name":"Pal","avatar":{"kind":"mascot","species":"corgi","color":"#5b9bff"}}"##;
    for (rel, text) in [("agents/pal/AGENT.md", "---\nname: Pal\n---\n\nBody\n"), ("agents/pal/agent.json", mascot), ("agents/lead/agent.json", mascot)] {
        let file = data.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }
    let expected = agents.rows().await.unwrap().into_iter().find(|row| row.id == "pal").unwrap().avatar;
    assert_eq!(expected["kind"], "mascot");
    assert_eq!(agents.lead_status().await.unwrap().avatar["kind"], "mascot");
    std::fs::write(data.join("agents/pal").join(DELETED_MARKER), "").unwrap();
    let who = agents.archived_identity("pal").await.unwrap().unwrap();
    assert_eq!((who.name.as_str(), who.avatar["kind"].as_str()), ("Pal", Some("mascot")));
}
