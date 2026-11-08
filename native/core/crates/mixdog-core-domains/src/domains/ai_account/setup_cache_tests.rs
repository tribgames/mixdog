//! The cached provider setup flow (`getProviderSetup` / `cachedProviderSetup`): what is served when,
//! what is rebuilt, and what is overlaid. The seams are fakes that count their calls.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::failure::Failure;
use super::provider_setup::{KeychainStatus, SetupOptions};
use super::setup_cache::{CachedProviderSetup, KeychainLive, SetupBuilder, SetupHost, SetupOverlays};

/// Builds `{ build: n, secrets, local }`, slowly enough for two readers to meet.
#[derive(Default)]
struct Builder {
    builds: AtomicUsize,
    options: Mutex<Vec<(bool, bool)>>,
    fail: AtomicBool,
}

#[async_trait]
impl SetupBuilder for Builder {
    async fn build(&self, options: SetupOptions) -> Result<Value, Failure> {
        let n = self.builds.fetch_add(1, Ordering::SeqCst) + 1;
        self.options.lock().unwrap().push((options.check_secrets, options.detect_local));
        tokio::time::sleep(Duration::from_millis(20)).await;
        if self.fail.load(Ordering::SeqCst) {
            return Err(Failure::error("keychain unreachable"));
        }
        Ok(json!({ "build": n, "secrets": options.check_secrets, "api": [{ "id": "openai" }], "keychain": "stale" }))
    }

    async fn proxy(&self, _force: bool) -> Result<Value, Failure> {
        self.builds.fetch_add(1, Ordering::SeqCst);
        Ok(json!({ "managedByClient": true }))
    }
}

struct Keychain {
    ready: AtomicBool,
    recovers: AtomicBool,
    changes: AtomicBool,
    interactive: Mutex<Vec<bool>>,
    forced: Mutex<Vec<bool>>,
}

#[async_trait]
impl KeychainLive for Keychain {
    fn status(&self) -> KeychainStatus {
        KeychainStatus::default()
    }
    fn prewarm_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    async fn await_prewarm(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }
    async fn retry(&self, interactive: bool) -> bool {
        self.interactive.lock().unwrap().push(interactive);
        self.recovers.swap(false, Ordering::SeqCst)
    }
    async fn refresh(&self, force: bool) -> bool {
        self.forced.lock().unwrap().push(force);
        self.changes.swap(false, Ordering::SeqCst)
    }
}

/// Marks what it overlaid, in order.
struct Overlays;

impl SetupOverlays for Overlays {
    fn with_live_keychain(&self, mut setup: Value) -> Value {
        setup["keychain"] = json!("live");
        setup
    }
    fn with_catalog_errors(&self, mut setup: Value) -> Value {
        setup["api"][0]["catalogError"] = json!(true);
        setup
    }
}

#[derive(Default)]
struct Host {
    proxy: AtomicBool,
    reloads: AtomicUsize,
    scheduled: AtomicUsize,
    warmup_pending: AtomicBool,
    closing: AtomicBool,
}

impl SetupHost for Host {
    fn model_proxy_client(&self) -> bool {
        self.proxy.load(Ordering::SeqCst)
    }
    fn reload_full_config(&self) {
        self.reloads.fetch_add(1, Ordering::SeqCst);
    }
    fn warmup_pending(&self) -> bool {
        self.warmup_pending.load(Ordering::SeqCst)
    }
    fn schedule_warmup(&self) {
        self.scheduled.fetch_add(1, Ordering::SeqCst);
    }
    fn closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }
}

fn world(ready: bool) -> (CachedProviderSetup, Arc<Builder>, Arc<Keychain>, Arc<Host>) {
    // The warm-up behind a cold read is a runtime task.
    mixdog_rt::testing::tokens();
    let builder = Arc::new(Builder::default());
    let keychain = Arc::new(Keychain { ready: AtomicBool::new(ready), recovers: AtomicBool::new(false), changes: AtomicBool::new(false), interactive: Mutex::default(), forced: Mutex::default() });
    let host = Arc::new(Host::default());
    let setup = CachedProviderSetup::new(builder.clone(), keychain.clone(), Arc::new(Overlays), host.clone());
    (setup, builder, keychain, host)
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(120)).await;
}

