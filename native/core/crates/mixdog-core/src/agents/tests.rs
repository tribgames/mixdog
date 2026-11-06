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
            let node = want["archived"][id].as_str().unwrap_or_default();
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
                    "kind": row.kind, "disabled": row.disabled, "hasDefinition": row.definition.is_some(),
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
            archived.insert(id.clone(), json!(agents.archived_name(id).await.unwrap()));
        }
        check("archived", Value::Object(archived), &want["archived"]);
        let status = agents.lead_status().await.unwrap();
        check(
            "lead",
            json!({ "created": status.created, "name": status.name, "route": status.route }),
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
