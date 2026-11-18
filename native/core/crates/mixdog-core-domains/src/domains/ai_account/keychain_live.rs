//! The keychain as the provider setup flow sees it ([`KeychainLive`]): the health
//! `mixdog_secrets::StatusTracker` keeps (Node's `keychainStatus()`), and the retry and passive
//! re-check of `shared/config.mjs` (`retryKeychain`, `refreshKeychainStatus`).
//!
//! Node's retry and refresh exist only on Linux (`platform() !== 'linux'` answers false). There they
//! drive a snapshot cache (`prewarmSecrets`, a TTL, background retries) that the Rust store does not
//! have: it asks the keyring per call and never caches a credential here. Focus checks the
//! collection without prompting; an explicit retry may ask Secret Service to unlock it.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_rt::CancellationToken;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use mixdog_secrets::SecretStore;
use mixdog_secrets::StatusTracker;

use super::provider_setup::KeychainStatus;
use super::provider_setup::UnsafeStore;
use super::setup_cache::KeychainLive;

pub struct HolderLive {
    tracker: Arc<StatusTracker>,
    /// The tracked keychain store: a probe through it updates the health.
    probe: Arc<dyn SecretStore>,
    io: DurabilityIo,
    plugin_data: PathBuf,
}

impl HolderLive {
    pub fn new(tracker: Arc<StatusTracker>, probe: Arc<dyn SecretStore>, io: DurabilityIo, plugin_data: PathBuf) -> Self {
        Self { tracker, probe, io, plugin_data }
    }

    /// Reads the private file's layout problem on the lane and keeps it for `status()`.
    async fn read_unsafe_store(&self) {
        let path = self.plugin_data.clone();
        let job = LaneToken::submit_wait(self.io, &CancellationToken::new(), move |_| mixdog_secrets::unsafe_store(&path)).await;
        if let Ok(job) = job
            && let Ok(found) = job.await {
            self.tracker.set_unsafe_store(found);
        }
    }
}

#[async_trait]
impl KeychainLive for HolderLive {
    fn status(&self) -> KeychainStatus {
        let snapshot = self.tracker.snapshot();
        let unsafe_store = snapshot.fallback.then(|| self.tracker.unsafe_store()).flatten().map(|(path, kind)| UnsafeStore {
            kind: match kind {
                mixdog_secrets::Unsafe::Type => "type",
                mixdog_secrets::Unsafe::Owner => "owner",
                mixdog_secrets::Unsafe::Permissions => "permissions",
            }
            .to_owned(),
            path: path.to_string_lossy().into_owned(),
        });
        KeychainStatus { state: snapshot.state, fallback: snapshot.fallback, unsafe_store }
    }

    fn prewarm_ready(&self) -> bool {
        true
    }

    async fn await_prewarm(&self) {
        self.read_unsafe_store().await;
    }

    async fn retry(&self, interactive: bool) -> bool {
        let state = self.tracker.snapshot().state;
        if !interactive || !self.tracker.is_linux() || state == "ok" {
            return false;
        }
        let recovered = self.probe.probe_keychain(true).await.is_ok();
        self.read_unsafe_store().await;
        recovered
    }

    async fn refresh(&self, force: bool) -> bool {
        if !force || !self.tracker.is_linux() {
            return false;
        }
        let before = self.tracker.snapshot();
        let _ = self.probe.probe_keychain(false).await;
        let after = self.tracker.snapshot();
        if after.fallback {
            self.read_unsafe_store().await;
        }
        before.state != after.state || before.fallback != after.fallback
    }
}
