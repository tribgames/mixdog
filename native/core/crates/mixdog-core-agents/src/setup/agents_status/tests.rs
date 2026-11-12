//! The `agents` status reader against the answers of Node's real setup executor
//! (`fixtures/desktop/settings/agents-status-twin.json`, from
//! `benchmarks/rust-core/recorders/record-agents-status.mjs`): each case is one recorded
//! agent-definition world (`agent-definitions-twin.json`: files in, catalog out), with the
//! orchestration mode and bot order the runtime answered, and the executor's whole text. The
//! text is compared with its keys in order. The mode, the bot order and the held sessions come
//! through the seams the reader is given, so they are checked as placed, not as computed.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use futures::FutureExt as _;
use mixdog_core_api::CoreError;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken as _;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::agents::AgentEvidence;

const STATUS: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/desktop/settings/agents-status-twin.json");
const WORLDS: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/desktop/settings/agent-definitions-twin.json");

fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    tokio::task::unconstrained(mixdog_rt::testing::tokens().durability_io.submit(&CancellationToken::new(), job).unwrap())
        .now_or_never()
        .expect("the test backend runs the job inline")
        .unwrap()
}

/// `fs.writeFileSync` through the statefile publication.
fn write(path: &Path, body: &[u8]) {
    let (path, body) = (path.to_owned(), body.to_vec());
    on_lane(move |lane| mixdog_statefile::write_file(lane, &path, &body, &mixdog_statefile::Opts::default()).map(drop)).unwrap();
}

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

/// One recorded world opened as the loader reads it.
async fn open_world(world: &Value) -> (tempfile::TempDir, AgentDefinitions) {
    let dir = tempfile::tempdir().unwrap();
    let (shipped, data) = (dir.path().join("shipped"), dir.path().join("data"));
    for (base, files) in [(&shipped, &world["shipped"]), (&data, &world["data"])] {
        for (rel, content) in files.as_object().unwrap() {
            write(&base.join(rel), content.as_str().unwrap().as_bytes());
        }
    }
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let config_path = dir.path().join("mixdog-config.json");
    write(&config_path, &serde_json::to_vec(&mixdog_core_config::config::agent_routes::stored_file_of(&world["config"])).unwrap());
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

/// The config service as the reader asks it: the calling thread's mode, the shared bot order.
struct ConfigService {
    mode: String,
    order: Value,
}

#[async_trait]
impl DomainCalls for ConfigService {
    async fn call(&self, method: &'static str, params: Value) -> Result<Value, CoreError> {
        match method {
            "config/getOrchestrationMode" => {
                assert_eq!(params, json!({ "threadId": "sess_a" }));
                Ok(json!(self.mode))
            }
            "config/getBotOrder" => Ok(json!({ "order": self.order })),
            other => panic!("unexpected domain call {other}"),
        }
    }
}

struct Held(Vec<Value>);

#[async_trait]
impl RoutePositions for Held {
    async fn others(&self, caller: &ThreadId) -> Result<Vec<Value>, PortError> {
        assert_eq!(caller.as_str(), "sess_a");
        Ok(self.0.clone())
    }
}

async fn status_of(agents: Arc<AgentDefinitions>, mode: &str, order: &Value, held: Vec<Value>, detail: bool) -> Value {
    let reader = AgentsStatus::new(agents, Arc::new(ConfigService { mode: mode.to_owned(), order: order.clone() }), Arc::new(Held(held)));
    let body = reader.read("agents", detail, &ThreadId::from("sess_a")).await.unwrap();
    // `{ domain, ...status }`, as the dispatcher builds it.
    let mut out = Map::new();
    out.insert("domain".into(), json!("agents"));
    out.extend(body.as_object().unwrap().clone());
    Value::Object(out)
}

/// Recorded cases per test: each opens its own world.
const CASE_CHUNK: usize = 5;

mixdog_rt::replay_chunks!(STATUS_TESTS, #[tokio::test] async the_agents_status_chunk; [
    the_agents_status_equals_what_the_recorded_node_executor_answered_00 = 0,
    the_agents_status_equals_what_the_recorded_node_executor_answered_01 = 1,
    the_agents_status_equals_what_the_recorded_node_executor_answered_02 = 2,
    the_agents_status_equals_what_the_recorded_node_executor_answered_03 = 3,
    the_agents_status_equals_what_the_recorded_node_executor_answered_04 = 4,
    the_agents_status_equals_what_the_recorded_node_executor_answered_05 = 5,
    the_agents_status_equals_what_the_recorded_node_executor_answered_06 = 6,
    the_agents_status_equals_what_the_recorded_node_executor_answered_07 = 7,
    the_agents_status_equals_what_the_recorded_node_executor_answered_08 = 8,
    the_agents_status_equals_what_the_recorded_node_executor_answered_09 = 9,
    the_agents_status_equals_what_the_recorded_node_executor_answered_10 = 10,
    the_agents_status_equals_what_the_recorded_node_executor_answered_11 = 11,
    the_agents_status_equals_what_the_recorded_node_executor_answered_12 = 12,
    the_agents_status_equals_what_the_recorded_node_executor_answered_13 = 13,
    the_agents_status_equals_what_the_recorded_node_executor_answered_14 = 14,
    the_agents_status_equals_what_the_recorded_node_executor_answered_15 = 15,
]);

