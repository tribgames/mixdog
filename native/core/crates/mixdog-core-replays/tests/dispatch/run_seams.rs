use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::boundary::CompactPolicy;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::{Value, json};

use mixdog_core::run_host::run_seams::*;
use mixdog_core::run_host::host_seams::ConfigSeams as _;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_config::config::Config;
use mixdog_store::schema::record::Header;
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

pub(super) async fn seams(stored: Option<Value>, env: HashMap<String, String>) -> (tempfile::TempDir, ConfigRunSeams) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mixdog-config.json");
    if let Some(stored) = stored {
        mixdog_core::run_host::fixture_fs::write_unsynced(&path, serde_json::to_vec(&stored).unwrap());
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
/// Entries per test: each recorded entry builds its own config, agent store and directory, so the replay is split into chunks nextest runs in parallel.
#[cfg(node_twin)]
const COMPACT_CHUNK: usize = 30;

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

/// With automatic compaction off the loop has no policy, yet the session's window is stated: a manual or scheduled pass
/// resolves it with `auto` forced on (`resolveSessionCompactionPolicy`, `compaction-runner.mjs`).
#[tokio::test]
async fn automatic_compaction_off_still_states_the_window_a_manual_pass_resolves() {
    let (_dir, seams) = seams(Some(json!({ "agent": { "compaction": { "auto": false } } })), HashMap::new()).await;
    let settings = seams.run_settings(&ThreadId::from("t"), &header(json!({ "contextWindow": 30000 }))).compact.unwrap();
    assert!(!settings.auto);
    assert!(CompactPolicy::resolve(&settings).is_none(), "the loop does not compact");
    let forced = CompactPolicy::resolve(&mixdog_agent::boundary::CompactSettings { auto: true, ..settings }).expect("a manual pass has a boundary");
    assert_eq!((forced.boundary_tokens, forced.context_window), (30000, Some(30000)));
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
/// A session resumed after the auto-clear changed takes the cache policy the saved auto-clear derives (`refreshSessionProviderCacheOpts`
/// on resume): off, or an idle window of an hour or more, is a 1h message tail; a shorter window 5m; a session with its own policy keeps it.
#[tokio::test]
async fn a_resumed_lead_session_takes_the_cache_ttl_of_the_saved_auto_clear() {
    let held = json!({ "cacheStrategy": { "tools": "none", "system": "1h", "tier3": "1h", "messages": "5m" } });
    let lead = header(json!({ "id": "sess_1", "provider": "anthropic-oauth", "providerCacheOpts": held, "providerCacheOptsOverride": false }));
    let messages = |opts: Option<Value>| opts.map(|opts| opts["cacheStrategy"]["messages"].clone());
    // `MIXDOG_CACHE_MESSAGES_TTL` overrides the saved window for every session with a tail, and a machine may set it: then the tail
    // is the override whatever the window, and a header already on it is left alone.
    let forced = std::env::var("MIXDOG_CACHE_MESSAGES_TTL").unwrap_or_default();
    let forced = Some(forced.trim()).filter(|ttl| matches!(*ttl, "1h" | "5m" | "none"));
    for (auto_clear, saved) in [
        (json!({ "enabled": false }), "1h"),
        (json!({ "enabled": true, "idleMs": 3_600_000 }), "1h"),
        (json!({ "enabled": true, "idleMs": 600_000 }), "5m"),
    ] {
        let tail = forced.unwrap_or(saved);
        let want = (tail != "5m").then(|| json!(tail));
        let (_dir, seams) = seams(Some(json!({ "agent": { "autoClear": auto_clear } })), HashMap::new()).await;
        assert_eq!(messages(seams.synced_cache_opts(&lead)), want, "{auto_clear}");
        let mut own = lead.clone();
        own.insert("providerCacheOptsOverride".into(), json!(true));
        assert_eq!(seams.synced_cache_opts(&own), None, "an explicit policy is kept");
    }
}


#[cfg(node_twin)]
const COMPACT_TWIN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/desktop/settings/run-compact-twin.json");
#[cfg(node_twin)]
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
#[cfg(node_twin)]
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
#[cfg(node_twin)]
fn every_recorded_compaction_entry_has_its_chunk_test() {
    let twin: Value = serde_json::from_str(&COMPACT_TWIN).unwrap();
    mixdog_rt::testing::assert_chunks_registered(COMPACT_TESTS, twin["entries"].as_array().unwrap().len(), COMPACT_CHUNK);
}
/// A session is installed on the saved compaction settings unless the caller injected its own configuration:
/// the recorded `install` cases (`fixtures/agent/compact/record_usage.mjs`, Node's `usesInjectedConfig` gate).
#[tokio::test]
#[cfg(node_twin)]
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

async fn compact_of(session: Value, env: &[(&str, &str)]) -> mixdog_agent::boundary::CompactSettings {
    let env = env.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect();
    let (_dir, seams) = seams(None, env).await;
    seams.run_settings(&ThreadId::from("t"), &header(session)).compact.expect("a run states its compaction settings")
}

#[tokio::test]
async fn a_session_with_a_window_compacts_at_that_window_and_aims_for_a_quarter_of_it() {
    let settings = compact_of(json!({ "provider": "anthropic", "contextWindow": 200_000, "owner": "user" }), &[]).await;
    assert!(settings.auto);
    assert_eq!((settings.context_window, settings.buffer_tokens, settings.configured_reserve_tokens), (Some(200_000), 0, 0));
    let policy = CompactPolicy::resolve(&settings).expect("a window gives a boundary");
    assert_eq!((policy.boundary_tokens, policy.target_tokens), (200_000, 50_000));
}

#[tokio::test]
async fn the_environment_switch_turns_automatic_compaction_off_and_only_a_known_word_counts() {
    let session = json!({ "provider": "anthropic", "contextWindow": 200_000 });
    for word in ["off", "0", "false", "no", " OFF "] {
        let settings = compact_of(session.clone(), &[("MIXDOG_AGENT_COMPACT_AUTO", word)]).await;
        assert!(!settings.auto && CompactPolicy::resolve(&settings).is_none(), "{word:?} turns it off");
    }
    for word in ["on", "1", "maybe", ""] {
        assert!(compact_of(session.clone(), &[("MIXDOG_AGENT_COMPACT_AUTO", word)]).await.auto, "{word:?} leaves it on");
    }
}

#[tokio::test]
async fn a_session_that_switched_compaction_off_stays_off_unless_it_is_an_agent_session() {
    let off = json!({ "auto": false });
    assert!(!compact_of(json!({ "contextWindow": 100_000, "sessionMode": "coding", "compaction": off }), &[]).await.auto);
    assert!(compact_of(json!({ "contextWindow": 100_000, "sessionMode": "agent", "compaction": off }), &[]).await.auto);
}

#[tokio::test]
async fn the_boundary_is_the_explicit_one_capped_by_the_window_or_else_the_window_or_the_auto_limit() {
    let boundary = |session: Value| async move {
        let settings = compact_of(session, &[]).await;
        CompactPolicy::resolve(&settings).map(|policy| policy.boundary_tokens)
    };
    assert_eq!(boundary(json!({ "contextWindow": 200_000, "compactBoundaryTokens": 300_000 })).await, Some(200_000));
    assert_eq!(boundary(json!({ "contextWindow": 200_000, "compactBoundaryTokens": 150_000 })).await, Some(150_000));
    assert_eq!(boundary(json!({ "autoCompactTokenLimit": 90_000 })).await, Some(90_000));
    assert_eq!(boundary(json!({})).await, None, "no window, no boundary, no limit: nothing to compact against");
}

#[tokio::test]
async fn a_main_session_reads_its_main_buffer_and_an_agent_owner_reads_its_own() {
    let compaction = json!({ "mainBuffer": 4_000, "bufferTokens": 9_000 });
    let main = compact_of(json!({ "owner": "user", "contextWindow": 100_000, "compaction": compaction }), &[]).await;
    let agent = compact_of(json!({ "owner": "agent", "contextWindow": 100_000, "compaction": compaction }), &[]).await;
    assert_eq!((main.buffer_tokens, agent.buffer_tokens), (4_000, 9_000));
    // With nothing configured a main session falls back to the main-buffer environment variable, an agent to its own.
    let env = [("MIXDOG_MAIN_COMPACT_BUFFER_TOKENS", "3000"), ("MIXDOG_AGENT_COMPACT_BUFFER_TOKENS", "7000")];
    assert_eq!(compact_of(json!({ "owner": "user", "contextWindow": 100_000 }), &env).await.buffer_tokens, 3_000);
    assert_eq!(compact_of(json!({ "owner": "agent", "contextWindow": 100_000 }), &env).await.buffer_tokens, 7_000);
}

#[tokio::test]
async fn the_configured_target_wins_over_the_environment_and_the_environment_over_nothing() {
    let session = |target: Option<u64>| json!({ "contextWindow": 100_000, "compaction": target.map_or(json!({}), |t| json!({ "targetTokens": t })) });
    let env = [("MIXDOG_AGENT_COMPACT_TARGET_TOKENS", "9000")];
    assert_eq!(compact_of(session(Some(8_000)), &env).await.target_tokens, Some(8_000));
    assert_eq!(compact_of(session(None), &env).await.target_tokens, Some(9_000));
    assert_eq!(compact_of(session(None), &[]).await.target_tokens, None);
}

#[tokio::test]
async fn a_percentage_target_over_one_is_read_as_a_percentage() {
    let share = |value: Value| async move {
        let settings = compact_of(json!({ "contextWindow": 100_000, "compaction": { "targetPercent": value } }), &[]).await;
        CompactPolicy::resolve(&settings).expect("policy").target_tokens
    };
    assert_eq!(share(json!(50)).await, 50_000);
    assert_eq!(share(json!(0.5)).await, 50_000);
}
