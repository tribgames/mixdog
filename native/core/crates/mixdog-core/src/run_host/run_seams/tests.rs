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
        crate::run_host::fixture_fs::write_unsynced(&path, serde_json::to_vec(&stored).unwrap());
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
    let seams = ConfigRunSeams::new(config, Arc::new(agents), dir.path().to_path_buf(), dir.path().to_path_buf(), env);
    (dir, seams)
}

fn header(value: Value) -> Header {
    value.as_object().unwrap().clone()
}

const COMPACT_TWIN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/desktop/settings/run-compact-twin.json");
/// Entries per test: each recorded entry builds its own config, agent store and directory, so the replay is split into chunks nextest runs in parallel.
const COMPACT_CHUNK: usize = 30;

async fn compaction_chunk(chunk: usize) {
    let twin: Value = serde_json::from_str(&COMPACT_TWIN).unwrap();
    let mut differ = Vec::new();
    let mut ran = 0;
    for (index, entry) in twin["entries"].as_array().unwrap().iter().enumerate().skip(chunk * COMPACT_CHUNK).take(COMPACT_CHUNK) {
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
        ran += 1;
        if got != expected {
            differ.push(format!("case {index}: {} -> Rust {got}, Node {expected}", entry["session"]));
        }
    }
    assert!(ran > 0, "compaction chunk {chunk} has no recorded entry");
    assert!(differ.is_empty(), "{} differ:\n{}", differ.len(), differ.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}


mixdog_rt::replay_chunks!(COMPACT_TESTS, #[tokio::test] async compaction_chunk; [
    the_compaction_settings_resolve_chunk_00 = 0,
    the_compaction_settings_resolve_chunk_01 = 1,
    the_compaction_settings_resolve_chunk_02 = 2,
    the_compaction_settings_resolve_chunk_03 = 3,
    the_compaction_settings_resolve_chunk_04 = 4,
    the_compaction_settings_resolve_chunk_05 = 5,
    the_compaction_settings_resolve_chunk_06 = 6,
    the_compaction_settings_resolve_chunk_07 = 7,
    the_compaction_settings_resolve_chunk_08 = 8,
    the_compaction_settings_resolve_chunk_09 = 9,
    the_compaction_settings_resolve_chunk_10 = 10,
    the_compaction_settings_resolve_chunk_11 = 11,
    the_compaction_settings_resolve_chunk_12 = 12,
    the_compaction_settings_resolve_chunk_13 = 13,
    the_compaction_settings_resolve_chunk_14 = 14,
    the_compaction_settings_resolve_chunk_15 = 15,
    the_compaction_settings_resolve_chunk_16 = 16,
    the_compaction_settings_resolve_chunk_17 = 17,
    the_compaction_settings_resolve_chunk_18 = 18,
    the_compaction_settings_resolve_chunk_19 = 19,
    the_compaction_settings_resolve_chunk_20 = 20,
    the_compaction_settings_resolve_chunk_21 = 21,
    the_compaction_settings_resolve_chunk_22 = 22,
    the_compaction_settings_resolve_chunk_23 = 23,
    the_compaction_settings_resolve_chunk_24 = 24,
    the_compaction_settings_resolve_chunk_25 = 25,
    the_compaction_settings_resolve_chunk_26 = 26,
    the_compaction_settings_resolve_chunk_27 = 27,
    the_compaction_settings_resolve_chunk_28 = 28,
    the_compaction_settings_resolve_chunk_29 = 29,
]);

/// Every recorded entry belongs to one chunk test and every chunk test has recorded entries.
#[test]
fn every_recorded_compaction_entry_has_its_chunk_test() {
    let twin: Value = serde_json::from_str(&COMPACT_TWIN).unwrap();
    mixdog_rt::testing::assert_chunks_registered(COMPACT_TESTS, twin["entries"].as_array().unwrap().len(), COMPACT_CHUNK);
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

/// Node's full config always has a `compaction` section (`config.mjs:367`, `{}`), so a stored config without one still seeds the
/// installed session from the empty section: `onModelChange` and `summaryMode` appear, the resolved buffer keys go
/// (`stored-header` of every `real-turn-harness` scenario).
#[tokio::test]
async fn an_installed_session_follows_the_empty_compaction_section_of_a_config_without_one() {
    let (_dir, seams) = seams(Some(json!({ "agent": {} })), HashMap::new()).await;
    let header = header(json!({ "compaction": { "auto": true, "bufferTokens": 0, "bufferRatio": 0, "lastStage": "pre_send_check" } }));
    let got = seams.synced_compaction(&header, true).expect("the session follows the empty section");
    assert_eq!(got, json!({ "auto": true, "lastStage": "pre_send_check", "onModelChange": true, "summaryMode": "smart" }));
}
/// A session is installed on the saved compaction settings unless the caller injected its own configuration:
/// the recorded `install` cases (`fixtures/agent/compact/record_usage.mjs`, Node's `usesInjectedConfig` gate).
#[tokio::test]
async fn an_installed_session_follows_the_saved_compaction_unless_the_config_is_injected() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent/compact/golden/usage.json")).unwrap();
    let mut seen = 0;
    for case in golden["cases"].as_array().unwrap().iter().filter(|case| case["op"] == "install") {
        let stored = json!({ "agent": { "compaction": case["args"]["config"]["compaction"].clone() } });
        let (_dir, seams) = seams(Some(stored), HashMap::new()).await;
        let injected = case["args"]["params"]["initialConfig"].is_object();
        let seams = seams.with_injected_config(injected);
        let header = header(case["header"].clone());
        let name = case["name"].as_str().unwrap();
        let got = seams.synced_compaction(&header, true).unwrap_or_else(|| header["compaction"].clone());
        assert_eq!(got, case["after"]["compaction"], "{name}");
        seen += 1;
    }
    assert_eq!(seen, 3);
}
