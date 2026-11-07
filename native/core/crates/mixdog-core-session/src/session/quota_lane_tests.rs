//! The global quota auto-resume switch against the Node recording
//! (`fixtures/quota-auto-resume/golden.json`, Node's real `quotaAutoResumeEnabled()` over each
//! recorded `mixdog-config.json`, and the file its setter leaves): the reader over a real config
//! holding the same document answers what Node answered.

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use serde_json::Value;

use super::quota_lane::auto_resume_enabled;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/quota-auto-resume/golden.json")).unwrap()
}

/// A config over a fresh file holding `doc` (`null`: no file).
async fn config_holding(dir: &std::path::Path, doc: &Value) -> Config {
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(dir.join("mixdog-config.json"), Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    if let Some(doc) = doc.as_object().cloned() {
        config
            .update(move |held| {
                *held = doc;
                Ok(())
            })
            .await
            .unwrap();
    }
    config
}

#[tokio::test]
async fn auto_resume_reads_quota_resume_auto_resume_as_node_does() {
    let golden = golden();
    for case in golden["reads"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_holding(dir.path(), &case["config"]).await;
        assert_eq!(auto_resume_enabled(&config), case["enabled"].as_bool().unwrap(), "{}", case["name"]);
    }
    // The file Node's setter leaves is read back as Node reads it.
    for case in golden["writes"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let config = config_holding(dir.path(), &case["file"]).await;
        assert_eq!(auto_resume_enabled(&config), case["enabled"].as_bool().unwrap(), "after setting {}", case["next"]);
    }
}
