//! The setup overlays: the live keyring alert replaces the stale one and goes last.

use serde_json::json;

use super::provider_setup::{KeychainStatus, UnsafeStore, keychain_issue_of};
use super::setup_overlays::with_live_keychain;

#[test]
fn the_live_keyring_alert_replaces_the_stale_one_and_goes_last() {
    let setup = json!({ "keychain": { "state": "locked" }, "api": [], "oauth": [] });
    let live = keychain_issue_of(KeychainStatus { state: "ok".into(), ..KeychainStatus::default() });
    assert_eq!(live, None, "an unlocked keyring has no alert");
    let unlocked = with_live_keychain(setup.clone(), live);
    assert!(unlocked.get("keychain").is_none(), "the stale alert is dropped");
    let locked = with_live_keychain(setup, keychain_issue_of(KeychainStatus { state: "locked".into(), ..KeychainStatus::default() }));
    assert_eq!(locked.as_object().unwrap().keys().last().map(String::as_str), Some("keychain"), "the alert is the last key");
    assert_eq!(locked["keychain"]["state"], "locked");
    let unsafe_store = keychain_issue_of(KeychainStatus {
        state: "ok".into(),
        fallback: true,
        unsafe_store: Some(UnsafeStore { kind: "owner".into(), path: "/data/secrets".into() }),
    })
    .unwrap();
    assert_eq!((unsafe_store["state"].as_str(), unsafe_store["kind"].as_str()), (Some("unsafe-store"), Some("owner")));
    assert_eq!(with_live_keychain(json!("not a setup"), None), json!("not a setup"));
}
