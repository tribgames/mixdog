//! The `modelCatalog` section against Node's rows around each mutation (`fixtures/model-lists-model-catalog`,
//! `benchmarks/rust-core/recorders/model-lists/record.mjs --set model-catalog`).
//!
//! Node sent the clients a hint after each resolved mutation (`provider-models-changed`) and they read `listProviderModels` again.
//! The recording is those reads around each mutation of a custom provider (`PROVIDER_KEYS`: hide a model, set a favorite, save a
//! provider, remove one; each twice where the second changes nothing), with the stored agent section the mutation left. The replay stores
//! the same section, runs what Node ran after it (`afterCredentialChange`: the registry follows the config, the caches go; a built-in
//! provider's preferences only reload the config), and compares what the feed published with Node's rows: a change is exactly one
//! publication with Node's rows, a mutation that left the rows alone publishes nothing.

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::state::SectionChange;
use mixdog_protocol::SectionName;
use serde_json::Value;

use super::model_catalog_feed::ModelCatalogFeed;
use super::model_list_node_tests::{Rig, assert_rows, rig};
use super::provider_sync::spawn_provider_sync;

fn recording() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/model-lists-model-catalog/node-model-lists.json")).unwrap()
}

/// What the publisher was told, as rows.
fn published(publisher: &MockStatePublisher) -> Vec<Value> {
    publisher
        .published()
        .into_iter()
        .map(|(section, key, change)| {
            assert_eq!((section, key), (SectionName::ModelCatalog, None));
            let SectionChange::Set(bytes) = change else { panic!("rows that fit are set inline") };
            serde_json::from_slice(&bytes).unwrap()
        })
        .collect()
}

/// Stores the agent section Node's mutation left, the way the daemon's config does, and follows it into the registry and the caches
/// (`applyConfigChange` -> `afterCredentialChange`) unless the mutation only reloads the config. Returns whether the registry was told.
async fn apply(rig: &Rig, sync: &mut super::provider_sync::ProviderSync, applied: &mut u64, call: &Value) -> bool {
    let agent: Value = serde_json::from_str(&call["agentAfter"].to_string().replace("__BASE_URL__", "http://127.0.0.1:9")).unwrap();
    let stored = agent.as_object().cloned().unwrap();
    let before = rig.config.agent();
    rig.config
        .update_agent(move |doc| {
            doc.clear();
            doc.extend(stored);
            Ok(())
        })
        .await
        .unwrap();
    if rig.config.agent() != before {
        *applied += 1;
        sync.applied.wait_for(|count| *count >= *applied).await.unwrap();
    }
    if call["action"] == "setModelPreferences" {
        return false;
    }
    let record = rig.loaded.get()["providers"].as_object().cloned().unwrap();
    rig.registry.sync_providers(&record, None).await.unwrap();
    if call["action"] == "removeCustomProvider" {
        // `onCustomProviderRemoved`: the removed provider leaves the registry at once.
        rig.registry.disable(call["args"][0].as_str().unwrap());
    }
    rig.readiness.reinit_providers().await.unwrap();
    true
}

#[tokio::test]
async fn a_mutation_publishes_nodes_rows_once_when_they_changed_and_nothing_when_they_did_not() {
    let recording = recording();
    let scenario = &recording["scenarios"][0];
    let calls = scenario["calls"].as_array().unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
    let service = rig.service.clone();
    rig.readiness.bind_invalidation(Arc::new(move || service.invalidate())).is_ok().then_some(()).unwrap();
    let publisher = Arc::new(MockStatePublisher::default());
    let feed = ModelCatalogFeed::new(rig.service.clone(), publisher.clone());
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
    let mut applied = 0;

    // Before anything changes: the first rows loaded are the section's first value.
    assert_rows("first read", &rig.service.rows(false, false).await.unwrap(), &calls[0]["value"]);
    feed.refresh(false).await;
    assert_eq!(published(&publisher), vec![calls[0]["value"].clone()], "the first value");

    let mut expected = 1;
    let (mut changed, mut unchanged) = (0, 0);
    for pair in calls[1..].chunks(2) {
        let [mutation, read] = pair else { panic!("a mutation and the read after it") };
        let before = published(&publisher).last().cloned().unwrap();
        let invalidated = apply(&rig, &mut sync, &mut applied, mutation).await;
        // What wakes the feed: the invalidation (it loads the catalog again) or only the stored config (it reads a loaded catalog).
        feed.refresh(invalidated).await;
        let what = format!("{} {}", mutation["action"], mutation["args"]);
        assert_rows(&format!("{what}: read after"), &rig.service.rows(false, false).await.unwrap(), &read["value"]);
        if read["value"] != before {
            expected += 1;
            changed += 1;
        } else {
            unchanged += 1;
        }
        let sent = published(&publisher);
        assert_eq!(sent.len(), expected, "{what}: one publication per change");
        assert_eq!(sent.last().unwrap(), &read["value"], "{what}: Node's rows");
    }
    assert_eq!((changed, unchanged), (4, 2), "the recording holds four changes and two mutations that left the rows alone");
    stop.cancel();
    sync.task.await.unwrap();
}
