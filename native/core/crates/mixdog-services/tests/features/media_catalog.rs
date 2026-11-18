//! The media model catalog loader and the usage ledger row of a generation.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::catalog::{PricedUsage, UsageArgs};
use mixdog_ai::registry::accounting::{UsagePricing, UsageRow, UsageSink};
use mixdog_services::media::catalog::CatalogFailure;
use mixdog_services::media::ledger::{MediaUsageCall, record_media_usage};
use mixdog_services::media::loader::{CatalogCache, CatalogSource, ModelLoader, Target};
use serde_json::{Map, Value, json};

// ---- the loader ----

struct World {
    fetches: AtomicUsize,
    answer: Mutex<Result<Value, CatalogFailure>>,
    revision: Mutex<String>,
    saved: Mutex<HashMap<String, Vec<Value>>>,
    expired: Mutex<bool>,
}

fn failing(code: &str) -> CatalogFailure {
    CatalogFailure { code: Some(code.to_owned()), timed_out: false }
}

#[async_trait]
impl CatalogSource for World {
    async fn target(&self, _: &str) -> Result<Target, CatalogFailure> {
        Ok(Target { key: "acct".into(), revision: self.revision.lock().unwrap().clone(), cached: true })
    }
    async fn fetch(&self, _: &str) -> Result<Value, CatalogFailure> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        self.answer.lock().unwrap().clone()
    }
}

#[async_trait]
impl CatalogCache for World {
    async fn load(&self, key: &str, stale: bool) -> Option<Vec<Value>> {
        if !stale && *self.expired.lock().unwrap() {
            return None;
        }
        self.saved.lock().unwrap().get(key).cloned()
    }
    async fn save(&self, key: &str, rows: &[Value]) {
        self.saved.lock().unwrap().insert(key.to_owned(), rows.to_vec());
        *self.expired.lock().unwrap() = false;
    }
}

struct Rig {
    world: Arc<World>,
    clock: Arc<AtomicI64>,
    loader: ModelLoader,
}

fn rig(first: Value) -> Rig {
    let world = Arc::new(World {
        fetches: AtomicUsize::new(0),
        answer: Mutex::new(Ok(first)),
        revision: Mutex::new("r1".into()),
        saved: Mutex::default(),
        expired: Mutex::new(false),
    });
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let now = clock.clone();
    let loader = ModelLoader::new(world.clone(), world.clone(), Arc::new(move || now.load(Ordering::SeqCst)));
    Rig { world, clock, loader }
}

fn fetches(rig: &Rig) -> usize {
    rig.world.fetches.load(Ordering::SeqCst)
}

#[tokio::test]
async fn a_fresh_catalog_is_fetched_once_and_then_served_from_the_cache() {
    let r = rig(json!([{"id": "m1"}]));
    let first = r.loader.load("lane").await.unwrap();
    assert_eq!((first.rows, first.warning), (vec![json!({"id": "m1"})], None));
    assert_eq!(r.world.saved.lock().unwrap()["acct"], vec![json!({"id": "m1"})]);
    r.loader.load("lane").await.unwrap();
    assert_eq!(fetches(&r), 1);
}

#[tokio::test]
async fn loads_made_together_share_one_provider_request() {
    let r = rig(json!([{"id": "m1"}]));
    let (a, b, c) = tokio::join!(r.loader.load("lane"), r.loader.load("lane"), r.loader.load("lane"));
    assert!(a.is_ok() && b.is_ok() && c.is_ok());
    assert_eq!(fetches(&r), 1);
}

#[tokio::test]
async fn an_expired_cache_or_a_new_catalog_revision_asks_the_provider_again() {
    let r = rig(json!([{"id": "m1"}]));
    r.loader.load("lane").await.unwrap();
    *r.world.expired.lock().unwrap() = true;
    r.loader.load("lane").await.unwrap();
    assert_eq!(fetches(&r), 2, "an expired cache");
    *r.world.revision.lock().unwrap() = "r2".into();
    r.loader.load("lane").await.unwrap();
    assert_eq!(fetches(&r), 3, "a revision the cache was not made for");
}

