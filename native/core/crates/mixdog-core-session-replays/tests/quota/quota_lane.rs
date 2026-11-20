//! The global quota auto-resume switch against the Node recording
//! (`fixtures/quota-auto-resume/golden.json`, Node's real `quotaAutoResumeEnabled()` over each
//! recorded 1.4.5 `mixdog-config.json`, and the file its setter leaves). The core reads 1.4.5's `quotaResume.autoResume`
//! as it stands (no migration step), so the reader over each recorded document answers what Node answered.

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use serde_json::Value;

use mixdog_core_session::session::quota_lane::auto_resume_enabled;

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
async fn the_reader_reads_the_1_4_5_key_and_the_registered_key() {
    let dir = tempfile::tempdir().unwrap();
    let legacy = config_holding(dir.path(), &serde_json::json!({"quotaResume": {"autoResume": false}})).await;
    assert!(!auto_resume_enabled(&legacy), "a 1.4.5 value is honoured without a migration");
    let dir = tempfile::tempdir().unwrap();
    let own = config_holding(dir.path(), &serde_json::json!({"quotaAutoResume": false})).await;
    assert!(!auto_resume_enabled(&own));
}


