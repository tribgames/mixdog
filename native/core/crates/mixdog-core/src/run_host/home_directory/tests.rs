//! The delivery's definitions over real definition files: the facts the agent definitions answer
//! (their own golden tests hold Node's answers) arrive in the delivery's terms.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::agents::{AgentDefinitions, AgentEvidence};
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::{AgentRoutes, Config, ConfigLanes};
use mixdog_services::bots::delivery::env::{HomeAgent, HomeDirectory, Presence};
use serde_json::{Value, json};

use super::DefinitionsDirectory;

struct NoEvidence;

#[async_trait]
impl AgentEvidence for NoEvidence {
    async fn home_greeted(&self, _: &str) -> bool {
        false
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

fn write(path: std::path::PathBuf, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

async fn directory(dir: &std::path::Path) -> DefinitionsDirectory {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let config_path = dir.join("mixdog-config.json");
    std::fs::write(&config_path, serde_json::to_vec(&json!({ "agent": {} })).unwrap()).unwrap();
    let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let (shipped, data) = (dir.join("shipped"), dir.join("data"));
    let agents = AgentDefinitions::new(&shipped, &data, tokens.interactive_io, AgentRoutes::new(config, &data), Arc::new(NoEvidence), Arc::new(|| Value::Null), dir.join("task"));
    DefinitionsDirectory::new(Arc::new(agents))
}

#[tokio::test]
async fn tells_a_bot_from_a_workflow_agent_a_deleted_agent_from_a_missing_one_and_no_room_from_any() {
    let dir = tempfile::tempdir().unwrap();
    let (shipped, data) = (dir.path().join("shipped"), dir.path().join("data"));
    write(shipped.join("agents/reviewer/AGENT.md"), "---\nkind: agent\n---\nReview.\n");
    write(data.join("agents/robo/AGENT.md"), "---\nkind: bot\n---\nHelp.\n");
    write(data.join("agents/gone/.deleted"), "");
    let directory = directory(dir.path()).await;

    assert_eq!(directory.home_agent("robo").await, HomeAgent::Bot);
    assert_eq!(directory.home_agent("reviewer").await, HomeAgent::None);
    assert_eq!(directory.home_agent("ghost").await, HomeAgent::Unknown);

    assert_eq!(directory.agent_presence("robo").await, Presence::Present);
    assert_eq!(directory.agent_presence("gone").await, Presence::Deleted);
    assert_eq!(directory.agent_presence("ghost").await, Presence::Deleted, "no folder and no shipped copy: proven gone");
    assert_eq!(directory.room_presence("room01").await, Presence::Unknown);
}

#[tokio::test]
async fn mixy_exists_follows_the_one_rule() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    write(data.join("agents/lead/agent.json"), r#"{"created":false}"#);
    assert!(!directory(dir.path()).await.mixy_exists().await, "`created: false` is no");
    write(data.join("agents/lead/agent.json"), r#"{"name":"Aria"}"#);
    assert!(directory(dir.path()).await.mixy_exists().await, "a name is yes");
}
