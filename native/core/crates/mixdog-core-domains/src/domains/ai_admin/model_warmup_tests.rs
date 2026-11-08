//! The provider model cache's warm (`model_warmup.rs`) and the one load it shares with the readers, against the Node
//! recording (`fixtures/model-lists/node-model-lists.json`) and the fake model endpoint of `model_list_node_tests`.
//! Every wait is on a gate, a counter or a task that ends; a load held at the endpoint is the test's, not the scheduler's.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

use super::model_list_node_tests::{Rig, assert_rows, node_calls, recording, rig, web_search};
use super::model_warmup::{ModelWarmup, WarmupConfig, WarmupGates};
use crate::domains::ai_account::SetupSource;
use crate::domains::ai_account::auth_refresh::{AuthRefreshFlow, ProviderEffects};
use crate::domains::ai_account::dashboards::Dashboards;
use mixdog_ai::admission::Admission;
use crate::domains::ai_account::collaborators::{AuthRefresh, WebSearchModels};

#[derive(Default)]
struct Gates {
    busy: Mutex<Option<&'static str>>,
    closing: AtomicBool,
}

impl WarmupGates for Gates {
    fn busy(&self) -> Option<&'static str> {
        *self.busy.lock().unwrap()
    }
    fn closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }
    fn profile(&self, _event: &str, _detail: &str) {}
    // The model warm never waits on the close; its tests set the flag.
    fn closed(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(std::future::pending())
    }
}

const ON: WarmupConfig = WarmupConfig { enabled: true, delay: Duration::ZERO };

async fn scenario(name: &str) -> Rig {
    let recording = recording();
    let scenario = recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap();
    rig(scenario, &recording["seeds"], false).await
}

fn warmup(rig: &Rig, config: WarmupConfig, gates: Arc<Gates>) -> Arc<ModelWarmup> {
    let warmup = ModelWarmup::new(config);
    warmup.bind(rig.service.clone(), gates).unwrap();
    warmup
}

fn hits(rig: &Rig) -> usize {
    rig.hits.load(Ordering::SeqCst)
}

/// A full read started while a load is held at the endpoint, and the wait until it has joined that load (the host
/// signals the join), so the release that follows cannot come before the reader is there.
async fn reader_joins(rig: &Rig) -> tokio::task::JoinHandle<Result<Vec<Value>, String>> {
    while let Ok(permit) = rig.host.joined.try_acquire() {
        permit.forget();
    }
    let service = rig.service.clone();
    let reader = tokio::spawn(async move { service.rows(false, false).await });
    rig.host.joined.acquire().await.unwrap().forget();
    reader
}

/// The endpoint requests one undisturbed full read of the profile makes.
async fn one_load() -> usize {
    let rig = scenario("custom-discovery").await;
    rig.service.rows(false, false).await.unwrap();
    assert!(hits(&rig) > 0);
    hits(&rig)
}

fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
    move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
}

// The refresh settled before anything was bound or scheduled. The warm reads the catalog's refresh state instead of
// waiting for an event it could have missed, so it still runs.
#[tokio::test]
async fn a_refresh_that_settled_before_the_warm_was_bound_does_not_lose_the_warm() {
    let rig = scenario("custom-discovery").await;
    rig.host.ensure_ready().await.unwrap();
    rig.catalog.refresh().await;
    assert!(!rig.catalog.refresh_in_flight());
    assert!(!rig.service.cache_loaded());
    let warm = warmup(&rig, ON, Arc::default());
    warm.start();
    warm.settle().await;
    assert!(rig.service.cache_loaded(), "the cache is loaded with no reader having asked");
}

// A catalog refresh still running parks the warm (it invalidates every model-derived cache when it lands); the wake its
// settling gives runs it.
#[tokio::test]
async fn a_running_catalog_refresh_parks_the_warm_until_it_settles() {
    let rig = scenario("custom-discovery").await;
    rig.host.ensure_ready().await.unwrap();
    rig.gate.send_replace(false);
    let catalog = rig.catalog.clone();
    let refresh = tokio::spawn(async move { catalog.refresh().await });
    rig.arrived.acquire().await.unwrap().forget();
    assert!(rig.catalog.refresh_in_flight());
    let warm = warmup(&rig, ON, Arc::default());
    warm.start();
    warm.settle().await;
    assert!(!rig.service.cache_loaded() && !rig.host.load_in_flight(), "parked, no load started");
    rig.gate.send_replace(true);
    refresh.await.unwrap();
    assert!(!rig.catalog.refresh_in_flight());
    warm.wake();
    warm.settle().await;
    assert!(rig.service.cache_loaded());
}

