//! Ownership of in-process mutations: a claim covers a set of keys and waits
//! only for earlier claims that conflict with it, so unrelated work never
//! waits. Claims are taken up front and all at once, so opposite-order batches
//! cannot deadlock. Not an OS lock: other processes are outside the guarantee.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use tokio::sync::watch;

use crate::pathguard::comparable;

struct Entry<K> {
    id: u64,
    keys: Vec<K>,
    done: watch::Receiver<()>,
}

struct State<K> {
    next: u64,
    entries: Vec<Entry<K>>,
}

pub struct Claims<K> {
    state: Arc<Mutex<State<K>>>,
    conflicts: fn(&K, &K) -> bool,
}

impl<K> Clone for Claims<K> {
    fn clone(&self) -> Self {
        Self { state: self.state.clone(), conflicts: self.conflicts }
    }
}

/// Released on drop.
pub struct ClaimGuard<K> {
    state: Arc<Mutex<State<K>>>,
    id: u64,
    _done: watch::Sender<()>,
}

impl<K> Drop for ClaimGuard<K> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.entries.retain(|e| e.id != self.id);
        }
    }
}

impl<K: Clone> Claims<K> {
    pub fn new(conflicts: fn(&K, &K) -> bool) -> Self {
        Self { state: Arc::new(Mutex::new(State { next: 0, entries: Vec::new() })), conflicts }
    }

    pub async fn acquire(&self, keys: Vec<K>) -> ClaimGuard<K> {
        let (tx, rx) = watch::channel(());
        let (id, predecessors) = {
            let mut state = self.state.lock().expect("claims lock");
            let predecessors: Vec<watch::Receiver<()>> = state
                .entries
                .iter()
                .filter(|e| e.keys.iter().any(|l| keys.iter().any(|r| (self.conflicts)(l, r))))
                .map(|e| e.done.clone())
                .collect();
            let id = state.next;
            state.next += 1;
            state.entries.push(Entry { id, keys, done: rx });
            (id, predecessors)
        };
        let guard = ClaimGuard { state: self.state.clone(), id, _done: tx };
        for mut previous in predecessors {
            // The sender never sends: `changed` fails exactly when the holder is dropped.
            while previous.changed().await.is_ok() {}
        }
        guard
    }
}

/// Blocking claims on file identities, taken on a lane thread once a file is
/// open: all keys at once, so opposite-order batches cannot deadlock.
#[derive(Default)]
pub struct IdentityLocks {
    held: std::sync::Mutex<std::collections::HashSet<String>>,
    released: std::sync::Condvar,
}

pub struct IdentityGuard<'a> {
    locks: &'a IdentityLocks,
    keys: Vec<String>,
}

impl IdentityLocks {
    pub fn lock(&self, keys: Vec<String>) -> IdentityGuard<'_> {
        let mut held = self.held.lock().expect("identity locks");
        while keys.iter().any(|k| held.contains(k)) {
            held = self.released.wait(held).expect("identity locks");
        }
        held.extend(keys.iter().cloned());
        IdentityGuard { locks: self, keys }
    }
}

impl Drop for IdentityGuard<'_> {
    fn drop(&mut self) {
        let mut held = self.locks.held.lock().expect("identity locks");
        for key in &self.keys {
            held.remove(key);
        }
        self.locks.released.notify_all();
    }
}

/// Path claims: equal or ancestor/descendant paths conflict (case-folded for scheduling only).
pub fn path_claims() -> Claims<PathBuf> {
    Claims::new(|a, b| {
        let (a, b) = (comparable(a), comparable(b));
        a.starts_with(&b) || b.starts_with(&a)
    })
}

/// File-identity claims: only the same file conflicts.
pub fn identity_claims() -> Claims<String> {
    Claims::new(|a, b| a == b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disjoint_parallel_overlapping_ordered() {
        let claims = path_claims();
        let a = claims.acquire(vec![PathBuf::from("/p/a")]).await;
        let b = claims.acquire(vec![PathBuf::from("/p/b")]).await;
        let c_claims = claims.clone();
        let waiter = tokio::spawn(async move { c_claims.acquire(vec![PathBuf::from("/p")]).await.id });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        drop(a);
        drop(b);
        waiter.await.unwrap();
    }
}
