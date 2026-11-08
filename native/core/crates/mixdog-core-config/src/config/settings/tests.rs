use std::sync::Mutex;

use mixdog_core_api::mock::MockStatePublisher;

use super::*;
use crate::config::ConfigLanes;
use crate::config::patch::js_deep_equal;
use crate::config::patch::stored_form;

#[derive(Default)]
struct Recorded(Mutex<Vec<Value>>);

#[async_trait]
impl SettingsEffects for Recorded {
    fn set_configured_shell(&self, command: &str) {
        self.0.lock().unwrap().push(json!(["setShell", command]));
    }
    fn note_cache_warming_enabled(&self, enabled: bool) {
        self.0.lock().unwrap().push(json!(["cacheWarming", enabled]));
    }
    async fn sync_developer_option(&self, id: &str) {
        self.0.lock().unwrap().push(json!(["syncDeveloper", id]));
    }
}

async fn settings(dir: &tempfile::TempDir, agent: &Value, shell_env: Option<String>) -> (Settings, Arc<Recorded>) {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    std::fs::write(&path, serde_json::to_vec(&json!({ "agent": agent, "desktop": { "zoom": 1 } })).unwrap()).unwrap();
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let effects = Arc::new(Recorded::default());
    let env: SettingsEnv = Arc::new(move |name| if name == "MIXDOG_SHELL" { shell_env.clone() } else { None });
    (Settings::new(config, effects.clone(), env), effects)
}

fn eq(a: &Value, b: &Value) -> bool {
    js_deep_equal(a, b)
}

fn stored(doc: &Value) -> Value {
    Value::Object(stored_form(doc.as_object().unwrap()))
}

/// Recorded entries per test: each opens its own config for every read and setter.
const ENTRY_CHUNK: usize = 8;

fn settings_twin() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/config-settings/config-settings-twin.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

/// The shell rule depends on the platform the twin was recorded on.
fn compares(node_is_windows: bool, method: &str) -> bool {
    !(method == "setSystemShell" && node_is_windows != cfg!(windows))
}

mixdog_rt::replay_chunks!(SETTINGS_TESTS, #[tokio::test] async the_settings_chunk; [
    reads_and_setters_match_the_recorded_node_settings_00 = 0,
    reads_and_setters_match_the_recorded_node_settings_01 = 1,
    reads_and_setters_match_the_recorded_node_settings_02 = 2,
    reads_and_setters_match_the_recorded_node_settings_03 = 3,
    reads_and_setters_match_the_recorded_node_settings_04 = 4,
    reads_and_setters_match_the_recorded_node_settings_05 = 5,
    reads_and_setters_match_the_recorded_node_settings_06 = 6,
    reads_and_setters_match_the_recorded_node_settings_07 = 7,
    reads_and_setters_match_the_recorded_node_settings_08 = 8,
    reads_and_setters_match_the_recorded_node_settings_09 = 9,
    reads_and_setters_match_the_recorded_node_settings_10 = 10,
    reads_and_setters_match_the_recorded_node_settings_11 = 11,
    reads_and_setters_match_the_recorded_node_settings_12 = 12,
    reads_and_setters_match_the_recorded_node_settings_13 = 13,
    reads_and_setters_match_the_recorded_node_settings_14 = 14,
]);

