//! `readHomeAgent` against `fixtures/home-agent/golden.json`, recorded from the real Node
//! function over definition files by `record-home-agent.mjs`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::{Value, json};

use super::HomeAgentKind;
use crate::agents::{AgentDefinitions, AgentEvidence, AgentRoutes};
use mixdog_core_config::config::{Config, ConfigLanes};

/// The home-thread evidence the recorder measured; nothing else is asked of the sessions.
struct Evidence(HashMap<String, bool>);

#[async_trait]
impl AgentEvidence for Evidence {
    async fn home_greeted(&self, agent_id: &str) -> bool {
        self.0.get(agent_id).copied().unwrap_or(false)
    }
    async fn home_chatted(&self, _: &str) -> bool {
        false
    }
    async fn mixy_owns_routines(&self) -> Result<bool, String> {
        Ok(false)
    }
}

fn write_files(base: &Path, files: &Value) {
    for (rel, content) in files.as_object().unwrap() {
        let file = base.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content.as_str().unwrap()).unwrap();
    }
}

fn text(kind: HomeAgentKind) -> &'static str {
    match kind {
        HomeAgentKind::Bot => "bot",
        HomeAgentKind::None => "none",
        HomeAgentKind::Unknown => "unknown",
    }
}

#[tokio::test]
async fn answers_what_the_node_function_answered_over_each_recorded_world() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/home-agent/golden.json");
    let golden: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    for world in golden["worlds"].as_array().unwrap() {
        let name = world["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (shipped, data) = (dir.path().join("shipped"), dir.path().join("data"));
        std::fs::create_dir_all(&shipped).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        write_files(&shipped, &world["shipped"]);
        write_files(&data, &world["data"]);
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let config_path = dir.path().join("mixdog-config.json");
        std::fs::write(&config_path, serde_json::to_vec(&json!({ "agent": {} })).unwrap()).unwrap();
        let (config, _) = Config::open(config_path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        let greeted = world["greeted"].as_object().unwrap().iter().map(|(id, v)| (id.clone(), v.as_bool().unwrap())).collect();
        let agents = AgentDefinitions::new(
            &shipped,
            &data,
            tokens.interactive_io,
            AgentRoutes::new(config, &data),
            Arc::new(Evidence(greeted)),
            Arc::new(|| Value::Null),
            dir.path().join("task"),
        );
        for (id, want) in world["answers"].as_object().unwrap() {
            let got = text(agents.home_agent(id).await.unwrap());
            if Some(got) != want.as_str() {
                failures.push(format!("{name} {id:?}: {got} != {want}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
