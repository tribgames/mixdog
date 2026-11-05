//! A hash map split over independently locked shards, so operations on unrelated keys never
//! contend on one lock. Critical sections are short and synchronous (RL §5.1); no guard is
//! ever held across an await.

use std::collections::HashMap;
use std::hash::BuildHasher;
use std::hash::Hash;
use std::hash::RandomState;
use std::sync::Mutex;
use std::sync::MutexGuard;

const SHARDS: usize = 32;

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) struct Sharded<K, V> {
    hasher: RandomState,
    shards: Box<[Mutex<HashMap<K, V>>]>,
}

impl<K: Hash + Eq, V> Sharded<K, V> {
    pub(crate) fn new() -> Self {
        Self::with_shards(SHARDS)
    }

    pub(crate) fn with_shards(count: usize) -> Self {
        Self {
            hasher: RandomState::new(),
            shards: (0..count).map(|_| Mutex::new(HashMap::new())).collect(),
        }
    }

    /// The shard that owns `key`, locked.
    pub(crate) fn shard(&self, key: &K) -> MutexGuard<'_, HashMap<K, V>> {
        let index = (self.hasher.hash_one(key) as usize) % self.shards.len();
        lock(&self.shards[index])
    }

    /// Every shard in turn, each locked only while its guard is alive.
    pub(crate) fn shards(&self) -> impl Iterator<Item = MutexGuard<'_, HashMap<K, V>>> {
        self.shards.iter().map(lock)
    }
}