#[test]
fn every_recorded_entry_has_its_settings_test() {
    let twin = settings_twin();
    let node_is_windows = twin["platform"] == "win32";
    let entries = twin["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 120);
    let setters = entries.iter().flat_map(|entry| entry["setters"].as_array().unwrap()).filter(|setter| compares(node_is_windows, setter["method"].as_str().unwrap())).count();
    assert!(setters >= 1000, "{setters}");
    mixdog_rt::testing::assert_chunks_registered(SETTINGS_TESTS, entries.len(), ENTRY_CHUNK);
}

async fn the_settings_chunk(chunk: usize) {
    let twin = settings_twin();
    let node_is_windows = twin["platform"] == "win32";
    let entries = twin["entries"].as_array().unwrap();
    let range = mixdog_rt::testing::chunk_range(entries.len(), chunk, ENTRY_CHUNK);
    for (index, entry) in entries.iter().enumerate().skip(range.start).take(range.len()) {
        let env = entry["shellEnv"].as_str().map(str::to_owned);
        let dir = tempfile::tempdir().unwrap();
        let (s, _) = settings(&dir, &entry["config"], env.clone()).await;
        let reads = &entry["reads"];
        for (name, got) in [
            ("heartbeat", s.heartbeat()),
            ("reactions", s.reactions()),
            ("titles", s.session_titles()),
            ("cacheWarming", s.cache_warming()),
            ("botOrder", s.bot_order()),
            ("shell", s.system_shell()),
            ("developer", s.developer()),
            ("recap", s.recap()),
            ("profile", s.profile()),
        ] {
            assert!(eq(&got, &reads[name]), "entry {index} read {name}: {got} vs {}", reads[name]);
        }
        for setter in entry["setters"].as_array().unwrap() {
            let method = setter["method"].as_str().unwrap();
            if !compares(node_is_windows, method) {
                continue;
            }
            let dir = tempfile::tempdir().unwrap();
            let (s, effects) = settings(&dir, &entry["config"], env.clone()).await;
            let args = setter["args"].as_array().unwrap();
            let result = match method {
                "setHeartbeatEnabled" => s.set_heartbeat_enabled(&args[0]).await,
                "setHeartbeatInterval" => s.set_heartbeat_interval(&args[0]).await,
                "setReactionsEnabled" => s.set_reactions_enabled(&args[0]).await,
                "setAiSessionTitles" => s.set_ai_session_titles(&args[0]).await,
                "setCacheWarmingEnabled" => s.set_cache_warming_enabled(&args[0]).await,
                "setBotOrder" => s.set_bot_order(&args[0]).await,
                "setSystemShell" => s.set_system_shell(&args[0]).await,
                "setDeveloperOption" => s.set_developer_option(&args[0], &args[1]).await,
                "setProfile" => s.set_profile(&args[0]).await,
                // The answer is the updater's view; only the stored switch is ours.
                "setAutoUpdate" => s.set_auto_update(&args[0]).await.map(|()| setter["value"].clone()),
                // The recorder kept the guide of the status Node answers; the status itself is
                // pinned by `save_starter_guide_state_answers_the_onboarding_status`.
                "saveStarterGuideState" => s.save_starter_guide_state(&args[0]).await.map(|status| status["starterGuide"].clone()),
                other => panic!("unknown setter {other}"),
            };
            let label = format!("entry {index} {method} {args:?}");
            match (&result, setter.get("error")) {
                (Err(error), Some(expected)) => assert_eq!(&json!(error.to_string()), expected, "{label}"),
                (Ok(value), None) => {
                    assert!(eq(value, &setter["value"]), "{label}: value {value} vs {}", setter["value"]);
                }
                _ => panic!("{label}: {result:?} vs {:?}", setter.get("error")),
            }
            let expected = setter.get("saved").filter(|saved| !saved.is_null()).unwrap_or(&entry["config"]);
            let agent = Value::Object(s.config.agent());
            assert!(eq(&stored(&agent), &stored(expected)), "{label}: stored config {agent} vs {expected}");
            let effects: Vec<Value> = effects
                .0
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call[0] != "cacheWarming")
                .cloned()
                .collect();
            assert!(eq(&Value::Array(effects), &setter["calls"]), "{label}: effects");
        }
    }
}

// Expected values come from the TUI registry (`src/tui/themes/index.mjs`, run under Node).
#[tokio::test]
async fn theme_resolves_and_persists_like_the_tui() {
    let dir = tempfile::tempdir().unwrap();
    let (s, _) = settings(&dir, &json!({}), None).await;
    assert_eq!(s.theme(), json!("basic"));
    let set = s.set_theme(&json!(" basicIndigo "), &json!({})).await.unwrap();
    assert_eq!(set, json!({ "id": "indigo", "label": "Indigo", "description": "Cool blue-indigo brand dark with orange live state." }));
    assert_eq!(s.theme(), json!("indigo"));
    let unknown = s.set_theme(&json!("nope"), &json!({ "persist": false })).await.unwrap();
    assert_eq!(unknown["id"], "basic");
    assert_eq!(s.theme(), json!("indigo"), "persist:false stores nothing");
    s.set_theme(&json!("rosepine"), &Value::Null).await.unwrap();
    assert_eq!(s.config.get("ui.theme"), Some(json!("rosepine")));
}

// `settings-profile-api.mjs` `saveStarterGuideState` returns `this.getOnboardingStatus()`; the
// values of the first assertions are those of `settings-profile-api.test.mjs`.
#[tokio::test]
async fn save_starter_guide_state_answers_the_onboarding_status() {
    let dir = tempfile::tempdir().unwrap();
    let onboarding = json!({ "completed": true, "version": 3, "completedAt": "then" });
    let (s, _) = settings(&dir, &json!({ "onboarding": onboarding }), None).await;
    let status = s
        .save_starter_guide_state(&json!({ "closed": true, "welcomed": true, "visited": ["workflow", "project", "project"] }))
        .await
        .unwrap();
    assert_eq!(status["completed"], json!(true));
    assert_eq!(status["version"], json!(3));
    assert_eq!(status["starterGuide"], json!({ "closed": true, "welcomed": true, "visited": ["project", "workflow"] }));
    assert!(status["workflowRoutes"].is_object());
    let mut keys: Vec<&String> = status.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["completed", "default", "starterGuide", "version", "workflowRoutes"]);
    assert_eq!(s.config.agent()["onboarding"]["completedAt"], json!("then"));
}

#[tokio::test]
async fn cache_warming_tells_the_warmer() {
    let dir = tempfile::tempdir().unwrap();
    let (s, effects) = settings(&dir, &json!({}), None).await;
    s.set_cache_warming_enabled(&json!(true)).await.unwrap();
    s.set_cache_warming_enabled(&json!(false)).await.unwrap();
    assert!(s.set_cache_warming_enabled(&json!("on")).await.is_err());
    assert_eq!(*effects.0.lock().unwrap(), vec![json!(["cacheWarming", true]), json!(["cacheWarming", false])]);
}
