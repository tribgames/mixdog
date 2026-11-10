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

use super::model_catalog_feed::{FeedToldDrop, ModelCatalogFeed};
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

    // The first load fills the cache and tells no client: the section's first value is the first trigger's.
    assert_rows("first read", &rig.service.rows(false, false).await.unwrap(), &calls[0]["value"]);
    assert!(published(&publisher).is_empty(), "a load alone publishes nothing");

    let mut expected = 0;
    let mut before = calls[0]["value"].clone();
    let (mut changed, mut unchanged) = (0, 0);
    for pair in calls[1..].chunks(2) {
        let [mutation, read] = pair else { panic!("a mutation and the read after it") };
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
        before = read["value"].clone();
    }
    assert_eq!((changed, unchanged), (4, 2), "the recording holds four changes and two mutations that left the rows alone");
    stop.cancel();
    sync.task.await.unwrap();
}

/// `model-catalog-background`: Node's clients kept their cached catalog until a trigger (the provider-change hint, a peer change, a
/// reconnection). A provider's catalog that moves on its own and a load that adopts the other rows (a forced read here) is no
/// trigger: nothing is published, and the next trigger (a favorite) publishes Node's rows, the moved catalog included. The wait for
/// that publication is the check: a publication made at the load would arrive first, with the rows of the load.
#[tokio::test]
async fn a_load_that_adopts_other_rows_publishes_nothing_until_a_trigger() {
    let recording = recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "model-catalog-background").unwrap();
    let calls = scenario["calls"].as_array().unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
    let feed = ModelCatalogFeed::start(rig.service.clone(), Arc::new(Channel(tx)), sync.applied.clone());
    let service = rig.service.clone();
    rig.readiness
        .bind_invalidation(Arc::new(FeedToldDrop { drop: Arc::new(move || service.invalidate()), feed: feed.clone() }))
        .is_ok()
        .then_some(())
        .unwrap();

    assert_rows("first read", &rig.service.rows(false, false).await.unwrap(), &calls[0]["value"]);
    rig.serve(&calls[1]["stub"]);
    assert_rows("the load that adopts the moved catalog", &rig.service.rows(true, false).await.unwrap(), &calls[2]["value"]);
    assert_ne!(calls[2]["value"], calls[0]["value"], "the recording moved the rows with no mutation");
    assert_rows("the cached read after it", &rig.service.rows(false, false).await.unwrap(), &calls[3]["value"]);
    assert_eq!(feed.invalidations(), 0, "no invalidation reached the feed");
    let stray = rx.try_recv();
    assert!(stray.is_err(), "no trigger yet: {stray:?} applied={}", *sync.applied.borrow());

    let mut applied = 0;
    assert!(!apply(&rig, &mut sync, &mut applied, &calls[4]).await);
    assert_eq!(rx.recv().await.unwrap(), calls[5]["value"], "the trigger publishes Node's rows");
    assert_ne!(calls[5]["value"], calls[2]["value"]);
    assert!(rx.try_recv().is_err(), "once");
    stop.cancel();
    sync.task.await.unwrap();
}

/// Publications as they happen, so a test waits on the real signal.
struct Channel(tokio::sync::mpsc::UnboundedSender<Value>);

impl mixdog_core_api::state::StatePublisher for Channel {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        assert_eq!((section, key), (SectionName::ModelCatalog, None));
        let SectionChange::Set(bytes) = change else { panic!("rows that fit are set inline") };
        self.0.send(serde_json::from_slice(&bytes).unwrap()).unwrap();
    }
}

/// The wiring `compose_flip.rs` makes: `ModelCatalogFeed::start` on the config's changes, and the readiness' one invalidation
/// telling it (`FeedToldDrop`), the settled startup catalog refresh's excepted. A config change alone (a favorite) and an invalidation (a hidden model, a provider saved or removed)
/// each publish Node's rows once; a mutation that left the rows alone publishes nothing, which the order of what arrives shows (a
/// stray publication would arrive before the next expected one). No sleeps: each wait is the publication itself.
#[tokio::test]
async fn the_composed_task_publishes_each_config_change_and_invalidation_once() {
    let recording = recording();
    let scenario = &recording["scenarios"][0];
    let calls = scenario["calls"].as_array().unwrap();
    let rig = rig(scenario, &recording["seeds"], false).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
    let feed = ModelCatalogFeed::start(rig.service.clone(), Arc::new(Channel(tx)), sync.applied.clone());
    let service = rig.service.clone();
    rig.readiness
        .bind_invalidation(Arc::new(FeedToldDrop { drop: Arc::new(move || service.invalidate()), feed: feed.clone() }))
        .is_ok()
        .then_some(())
        .unwrap();
    let mut applied = 0;

    // The load of the first read fills the cache and publishes nothing (a stray publication arrives before the next expected one).
    assert_rows("first read", &rig.service.rows(false, false).await.unwrap(), &calls[0]["value"]);
    let mut last = calls[0]["value"].clone();
    let (mut changed, mut unchanged) = (0, 0);
    for pair in calls[1..].chunks(2) {
        let [mutation, read] = pair else { panic!("a mutation and the read after it") };
        let what = format!("{} {}", mutation["action"], mutation["args"]);
        let told = feed.invalidations();
        let providers_before = rig.config.agent().get("providers").cloned();
        let invalidated = apply(&rig, &mut sync, &mut applied, mutation).await;
        // Node's signal per mutation (`login.mjs`): `setModelPreferences` of a built-in provider reloads the config and nothing
        // else (`:94-98`, the config signal without a `providers` change when the favorite is the only change); every other
        // mutation ends in `afterCredentialChange` (`refresh.mjs:48-51`: the config applied, then `invalidateProviderCaches`), so
        // a stored `providers` change is followed by its invalidation, and the feed waits for it.
        let providers_changed = rig.config.agent().get("providers").cloned() != providers_before;
        match mutation["action"].as_str().unwrap() {
            "setModelPreferences" => assert!(!invalidated, "{what}: config signal only"),
            _ => assert!(invalidated, "{what}: ends in the invalidation"),
        }
        if providers_changed {
            assert!(invalidated, "{what}: a providers change is always followed by its invalidation");
        }
        // The signal each of Node's mutations ended in, checked before any publication is awaited: a stored change that is only
        // reloaded (the model preferences) tells the feed nothing, the others invalidate once. A wiring that lost the invalidation
        // fails here and not by waiting for a publication that cannot come.
        assert_eq!(feed.invalidations(), told + u64::from(invalidated), "{what}: the invalidation reached the feed");
        if read["value"] == last {
            unchanged += 1;
            continue;
        }
        assert_eq!(rx.recv().await.unwrap(), read["value"], "{what}: Node's rows, once");
        last = read["value"].clone();
        changed += 1;
    }
    assert_eq!((changed, unchanged), (4, 2));
    assert!(rx.try_recv().is_err(), "nothing beyond the changes");
    stop.cancel();
    sync.task.await.unwrap();
}