// The warm-up loop is armed but its first refresh has not begun (the 200 ms boot delay, or a busy runtime): the boot warm
// waits for it as Node's `startupProviderCatalogRefreshPending` makes it, instead of loading a cache the refresh then drops.
#[tokio::test]
async fn the_boot_warm_waits_for_a_startup_refresh_that_has_not_begun() {
    let rig = scenario("custom-discovery").await;
    rig.host.ensure_ready().await.unwrap();
    rig.catalog.expect_startup_refresh();
    let warm = warmup(&rig, ON, Arc::default());
    let waker = warm.clone();
    rig.catalog.on_refresh_settled(Arc::new(move || waker.wake()));
    warm.start();
    warm.settle().await;
    assert!(!rig.service.cache_loaded() && !rig.host.load_in_flight() && hits(&rig) == 0, "parked behind the pending refresh");
    rig.catalog.refresh_startup().await;
    warm.settle().await;
    assert!(rig.service.cache_loaded(), "the refresh settling woke the warm");
}

// The warm-up loop stopped before its first refresh: nothing is pending, and the parked warm is woken.
#[tokio::test]
async fn a_stopped_warm_up_loop_releases_the_boot_warm() {
    let rig = scenario("custom-discovery").await;
    rig.host.ensure_ready().await.unwrap();
    rig.catalog.expect_startup_refresh();
    let warm = warmup(&rig, ON, Arc::default());
    let waker = warm.clone();
    rig.catalog.on_refresh_settled(Arc::new(move || waker.wake()));
    warm.start();
    warm.settle().await;
    assert!(!rig.service.cache_loaded());
    rig.catalog.abandon_startup_refresh();
    warm.settle().await;
    assert!(rig.service.cache_loaded());
}

#[tokio::test]
async fn a_busy_runtime_parks_the_warm_until_a_wake_finds_it_idle() {
    let rig = scenario("custom-discovery").await;
    let gates = Arc::new(Gates::default());
    *gates.busy.lock().unwrap() = Some("turn-active");
    let warm = warmup(&rig, ON, gates.clone());
    warm.start();
    warm.settle().await;
    assert!(!rig.service.cache_loaded());
    warm.wake();
    warm.settle().await;
    assert!(!rig.service.cache_loaded(), "still busy: parked again");
    assert_eq!(hits(&rig), 0);
    *gates.busy.lock().unwrap() = None;
    warm.wake();
    warm.settle().await;
    assert!(rig.service.cache_loaded());
    // Nothing is parked any more: a wake starts nothing.
    let before = hits(&rig);
    warm.wake();
    warm.settle().await;
    assert_eq!(hits(&rig), before);
}

#[tokio::test]
async fn a_closing_runtime_warms_nothing() {
    let rig = scenario("custom-discovery").await;
    let gates = Arc::new(Gates::default());
    gates.closing.store(true, Ordering::SeqCst);
    let warm = warmup(&rig, ON, gates);
    warm.start();
    warm.first_turn_settled();
    warm.settle().await;
    assert_eq!(hits(&rig), 0);
    assert!(!rig.service.cache_loaded());
}

// One load, however many ask: a full reader that arrives while the warm's load is held at the endpoint joins it.
#[tokio::test]
async fn a_full_reader_overlapping_the_scheduled_warm_shares_its_one_load() {
    let single = one_load().await;
    let rig = scenario("custom-discovery").await;
    rig.gate.send_replace(false);
    let warm = warmup(&rig, ON, Arc::default());
    warm.start();
    rig.arrived.acquire().await.unwrap().forget();
    let reader = reader_joins(&rig).await;
    assert_eq!(rig.arrived.available_permits(), 0, "the reader started no load of its own");
    rig.gate.send_replace(true);
    let rows = reader.await.unwrap().unwrap();
    warm.settle().await;
    assert!(!rows.is_empty());
    assert!(rig.service.cache_loaded());
    assert_eq!(hits(&rig), single, "one load, counted at the endpoint");
}

