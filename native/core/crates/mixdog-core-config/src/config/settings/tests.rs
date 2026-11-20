use std::sync::Mutex;

use mixdog_core_api::mock::MockStatePublisher;

use super::*;
use crate::config::ConfigLanes;

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


