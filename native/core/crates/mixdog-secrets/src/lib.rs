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
}

impl SecretError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), no_provider: false }
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
    /// checked, elsewhere a failed read counts as "no".
    async fn has(&self, account: &str) -> bool {
        matches!(self.get(account).await, Ok(Some(_)))
    }
}

/// Runs a blocking closure on the durability lane.
pub(crate) async fn on_lane<T: Send + 'static>(
    io: DurabilityIo,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, SecretError> {
    let job = io.submit(&CancellationToken::new(), move |_lane| work()).map_err(|_| SecretError::new("the durability lane is full"))?;
    job.await.map_err(|e| SecretError::new(format!("{e:?}")))
}

/// `MIXDOG_KEYCHAIN_TIMEOUT_MS` (default 15 s): the bound on every keychain provider call.
#[allow(dead_code, reason = "used by the Linux and macOS providers")]
pub(crate) fn keychain_timeout() -> std::time::Duration {
    let millis = std::env::var("MIXDOG_KEYCHAIN_TIMEOUT_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|m| *m > 0).unwrap_or(15_000);
    std::time::Duration::from_millis(millis)
}

/// The store a daemon uses: the OS keychain, with the private secrets file behind it on Linux.
pub fn default_store(io: DurabilityIo, plugin_data: &Path) -> Arc<dyn SecretStore> {
    #[cfg(windows)]
    return Arc::new(windows::DpapiStore::new(io, plugin_data));
    #[cfg(target_os = "macos")]
    {
        // The macOS keychain is not under the plugin data dir.
        let _ = plugin_data;
        return Arc::new(macos::KeychainStore::new(io));
    }
    #[cfg(target_os = "linux")]
    return Arc::new(fallback::FallbackStore::new(Arc::new(linux::SecretServiceStore::new()), plugin_data, io));
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = (io, plugin_data);
        Arc::new(MemoryStore::default())
    }
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
