//! The keychain health Node tracks (`lib/keychain-cjs.cjs` `_keychainStatus` / `keychainStatus()`):
//! it starts `unknown`, becomes `ok` when a keychain call succeeds, and takes its state from the
//! message of a failure: the unreachable report is `unreachable`, a message saying `not installed`
//! is `missing`, `locked` or `timed out` is `locked`, anything else `error`. `fallback` (the host has
//! no keychain provider, so the private secrets file serves) is true only on Linux, and only after
//! a failure that confirmed it. A failure that is not a "no provider / unreachable" report raises a
//! desktop notice (`secret-storage-failed`). The sync outcomes of Node's blocking calls feed the
//! same health on Linux only.
//!
//! [`TrackedStore`] wraps a keychain store and notes the outcome of every call it makes, as Node's
//! async entry points do (`getSecretAsync`, `setSecretAsync`, `deleteSecretAsync`). A call whose
//! lane job never ran says nothing about the keychain and is not noted.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;

use super::SecretError;
use super::SecretStore;
use super::Unsafe;

/// The error code Node's failure carries: `KEYRING_UNAVAILABLE` (no provider on the host) or
/// `KEYRING_UNREACHABLE` (an inconclusive probe).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FailureCode {
    Other,
    Unavailable,
    Unreachable,
}

#[derive(Clone)]
struct Raw {
    state: String,
    message: String,
    unavailable: bool,
}

/// `keychainStatus()` without the private file's layout (see [`StatusTracker::unsafe_store`]).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Snapshot {
    pub state: String,
    pub message: String,
    pub fallback: bool,
}

pub struct StatusTracker {
    raw: Mutex<Raw>,
    linux: bool,
    notice: Arc<dyn Fn() + Send + Sync>,
    /// The layout problem of the private secrets file, read on a lane and kept (it needs a file read).
    unsafe_store: Mutex<Option<(PathBuf, Unsafe)>>,
}

impl StatusTracker {
    /// `linux` is the platform rule of Node's `platform() === 'linux'`; `notice` raises the desktop
    /// notice (`secret-storage-failed`).
    pub fn new(linux: bool, notice: Arc<dyn Fn() + Send + Sync>) -> Arc<Self> {
        let raw = Mutex::new(Raw { state: "unknown".into(), message: String::new(), unavailable: false });
        Arc::new(Self { raw, linux, notice, unsafe_store: Mutex::new(None) })
    }

    fn raw(&self) -> std::sync::MutexGuard<'_, Raw> {
        self.raw.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `_noteKeychainOk()`.
    pub fn note_ok(&self) {
        *self.raw() = Raw { state: "ok".into(), message: String::new(), unavailable: false };
    }

    /// `_noteKeychainFailure(error)`.
    pub fn note_failure(&self, message: &str, code: FailureCode) {
        let state = if code == FailureCode::Unreachable {
            "unreachable"
        } else if message.contains("not installed") {
            "missing"
        } else if message.contains("locked") || message.contains("timed out") {
            "locked"
        } else {
            "error"
        };
        *self.raw() = Raw { state: state.into(), message: message.to_owned(), unavailable: code == FailureCode::Unavailable };
        // No provider at all means the private file serves instead (a working store), and an
        // inconclusive passive probe proves no failure.
        if code == FailureCode::Other {
            (self.notice)();
        }
    }

    /// `_noteSyncOutcome(error)`: the blocking calls feed the health on Linux only.
    pub fn note_sync_outcome(&self, failure: Option<(&str, FailureCode)>) {
        if !self.linux {
            return;
        }
        match failure {
            Some((message, code)) => self.note_failure(message, code),
            None => self.note_ok(),
        }
    }

    /// `keychainStatus()` (the part that needs no file read).
    pub fn snapshot(&self) -> Snapshot {
        let raw = self.raw().clone();
        Snapshot { state: raw.state, message: raw.message, fallback: raw.unavailable && self.linux }
    }

    /// Whether this is the Linux rule (retry and refresh exist only there).
    pub fn is_linux(&self) -> bool {
        self.linux
    }

    /// Keeps the private file's layout problem, read on a lane by the caller (`fallbackUnsafeStore`).
    pub fn set_unsafe_store(&self, found: Option<(PathBuf, Unsafe)>) {
        *self.unsafe_store.lock().unwrap_or_else(PoisonError::into_inner) = found;
    }

    /// The layout problem kept by [`Self::set_unsafe_store`]; only meaningful while `fallback`.
    pub fn unsafe_store(&self) -> Option<(PathBuf, Unsafe)> {
        self.unsafe_store.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

/// A keychain store whose every outcome is noted in a [`StatusTracker`].
pub struct TrackedStore {
    inner: Arc<dyn SecretStore>,
    tracker: Arc<StatusTracker>,
}

impl TrackedStore {
    pub fn new(inner: Arc<dyn SecretStore>, tracker: Arc<StatusTracker>) -> Self {
        Self { inner, tracker }
    }

    fn note<T>(&self, result: &Result<T, SecretError>) {
        match result {
            Ok(_) => self.tracker.note_ok(),
            Err(error) if error.unrun => {}
            Err(error) => self.tracker.note_failure(&error.message, if error.no_provider { FailureCode::Unavailable } else { FailureCode::Other }),
        }
    }
}

#[async_trait]
impl SecretStore for TrackedStore {
    async fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        let result = self.inner.get(account).await;
        self.note(&result);
        result
    }

    async fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        let result = self.inner.set(account, value).await;
        self.note(&result);
        result
    }

    async fn delete(&self, account: &str) -> Result<(), SecretError> {
        let result = self.inner.delete(account).await;
        self.note(&result);
        result
    }

    async fn is_fallback(&self, account: &str) -> Result<bool, SecretError> {
        self.inner.is_fallback(account).await
    }
}