#[tokio::test]
async fn a_cold_read_answers_the_no_secrets_snapshot_flagged_and_publishes_the_real_one_behind_it() {
    let (setup, builder, keychain, host) = world(false);
    let quick = setup.get_setup(false, false, false, false).await.unwrap();
    assert_eq!((quick["secrets"].clone(), quick["pendingSecrets"].clone()), (json!(false), json!(true)));
    assert_eq!(quick["api"][0]["catalogError"], json!(true), "the catalog failures are overlaid on the snapshot");
    assert_eq!(builder.options.lock().unwrap()[0], (false, false), "the snapshot reads no secret and no local runtime");
    assert_eq!(host.scheduled.load(Ordering::SeqCst), 1, "the warm-up is scheduled once the snapshot is cached");
    settle().await;
    assert!(keychain.ready.load(Ordering::SeqCst) && setup.has_cached(), "the background read waited for the keychain and cached the real setup");
    assert_eq!(builder.options.lock().unwrap()[1], (true, true));
    let again = setup.get_setup(false, false, false, false).await.unwrap();
    assert_eq!((again["build"].clone(), again["keychain"].clone()), (json!(2), json!("live")), "the cached one is served, with the live keyring overlaid");
    assert!(again.get("pendingSecrets").is_none());
    assert_eq!(builder.builds.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn the_warmup_is_not_scheduled_twice_nor_while_closing() {
    let (setup, _, _, host) = world(false);
    host.warmup_pending.store(true, Ordering::SeqCst);
    setup.cached(false, true).await.unwrap();
    assert_eq!(host.scheduled.load(Ordering::SeqCst), 0);
    let (setup, _, _, host) = world(false);
    host.closing.store(true, Ordering::SeqCst);
    setup.cached(false, true).await.unwrap();
    assert_eq!(host.scheduled.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_ready_cached_read_rebuilds_only_when_forced_or_the_keyring_changed() {
    let (setup, builder, keychain, host) = world(true);
    setup.cached(false, false).await.unwrap();
    // Cached and nothing changed: served as is; the keyring is still checked passively.
    let served = setup.get_setup(false, false, false, true).await.unwrap();
    assert_eq!(served["build"], json!(1));
    assert_eq!(*keychain.forced.lock().unwrap(), vec![true], "a focus recheck skips the snapshot TTL");
    assert_eq!(host.reloads.load(Ordering::SeqCst), 0);
    // A keyring that recovered, with an interactive unlock asked for.
    keychain.recovers.store(true, Ordering::SeqCst);
    let rebuilt = setup.get_setup(false, false, true, false).await.unwrap();
    assert_eq!(rebuilt["build"], json!(2));
    assert_eq!(*keychain.interactive.lock().unwrap(), vec![false, true]);
    assert_eq!(host.reloads.load(Ordering::SeqCst), 1);
    // Stored values changed under it.
    keychain.changes.store(true, Ordering::SeqCst);
    assert_eq!(setup.get_setup(false, false, false, false).await.unwrap()["build"], json!(3));
    assert_eq!(host.reloads.load(Ordering::SeqCst), 2);
    // A forced read reloads the config and rebuilds.
    assert_eq!(setup.get_setup(true, false, false, false).await.unwrap()["build"], json!(4));
    assert_eq!(host.reloads.load(Ordering::SeqCst), 3);
    assert_eq!(builder.builds.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn readers_that_meet_share_one_build_and_a_forced_one_waits_for_it_then_rebuilds() {
    let (setup, builder, _, _) = world(true);
    let (a, b) = tokio::join!(setup.cached(false, false), setup.cached(false, false));
    assert_eq!((a.unwrap()["build"].clone(), b.unwrap()["build"].clone()), (json!(1), json!(1)));
    assert_eq!(builder.builds.load(Ordering::SeqCst), 1);
    let forced = setup.cached(true, false).await.unwrap();
    assert_eq!(forced["build"], json!(2));
}

#[tokio::test]
async fn an_invalidated_cache_is_not_refilled_by_a_build_begun_before_it() {
    let (setup, _, _, _) = world(true);
    let slow = setup.clone();
    let building = tokio::spawn(async move { slow.cached(false, false).await });
    tokio::time::sleep(Duration::from_millis(5)).await;
    setup.invalidate();
    building.await.unwrap().unwrap();
    assert!(!setup.has_cached(), "the stale build answers its caller but fills nothing");
    assert_eq!(setup.cached(false, false).await.unwrap()["build"], json!(2));
}

#[tokio::test]
async fn the_proxy_mode_is_never_cached_and_a_failed_build_is_an_error() {
    let (setup, builder, _, host) = world(true);
    host.proxy.store(true, Ordering::SeqCst);
    setup.get_setup(false, false, false, false).await.unwrap();
    setup.get_setup(false, false, false, false).await.unwrap();
    assert_eq!(builder.builds.load(Ordering::SeqCst), 2);
    assert!(!setup.has_cached());
    host.proxy.store(false, Ordering::SeqCst);
    builder.fail.store(true, Ordering::SeqCst);
    let error = setup.cached(false, false).await.unwrap_err();
    assert_eq!(error.message(), "keychain unreachable");
    assert!(!setup.has_cached(), "a failure is not cached, so the next read tries again");
}

/// Node's two reads of a cold start (`fixtures/provider-setup-warmup/golden.json`, `record-provider-setup-warmup.mjs`):
/// the snapshot flagged `pendingSecrets`, then, once the warm-up built the setup, the authoritative one.
fn warmup_golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/provider-setup-warmup/golden.json")).unwrap()
}

/// Builds Node's recorded documents: the snapshot for the no-secrets build, the full setup otherwise.
struct Recorded(Value);

#[async_trait]
impl SetupBuilder for Recorded {
    async fn build(&self, options: SetupOptions) -> Result<Value, Failure> {
        Ok(self.0["built"][if options.check_secrets { "full" } else { "quick" }].clone())
    }
    async fn proxy(&self, _force: bool) -> Result<Value, Failure> {
        unreachable!("the recording is not the proxy mode")
    }
}

/// The recording has no keyring alert and no catalog failure, so both overlays leave the document as it is.
struct Plain;

impl SetupOverlays for Plain {
    fn with_live_keychain(&self, setup: Value) -> Value {
        setup
    }
    fn with_catalog_errors(&self, setup: Value) -> Value {
        setup
    }
}

#[tokio::test]
async fn the_pushed_section_follows_the_warmup_to_the_setup_nodes_next_read_answers() {
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_core_api::state::SectionChange;
    use mixdog_protocol::SectionName;

    use super::account::{SectionPush, republish_on_wakes};
    use super::collaborators::ProviderSetup;

    mixdog_rt::testing::tokens();
    let golden = warmup_golden();
    let keychain = Arc::new(Keychain { ready: AtomicBool::new(false), recovers: AtomicBool::new(false), changes: AtomicBool::new(false), interactive: Mutex::default(), forced: Mutex::default() });
    let setup = CachedProviderSetup::new(Arc::new(Recorded(golden.clone())), keychain, Arc::new(Plain), Arc::new(Host::default()));
    let publisher = Arc::new(MockStatePublisher::default());
    let pushed = Arc::new(SectionPush::new(publisher.clone()));
    let (_config, config_rx) = tokio::sync::watch::channel(0u64);
    let (done, mut published) = tokio::sync::mpsc::unbounded_channel();
    let section = {
        let (setup, pushed) = (setup.clone(), pushed.clone());
        move || {
            let (setup, pushed, done) = (setup.clone(), pushed.clone(), done.clone());
            async move {
                if let Ok(value) = setup.get_setup(false, false, false, false).await {
                    pushed.push(SectionName::ProviderSetup, None, value);
                }
                done.send(()).unwrap();
            }
        }
    };
    mixdog_rt::spawn("test-sections", mixdog_rt::TaskClass::Work, republish_on_wakes(config_rx, Arc::new(tokio::sync::Notify::new()), setup.filled(), section));
    // The section's first value, then the one the warm-up's fill wakes.
    published.recv().await.unwrap();
    published.recv().await.unwrap();
    let values: Vec<Value> = publisher
        .published()
        .iter()
        .map(|(_, _, change)| {
            let SectionChange::Set(bytes) = change else { panic!("a small value is carried whole") };
            serde_json::from_slice(bytes).unwrap()
        })
        .collect();
    assert_eq!(values, [golden["reads"][0]["value"].clone(), golden["reads"][1]["value"].clone()]);
}
