//! The `desktop` section's one-time separation: the loaded document follows the pass.

use serde_json::Value;

use super::super::separation::tests::open;
use super::super::separation::tests::put;

const NOW_MS: i64 = 1_800_000_000_123;

/// A new profile's boot writes its config once: the pass marks the file with the notification stamp in the same write and,
/// with nothing to back up, makes no backup folder; the boot's own stamp then has nothing left to write.
#[tokio::test]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "reads and dates the test's own file on the test thread")]
async fn a_new_profile_is_separated_and_stamped_in_one_write_without_a_backup() {
    let dir = tempfile::tempdir().expect("dir");
    let config = open(dir.path()).await;
    assert!(config.separate_desktop_defaults_stamping(NOW_MS, Some(4_242)).await.expect("pass"));
    let file = dir.path().join("mixdog-config.json");
    let long_ago = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
    std::fs::File::options().write(true).open(&file).unwrap().set_modified(long_ago).unwrap();
    config.stamp_notifications(9_999).await.expect("stamp");

    let on_disk: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(on_disk["desktop"], serde_json::json!({ "defaultsSeparationVersion": 1 }));
    assert_eq!(on_disk["notifications"], serde_json::json!({ "migratedAt": 4_242 }));
    assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), long_ago, "the stamp wrote the config a second time");
    assert!(!dir.path().join("backups").exists());
}

/// The in-memory document follows the file the pass wrote.
#[tokio::test]
async fn the_loaded_document_follows_the_pass() {
    let dir = tempfile::tempdir().expect("dir");
    put(dir.path().join("mixdog-config.json"), r#"{"defaultsVersion":2,"desktop":{"keepAwake":true,"runInBackground":false,"zoomFactor":1}}"#.to_owned()).await;
    let config = open(dir.path()).await;
    assert!(config.separate_desktop_defaults(NOW_MS).await.expect("pass"));
    assert_eq!(
        Value::Object((*config.full()).clone()),
        serde_json::json!({ "defaultsVersion": 2, "desktop": { "runInBackground": false, "defaultsSeparationVersion": 1 } })
    );
}
