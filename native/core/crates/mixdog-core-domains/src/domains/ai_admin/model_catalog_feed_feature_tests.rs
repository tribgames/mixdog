//! The `modelCatalog` section around each mutation: a change of the listed rows is published once with the new rows, a mutation
//! that leaves the rows alone publishes nothing, and a load that adopts other rows is no trigger.

use std::sync::Arc;

use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::state::SectionChange;
use mixdog_protocol::SectionName;
use serde_json::{Value, json};

use super::model_catalog_feed::{FeedToldDrop, ModelCatalogFeed};
use super::model_list_rig::{Rig, custom_discovery, custom_manual, rig, seeds};
use super::provider_sync::spawn_provider_sync;

/// The stored agent section of `scenario` with `hidden` models hidden on its one provider.
fn agent_hiding(scenario: &Value, provider: &str, hidden: &[&str]) -> Value {
    let mut agent = scenario["agent"].clone();
    for id in hidden {
        agent["providers"][provider]["modelOverrides"][*id] = json!({ "hidden": true });
    }
    agent
}

fn ids(rows: &[Value]) -> Vec<String> {
    let mut ids: Vec<String> = rows.iter().map(|row| row["id"].as_str().unwrap().to_owned()).collect();
    ids.sort();
    ids
}

fn published(publisher: &MockStatePublisher) -> Vec<Vec<String>> {
    publisher
        .published()
        .into_iter()
        .map(|(section, key, change)| {
            assert_eq!((section, key), (SectionName::ModelCatalog, None));
            let SectionChange::Set(bytes) = change else { panic!("rows that fit are set inline") };
            ids(serde_json::from_slice::<Vec<Value>>(&bytes).unwrap().as_slice())
        })
        .collect()
}

/// Stores `agent` the way the daemon's config does, and follows it into the registry and the caches (`afterCredentialChange`).
async fn apply(rig: &Rig, sync: &mut super::provider_sync::ProviderSync, applied: &mut u64, agent: &Value) {
    let agent: Value = serde_json::from_str(&agent.to_string().replace("__BASE_URL__", "http://127.0.0.1:9")).unwrap();
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
    rig.readiness.reinit_providers(None).await.unwrap();
}

struct Channel(tokio::sync::mpsc::UnboundedSender<Vec<String>>);

impl mixdog_core_api::state::StatePublisher for Channel {
    fn publish(&self, section: SectionName, key: Option<String>, change: SectionChange) {
        assert_eq!((section, key), (SectionName::ModelCatalog, None));
        let SectionChange::Set(bytes) = change else { panic!("rows that fit are set inline") };
        self.0.send(ids(serde_json::from_slice::<Vec<Value>>(&bytes).unwrap().as_slice())).unwrap();
    }
}

#[tokio::test]
async fn a_mutation_that_changes_the_rows_publishes_them_once_and_one_that_does_not_publishes_nothing() {
    let scenario = custom_manual();
    let rig = rig(&scenario, &seeds(), false).await;
    let service = rig.service.clone();
    rig.readiness.bind_invalidation(Arc::new(move || service.invalidate())).is_ok().then_some(()).unwrap();
    let publisher = Arc::new(MockStatePublisher::default());
    let feed = ModelCatalogFeed::new(rig.service.clone(), publisher.clone());
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
    let mut applied = 0;

    assert_eq!(ids(&rig.service.rows(false, false).await.unwrap()), ["m1", "m2", "m4"], "a hidden model is not listed");
    assert!(published(&publisher).is_empty(), "a load alone publishes nothing");

    let hiding_m1 = agent_hiding(&scenario, "custom-aaaa", &["m1"]);
    apply(&rig, &mut sync, &mut applied, &hiding_m1).await;
    feed.refresh(true).await;
    assert_eq!(ids(&rig.service.rows(false, false).await.unwrap()), ["m2", "m4"]);
    assert_eq!(published(&publisher), [["m2", "m4"]], "one publication with the new rows");

    apply(&rig, &mut sync, &mut applied, &hiding_m1).await;
    feed.refresh(true).await;
    assert_eq!(published(&publisher).len(), 1, "a mutation that leaves the rows alone publishes nothing");

    apply(&rig, &mut sync, &mut applied, &scenario["agent"]).await;
    feed.refresh(true).await;
    assert_eq!(published(&publisher).last().unwrap(), &["m1", "m2", "m4"], "showing the model again is a change too");
    assert_eq!(published(&publisher).len(), 2);
    stop.cancel();
    sync.task.await.unwrap();
}

