use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::config::ConfigLanes;

fn route(model: &str) -> Value {
    json!({ "provider": "openai", "model": model })
}

async fn routes(dir: &tempfile::TempDir, agent: Value, split: bool) -> AgentRoutes {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "defaultsVersion": 2, "agent": agent, "desktop": { "zoom": 1 } })).unwrap()).unwrap();
    if split {
        let bots = dir.path().join("bots");
        std::fs::create_dir_all(bots.join("ada")).unwrap();
        std::fs::write(bots.join("migration.json"), r#"{"version":1,"bots":["moved"]}"#).unwrap();
    }
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    AgentRoutes::new(config, dir.path())
}

fn bot_file(dir: &tempfile::TempDir, bot: &str) -> Value {
    let text = std::fs::read(dir.path().join("bots").join(bot).join("agent.json")).unwrap();
    serde_json::from_slice(&text).unwrap()
}

#[tokio::test]
async fn homes_follow_the_store_rules() {
    let dir = tempfile::tempdir().unwrap();
    let routes = routes(&dir, json!({}), true).await;
    assert_eq!(routes.home("lead").await.unwrap(), RouteHome::Mixy);
    assert_eq!(routes.home("ada").await.unwrap(), RouteHome::StoreBot);
    assert_eq!(routes.home("moved").await.unwrap(), RouteHome::StoreBot);
    assert_eq!(routes.home("mixy").await.unwrap(), RouteHome::Config);
    assert_eq!(routes.home(".hidden").await.unwrap(), RouteHome::Config);
    assert_eq!(routes.home("worker").await.unwrap(), RouteHome::Config);
    let before_split = tempfile::tempdir().unwrap();
    let routes = self::routes(&before_split, json!({}), false).await;
    assert_eq!(routes.home("ada").await.unwrap(), RouteHome::Config);
}

#[tokio::test]
async fn a_config_agent_keeps_its_route_and_off_state_apart() {
    let dir = tempfile::tempdir().unwrap();
    let routes = routes(&dir, json!({ "default": "p", "agents": { "bad": { "provider": "x" } } }), false).await;
    assert_eq!(routes.own_route("worker").await.unwrap(), json!({}));
    routes.save_route("worker", route("a"), true).await.unwrap();
    assert!(routes.is_disabled("Worker"));
    assert_eq!(routes.own_route("worker").await.unwrap(), route("a"));
    // The incomplete route and the other sections of the file are handled as Node does.
    let agent = routes.config.agent();
    assert_eq!(agent["agents"], json!({ "worker": route("a") }));
    // `worker` is off by default, so a file that keeps it off stores nothing for it.
    assert!(agent.get("disabledAgents").is_none() && agent.get("enabledAgents").is_none());
    assert_eq!(routes.config.get("desktop").unwrap(), json!({ "zoom": 1 }));
    routes.set_disabled("worker", false).await.unwrap();
    assert!(!routes.is_disabled("worker"));
    assert!(routes.config.agent().get("disabledAgents").is_none());
    assert_eq!(routes.own_route("worker").await.unwrap(), route("a"));
    routes.clear_route("worker").await.unwrap();
    assert_eq!(routes.own_route("worker").await.unwrap(), json!({}));
}

#[tokio::test]
async fn store_bots_and_mixy_write_their_own_folder() {
    let dir = tempfile::tempdir().unwrap();
    let routes = routes(&dir, json!({ "agents": { "lead": route("main") } }), true).await;
    std::fs::write(dir.path().join("bots/ada/agent.json"), r#"{"name":"Ada","route":{"provider":"x"}}"#).unwrap();
    assert_eq!(routes.own_route("ada").await.unwrap(), json!({}), "an incomplete route reads as none");
    routes.save_route("ada", route("b"), true).await.unwrap();
    assert_eq!(bot_file(&dir, "ada"), json!({ "name": "Ada", "route": route("b") }));
    assert!(routes.is_disabled("ada"));
    assert!(routes.config.agent()["agents"].as_object().unwrap().get("ada").is_none());
    // Mixy: its own folder, never the Lead's config route, and never switched off.
    routes.save_route("lead", route("m"), true).await.unwrap();
    assert_eq!(bot_file(&dir, "mixy"), json!({ "route": route("m") }));
    assert!(!routes.is_disabled("lead"));
    assert_eq!(routes.own_route("lead").await.unwrap(), route("m"));
    assert_eq!(routes.config.agent()["agents"]["lead"], route("main"));
    routes.clear_route("lead").await.unwrap();
    assert_eq!(bot_file(&dir, "mixy"), json!({}));
    assert_eq!(routes.own_route("lead").await.unwrap(), json!({}));
    // The previous content stays as the last good copy.
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(dir.path().join("bots/mixy/agent.json.bak")).unwrap()).unwrap(),
        json!({ "route": route("m") })
    );
}

