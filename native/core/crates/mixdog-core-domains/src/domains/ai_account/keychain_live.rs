//! The keychain as the provider setup flow sees it ([`KeychainLive`]): the health
//! `mixdog_secrets::StatusTracker` keeps (Node's `keychainStatus()`), and the retry and passive
//! re-check of `shared/config.mjs` (`retryKeychain`, `refreshKeychainStatus`).
//!
//! Node's retry and refresh exist only on Linux (`platform() !== 'linux'` answers false). There they
//! drive a snapshot cache (`prewarmSecrets`, a TTL, background retries) that the Rust store does not
//! have: it asks the keyring per call, so nothing is cached to go stale and there is nothing to
//! prewarm (`prewarm_ready` is always true). What remains of the contract:
//! * `retry(interactive)` re-asks the keyring (one lookup through the tracked store, which notes
//!   the outcome) only when it is failing and an unlock prompt is allowed; a non-interactive retry
//!   would prompt, which the Rust Secret Service client cannot avoid, so it changes nothing.
//!   It answers whether the keyring is now `ok`.
//! * `refresh` re-snapshots a cache that does not exist: it never reports a change.
//!
//! The Linux behaviour has no Node golden yet (recorded on the Linux build host, see the request).

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

/// The account the retry looks up: nothing is stored under it; the answer only tells whether the
/// keyring responds.
const PROBE_ACCOUNT: &str = "agent.keychain-probe";

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
        if let Ok(job) = job {
            if let Ok(found) = job.await {
                self.tracker.set_unsafe_store(found);
            }
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
        if !self.tracker.is_linux() || state == "ok" || state == "unknown" {
            return false;
        }
        if interactive {
            let _ = self.probe.get(PROBE_ACCOUNT).await;
            self.read_unsafe_store().await;
        }
        self.tracker.snapshot().state == "ok"
    }

    async fn refresh(&self, _force: bool) -> bool {
        false
    }
}
