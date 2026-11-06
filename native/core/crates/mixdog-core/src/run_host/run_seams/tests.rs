use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::boundary::CompactPolicy;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::{Value, json};

use crate::run_host::run_seams::*;
use mixdog_core_agents::agents::AgentEvidence;
use mixdog_core_config::config::AgentRoutes;
use mixdog_core_config::config::ConfigLanes;

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

async fn seams(stored: Option<Value>, env: HashMap<String, String>) -> (tempfile::TempDir, ConfigRunSeams) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");
    if let Some(stored) = stored {
        crate::run_host::fixture_fs::write(&path, serde_json::to_vec(&stored).unwrap());
    }
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let agents = AgentDefinitions::new(
        dir.path(),
        dir.path(),
        tokens.interactive_io,
        AgentRoutes::new(config.clone(), dir.path()),
        Arc::new(NoEvidence),
        Arc::new(|| Value::Null),
        dir.path().join("workspace"),
    );
    let env: EnvReader = Arc::new(move |name| env.get(name).cloned());
    let seams = ConfigRunSeams::new(config, agents, dir.path().to_path_buf(), dir.path().to_path_buf(), env);
    (dir, seams)
}

fn header(value: Value) -> Header {
    value.as_object().unwrap().clone()
}

#[tokio::test]
async fn the_compaction_settings_resolve_what_the_recorded_node_policy_resolved() {
    let twin: Value = serde_json::from_str(include_str!("../../../../../fixtures/desktop/settings/run-compact-twin.json")).unwrap();
    let mut differ = Vec::new();
    for (index, entry) in twin["entries"].as_array().unwrap().iter().enumerate() {
        let config = entry["config"].as_object().unwrap();
        let stored = (!config.is_empty()).then(|| json!({ "agent": config }));
        let env = entry["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        let (_dir, seams) = seams(stored, env).await;
        let settings = seams.run_settings(&ThreadId::from("t"), &header(entry["session"].clone())).compact.unwrap();
        let policy = CompactPolicy::resolve(&settings);
        let want = &entry["policy"];
        let got = match &policy {
            None if !settings.auto => json!({ "auto": false }),
            None => Value::Null,
            Some(p) => json!({
                "auto": true, "boundaryTokens": p.boundary_tokens, "triggerTokens": p.trigger_tokens,
                "compactTargetTokens": p.target_tokens, "singleShot": p.single_shot, "contextWindow": p.context_window,
                "reserveTokens": p.reserve_tokens, "configuredReserveTokens": p.configured_reserve_tokens,
                "tokenCalibration": p.token_calibration,
            }),
        };
        let mut expected = want.clone();
        if let Some(object) = expected.as_object_mut() {
            // Node's JSON writes the neutral factor as `1`; the Rust side holds a float.
            if let Some(factor) = object.get("tokenCalibration").and_then(Value::as_f64) {
                object.insert("tokenCalibration".into(), json!(factor));
            }
        }
        if got != expected {
            differ.push(format!("case {index}: {} -> Rust {got}, Node {expected}", entry["session"]));
        }
    }
    assert!(differ.is_empty(), "{} differ:\n{}", differ.len(), differ.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

#[tokio::test]
async fn the_other_seams_answer_from_the_config_and_the_agent_store() {
    let stored = json!({ "agent": { "instructionFiles": "claude", "profile": { "language": "ko" } } });
    let (_dir, seams) = seams(Some(stored), HashMap::new()).await;
    assert_eq!(seams.stored_instruction_files(), Some(json!("claude")));
    assert!(seams.hidden_agent(Some("title-agent")));
    assert!(!seams.hidden_agent(Some("worker")) && !seams.hidden_agent(None));
    let (id, name) = seams.response_language().unwrap();
    assert_eq!(id, "ko");
    assert!(!name.is_empty());

    let thread = ThreadId::from("t");
    let cursor = seams.run_settings(&thread, &header(json!({ "agent": "title-agent", "provider": "cursor-api", "sessionMode": "agent" })));
    assert!(cursor.hidden_agent && cursor.agent_mode && cursor.read_body_required);
    let plain = seams.run_settings(&thread, &header(json!({ "agent": "lead", "provider": "openai", "id": "sess_plain" })));
    assert!(!plain.hidden_agent && !plain.agent_mode && !plain.read_body_required);
    assert!(plain.effort.is_none() && plain.limits.is_none() && plain.text_only.is_none());
}
