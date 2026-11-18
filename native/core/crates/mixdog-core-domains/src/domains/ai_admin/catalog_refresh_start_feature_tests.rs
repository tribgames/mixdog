//! The catalog refresh the readiness starts when providers are made ready: it runs once, a second ready call during it joins it,
//! a change of the provider set during it starts another, and its completion re-warms the model list.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{Value, json};

use super::model_list_rig::{custom_discovery, rig, seeds, web_search};

async fn within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    match mixdog_rt::time::timeout(Duration::from_secs(10), wait).await {
        Ok(done) => done,
        Err(_) => panic!("waited 10 s for {what}"),
    }
}

#[tokio::test]
async fn a_ready_call_starts_the_refresh_and_its_completion_re_warms_the_model_list_once() {
    let rig = rig(&custom_discovery(), &seeds(), false).await;
    rig.bind_rewarm();
    rig.readiness.ensure_providers_ready(None).await.unwrap();
    rig.readiness.settle_refreshes().await;
    assert_eq!(rig.hits.load(Ordering::SeqCst), 1, "the provider's models were listed once");
    assert_eq!(rig.rewarms.load(Ordering::SeqCst), 1, "the settled refresh re-warms once");
}

#[tokio::test]
async fn a_second_ready_call_during_a_running_refresh_joins_it() {
    let rig = rig(&custom_discovery(), &seeds(), false).await;
    rig.gate.send_replace(false);
    within("the first ready call", rig.readiness.ensure_providers_ready(None)).await.unwrap();
    within("the refresh's request at the endpoint", async { rig.arrived.acquire().await.unwrap().forget() }).await;
    within("the second ready call", rig.readiness.ensure_providers_ready(None)).await.unwrap();
    rig.gate.send_replace(true);
    within("the refresh to settle", rig.readiness.settle_refreshes()).await;
    assert_eq!(rig.hits.load(Ordering::SeqCst), 1, "one refresh served both calls");
}

#[tokio::test]
async fn a_change_of_the_provider_set_during_a_running_refresh_starts_another() {
    let rig = rig(&custom_discovery(), &seeds(), false).await;
    rig.gate.send_replace(false);
    within("the first ready call", rig.readiness.ensure_providers_ready(None)).await.unwrap();
    within("the refresh's request at the endpoint", async { rig.arrived.acquire().await.unwrap().forget() }).await;
    let mut providers = rig.loaded.get()["providers"].as_object().cloned().unwrap();
    let mut second: Value = providers["custom-dddd"].clone();
    second["name"] = json!("Echo");
    providers.insert("custom-eeee".into(), second);
    within("the ready call with another provider", rig.readiness.ensure_providers_ready(Some(providers))).await.unwrap();
    rig.gate.send_replace(true);
    within("the refreshes to settle", rig.readiness.settle_refreshes()).await;
    assert!(rig.hits.load(Ordering::SeqCst) >= 2, "a refresh over the new provider set followed the running one");
}

/// Lets the work the refresh started run to its end (the re-warm's load, and a refresh that load started): the endpoint's
/// arrivals as they stand once nothing is left to run.
async fn quiet(rig: &super::model_list_rig::Rig) -> usize {
    // A timer that just became due starts its refresh on its own task.
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    rig.readiness.settle_refreshes().await;
    rig.service.settle_warm().await;
    rig.readiness.settle_refreshes().await;
    rig.hits.load(Ordering::SeqCst)
}

/// `custom_discovery` with a second provider, `custom-eeee`, whose endpoint lists `e-1`.
fn two_providers() -> Value {
    let mut scenario = custom_discovery();
    let mut second = scenario["agent"]["providers"]["custom-dddd"].clone();
    second["name"] = json!("Echo");
    second["baseURL"] = json!("__BASE_URL__/e/v1");
    second.as_object_mut().unwrap().remove("modelOverrides");
    scenario["agent"]["providers"]["custom-eeee"] = second;
    scenario["stub"]["/e/v1/models"] = json!({ "object": "list", "data": [{ "id": "e-1", "object": "model", "owned_by": "fixture" }] });
    scenario
}

