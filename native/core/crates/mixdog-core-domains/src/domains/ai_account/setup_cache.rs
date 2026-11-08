//! The cached provider setup: `getProviderSetup` of `session-runtime/provider-auth/setup.mjs` over
//! `cachedProviderSetup` of `session-runtime/provider-usage.mjs`.
//!
//! An unforced read never blocks on the OS keychain: until the keychain warm-up is done and a
//! complete setup is cached it answers the no-secrets snapshot, flagged `pendingSecrets`, and lets a
//! background read publish the authoritative one. A complete read waits for the warm-up, retries a
//! locked keyring, re-checks the keychain passively and overlays what is live (the keyring alert,
//! the catalog failures). Everything the flow reads of the process is a seam below, so the flow is
//! what is tested: the builder is [`SetupBuilder`] (the gatherer in `setup_world.rs`), the keychain
//! is [`KeychainLive`], the overlays are [`SetupOverlays`] and the boot's own switches
//! [`SetupHost`].

use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde_json::{Value, json};
use tokio::sync::watch;

use super::collaborators::ProviderSetup;
use super::failure::Failure;
use super::provider_setup::{KeychainStatus, SetupOptions};

/// `providerSetup(displayConfig(), options)`: one full build of the setup document. In the
/// model-proxy client mode it answers the proxy's projection instead.
#[async_trait]
pub trait SetupBuilder: Send + Sync {
    async fn build(&self, options: SetupOptions) -> Result<Value, Failure>;
    /// `providerSetup` in the model-proxy client mode: the projection of what the PC advertised (`force` asks it afresh).
    async fn proxy(&self, force: bool) -> Result<Value, Failure>;
}

/// The keychain as the setup flow sees it (`keychain-cjs` through `shared/config.mjs`).
#[async_trait]
pub trait KeychainLive: Send + Sync {
    /// `getKeychainStatus()`.
    fn status(&self) -> KeychainStatus;
    /// `rt.keychainPrewarmWaitDone`.
    fn prewarm_ready(&self) -> bool;
    /// `awaitKeychainPrewarm()`.
    async fn await_prewarm(&self);
    /// `retryKeychain({ interactive })`: true when a failed keyring just recovered.
    async fn retry(&self, interactive: bool) -> bool;
    /// `refreshKeychainStatus({ force })`: true when the stored values changed.
    async fn refresh(&self, force: bool) -> bool;
}

/// What is overlaid on a setup on every read, because it changes while a cached one is served.
pub trait SetupOverlays: Send + Sync {
    /// `withLiveKeychain`: the setup without its stale `keychain`, plus the live alert if any.
    fn with_live_keychain(&self, setup: Value) -> Value;
    /// `withCatalogErrors`: a provider whose model list failed says why on its row.
    fn with_catalog_errors(&self, setup: Value) -> Value;
}

/// The boot's own switches around the setup.
pub trait SetupHost: Send + Sync {
    /// `modelProxyClientMode()`.
    fn model_proxy_client(&self) -> bool;
    /// `reloadFullConfig()`.
    fn reload_full_config(&self);
    /// `getProviderSetupWarmupTimer()`: a warm-up is already scheduled.
    fn warmup_pending(&self) -> bool;
    /// `scheduleProviderSetupWarmup(0)`.
    fn schedule_warmup(&self);
    /// `isCloseRequested()`.
    fn closing(&self) -> bool;
}

type Building = Shared<BoxFuture<'static, Result<Value, String>>>;

#[derive(Default)]
struct State {
    setup: Option<Value>,
    quick: Option<Value>,
    pending: Option<(u64, Building)>,
    /// Counts builds, so a finished one knows whether it is still the current one.
    builds: u64,
    quick_requests: u64,
    /// Bumped by [`CachedProviderSetup::invalidate`]: a build begun before it never fills a cache.
    generation: u64,
}

struct Inner {
    builder: Arc<dyn SetupBuilder>,
    keychain: Arc<dyn KeychainLive>,
    overlays: Arc<dyn SetupOverlays>,
    host: Arc<dyn SetupHost>,
    state: Mutex<State>,
    /// Counts the complete setups that filled the cache (the readers of the pushed section wake on it).
    filled: watch::Sender<u64>,
}

#[derive(Clone)]
pub struct CachedProviderSetup(Arc<Inner>);