// The same with the load a cold quick read starts (`warmProviderModelCache({ loadSecrets: true })` inside
// `collectProviderModels`).
#[tokio::test]
async fn a_full_reader_overlapping_a_quick_reads_warm_shares_its_one_load() {
    let single = one_load().await;
    let rig = scenario("custom-discovery").await;
    rig.gate.send_replace(false);
    rig.service.rows(false, true).await.unwrap();
    rig.arrived.acquire().await.unwrap().forget();
    let reader = reader_joins(&rig).await;
    assert_eq!(rig.arrived.available_permits(), 0, "the reader started no load of its own");
    rig.gate.send_replace(true);
    reader.await.unwrap().unwrap();
    rig.host.settle_warm().await;
    assert_eq!(hits(&rig), single, "one load, counted at the endpoint");
}

// `invalidateProviderCaches` while the boot warm is loading: the load is not adopted. The first settled turn of the
// process schedules the warm again, once.
#[tokio::test]
async fn an_invalidation_during_the_boot_warm_refuses_it_and_the_first_turn_warms_again() {
    let rig = scenario("custom-discovery").await;
    rig.gate.send_replace(false);
    let warm = warmup(&rig, ON, Arc::default());
    warm.start();
    rig.arrived.acquire().await.unwrap().forget();
    rig.service.invalidate();
    rig.gate.send_replace(true);
    warm.settle().await;
    assert!(!rig.service.cache_loaded(), "the load that began before the invalidation fills nothing");
    warm.first_turn_settled();
    warm.settle().await;
    assert!(rig.service.cache_loaded(), "the first settled turn reschedules the warm");
    rig.service.invalidate();
    warm.first_turn_settled();
    warm.settle().await;
    assert!(!rig.service.cache_loaded(), "later settled turns do not (`isFirstTurnCompleted`)");
}

#[tokio::test]
async fn the_switches_gate_the_scheduled_warm_on_and_off() {
    static CASES: [(&[(&str, &str)], bool); 7] = [
        (&[], true),
        (&[("MIXDOG_DISABLE_PROVIDER_WARMUP", "1")], false),
        (&[("MIXDOG_DISABLE_MODEL_PREFETCH", "true")], false),
        (&[("MIXDOG_DISABLE_MODEL_PREFETCH", "0")], true),
        (&[("MIXDOG_DISABLE_PROVIDER_WARMUP", "off"), ("MIXDOG_DISABLE_MODEL_PREFETCH", "no")], true),
        (&[("MIXDOG_DISABLE_PROVIDER_WARMUP", "maybe")], true),
        (&[("MIXDOG_DISABLE_PROVIDER_WARMUP", " YES "), ("MIXDOG_DISABLE_MODEL_PREFETCH", "0")], false),
    ];
    for (pairs, loaded) in CASES {
        let rig = scenario("custom-discovery").await;
        let warm = warmup(&rig, WarmupConfig::from_env(&env(pairs)), Arc::default());
        warm.start();
        warm.first_turn_settled();
        warm.settle().await;
        assert_eq!(rig.service.cache_loaded(), loaded, "{pairs:?}");
        assert_eq!(hits(&rig) > 0, loaded, "{pairs:?}");
    }
}

#[test]
fn the_delay_is_nodes_env_delay_and_defaults_to_the_daemons_zero() {
    let delay = |pairs: &'static [(&str, &str)]| WarmupConfig::from_env(&env(pairs)).delay;
    const KEY: &str = "MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS";
    assert_eq!(delay(&[]), Duration::ZERO);
    assert_eq!(delay(&[(KEY, "")]), Duration::ZERO);
    assert_eq!(delay(&[(KEY, "x")]), Duration::ZERO, "not a number keeps the default");
    assert_eq!(delay(&[(KEY, "1500.9")]), Duration::from_millis(1500));
    assert_eq!(delay(&[(KEY, "-5")]), Duration::ZERO);
    assert_eq!(delay(&[(KEY, "999999")]), Duration::from_millis(120_000));
}

