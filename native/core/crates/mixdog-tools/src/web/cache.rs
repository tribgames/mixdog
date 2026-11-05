//! Bounded in-memory result cache: entry expiry plus entry-count and byte caps,
//! evicting the oldest insert first. The lock is held only for map edits.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

const MAX_ENTRIES: usize = 500;
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Node `buildCacheKey`: `namespace:` + the SHA-256 of `JSON.stringify(payload)`.
pub fn node_cache_key(namespace: &str, payload: &Value) -> String {
    let digest = Sha256::digest(mixdog_js::json_stringify(payload).as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{namespace}:{hex}")
}

/// Node `approxEntryBytes` without the key: the `JSON.stringify` length (UTF-16 units) of the
/// entry Node stores, `{ cachedAt, expiresAt, payload }`.
pub fn node_entry_size(payload: &Value, ttl: Duration) -> usize {
    let cached_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(0));
    let expires_at = cached_at + u64::try_from(ttl.as_millis()).unwrap_or(0);
    let entry = json!({ "cachedAt": cached_at, "expiresAt": expires_at, "payload": payload });
    mixdog_js::utf16_len(&mixdog_js::json_stringify(&entry))
}

struct Entry<V> {
    cached_at: Instant,
    expires_at: Instant,
    bytes: usize,
    value: Arc<V>,
}

struct Inner<V> {
    entries: HashMap<String, Entry<V>>,
    bytes: usize,
}

pub struct TtlCache<V> {
    inner: Mutex<Inner<V>>,
}

impl<V> Default for TtlCache<V> {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                entries: HashMap::new(),
                bytes: 0,
            }),
        }
    }
}

impl<V> Inner<V> {
    fn remove(&mut self, key: &str) {
        if let Some(entry) = self.entries.remove(key) {
            self.bytes -= entry.bytes;
        }
    }

    fn evict_oldest(&mut self) -> bool {
        let oldest = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.cached_at)
            .map(|(key, _)| key.clone());
        match oldest {
            Some(key) => {
                self.remove(&key);
                true
            }
            None => false,
        }
    }
}

impl<V> TtlCache<V> {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner<V>> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn get(&self, key: &str) -> Option<Arc<V>> {
        let mut inner = self.lock();
        let entry = inner.entries.get(key)?;
        if entry.expires_at <= Instant::now() {
            inner.remove(key);
            return None;
        }
        Some(entry.value.clone())
    }

    /// `size` is the caller's estimate of the entry's weight in bytes.
    pub fn put(&self, key: String, value: Arc<V>, size: usize, ttl: Duration) {
        let mut inner = self.lock();
        inner.remove(&key);
        let now = Instant::now();
        let bytes = key.len() + size;
        inner.bytes += bytes;
        inner.entries.insert(
            key,
            Entry {
                cached_at: now,
                expires_at: now + ttl,
                bytes,
                value,
            },
        );
        while inner.entries.len() > MAX_ENTRIES || inner.bytes > MAX_BYTES {
            if !inner.evict_oldest() {
                break;
            }
        }
    }
}