impl CachedProviderSetup {
    pub fn new(builder: Arc<dyn SetupBuilder>, keychain: Arc<dyn KeychainLive>, overlays: Arc<dyn SetupOverlays>, host: Arc<dyn SetupHost>) -> Self {
        Self(Arc::new(Inner { builder, keychain, overlays, host, state: Mutex::new(State::default()), filled: watch::channel(0).0 }))
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `hasProviderSetupCached()`.
    pub fn has_cached(&self) -> bool {
        self.state().setup.is_some()
    }

    /// `invalidateProviderCaches` for the setup: both snapshots and any build in flight are dropped.
    pub fn invalidate(&self) {
        let mut state = self.state();
        state.setup = None;
        state.quick = None;
        state.pending = None;
        state.generation += 1;
    }

    /// `cachedProviderSetup({ force, quick })`.
    pub async fn cached(&self, force: bool, quick: bool) -> Result<Value, Failure> {
        let inner = &self.0;
        // The proxy owns a short cache of its own; a session's indefinite one would hide PC sign-ins.
        if inner.host.model_proxy_client() {
            return inner.builder.proxy(force).await;
        }
        if !force {
            if let Some(setup) = self.state().setup.clone() {
                return Ok(setup);
            }
        }
        if quick {
            return self.quick(force).await;
        }
        let pending = self.state().pending.as_ref().map(|(_, building)| building.clone());
        if let Some(building) = pending {
            let setup = building.await.map_err(Failure::error)?;
            if !force {
                return Ok(setup);
            }
        }
        let (id, generation, building) = {
            let mut state = self.state();
            state.builds += 1;
            let id = state.builds;
            let builder = Arc::clone(&inner.builder);
            let building: Building = async move { builder.build(SetupOptions { check_secrets: true, detect_local: true }).await.map_err(|failure| failure.message().to_owned()) }.boxed().shared();
            state.pending = Some((id, building.clone()));
            (id, state.generation, building)
        };
        let result = building.await;
        let mut state = self.state();
        if state.pending.as_ref().is_some_and(|(current, _)| *current == id) {
            state.pending = None;
            if let (Ok(setup), true) = (&result, state.generation == generation) {
                state.setup = Some(setup.clone());
                self.0.filled.send_modify(|count| *count += 1);
            }
        }
        result.map_err(Failure::error)
    }

    async fn quick(&self, force: bool) -> Result<Value, Failure> {
        if !force {
            if let Some(quick) = self.state().quick.clone() {
                return Ok(quick);
            }
        }
        let (request, generation) = {
            let mut state = self.state();
            state.quick_requests += 1;
            (state.quick_requests, state.generation)
        };
        let setup = self.0.builder.build(SetupOptions { check_secrets: false, detect_local: false }).await?;
        let schedule = {
            let mut state = self.state();
            let current = state.quick_requests == request && state.generation == generation;
            if current {
                state.quick = Some(setup.clone());
            }
            current && state.pending.is_none()
        };
        if schedule && !self.0.host.warmup_pending() && !self.0.host.closing() {
            self.0.host.schedule_warmup();
        }
        Ok(setup)
    }

    /// `getProviderSetup(options)`.
    pub async fn get_setup(&self, force: bool, refresh: bool, unlock_keychain: bool, recheck_keychain: bool) -> Result<Value, Failure> {
        let inner = &self.0;
        let force = force || refresh;
        if inner.host.model_proxy_client() {
            return self.cached(force || recheck_keychain, false).await;
        }
        let ready = inner.keychain.prewarm_ready();
        if !force && (!ready || !self.has_cached()) {
            let quick = self.cached(false, true).await?;
            let this = self.clone();
            mixdog_rt::spawn("provider-setup-warmup", mixdog_rt::TaskClass::Work, async move {
                this.0.keychain.await_prewarm().await;
                let _ = this.cached(false, false).await;
            });
            let mut flagged = quick;
            if let Value::Object(map) = &mut flagged {
                map.insert("pendingSecrets".into(), json!(!ready));
            }
            return Ok(inner.overlays.with_catalog_errors(flagged));
        }
        inner.keychain.await_prewarm().await;
        // A keyring the user has since unlocked: rebuild the setup cached while every key read as absent.
        let recovered = inner.keychain.retry(unlock_keychain).await;
        if force || recovered {
            inner.host.reload_full_config();
        }
        // Passive: detects a re-locked keyring and re-snapshots a stale cache so external changes show.
        let changed = inner.keychain.refresh(recheck_keychain).await;
        if changed {
            inner.host.reload_full_config();
        }
        let setup = self.cached(force || recovered || changed, false).await?;
        Ok(inner.overlays.with_catalog_errors(inner.overlays.with_live_keychain(setup)))
    }
}

#[async_trait]
impl ProviderSetup for CachedProviderSetup {
    async fn get(&self, force: bool, refresh: bool, unlock_keychain: bool, recheck_keychain: bool) -> Result<Value, Failure> {
        self.get_setup(force, refresh, unlock_keychain, recheck_keychain).await
    }

    fn filled(&self) -> watch::Receiver<u64> {
        self.0.filled.subscribe()
    }
}
