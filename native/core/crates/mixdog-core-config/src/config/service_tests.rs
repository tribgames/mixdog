use mixdog_core_api::mock::MockStatePublisher;

use super::*;
use crate::config::ConfigLanes;
use crate::config::NoEffects;
use crate::config::SettingsEnv;

/// `setProfile(input)`: the wire carries the object as the `input` param next to `opId`, and the
/// answer and a later `getProfile` show what it set.
#[tokio::test]
async fn set_profile_applies_the_input_param() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.path().join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    let env: SettingsEnv = Arc::new(|_| None);
    let settings = Settings::new(config, Arc::new(NoEffects), env);

    let params = json!({ "opId": "op-1", "input": { "title": "Harness", "language": "en", "experienceLevel": "expert" } });
    let set = settings_call(&settings, "config/setProfile", &params).await.unwrap();
    assert_eq!((set["title"].as_str(), set["language"].as_str(), set["experienceLevel"].as_str()), (Some("Harness"), Some("en"), Some("expert")));
    assert_eq!(settings_call(&settings, "config/getProfile", &json!({})).await.unwrap(), set);
}
