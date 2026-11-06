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

#[tokio::test]
async fn reads_and_setters_match_the_recorded_node_settings() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/settings/config-settings-twin.json");
    let twin: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let node_is_windows = twin["platform"] == "win32";
    let entries = twin["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 120);
    let mut compared = 0;
    for (index, entry) in entries.iter().enumerate() {
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
            // The shell rule depends on the platform the twin was recorded on.
            if method == "setSystemShell" && node_is_windows != cfg!(windows) {
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
                "saveStarterGuideState" => s.save_starter_guide_state(&args[0]).await,
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
            compared += 1;
        }
    }
    assert!(compared >= 1000, "{compared}");
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

#[tokio::test]
async fn cache_warming_tells_the_warmer() {
    let dir = tempfile::tempdir().unwrap();
    let (s, effects) = settings(&dir, &json!({}), None).await;
    s.set_cache_warming_enabled(&json!(true)).await.unwrap();
    s.set_cache_warming_enabled(&json!(false)).await.unwrap();
    assert!(s.set_cache_warming_enabled(&json!("on")).await.is_err());
    assert_eq!(*effects.0.lock().unwrap(), vec![json!(["cacheWarming", true]), json!(["cacheWarming", false])]);
}
