//! `readHomeAgent` against `fixtures/home-agent/golden.json`, recorded from the real Node
//! function over definition files by `record-home-agent.mjs`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use futures::FutureExt;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use serde_json::{Value, json};

use super::HomeAgentKind;
use crate::agents::{AgentDefinitions, AgentEvidence, AgentRoutes};
use mixdog_core_config::config::{Config, ConfigLanes};

// File fixtures through the lane-proofed statefile functions; the test backend runs a lane job inline
// at submit. `unconstrained`: inside a tokio test the handle's oneshot would otherwise answer Pending
// once the task's coop budget is spent.
fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&CancellationToken::new(), job).unwrap())
        .now_or_never()
        .expect("the test backend runs the job inline")
        .unwrap()
}

/// Writes `body`, parent directories made as needed.
fn write(path: &Path, body: &[u8]) {
    let (path, body) = (path.to_owned(), body.to_vec());
    on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default())).unwrap();
}

fn create_dir_all(path: &Path) {
    let path = path.to_owned();
    on_lane(move |lane| mixdog_statefile::create_private_dir_all(lane, &path)).unwrap();
}

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
        write(&file, content.as_str().unwrap().as_bytes());
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
    let golden: Value = serde_json::from_slice(&mixdog_statefile::read_content(&path).unwrap().unwrap()).unwrap();
    let mut failures = Vec::new();
    for world in golden["worlds"].as_array().unwrap() {
        let name = world["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (shipped, data) = (dir.path().join("shipped"), dir.path().join("data"));
        create_dir_all(&shipped);
        create_dir_all(&data);
        write_files(&shipped, &world["shipped"]);
        write_files(&data, &world["data"]);
        let tokens = mixdog_rt::testing::tokens();
        let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
        let config_path = dir.path().join("mixdog-config.json");
        write(&config_path, &serde_json::to_vec(&mixdog_core_config::config::agent_routes::stored_file_of(&json!({}))).unwrap());
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