#[tokio::test]
async fn a_damaged_bot_file_reads_from_its_last_good_copy() {
    let dir = tempfile::tempdir().unwrap();
    let routes = routes(&dir, json!({}), true).await;
    routes.save_route("ada", route("b"), false).await.unwrap();
    routes.save_route("ada", route("c"), false).await.unwrap();
    std::fs::write(dir.path().join("bots/ada/agent.json"), b"\0\0").unwrap();
    assert_eq!(routes.own_route("ada").await.unwrap(), route("b"));
}

async fn routes_of(dir: &tempfile::TempDir, root: Value) -> AgentRoutes {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&root).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    AgentRoutes::new(config, dir.path())
}

fn ids(value: &Value) -> Vec<&str> {
    value.as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect()
}

/// A separated file stores the roster as the user's delta against the defaults: `disabledAgents` lists what
/// the user turned off beyond them, `enabledAgents` the default-off agents they turned on.
#[tokio::test]
async fn a_separated_file_holds_the_roster_as_a_delta() {
    let dir = tempfile::tempdir().unwrap();
    let routes = routes_of(&dir, json!({ "defaultsVersion": 2, "agent": { "enabledAgents": ["worker"], "disabledAgents": ["custom"] } })).await;
    assert!(!routes.is_disabled("worker") && routes.is_disabled("reviewer") && routes.is_disabled("custom") && !routes.is_disabled("other"));
    routes.set_disabled("custom", false).await.unwrap();
    routes.set_disabled("reviewer", false).await.unwrap();
    let agent = routes.config.agent();
    assert_eq!(ids(&agent["enabledAgents"]), ["reviewer", "worker"]);
    assert!(agent.get("disabledAgents").is_none());
    routes.set_disabled("worker", true).await.unwrap();
    routes.set_disabled("reviewer", true).await.unwrap();
    let agent = routes.config.agent();
    assert!(agent.get("enabledAgents").is_none() && agent.get("disabledAgents").is_none(), "the defaults alone are stored as nothing");
}

/// The explorer, maintainer and title hosts ask `agent_disabled` of the agent section they are
/// handed; it is the stored section, read as `effectiveDisabledAgents` reads it.
#[test]
fn a_stored_section_reads_as_the_effective_roster() {
    let section = json!({ "enabledAgents": ["maintainer"], "disabledAgents": ["Custom"] });
    let agent = section.as_object().unwrap();
    assert!(!agent_disabled(agent, " Maintainer ") && !agent_disabled(agent, "other"));
    assert!(agent_disabled(agent, "explore") && agent_disabled(agent, "worker") && agent_disabled(agent, "custom"));
    assert!(agent_disabled(&Map::new(), "maintainer"), "a section that says nothing keeps the default roster off");
}

#[test]
fn ids_normalise_like_node() {
    assert_eq!(agent_id_key("  Front_Worker x "), "front-worker-x");
    assert_eq!(agent_id_key("a__ b"), "a-b");
}

/// Mixy's manifest Node saved with a name a phone sent cut inside an emoji
/// (`native/core/fixtures/lone-surrogate-files`, record-lone-surrogate-files.mjs): the display name is Node's
/// `mixyDisplayName()` (the half emoji as U+FFFD), not the default a failed read gives.
#[tokio::test]
async fn a_mixy_name_node_saved_with_half_an_emoji_is_the_display_name() {
    let set = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lone-surrogate-files");
    let cases: Value = serde_json::from_slice(&std::fs::read(set.join("cases.json")).unwrap()).unwrap();
    let case = cases.as_array().unwrap().iter().find(|c| c["name"] == "mixy-identity").unwrap().clone();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    std::fs::create_dir_all(data.join("agents/lead")).unwrap();
    std::fs::copy(set.join("mixy-identity/before/agents/lead/agent.json"), data.join("agents/lead/agent.json")).unwrap();
    let name = super::on_lane(mixdog_rt::testing::tokens().interactive_io, move |lane| mixy_display_name(lane, &data)).await.unwrap();
    assert_eq!(name, case["nodeRead"]["mixyDisplayName"].as_str().unwrap());
}
