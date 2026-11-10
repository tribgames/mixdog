//! The process-wide registry of live explicit caches (`geminiGlobalCaches` in
//! `gemini-cache.mjs`): sessions with the same credential, model and prefix
//! share one `cachedContents` entry. Insertion order is eviction order, and
//! replacing a key keeps its place, as a JS `Map` does.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::Shared;
use mixdog_core_api::domain::provider::GeminiCacheState;

/// Headroom a cross-session hit needs: the provider's first-byte window plus setup.
const MIN_LIVE_MS: u64 = 75 * 1000;
const MAX_ENTRIES: usize = 128;
/// Grace before deleting a superseded name, so a session still mid-flight on it finishes.
pub const DELETE_GRACE_MS: u64 = 2 * 60 * 1000;

/// One live `cachedContents` entry (`geminiCacheEntry`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CacheEntry {
    pub cache_name: String,
    pub cache_created_at: u64,
    pub cache_expires_at: u64,
    pub cache_model: String,
    pub cache_token_size: u64,
    pub cache_prefix_content_count: usize,
    pub cache_prefix_hash: String,
    pub cache_credential_fingerprint: String,
}

impl CacheEntry {
    /// `_attachGeminiCacheState`: the session state for this entry at `iteration`.
    pub fn attach(&self, iteration: u32) -> GeminiCacheState {
        GeminiCacheState {
            cache_name: self.cache_name.clone(),
            cache_created_at: self.cache_created_at,
            cache_created_at_iter: iteration,
            cache_expires_at: self.cache_expires_at,
            cache_model: self.cache_model.clone(),
            cache_token_size: self.cache_token_size,
            cache_prefix_content_count: self.cache_prefix_content_count,
            cache_prefix_hash: self.cache_prefix_hash.clone(),
            cache_credential_fingerprint: self.cache_credential_fingerprint.clone(),
        }
    }
}

/// A create in flight, shared by its owner and every waiter.
pub type Create = Shared<oneshot::Receiver<Option<CacheEntry>>>;

/// What [`Registry::claim`] decided for a prefix key.
pub enum Claim {
    /// A live entry with enough headroom.
    Live(CacheEntry),
    /// Another caller is creating it: wait for that create.
    Join(Create),
    /// This caller creates it and must call [`Registry::finish`] exactly once.
    Own { done: oneshot::Sender<Option<CacheEntry>>, wait: Create },
}

#[derive(Default)]
struct Inner {
    entries: Vec<(String, CacheEntry)>,
    /// `geminiGlobalCacheCreates`: at most one create per key.
    flights: HashMap<String, Create>,
}

#[derive(Default)]
pub struct Registry {
    inner: Mutex<Inner>,
}

fn prune(entries: &mut Vec<(String, CacheEntry)>, now: u64) {
    entries.retain(|(_, e)| !e.cache_name.is_empty() && e.cache_expires_at > now);
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
}

impl Registry {
    /// The process-wide registry: sessions share caches across adapters.
    pub fn shared() -> Arc<Self> {
        static SHARED: OnceLock<Arc<Registry>> = OnceLock::new();
        SHARED.get_or_init(Arc::default).clone()
    }

    /// The process-wide registry as a new process has it: no cache, no create in flight.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn reset_shared() {
        *Self::shared().lock() = Inner::default();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn live(inner: &mut Inner, key: &str, now: u64) -> Option<CacheEntry> {
        prune(&mut inner.entries, now);
        let at = inner.entries.iter().position(|(k, _)| k == key)?;
        if inner.entries[at].1.cache_expires_at.saturating_sub(now) <= MIN_LIVE_MS {
            inner.entries.remove(at);
            return None;
        }
        Some(inner.entries[at].1.clone())
    }

    /// `_getGeminiGlobalCache`: a live entry with enough headroom left, else none
    /// (an entry short of it is dropped).
    pub fn get(&self, key: &str, now: u64) -> Option<CacheEntry> {
        Self::live(&mut self.lock(), key, now)
    }

    /// Check-or-join-or-create for `key` in one critical section, so exactly
    /// one caller in the process becomes the creator.
    pub fn claim(&self, key: &str, now: u64) -> Claim {
        let mut inner = self.lock();
        if let Some(entry) = Self::live(&mut inner, key, now) {
            return Claim::Live(entry);
        }
        if let Some(flight) = inner.flights.get(key) {
            return Claim::Join(flight.clone());
        }
        let (done, receiver) = oneshot::channel();
        let wait = receiver.shared();
        inner.flights.insert(key.to_owned(), wait.clone());
        Claim::Own { done, wait }
    }

    /// Ends the create `claim` granted: publishes `entry` and releases the
    /// key in one critical section (no instant with neither), then wakes the
    /// waiters.
    pub fn finish(&self, key: &str, entry: Option<CacheEntry>, done: oneshot::Sender<Option<CacheEntry>>, now: u64) {
        {
            let mut inner = self.lock();
            if let Some(entry) = entry.clone().filter(|e| !e.cache_name.is_empty()) {
                Self::put(&mut inner, key, entry, now);
            }
            inner.flights.remove(key);
        }
        let _ = done.send(entry);
    }

    /// Releases `key` without publishing: the create ended with nothing (or its
    /// task was dropped). Waiters resolve `None` when `done` drops with it.
    pub fn release(&self, key: &str) {
        self.lock().flights.remove(key);
    }

    fn put(inner: &mut Inner, key: &str, entry: CacheEntry, now: u64) {
        match inner.entries.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = entry,
            None => inner.entries.push((key.to_owned(), entry)),
        }
        prune(&mut inner.entries, now);
    }

    /// `_setGeminiGlobalCache`.
    pub fn set(&self, key: &str, entry: CacheEntry, now: u64) {
        if key.is_empty() || entry.cache_name.is_empty() {
            return;
        }
        Self::put(&mut self.lock(), key, entry, now);
    }

    /// `_geminiGlobalCacheNameIsLive`.
    pub fn name_is_live(&self, name: &str, now: u64) -> bool {
        !name.is_empty() && self.lock().entries.iter().any(|(_, e)| e.cache_name == name && e.cache_expires_at > now)
    }

    /// `_invalidateGeminiCacheName`.
    pub fn invalidate_name(&self, name: &str) {
        if !name.is_empty() {
            self.lock().entries.retain(|(_, e)| e.cache_name != name);
        }
    }

    /// `_invalidateGeminiCachesForCredentialFingerprint`.
    pub fn invalidate_credential(&self, fingerprint: &str) {
        if !fingerprint.is_empty() {
            self.lock().entries.retain(|(_, e)| e.cache_credential_fingerprint != fingerprint);
        }
    }
}
