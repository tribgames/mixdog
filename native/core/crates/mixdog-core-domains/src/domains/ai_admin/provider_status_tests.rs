//! `status providers`: the quota switch is on unless the config says false.

use std::sync::Arc;

use mixdog_core_config::config::Config;
use mixdog_rt::LaneToken as _;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::provider_status::QuotaAutoResumeSetting;

#[tokio::test]
async fn the_quota_switch_is_on_unless_the_config_says_false() {
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_config::config::ConfigLanes;
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    // Node: `readSection('quotaResume')?.autoResume !== false`; `quotaResume` is a section of the file's root, beside `agent`.
    for (root, want) in [
        (json!({}), true),
        (json!({ "quotaResume": {} }), true),
        (json!({ "quotaResume": { "autoResume": true } }), true),
        (json!({ "quotaResume": { "autoResume": null } }), true),
        (json!({ "quotaResume": { "autoResume": 0 } }), true),
        (json!({ "quotaResume": { "autoResume": false } }), false),
    ] {
        let path = dir.path().join("mixdog-config.json");
        let bytes = serde_json::to_vec(&root).unwrap();
        let file = path.clone();
        tokens
            .durability_io
            .submit(&CancellationToken::new(), move |lane| mixdog_statefile::write_file(lane, &file, &bytes, &mixdog_statefile::Opts::default()))
            .unwrap()
            .await
            .unwrap()
            .unwrap();
        let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
        assert_eq!(QuotaAutoResumeSetting::enabled(&config), want, "{root}");
    }
}
