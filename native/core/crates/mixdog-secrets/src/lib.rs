//! The one secret store of the core, byte-compatible with Node's `lib/keychain-cjs.cjs` so keys and
//! sign-ins saved before the upgrade are found after it. An account is a plain string
//! (`agent.<providerId>.apiKey`, `mcp-oauth.<sha256>`, …) under the service name `mixdog`.
//!
//! - Windows: a DPAPI file `<plugin data>/secrets/<account>.dpapi` holding the base64 of
//!   `CryptProtectData(utf8 value, no entropy, current user)`.
//! - macOS: a generic-password item `-a <account> -s mixdog`.
//! - Linux: a Secret Service item with attributes `service=mixdog`, `account=<account>`, label
//!   `mixdog <account>`. On a host that positively has no provider (no bus, no service) a private
//!   file `<plugin data>/secrets/<encodeURIComponent(account)>.secret` serves instead.
//!
//! Values are never chunked: a value over a platform's limit fails as it does in Node. Blocking
//! calls run on the durability lane.

mod fallback;
mod status;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use tokio_util::sync::CancellationToken;

pub use fallback::Unsafe;
pub use status::FailureCode;
pub use status::Snapshot;
pub use status::StatusTracker;
pub use status::TrackedStore;
pub use fallback::unsafe_store;

/// The keychain service every item is stored under.
pub const SERVICE: &str = "mixdog";

/// A secret store failure (a locked or unavailable keychain).
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[error("{message}")]
pub struct SecretError {
    pub message: String,
    /// The host positively has no keychain provider (not a locked or failing keychain).
    pub no_provider: bool,
    /// The job that would have made the keychain call never ran (the durability lane was full or
    /// dropped it). It says nothing about the secret: a presence check must report it as an
    /// error, never as "not stored".
    pub unrun: bool,
}

impl SecretError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), no_provider: false, unrun: false }
    }

    /// A call whose lane job never ran.
    pub fn unrun(message: impl Into<String>) -> Self {
        Self { message: message.into(), no_provider: false, unrun: true }
    }
}

#[async_trait]
pub trait SecretStore: Send + Sync {
    /// The stored value; `None` when the account holds nothing.
    async fn get(&self, account: &str) -> Result<Option<String>, SecretError>;
    async fn set(&self, account: &str, value: &str) -> Result<(), SecretError>;
    /// Removes the account; nothing stored is not an error.
    async fn delete(&self, account: &str) -> Result<(), SecretError>;
    /// Whether the account holds a value (`hasSecret`): on Windows only the file's existence is
    /// checked, elsewhere a read that FAILED counts as "no" (Node's `catch`). `Err` only when the
    /// check never ran ([`SecretError::unrun`]), which must not read as "not signed in".
    async fn has(&self, account: &str) -> Result<bool, SecretError> {
        match self.get(account).await {
            Ok(value) => Ok(value.is_some()),
            Err(error) if error.unrun => Err(error),
            Err(_) => Ok(false),
        }
    }
    /// `Err` only for an [`unrun`](SecretError::unrun) check: it must not read as "the keychain".
    async fn is_fallback(&self, _account: &str) -> Result<bool, SecretError> {
        Ok(false)
    }
}

/// Runs a blocking closure on the durability lane.
pub(crate) async fn on_lane<T: Send + 'static>(
    io: DurabilityIo,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, SecretError> {
    let job = io.submit(&CancellationToken::new(), move |_lane| work()).map_err(|_| SecretError::unrun("the durability lane is full"))?;
    job.await.map_err(|e| SecretError::unrun(format!("{e:?}")))
}

/// `MIXDOG_KEYCHAIN_TIMEOUT_MS` (default 15 s): the bound on every keychain provider call.
#[allow(dead_code, reason = "used by the Linux and macOS providers")]
pub(crate) fn keychain_timeout() -> std::time::Duration {
    let millis = std::env::var("MIXDOG_KEYCHAIN_TIMEOUT_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|m| *m > 0).unwrap_or(15_000);
    std::time::Duration::from_millis(millis)
}

/// The store a daemon uses: the OS keychain, with the private secrets file behind it on Linux.
pub fn default_store(io: DurabilityIo, plugin_data: &Path) -> Arc<dyn SecretStore> {
    default_store_with_status(io, plugin_data, Arc::new(|| {})).0
}

/// [`default_store`] and the health of its keychain (`keychainStatus()`): every call the keychain
/// itself answers is noted (the private file behind it is not part of the keychain's health, as in
/// Node). `notice` raises the desktop notice a failure that is not a "no provider / unreachable"
/// report calls for.
pub fn default_store_with_status(io: DurabilityIo, plugin_data: &Path, notice: Arc<dyn Fn() + Send + Sync>) -> (Arc<dyn SecretStore>, Arc<StatusTracker>) {
    let tracker = StatusTracker::new(cfg!(target_os = "linux"), notice);
    #[cfg(windows)]
    let keychain: Arc<dyn SecretStore> = Arc::new(windows::DpapiStore::new(io, plugin_data));
    #[cfg(target_os = "macos")]
    // The macOS keychain is not under the plugin data dir.
    let keychain: Arc<dyn SecretStore> = Arc::new(macos::KeychainStore::new(io));
    #[cfg(target_os = "linux")]
    let keychain: Arc<dyn SecretStore> = Arc::new(linux::SecretServiceStore::new());
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let keychain: Arc<dyn SecretStore> = Arc::new(MemoryStore::default());
    let tracked: Arc<dyn SecretStore> = Arc::new(TrackedStore::new(keychain, Arc::clone(&tracker)));
    #[cfg(target_os = "linux")]
    let store: Arc<dyn SecretStore> = Arc::new(fallback::FallbackStore::new(tracked, plugin_data, io));
    #[cfg(not(target_os = "linux"))]
    let store = {
        let _ = (io, plugin_data);
        tracked
    };
    (store, tracker)
}
/// An in-process store (tests, and hosts with no keychain that accept losing sign-ins on exit).
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, String>>,
}

#[async_trait]
impl SecretStore for MemoryStore {
    async fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        Ok(self.entries.lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned())
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).insert(account.to_owned(), value.to_owned());
        Ok(())
    }

    async fn delete(&self, account: &str) -> Result<(), SecretError> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A store whose `get` fails the way the test says.
    struct Reads(SecretError);

    #[async_trait]
    impl SecretStore for Reads {
        async fn get(&self, _: &str) -> Result<Option<String>, SecretError> {
            Err(self.0.clone())
        }
        async fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
            Ok(())
        }
        async fn delete(&self, _: &str) -> Result<(), SecretError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn presence_is_a_value_when_the_check_ran_and_an_error_when_it_never_ran() {
        let store = MemoryStore::default();
        assert_eq!(store.has("a").await, Ok(false));
        store.set("a", "v").await.unwrap();
        assert_eq!(store.has("a").await, Ok(true));
        // A keychain read that failed is "no", as Node's `hasSecret` catch has it.
        assert_eq!(Reads(SecretError::new("[keychain] locked")).has("a").await, Ok(false));
        // A check whose lane job never ran is neither: it must not read as "not signed in".
        let unrun = SecretError::unrun("the durability lane is full");
        assert_eq!(Reads(unrun.clone()).has("a").await, Err(unrun));
    }
}

#[cfg(test)]
mod status_tests;