#[tokio::test]
async fn the_composed_task_publishes_each_invalidating_change_once() {
    let scenario = custom_manual();
    let rig = rig(&scenario, &seeds(), false).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
    let feed = ModelCatalogFeed::start(rig.service.clone(), Arc::new(Channel(tx)), sync.applied.clone());
    let service = rig.service.clone();
    rig.readiness.bind_invalidation(Arc::new(FeedToldDrop { drop: Arc::new(move || service.invalidate()), feed: feed.clone() })).is_ok().then_some(()).unwrap();
    let mut applied = 0;

    assert_eq!(ids(&rig.service.rows(false, false).await.unwrap()), ["m1", "m2", "m4"]);
    let told = feed.invalidations();
    apply(&rig, &mut sync, &mut applied, &agent_hiding(&scenario, "custom-aaaa", &["m1"])).await;
    assert!(feed.invalidations() > told, "the invalidation reached the feed");
    assert_eq!(rx.recv().await.unwrap(), ["m2", "m4"], "the new rows, once");
    apply(&rig, &mut sync, &mut applied, &agent_hiding(&scenario, "custom-aaaa", &["m1"])).await;
    rig.service.rows(false, false).await.unwrap();
    assert!(rx.try_recv().is_err(), "nothing beyond the change");
    stop.cancel();
    sync.task.await.unwrap();
}

/// Clients keep their cached catalog until a trigger: a provider's catalog that moves on its own and a load that adopts the
/// other rows publish nothing; the next trigger publishes the moved catalog's rows.
#[tokio::test]
async fn a_load_that_adopts_other_rows_publishes_nothing_until_a_trigger() {
    let scenario = custom_discovery();
    let rig = rig(&scenario, &seeds(), false).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
    let feed = ModelCatalogFeed::start(rig.service.clone(), Arc::new(Channel(tx)), sync.applied.clone());
    let service = rig.service.clone();
    rig.readiness.bind_invalidation(Arc::new(FeedToldDrop { drop: Arc::new(move || service.invalidate()), feed: feed.clone() })).is_ok().then_some(()).unwrap();

    assert_eq!(ids(&rig.service.rows(false, false).await.unwrap()), ["disc-a", "disc-c", "m1"]);
    rig.serve(&json!({ "/c/v1/models": { "object": "list", "data": [{ "id": "disc-a", "object": "model" }, { "id": "disc-z", "object": "model" }] } }));
    assert_eq!(ids(&rig.service.rows(true, false).await.unwrap()), ["disc-a", "disc-z", "m1"], "the forced load adopts the moved catalog");
    assert_eq!(ids(&rig.service.rows(false, false).await.unwrap()), ["disc-a", "disc-z", "m1"]);
    assert_eq!(feed.invalidations(), 0, "no invalidation reached the feed");
    assert!(rx.try_recv().is_err(), "no trigger yet");

    let mut applied = 0;
    apply(&rig, &mut sync, &mut applied, &agent_hiding(&scenario, "custom-dddd", &["disc-b", "disc-a"])).await;
    assert_eq!(rx.recv().await.unwrap(), ["disc-z", "m1"], "the trigger publishes the moved catalog's rows");
    assert!(rx.try_recv().is_err(), "once");
    stop.cancel();
    sync.task.await.unwrap();
}

/// A change that arrives after the sync subscribed and before its first load is taken in by that load alone: neither the
/// config's tick nor a credential touch is left for the loop, which would rebuild, publish and count the same change again.
#[tokio::test]
async fn a_change_the_first_load_took_in_is_not_applied_again() {
    let scenario = custom_manual();
    let rig = rig(&scenario, &seeds(), false).await;
    let mut changes = rig.config.changes();
    let touched = tokio::sync::Notify::new();
    touched.notify_one();
    let agent: Value =
        serde_json::from_str(&agent_hiding(&scenario, "custom-aaaa", &["m1"]).to_string().replace("__BASE_URL__", "http://127.0.0.1:9")).unwrap();
    let stored = agent.as_object().cloned().unwrap();
    rig.config
        .update_agent(move |doc| {
            doc.clear();
            doc.extend(stored);
            Ok(())
        })
        .await
        .unwrap();
    assert!(changes.has_changed().unwrap(), "the write ticked the subscription");
    let handed_on = super::provider_sync::first_pass(&rig.config, &rig.effective, &rig.readiness, &rig.loaded, &mut changes, &touched).await;
    assert!(handed_on, "the load took the write in");
    assert!(!changes.has_changed().unwrap(), "the write is not left unread for the loop");
    assert!(futures::FutureExt::now_or_never(touched.notified()).is_none(), "the touch is not left for the loop");
}