#[test]
fn every_recorded_case_has_its_status_test() {
    let twin: Value = serde_json::from_str(&STATUS).unwrap();
    let cases = twin["cases"].as_array().unwrap();
    assert!(cases.len() >= 80);
    mixdog_rt::testing::assert_chunks_registered(STATUS_TESTS, cases.len(), CASE_CHUNK);
}

async fn the_agents_status_chunk(chunk: usize) {
    let twin: Value = serde_json::from_str(&STATUS).unwrap();
    let worlds: Value = serde_json::from_str(&WORLDS).unwrap();
    let by_name: HashMap<&str, &Value> = worlds["worlds"].as_array().unwrap().iter().map(|w| (w["name"].as_str().unwrap(), w)).collect();
    let mut failures = Vec::new();
    let cases = twin["cases"].as_array().unwrap();
    for case in &cases[mixdog_rt::testing::chunk_range(cases.len(), chunk, CASE_CHUNK)] {
        let name = case["world"].as_str().unwrap();
        let (_dir, agents) = open_world(by_name[name]).await;
        let got = status_of(Arc::new(agents), case["mode"].as_str().unwrap(), &case["botOrder"], Vec::new(), case["detail"].as_bool().unwrap()).await;
        // Node's text, parsed and printed again: both sides print through the same writer, so
        // the comparison is of keys in order and values.
        let want: Value = serde_json::from_str(case["text"].as_str().unwrap()).unwrap();
        if got.to_string() != want.to_string() {
            failures.push(format!("{name}: {got} != {want}"));
        }
    }
    assert!(failures.is_empty(), "{} differ:\n{}", failures.len(), failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n"));
}

/// The held sessions come last, whole and in the order the route owner gave them.
#[tokio::test]
async fn the_held_sessions_are_printed_last_as_given() {
    let twin: Value = serde_json::from_str(&STATUS).unwrap();
    let worlds: Value = serde_json::from_str(&WORLDS).unwrap();
    let case = &twin["cases"][0];
    let world = worlds["worlds"].as_array().unwrap().iter().find(|w| w["name"] == case["world"]).unwrap();
    let (_dir, agents) = open_world(world).await;
    let held = vec![json!({ "sessionId": "sess_b", "kind": "bot" }), json!({ "sessionId": "sess_c", "kind": "agent" })];
    let got = status_of(Arc::new(agents), "balanced", &json!(["a"]), held.clone(), false).await;
    let keys: Vec<&String> = got.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["domain", "agents", "orchestrationMode", "orchestrationModes", "botOrder", "sessions"]);
    assert_eq!(got["sessions"], json!(held));
    assert_eq!(got["orchestrationModes"], json!(["none", "focused", "balanced", "swarm"]));
    assert_eq!(got["botOrder"], json!(["a"]));
}