#[tokio::test(start_paused = true)]
async fn the_scheduled_warm_waits_for_its_delay() {
    let rig = scenario("custom-discovery").await;
    let config = WarmupConfig { enabled: true, delay: Duration::from_millis(3000) };
    let warm = warmup(&rig, config, Arc::default());
    let started = tokio::time::Instant::now();
    // The timer counts from this call, so the clock may move as soon as `start` returns: no wait for the task.
    warm.start();
    tokio::time::advance(Duration::from_millis(2999)).await;
    assert_eq!(hits(&rig), 0, "not yet at 2999 ms");
    tokio::time::advance(Duration::from_millis(1)).await;
    warm.settle().await;
    assert!(rig.service.cache_loaded());
    // The paused clock moves only by `advance` and by the auto-advance to the next timer: a longer delay would read later.
    assert_eq!(tokio::time::Instant::now() - started, Duration::from_millis(3000), "the warm ran at the delay, no later");
}

// `warmProviderModelCache()` of an account change (`accounts.mjs` `updateProviderAccounts`, `refresh.mjs`): straight
// away, with the scheduled warm switched off, and without secrets, so the load runs but is not adopted. A reader that
// arrives while it is held joins it.
#[tokio::test]
async fn the_account_change_warm_loads_once_at_once_and_is_not_adopted() {
    let off = WarmupConfig { enabled: false, delay: Duration::ZERO };
    let after_change = || async {
        let rig = scenario("custom-discovery").await;
        rig.service.rows(false, false).await.unwrap();
        // The requests of that open-gate read are not the held load's arrivals.
        while let Ok(permit) = rig.arrived.try_acquire() {
            permit.forget();
        }
        // `invalidateProviderCaches()` of the flow, then its warm.
        rig.service.invalidate();
        let before = hits(&rig);
        (rig, before)
    };
    let (alone, before) = after_change().await;
    let warm = warmup(&alone, off, Arc::default());
    warm.warm_now();
    warm.settle().await;
    let single = hits(&alone) - before;
    assert!(single > 0, "the warm listed the providers again");
    assert!(!alone.service.cache_loaded(), "a load without secrets is never adopted as the cache");

    let (shared, before) = after_change().await;
    shared.gate.send_replace(false);
    let warm = warmup(&shared, off, Arc::default());
    warm.warm_now();
    shared.arrived.acquire().await.unwrap().forget();
    let reader = reader_joins(&shared).await;
    assert_eq!(shared.arrived.available_permits(), 0, "the reader joined the account warm");
    shared.gate.send_replace(true);
    assert!(!reader.await.unwrap().unwrap().is_empty());
    warm.settle().await;
    assert_eq!(hits(&shared) - before, single);
}

// The composed startup with no reader: Node's daemon had loaded its cache by the time of the first read, so a quick
// read is complete and the web-search read comes from the cache; every recorded profile with an enabled provider reads
// the recorded full rows afterwards.
#[tokio::test]
async fn startup_with_no_reader_leaves_the_cache_loaded_as_nodes_boot_warm_does() {
    let recording = recording();
    let mut complete = 0;
    for scenario in recording["scenarios"].as_array().unwrap().iter().filter(|s| s["name"] != "custom-discovery-update") {
        let name = scenario["name"].as_str().unwrap();
        let [quick, full, search] = node_calls(scenario);
        let rig = rig(scenario, &recording["seeds"], false).await;
        let warm = warmup(&rig, ON, Arc::default());
        warm.start();
        warm.settle().await;
        if full.as_array().is_some_and(Vec::is_empty) {
            assert!(!rig.service.cache_loaded(), "{name}: no enabled provider, nothing to load");
            continue;
        }
        assert!(rig.service.cache_loaded(), "{name}: loaded at startup");
        if quick.get(0).is_some_and(|row| row["catalogComplete"] == Value::Bool(true)) {
            assert_rows(&format!("{name}: quick"), &rig.service.rows(false, true).await.unwrap(), quick);
            let found = web_search(&rig).list(None, false).await.unwrap();
            assert_rows(&format!("{name}: web search"), found.as_array().unwrap(), search);
            complete += 1;
        }
        assert_rows(&format!("{name}: full"), &rig.service.rows(false, false).await.unwrap(), full);
    }
    assert!(complete > 0);
}