#[tokio::test]
async fn a_provider_outage_serves_the_last_catalog_with_a_warning_and_is_not_asked_again_for_a_minute() {
    let r = rig(json!([{"id": "m1"}]));
    r.loader.load("lane").await.unwrap();
    *r.world.expired.lock().unwrap() = true;
    *r.world.answer.lock().unwrap() = Err(failing("MEDIA_UPSTREAM_FAILED"));
    let stale = r.loader.load("lane").await.unwrap();
    assert_eq!(stale.rows, vec![json!({"id": "m1"})]);
    assert!(stale.warning.unwrap().starts_with("Using the last successful model catalog. "));
    assert_eq!(fetches(&r), 2);

    r.clock.fetch_add(59_000, Ordering::SeqCst);
    assert!(r.loader.load("lane").await.unwrap().warning.is_some());
    assert_eq!(fetches(&r), 2, "still inside the 60 s window");

    r.clock.fetch_add(2_000, Ordering::SeqCst);
    *r.world.answer.lock().unwrap() = Ok(json!([{"id": "m2"}]));
    let fresh = r.loader.load("lane").await.unwrap();
    assert_eq!((fresh.rows, fresh.warning), (vec![json!({"id": "m2"})], None));
    assert_eq!(fetches(&r), 3);
}

#[tokio::test]
async fn a_revoked_forbidden_or_unpaid_account_is_never_served_from_the_past() {
    for code in ["MEDIA_AUTH_REJECTED", "MEDIA_ACCESS_DENIED", "MEDIA_BILLING_BLOCKED"] {
        let r = rig(json!([{"id": "m1"}]));
        r.loader.load("lane").await.unwrap();
        *r.world.expired.lock().unwrap() = true;
        *r.world.answer.lock().unwrap() = Err(failing(code));
        let error = r.loader.load("lane").await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some(code));
    }
}

#[tokio::test]
async fn a_failure_with_nothing_cached_and_an_answer_that_is_not_a_list_are_errors() {
    let r = rig(json!([]));
    *r.world.answer.lock().unwrap() = Err(failing("MEDIA_UPSTREAM_FAILED"));
    assert!(r.loader.load("lane").await.is_err());
    *r.world.answer.lock().unwrap() = Ok(json!({"not": "an array"}));
    assert!(r.loader.load("lane").await.is_err());
    // An empty catalog the provider really answered is authoritative, not an outage.
    *r.world.answer.lock().unwrap() = Ok(json!([]));
    assert_eq!(r.loader.load("lane").await.unwrap().rows, Vec::<Value>::new());
}

// ---- the ledger row ----

struct Unpriced;

impl UsagePricing for Unpriced {
    fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
        PricedUsage { input: args.input_tokens, cost_usd: None, rates: Map::new() }
    }
}

#[derive(Default)]
struct Collect(Mutex<Vec<UsageRow>>);

#[async_trait]
impl UsageSink for Collect {
    async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
        self.0.lock().unwrap().push(row);
        Ok(())
    }
}

struct Refuse;

#[async_trait]
impl UsageSink for Refuse {
    async fn record_queued(&self, _: UsageRow) -> Result<(), String> {
        Err("disk full".to_owned())
    }
}

fn call<'a>(lane: &'a str, usage: Option<&'a Value>) -> MediaUsageCall<'a> {
    MediaUsageCall { lane, model: "m", pricing_model: None, usage, session_id: "sess", source_type: "lead", account: "acct@x.com" }
}

#[tokio::test]
async fn a_generation_is_billed_as_one_row_of_what_the_provider_reported() {
    let sink = Collect::default();
    let usage = json!({"inputTokens": 12, "outputTokens": 7, "costUsd": 0.04});
    record_media_usage(&sink, &Unpriced, &|| "row-1".to_owned(), 1_800_000_000_000, call("gemini", Some(&usage))).await;
    let rows = sink.0.lock().unwrap();
    assert_eq!(rows.len(), 1);
    let row = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!((&row["provider"], &row["model"], &row["account"]), (&json!("gemini"), &json!("m"), &json!("acct@x.com")));
    assert_eq!((row["input"].as_f64(), row["output"].as_f64(), &row["sessionId"]), (Some(12.0), Some(7.0), &json!("sess")), "{row}");
    assert_eq!((&row["costUsd"], &row["costSource"]), (&json!(0.04), &json!("provider")), "an unpriced model is billed what the provider reported");
}

#[tokio::test]
async fn a_ledger_that_refuses_never_fails_the_generation_and_a_row_needs_a_lane() {
    record_media_usage(&Refuse, &Unpriced, &|| "id".to_owned(), 1, call("gemini", None)).await;
    let sink = Collect::default();
    record_media_usage(&sink, &Unpriced, &|| "id".to_owned(), 1, call("", None)).await;
    assert!(sink.0.lock().unwrap().is_empty(), "a row without a lane is not written");
}