#[tokio::test]
async fn a_refresh_whose_endpoint_fails_still_re_warms_once_and_a_later_read_asks_the_endpoint_again() {
    let mut scenario = custom_discovery();
    scenario["stub"] = json!({ "/c/v1/models": { "__status": 500 } });
    // No model of its own: a failed discovery with a manual model still lists that one, which is an answer.
    scenario["agent"]["providers"]["custom-dddd"].as_object_mut().unwrap().remove("modelOverrides");
    let rig = rig(&scenario, &seeds(), false).await;
    rig.bind_rewarm();
    rig.readiness.ensure_providers_ready(None).await.unwrap();
    let settled = quiet(&rig).await;
    assert!(settled >= 1, "the refresh asked the endpoint");
    assert_eq!(rig.rewarms.load(Ordering::SeqCst), 1, "a failed refresh settles and re-warms like a good one");
    if let Ok(rows) = rig.service.rows(false, false).await {
        assert!(rows.iter().all(|row| row["id"] != "disc-a"), "nothing the failed endpoint did not list: {rows:?}");
    }
    assert!(rig.hits.load(Ordering::SeqCst) > settled, "the failed models were not cached: the read asked again");
}

#[tokio::test]
async fn a_ready_call_after_a_provider_was_removed_starts_no_refresh_and_the_next_read_lists_only_what_is_left() {
    let rig = rig(&two_providers(), &seeds(), false).await;
    rig.bind_rewarm();
    rig.readiness.ensure_providers_ready(None).await.unwrap();
    quiet(&rig).await;
    let before = rig.service.rows(false, false).await.unwrap();
    assert!(before.iter().any(|row| row["id"] == "e-1"), "{before:?}");
    let base = quiet(&rig).await;

    // The removal as the product makes it: the stored provider goes and the registry drops it at once.
    rig.config
        .update_agent(|doc| {
            doc.get_mut("providers").and_then(Value::as_object_mut).and_then(|stored| stored.remove("custom-eeee")).expect("the provider is stored");
            Ok(())
        })
        .await
        .unwrap();
    rig.readiness.disable_provider("custom-eeee");
    let mut providers = rig.loaded.get()["providers"].as_object().cloned().unwrap();
    providers.remove("custom-eeee").expect("the provider is configured");
    within("the ready call without the removed provider", rig.readiness.ensure_providers_ready(Some(providers))).await.unwrap();
    assert_eq!(quiet(&rig).await, base, "removing a provider asks no endpoint");

    let after = rig.service.rows(false, false).await.unwrap();
    assert!(after.iter().any(|row| row["id"] == "disc-a"), "{after:?}");
    assert!(after.iter().all(|row| row["id"] != "e-1"), "{after:?}");
}

#[tokio::test(start_paused = true)]
async fn the_catalog_timer_fires_one_interval_after_the_startup_refresh_and_not_a_millisecond_before() {
    assert_eq!(mixdog_ai::catalog::CATALOG_REFRESH_INTERVAL, Duration::from_secs(86_400));
    let rig = rig(&custom_discovery(), &seeds(), false).await;
    rig.bind_rewarm();
    rig.readiness.ensure_providers_ready(None).await.unwrap();
    let base = quiet(&rig).await;
    assert_eq!(rig.readiness.catalog_timer_fires(), 0);

    tokio::time::advance(Duration::from_millis(86_399_999)).await;
    assert_eq!(quiet(&rig).await, base, "no request a millisecond before the interval");
    assert_eq!(rig.readiness.catalog_timer_fires(), 0);

    tokio::time::advance(Duration::from_millis(1)).await;
    let fired = quiet(&rig).await;
    assert_eq!(rig.readiness.catalog_timer_fires(), 1);
    assert!(fired > base, "the timer's refresh asked the endpoint");
}

#[tokio::test]
async fn a_web_search_read_after_the_refresh_completed_and_the_re_warm_landed_lists_only_what_the_model_list_holds() {
    use crate::domains::ai_account::collaborators::WebSearchModels as _;
    let rig = rig(&custom_discovery(), &seeds(), false).await;
    rig.bind_rewarm();
    rig.readiness.ensure_providers_ready(None).await.unwrap();
    within("the refresh and its completion", rig.readiness.settle_refreshes()).await;
    within("the re-warm", rig.service.settle_warm()).await;
    assert!(rig.service.cache_loaded(), "the re-warm landed");
    let listed: Vec<Value> = rig.service.rows(false, false).await.unwrap();
    let found = within("the web-search read", web_search(&rig).list(None, false)).await.unwrap();
    let held: Vec<&Value> = listed.iter().map(|row| &row["id"]).collect();
    for row in found.as_array().unwrap() {
        assert!(held.contains(&&row["id"]), "a web-search row that the model list does not hold: {row}");
    }
}