struct NoSetup;
#[async_trait::async_trait]
impl SetupSource for NoSetup {
    async fn setup(&self, _: bool, _: bool) -> Result<Value, String> {
        Ok(Value::Null)
    }
    async fn display_config(&self) -> Result<Value, String> {
        Ok(Value::Null)
    }
}

// The production account-effects wrapper over the rig: the readiness' invalidation hook is the model list's, as the daemon binds it.
fn account_flow(rig: &Rig, warm: Arc<ModelWarmup>) -> Arc<AuthRefreshFlow<ProviderEffects>> {
    let service = rig.service.clone();
    rig.readiness.bind_invalidation(Arc::new(move || service.invalidate())).is_ok().then_some(()).unwrap();
    let effects = ProviderEffects::new(rig.config.clone(), rig.readiness.clone(), Arc::new(Admission::new()), Dashboards::new(Arc::new(NoSetup)), warm);
    AuthRefreshFlow::new(effects)
}

// `warmProviderModelCache()` of the account flows passes no `loadSecrets`: its load prepares no secret. A reader's load does.
#[tokio::test]
async fn the_account_change_warm_reads_no_secret() {
    let rig = scenario("custom-discovery").await;
    let base = rig.secret_reads.load(Ordering::SeqCst);
    let warm = warmup(&rig, WarmupConfig { enabled: false, delay: Duration::ZERO }, Arc::default());
    warm.warm_now();
    warm.settle().await;
    assert_eq!(rig.secret_reads.load(Ordering::SeqCst), base, "the account warm reads no secret");
    rig.service.rows(false, false).await.unwrap();
    assert!(rig.secret_reads.load(Ordering::SeqCst) > base, "a load with secrets reads them");
}

// The load is held at its keychain read (inside the preparation); an invalidation lands there. The superseded load runs
// on but is not adopted, and the next one is.
#[tokio::test]
async fn an_invalidation_during_the_preparation_refuses_the_load() {
    let rig = scenario("custom-discovery").await;
    // The reads of building the rig are not the held load's arrivals.
    while let Ok(permit) = rig.vault_arrived.try_acquire() {
        permit.forget();
    }
    rig.vault_gate.send_replace(false);
    let warm = warmup(&rig, ON, Arc::default());
    warm.start();
    rig.vault_arrived.acquire().await.unwrap().forget();
    rig.service.invalidate();
    rig.vault_gate.send_replace(true);
    warm.settle().await;
    assert!(!rig.service.cache_loaded(), "the load superseded during its preparation is not adopted");
    warm.first_turn_settled();
    warm.settle().await;
    assert!(rig.service.cache_loaded(), "a load begun afterwards is");
}

// Through the production flow: the account switch drops the caches and warms; a reader overlapping it joins its one load.
#[tokio::test]
async fn an_account_switch_warms_through_the_one_shared_load() {
    let off = WarmupConfig { enabled: false, delay: Duration::ZERO };
    let primed = || async {
        let rig = scenario("custom-discovery").await;
        rig.service.rows(false, false).await.unwrap();
        while let Ok(permit) = rig.arrived.try_acquire() {
            permit.forget();
        }
        let flow = account_flow(&rig, warmup(&rig, off, Arc::default()));
        (rig, flow)
    };
    let (alone, flow) = primed().await;
    let before = hits(&alone);
    flow.account_selection_changed();
    alone.host.settle_warm().await;
    let single = hits(&alone) - before;
    assert!(single > 0);

    let (shared, flow) = primed().await;
    let before = hits(&shared);
    shared.gate.send_replace(false);
    flow.account_selection_changed();
    shared.arrived.acquire().await.unwrap().forget();
    let reader = reader_joins(&shared).await;
    assert_eq!(shared.arrived.available_permits(), 0, "the reader joined the account warm");
    shared.gate.send_replace(true);
    assert!(!reader.await.unwrap().unwrap().is_empty());
    shared.host.settle_warm().await;
    assert_eq!(hits(&shared) - before, single);
}

