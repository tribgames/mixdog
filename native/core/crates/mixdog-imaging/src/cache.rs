//! The resize cache of `resizeImageBuffer`: a least-recently-used map, bounded by the bytes of the renditions it
//! holds (64 MiB), keyed by a hash of the input bytes, the extension, the token budget and the profile. A hit hands
//! out a copy, so a caller can never change what the next caller gets.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;

use sha2::Digest;
use sha2::Sha256;

use crate::Resized;
use crate::policy::Profile;

/// `IMAGE_RESIZE_CACHE_MAX_BYTES`.
pub const IMAGE_RESIZE_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;

pub type CacheKey = [u8; 32];

/// `resizeCacheKey`: sha256 over the extension, the token budget, the profile and the bytes, NUL-separated.
pub fn resize_cache_key(bytes: &[u8], ext: &str, max_tokens: u64, profile: Profile) -> CacheKey {
    let mut hasher = Sha256::new();
    hasher.update(ext.as_bytes());
    hasher.update([0u8]);
    hasher.update(max_tokens.to_string().as_bytes());
    hasher.update([0u8]);
    hasher.update(profile.name().as_bytes());
    hasher.update([0u8]);
    hasher.update(bytes);
    hasher.finalize().into()
}

/// What `imageResizeCacheStats` reports.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CacheStats {
    pub entries: usize,
    pub bytes: usize,
    pub max_bytes: usize,
    pub hits: u64,
    pub misses: u64,
}

struct Slot<V> {
    value: V,
    bytes: usize,
    tick: u64,
}

/// A least-recently-used map bounded by the bytes of its values.
pub struct ByteLru<V> {
    max_bytes: usize,
    bytes: usize,
    slots: HashMap<CacheKey, Slot<V>>,
    /// Recency: the smallest tick is the oldest entry.
    order: BTreeMap<u64, CacheKey>,
    tick: u64,
    hits: u64,
    misses: u64,
}

impl<V: Clone> ByteLru<V> {
    pub fn new(max_bytes: usize) -> Self {
        Self { max_bytes, bytes: 0, slots: HashMap::new(), order: BTreeMap::new(), tick: 0, hits: 0, misses: 0 }
    }

    /// A copy of the cached value, refreshed to most recently used (`recallResizeResult`).
    pub fn get(&mut self, key: &CacheKey) -> Option<V> {
        let Some(slot) = self.slots.get_mut(key) else {
            self.misses += 1;
            return None;
        };
        self.hits += 1;
        self.tick += 1;
        self.order.remove(&slot.tick);
        slot.tick = self.tick;
        self.order.insert(self.tick, *key);
        Some(slot.value.clone())
    }

    /// Remembers `value` as `bytes` bytes (`rememberResizeResult`): nothing for an empty value or one bigger than the
    /// whole cache; the oldest entries leave until the rest fits.
    pub fn insert(&mut self, key: CacheKey, value: &V, bytes: usize) {
        if bytes == 0 || bytes > self.max_bytes {
            return;
        }
        if let Some(existing) = self.slots.remove(&key) {
            self.bytes -= existing.bytes;
            self.order.remove(&existing.tick);
        }
        self.tick += 1;
        self.slots.insert(key, Slot { value: value.clone(), bytes, tick: self.tick });
        self.order.insert(self.tick, key);
        self.bytes += bytes;
        while self.bytes > self.max_bytes {
            let Some((_, oldest)) = self.order.pop_first() else { break };
            if let Some(evicted) = self.slots.remove(&oldest) {
                self.bytes -= evicted.bytes;
            }
        }
    }

    pub fn stats(&self) -> CacheStats {
        CacheStats { entries: self.slots.len(), bytes: self.bytes, max_bytes: self.max_bytes, hits: self.hits, misses: self.misses }
    }
}

static RESIZE_CACHE: LazyLock<Mutex<ByteLru<Resized>>> = LazyLock::new(|| Mutex::new(ByteLru::new(IMAGE_RESIZE_CACHE_MAX_BYTES)));

fn locked() -> std::sync::MutexGuard<'static, ByteLru<Resized>> {
    RESIZE_CACHE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A cached rendition, or `None` on a miss.
pub(crate) fn recall(key: &CacheKey) -> Option<Resized> {
    locked().get(key)
}

pub(crate) fn remember(key: CacheKey, result: &Resized) {
    locked().insert(key, result, result.data.len());
}

/// `imageResizeCacheStats`.
pub fn image_resize_cache_stats() -> CacheStats {
    locked().stats()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> CacheKey {
        [n; 32]
    }

    #[test]
    fn the_key_depends_on_every_input() {
        let base = resize_cache_key(b"abc", "png", 100, Profile::Anthropic);
        assert_eq!(base, resize_cache_key(b"abc", "png", 100, Profile::Anthropic));
        assert_ne!(base, resize_cache_key(b"abd", "png", 100, Profile::Anthropic));
        assert_ne!(base, resize_cache_key(b"abc", "jpeg", 100, Profile::Anthropic));
        assert_ne!(base, resize_cache_key(b"abc", "png", 101, Profile::Anthropic));
        assert_ne!(base, resize_cache_key(b"abc", "png", 100, Profile::OpenAi));
        // The NUL separators keep ("a", "bc") apart from ("ab", "c").
        assert_ne!(resize_cache_key(b"c", "ab", 1, Profile::OpenAi), resize_cache_key(b"bc", "a", 1, Profile::OpenAi));
    }

    #[test]
    fn the_oldest_entry_leaves_first_and_a_hit_refreshes() {
        let mut cache: ByteLru<Vec<u8>> = ByteLru::new(10);
        cache.insert(key(1), &vec![1; 4], 4);
        cache.insert(key(2), &vec![2; 4], 4);
        assert_eq!(cache.get(&key(1)), Some(vec![1; 4]));
        cache.insert(key(3), &vec![3; 4], 4);
        assert_eq!(cache.get(&key(2)), None, "the least recently used entry is evicted");
        assert!(cache.get(&key(1)).is_some() && cache.get(&key(3)).is_some());
        let stats = cache.stats();
        assert_eq!((stats.entries, stats.bytes, stats.max_bytes, stats.hits, stats.misses), (2, 8, 10, 3, 1));
    }

    #[test]
    fn an_empty_or_oversized_value_is_not_kept_and_a_replacement_swaps_the_bytes() {
        let mut cache: ByteLru<u8> = ByteLru::new(10);
        cache.insert(key(1), &1, 0);
        cache.insert(key(2), &2, 11);
        assert_eq!(cache.stats().entries, 0);
        cache.insert(key(3), &3, 6);
        cache.insert(key(3), &4, 3);
        assert_eq!(cache.stats().bytes, 3);
        assert_eq!(cache.get(&key(3)), Some(4));
    }

    #[test]
    fn a_value_that_makes_the_total_too_big_evicts_until_it_fits() {
        let mut cache: ByteLru<u8> = ByteLru::new(10);
        for n in 1..=5 {
            cache.insert(key(n), &n, 3);
        }
        let stats = cache.stats();
        assert_eq!((stats.entries, stats.bytes), (3, 9));
        assert_eq!(cache.get(&key(1)), None);
        assert_eq!(cache.get(&key(5)), Some(5));
    }
}
