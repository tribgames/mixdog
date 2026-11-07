//! The overlays against Node's `withCatalogErrors` (`fixtures/catalog-errors/golden.json`,
//! `record-catalog-errors.mjs`), and the live keyring alert.

use std::collections::HashMap;

use serde_json::{Value, json};

use super::provider_setup::{KeychainStatus, UnsafeStore, keychain_issue_of};
use super::setup_overlays::{CatalogFailure, CatalogFailures, with_catalog_errors, with_live_keychain};

const GOLDEN: &str = include_str!("../../../../../fixtures/catalog-errors/golden.json");

struct Held(HashMap<String, CatalogFailure>);

impl CatalogFailures for Held {
    fn failure(&self, id: &str) -> Option<CatalogFailure> {
        self.0.get(id).cloned()
    }
}

#[test]
fn the_catalog_errors_land_on_the_rows_as_node_puts_them() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 10);
    for scenario in scenarios {
        let held = Held(
            scenario["held"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(id, f)| (id.clone(), CatalogFailure { message: f["message"].as_str().unwrap().to_owned(), error_kind: f.get("errorKind").cloned() }))
                .collect(),
        );
        let got = with_catalog_errors(scenario["before"].clone(), &held);
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&scenario["after"]).unwrap(), "{}", scenario["name"]);
    }
    for row in golden["passthrough"].as_array().unwrap() {
        assert_eq!(with_catalog_errors(row["value"].clone(), &Held(HashMap::new())), row["after"]);
    }
}

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
    let unsafe_store = keychain_issue_of(KeychainStatus { state: "ok".into(), fallback: true, unsafe_store: Some(UnsafeStore { kind: "owner".into(), path: "/data/secrets".into() }) }).unwrap();
    assert_eq!((unsafe_store["state"].as_str(), unsafe_store["kind"].as_str()), (Some("unsafe-store"), Some("owner")));
    assert_eq!(with_live_keychain(json!("not a setup"), None), json!("not a setup"));
}