// The account-change effect after a stored provider change (`accounts.mjs:92-94`: the config is reloaded, the caches
// dropped, then the model cache warmed). The warm prepares the providers of the config as it is now: the profile
// starts as Node's `custom-manual`, the stored config becomes Node's `custom-discovery`, the config sync hands it to
// the readiness, and the production account effects run. The warm alone must have registered and listed the new
// provider; the rows then are the ones Node recorded for that profile.
#[tokio::test]
async fn an_account_change_warm_lists_the_providers_of_the_config_as_it_is_now() {
    let recording = recording();
    let find = |name: &str| recording["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone();
    let (old, new) = (find("custom-manual"), find("custom-discovery"));
    let mut start = old;
    start["stub"] = new["stub"].clone();
    let rig = rig(&start, &recording["seeds"], false).await;
    let stop = mixdog_rt::CancellationToken::new();
    let mut sync = super::provider_sync::spawn_provider_sync(rig.config.clone(), rig.effective.clone(), rig.readiness.clone(), rig.loaded.clone(), stop.clone());
    let stored: Value = serde_json::from_str(&new["agent"].to_string().replace("__BASE_URL__", "http://127.0.0.1:9")).unwrap();
    let stored = stored.as_object().cloned().unwrap();
    rig.config
        .update_agent(move |doc| {
            doc.clear();
            doc.extend(stored);
            Ok(())
        })
        .await
        .unwrap();
    sync.applied.wait_for(|applied| *applied >= 1).await.unwrap();
    assert!(!rig.registry.names().contains("custom-dddd"), "nothing has listed the new provider yet");
    let before = hits(&rig);

    let warm = warmup(&rig, WarmupConfig { enabled: false, delay: Duration::ZERO }, Arc::default());
    let flow = account_flow(&rig, warm.clone());
    flow.account_selection_changed();
    warm.settle().await;

    assert!(rig.registry.names().contains("custom-dddd"), "the warm prepared the new config's provider");
    assert!(hits(&rig) > before, "and listed it");
    let rows = rig.service.rows(false, false).await.unwrap();
    assert_rows("custom-discovery after the change: full", &rows, node_calls(&new)[1]);
    stop.cancel();
    sync.task.await.unwrap();
}

// The claim a load makes after its preparation is one step (`ownsLoad`, the revision sync, the sequence): a load an
// invalidation superseded before it keeps the sequence it began under and is refused, one that is still current takes
// the sequence in force and is adopted, and an invalidation after the claim refuses it.
#[tokio::test]
async fn a_loads_claim_is_refused_after_an_invalidation_and_adopted_before_one() {
    let rig = scenario("custom-discovery").await;
    let started = rig.host.begin();
    rig.host.invalidate();
    let (_, seq) = rig.host.claim(started);
    assert_eq!(seq, started, "a superseded load keeps its own sequence");
    rig.host.adopt(seq);
    assert!(!rig.service.cache_loaded(), "and is not adopted");

    let started = rig.host.begin();
    let (_, seq) = rig.host.claim(started);
    rig.host.invalidate();
    rig.host.adopt(seq);
    assert!(!rig.service.cache_loaded(), "an invalidation after the claim refuses it");

    let started = rig.host.begin();
    let (_, seq) = rig.host.claim(started);
    rig.host.adopt(seq);
    assert!(rig.service.cache_loaded(), "a current load is adopted");
}

// An invalidation attempted exactly between the claim's ownership check and its sequence choice. The hook is a
// concurrent caller that invalidates the moment the cache lock is free. Held across the claim, the lock keeps it out
// until the claim is done, which then refuses the adoption; a claim that let the lock go between its steps lets the
// invalidation land inside, takes the new sequence for a load that was superseded, and adopts it.
#[tokio::test]
async fn an_invalidation_between_the_claims_steps_cannot_land_and_a_superseded_load_is_never_adopted() {
    let rig = scenario("custom-discovery").await;
    let started = rig.host.begin();
    let landed = Arc::new(AtomicBool::new(false));
    let hook_landed = landed.clone();
    *rig.host.claim_hook.lock().unwrap() = Some(Arc::new(move |host| hook_landed.store(host.invalidate_unless_locked(), Ordering::SeqCst)));
    let (_, seq) = rig.host.claim(started);
    assert!(!landed.load(Ordering::SeqCst), "the invalidation got in between the ownership check and the sequence choice");
    // What the held-out invalidation does once the claim is done.
    rig.host.invalidate();
    rig.host.adopt(seq);
    assert!(!rig.service.cache_loaded(), "a load superseded after its claim is not adopted");
}
