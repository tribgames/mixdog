//! The map-backed LRU of the per-stream markdown caches (`touchLru` of `src/tui/markdown/lru.mjs`): the most recently
//! inserted or read entry is last, the oldest entries are evicted when more than `max` remain.

use std::borrow::Borrow;
use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

pub struct Lru<K, V> {
    max: usize,
    entries: HashMap<K, V>,
    order: VecDeque<K>,
}

impl<K: Hash + Eq + Clone, V> Lru<K, V> {
    pub fn new(max: usize) -> Self {
        Self { max, entries: HashMap::new(), order: VecDeque::new() }
    }

    /// `touchLru(cache, key, value, max)`: inserts or refreshes `key` as the most recent entry, then evicts the oldest
    /// until at most `max` remain.
    pub fn touch(&mut self, key: K, value: V) {
        let stale = if self.entries.contains_key(&key) { self.order.iter().position(|k| *k == key) } else { None };
        if let Some(at) = stale {
            self.order.remove(at);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
        while self.entries.len() > self.max {
            let Some(oldest) = self.order.pop_front() else { break };
            self.entries.remove(&oldest);
        }
    }

    /// `cache.get(key)` followed by a refresh of a hit.
    pub fn get<Q>(&mut self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        if !self.entries.contains_key(key) {
            return None;
        }
        let at = self.order.iter().position(|k| Borrow::<Q>::borrow(k) == key);
        if let Some(entry) = at.and_then(|at| self.order.remove(at)) {
            self.order.push_back(entry);
        }
        self.entries.get(key)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_oldest_entry_goes_first_and_a_read_refreshes() {
        let mut cache: Lru<String, u32> = Lru::new(2);
        cache.touch("a".to_owned(), 1);
        cache.touch("b".to_owned(), 2);
        assert_eq!(cache.get("a"), Some(&1));
        cache.touch("c".to_owned(), 3);
        assert_eq!(cache.get("b"), None);
        assert_eq!(cache.get("a"), Some(&1));
        assert_eq!(cache.get("c"), Some(&3));
        assert_eq!(cache.len(), 2);
        cache.touch("a".to_owned(), 9);
        assert_eq!(cache.get("a"), Some(&9));
        assert_eq!(cache.len(), 2);
        assert!(!cache.is_empty());
    }
}
