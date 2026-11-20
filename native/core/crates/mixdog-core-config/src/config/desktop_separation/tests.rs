//! The `desktop` section's one-time separation: the loaded document follows the pass.


use serde_json::Value;

use super::super::separation::tests::open;
use super::super::separation::tests::put;

const NOW_MS: i64 = 1_800_000_000_123;



/// The in-memory document follows the file the pass wrote.
#[tokio::test]
async fn the_loaded_document_follows_the_pass() {
    let dir = tempfile::tempdir().expect("dir");
    put(
        dir.path().join("mixdog-config.json"),
        r#"{"defaultsVersion":2,"desktop":{"keepAwake":true,"runInBackground":false,"zoomFactor":1}}"#.to_owned(),
    )
    .await;
    let config = open(dir.path()).await;
    assert!(config.separate_desktop_defaults(NOW_MS).await.expect("pass"));
    assert_eq!(
        Value::Object((*config.full()).clone()),
        serde_json::json!({ "defaultsVersion": 2, "desktop": { "runInBackground": false, "defaultsSeparationVersion": 1 } })
    );
}


