//! The pool of idle connections, by hand: undici's pool hands a request to the first free client in the order the
//! clients were created, and a client's idle socket closes when its keep-alive runs out (`client-h1.js`
//! `keepAliveTimeout`), not when another request next looks at it.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use bytes::Bytes;
use tokio::time::Instant;

use super::h1::Conn;

pub enum Idle {
    /// `conn.born` is the connection's creation number; the list of a key is kept in that order. `stamp` tells one
    /// idle period of the connection from the next, so a timer armed for an earlier one cannot end a later one.
    H1 { conn: Conn, until: Instant, stamp: u64 },
    /// An HTTP/2 connection is shared by every request: `id` is its creation number.
    H2 { id: u64, send: h2::client::SendRequest<Bytes> },
}

#[derive(Default)]
pub struct Pool {
    idle: Mutex<HashMap<String, Vec<Idle>>>,
    counter: AtomicU64,
}

impl Pool {
    /// A new connection's number.
    pub fn birth(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::Relaxed)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Idle>>> {
        self.idle.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `conn` is idle for `ttl` and then closed by its timer.
    pub fn put_h1(self: &Arc<Self>, key: String, conn: Conn, ttl: Duration) {
        let until = Instant::now() + ttl;
        let stamp = self.birth();
        let born = conn.born;
        {
            let mut all = self.lock();
            let list = all.entry(key.clone()).or_default();
            let at = list
                .iter()
                .position(|other| matches!(other, Idle::H1 { conn: other, .. } if other.born > born))
                .unwrap_or(list.len());
            list.insert(at, Idle::H1 { conn, until, stamp });
        }
        // Without a runtime (a teardown) the connection is dropped with the pool.
        if tokio::runtime::Handle::try_current().is_ok() {
            let pool: Weak<Self> = Arc::downgrade(self);
            tokio::spawn(async move {
                tokio::time::sleep_until(until).await;
                if let Some(pool) = pool.upgrade() {
                    pool.expire(&key, stamp);
                }
            });
        }
    }

    pub fn put_h2(&self, key: String, id: u64, send: h2::client::SendRequest<Bytes>) {
        self.lock().entry(key).or_default().push(Idle::H2 { id, send });
    }

    /// The idle period `stamp` of `key` is over: its connection closes.
    fn expire(&self, key: &str, stamp: u64) {
        let gone = {
            let mut all = self.lock();
            let Some(list) = all.get_mut(key) else { return };
            let at = list.iter().position(|idle| matches!(idle, Idle::H1 { stamp: s, .. } if *s == stamp));
            let gone = at.map(|at| list.remove(at));
            if list.is_empty() {
                all.remove(key);
            }
            gone
        };
        drop(gone);
    }

    /// The HTTP/2 connection `id` of `key` is dead or finished.
    pub fn remove_h2(&self, key: &str, id: u64) {
        let mut all = self.lock();
        if let Some(list) = all.get_mut(key) {
            list.retain(|idle| !matches!(idle, Idle::H2 { id: other, .. } if *other == id));
            if list.is_empty() {
                all.remove(key);
            }
        }
    }

    /// Every idle connection closes (the route changed).
    pub fn clear(&self) {
        let all = std::mem::take(&mut *self.lock());
        drop(all);
    }

    /// The oldest idle connection of `key` that is still open. A socket that was used is looked at again after one
    /// turn of the scheduler, so a close that has arrived is seen (`client-h1.js` `scheduleIdleSocketValidation`).
    pub async fn take(&self, key: &str) -> Option<Idle> {
        // Without an idle connection nothing waits: the caller dials within the same poll.
        if !self.lock().contains_key(key) {
            return None;
        }
        tokio::task::yield_now().await;
        loop {
            let found = {
                let mut all = self.lock();
                let list = all.get_mut(key)?;
                let found = match list.first() {
                    Some(Idle::H2 { id, send }) => Some(Idle::H2 { id: *id, send: send.clone() }),
                    Some(Idle::H1 { .. }) => Some(list.remove(0)),
                    None => None,
                };
                if list.is_empty() {
                    all.remove(key);
                }
                found
            };
            match found? {
                Idle::H1 { conn, until, .. } => {
                    if Instant::now() < until && !conn.is_closed() {
                        return Some(Idle::H1 { conn, until, stamp: 0 });
                    }
                }
                h2 => return Some(h2),
            }
        }
    }

    #[cfg(test)]
    pub fn idle_count(&self, key: &str) -> usize {
        self.lock().get(key).map_or(0, Vec::len)
    }
}
