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

/// A connection handed out by [`Pool::take`]. An HTTP/2 connection comes with its stream already counted open, in the
/// same critical section that found it, so its idle expiry cannot end it between the two.
pub enum Taken {
    H1(Conn),
    H2 { id: u64, send: h2::client::SendRequest<Bytes>, guard: H2Guard },
}

/// What the pool knows of an HTTP/2 connection beyond its handle: the streams open on it, and the idle period whose
/// timer is armed (a stamp from [`Pool::birth`], as for an h1 connection).
struct H2Meta {
    open: usize,
    stamp: u64,
}

/// Everything a route change, an insertion, a checkout and an expiry decide on, behind one lock: each of them is one
/// critical section, so none sees the state between another's check and its change.
#[derive(Default)]
struct State {
    idle: HashMap<String, Vec<Idle>>,
    h2: HashMap<u64, H2Meta>,
    /// Counts the route changes ([`Pool::clear`]). A connection carries the count read before the route its dial
    /// used was decided; one that meets a later count when it would go into the pool is closed instead, so a
    /// connection dialled or checked out while the route changed does not idle under its old route.
    generation: u64,
    /// Connections whose answer was read whole by a caller that sends again at once ([`Pool::hold_h1`]), by key: each
    /// with its hold's number and its keep-alive.
    held: HashMap<String, Vec<(u64, Conn, Duration)>>,
}

impl State {
    /// Takes the HTTP/2 connection `id` of `key` out of the pool, its handle returned to be dropped after the lock.
    fn remove_h2(&mut self, key: &str, id: u64) -> Vec<Idle> {
        self.h2.remove(&id);
        let mut gone = Vec::new();
        if let Some(list) = self.idle.get_mut(key) {
            let (out, kept): (Vec<Idle>, Vec<Idle>) =
                std::mem::take(list).into_iter().partition(|idle| matches!(idle, Idle::H2 { id: other, .. } if *other == id));
            *list = kept;
            gone = out;
            if list.is_empty() {
                self.idle.remove(key);
            }
        }
        gone
    }
}

/// The points of the pool's operations a test can hold, to run another operation there.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum At {
    /// An idle HTTP/2 connection's timer has fired; its expiry has not looked at the connection yet.
    Expire,
    /// A checkout has found its connection.
    Checkout,
    /// A connection is about to go into the pool.
    Put,
    /// A request found no idle connection and is about to dial.
    Dial,
}

#[cfg(test)]
type Hook = Box<dyn FnOnce() + Send>;

#[derive(Default)]
pub struct Pool {
    state: Mutex<State>,
    counter: AtomicU64,
    #[cfg(test)]
    hooks: Mutex<HashMap<At, Hook>>,
}

impl Pool {
    /// A new connection's number.
    pub fn birth(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::Relaxed)
    }

    /// The route generation of a connection whose route is decided after this call.
    pub fn generation(&self) -> u64 {
        self.lock().generation
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs, once, what a test holds at `at`.
    #[cfg(test)]
    pub fn hook(&self, at: At, run: impl FnOnce() + Send + 'static) {
        self.hooks.lock().unwrap().insert(at, Box::new(run));
    }

    #[cfg(test)]
    pub fn at(&self, at: At) {
        let hook = self.hooks.lock().unwrap().remove(&at);
        if let Some(hook) = hook {
            hook();
        }
    }

    /// `conn` is idle for `ttl` and then closed by its timer; one opened under an earlier route is closed now.
    pub fn put_h1(self: &Arc<Self>, key: String, conn: Conn, ttl: Duration) {
        #[cfg(test)]
        self.at(At::Put);
        let until = Instant::now() + ttl;
        let stamp = self.birth();
        let born = conn.born;
        {
            let mut state = self.lock();
            if conn.generation != state.generation {
                drop(state);
                return; // `conn` is dropped: closed, not kept
            }
            let list = state.idle.entry(key.clone()).or_default();
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

    /// `conn`'s answer was read whole by a caller that sends its next request at once: undici gives the socket back one
    /// `setImmediate` after the body ended (`client-h1.js:842-846`, undici 8.12.3), so that request, and any other
    /// dispatched in the same turn of the event loop, finds it busy and a request a turn later finds it free
    /// (`resendIfEncodingRejected`, request-compression.mjs:60-68). It stays out of the pool until the next request of
    /// `key` has its connection and its task has yielded once ([`Pool::free_held`]) or the hold ends
    /// ([`Pool::end_hold`]); the hold's number is returned.
    pub fn hold_h1(&self, key: String, conn: Conn, ttl: Duration) -> u64 {
        let hold = self.birth();
        self.lock().held.entry(key).or_default().push((hold, conn, ttl));
        hold
    }

    /// Whether a connection of `key` is held ([`Pool::hold_h1`]).
    pub fn holds(&self, key: &str) -> bool {
        self.lock().held.contains_key(key)
    }

    /// The next request of `key` has its connection and a turn has passed: every connection held for it goes into the
    /// pool.
    pub fn free_held(self: &Arc<Self>, key: &str) {
        let freed = self.lock().held.remove(key).unwrap_or_default();
        for (_, conn, ttl) in freed {
            self.put_h1(key.to_owned(), conn, ttl);
        }
    }

    /// The hold `hold` of `key` ends with no request after it: its connection goes into the pool if it is still held.
    pub fn end_hold(self: &Arc<Self>, key: &str, hold: u64) {
        let freed = {
            let mut state = self.lock();
            let Some(list) = state.held.get_mut(key) else { return };
            let freed = list.iter().position(|(h, ..)| *h == hold).map(|at| list.remove(at));
            if list.is_empty() {
                state.held.remove(key);
            }
            freed
        };
        if let Some((_, conn, ttl)) = freed {
            self.put_h1(key.to_owned(), conn, ttl);
        }
    }

    /// The new HTTP/2 connection `id`, dialled under route `generation`, with its first stream open: it is shared
    /// from now on, unless the route changed since `generation`, when it serves this stream alone and closes after it.
    pub fn put_h2(self: &Arc<Self>, key: String, id: u64, send: h2::client::SendRequest<Bytes>, generation: u64) -> H2Guard {
        {
            let mut state = self.lock();
            if state.generation == generation {
                state.h2.insert(id, H2Meta { open: 1, stamp: self.birth() });
                state.idle.entry(key.clone()).or_default().push(Idle::H2 { id, send });
            }
        }
        H2Guard { pool: self.clone(), key, id }
    }

    /// undici closes an h2 session that has had no stream for keepAliveTimeout (client-h2.js, setHttp2IdleTimeout).
    fn h2_closed_stream(self: &Arc<Self>, key: &str, id: u64) {
        let stamp = {
            let mut state = self.lock();
            let Some(meta) = state.h2.get_mut(&id) else { return };
            meta.open = meta.open.saturating_sub(1);
            if meta.open > 0 {
                return;
            }
            meta.stamp = self.birth();
            meta.stamp
        };
        if tokio::runtime::Handle::try_current().is_ok() {
            let (pool, key): (Weak<Self>, String) = (Arc::downgrade(self), key.to_owned());
            let until = Instant::now() + super::KEEP_ALIVE;
            tokio::spawn(async move {
                tokio::time::sleep_until(until).await;
                if let Some(pool) = pool.upgrade() {
                    pool.expire_h2(&key, id, stamp);
                }
            });
        }
    }

    /// The idle period `stamp` of the HTTP/2 connection `id` is over: it closes unless a stream started since, decided
    /// and done in one critical section (undici rechecks inside the timeout callback, `client-h2.js`
    /// `onHttp2SessionIdleTimeout`).
    fn expire_h2(&self, key: &str, id: u64, stamp: u64) {
        #[cfg(test)]
        self.at(At::Expire);
        let gone = {
            let mut state = self.lock();
            if !state.h2.get(&id).is_some_and(|meta| meta.open == 0 && meta.stamp == stamp) {
                return;
            }
            state.remove_h2(key, id)
        };
        drop(gone);
    }

    /// The idle period `stamp` of `key` is over: its connection closes.
    fn expire(&self, key: &str, stamp: u64) {
        let gone = {
            let mut state = self.lock();
            let Some(list) = state.idle.get_mut(key) else { return };
            let at = list.iter().position(|idle| matches!(idle, Idle::H1 { stamp: s, .. } if *s == stamp));
            let gone = at.map(|at| list.remove(at));
            if list.is_empty() {
                state.idle.remove(key);
            }
            gone
        };
        drop(gone);
    }

    /// The HTTP/2 connection `id` of `key` is dead or finished.
    pub fn remove_h2(&self, key: &str, id: u64) {
        let gone = self.lock().remove_h2(key, id);
        drop(gone);
    }

    /// Every idle connection closes, and every connection out now closes when it comes back (the route changed).
    pub fn clear(&self) {
        let all = {
            let mut state = self.lock();
            state.generation += 1;
            state.h2.clear();
            std::mem::take(&mut state.idle)
        };
        drop(all);
    }

    /// The oldest idle connection of `key` that is still open. It is chosen at once, as undici's pool picks a free
    /// client inside `dispatch`, so a request after this one in the same turn finds it busy; a socket that was used is
    /// written to after one turn of the scheduler, so a close that has arrived by then is seen and another one is
    /// chosen (`client-h1.js` `scheduleIdleSocketValidation`).
    pub async fn take(self: &Arc<Self>, key: &str) -> Option<Taken> {
        loop {
            // Without an idle connection nothing waits: the caller dials within the same poll.
            let taken = self.checkout(key)?;
            tokio::task::yield_now().await;
            match taken {
                Taken::H1(conn) if conn.is_closed() => drop(conn),
                taken => return Some(taken),
            }
        }
    }

    /// The connection [`Pool::take`] chooses.
    fn checkout(self: &Arc<Self>, key: &str) -> Option<Taken> {
        loop {
            let found = {
                let mut state = self.lock();
                let State { idle, h2, .. } = &mut *state;
                let list = idle.get_mut(key)?;
                let found = match list.first() {
                    Some(Idle::H2 { id, send }) => {
                        // The stream is counted open, and an armed idle timer outdated, before the lock is let go.
                        if let Some(meta) = h2.get_mut(id) {
                            meta.open += 1;
                            meta.stamp = self.birth();
                        }
                        Some(Idle::H2 { id: *id, send: send.clone() })
                    }
                    Some(Idle::H1 { .. }) => Some(list.remove(0)),
                    None => None,
                };
                if list.is_empty() {
                    idle.remove(key);
                }
                found
            };
            #[cfg(test)]
            self.at(At::Checkout);
            match found? {
                Idle::H1 { conn, until, .. } => {
                    if Instant::now() < until && !conn.is_closed() {
                        return Some(Taken::H1(conn));
                    }
                }
                Idle::H2 { id, send } => return Some(Taken::H2 { id, send, guard: H2Guard { pool: self.clone(), key: key.to_owned(), id } }),
            }
        }
    }

    #[cfg(test)]
    pub fn idle_count(&self, key: &str) -> usize {
        self.lock().idle.get(key).map_or(0, Vec::len)
    }

    /// The idle period an HTTP/2 connection's armed timer belongs to.
    #[cfg(test)]
    fn h2_stamp(&self, id: u64) -> u64 {
        self.lock().h2[&id].stamp
    }
}

/// A stream open on an HTTP/2 connection; the connection is idle again when the last one drops.
pub struct H2Guard {
    pool: Arc<Pool>,
    key: String,
    id: u64,
}

impl Drop for H2Guard {
    fn drop(&mut self) {
        self.pool.h2_closed_stream(&self.key, self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    // A8: an idle connection closes when its keep-alive runs out, with no other request to look at it.
    #[tokio::test(start_paused = true)]
    async fn an_idle_connection_is_closed_by_its_timer() {
        let pool = Arc::new(Pool::default());
        let (near, mut far) = tokio::io::duplex(64);
        let conn = Conn::open(Box::new(near), pool.birth(), pool.generation()).await.unwrap();
        pool.put_h1("k".into(), conn, Duration::from_secs(60));
        assert_eq!(pool.idle_count("k"), 1);
        tokio::time::advance(Duration::from_secs(59)).await;
        assert_eq!(pool.idle_count("k"), 1, "still inside its keep-alive");
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        assert_eq!(pool.idle_count("k"), 0, "closed at the end of its keep-alive");
        assert_eq!(eof(&mut far).await, 0, "the peer sees the close");
    }

    // The oldest idle connection is the next one used (undici's pool order).
    #[tokio::test(start_paused = true)]
    async fn the_oldest_idle_connection_is_taken_first() {
        let pool = Arc::new(Pool::default());
        let mut peers = Vec::new();
        let mut born = Vec::new();
        for _ in 0..2 {
            let (near, far) = tokio::io::duplex(64);
            peers.push(far);
            let conn = Conn::open(Box::new(near), pool.birth(), pool.generation()).await.unwrap();
            born.push(conn.born);
            pool.put_h1("k".into(), conn, Duration::from_secs(60));
        }
        // Put back in the other order than created.
        let first = pool.take("k").await;
        let Some(Taken::H1(conn)) = first else { panic!("an idle connection") };
        assert_eq!(conn.born, born[0]);
    }

    /// An HTTP/2 connection to a peer that accepts streams and answers none of them.
    async fn h2_connection() -> (h2::client::SendRequest<Bytes>, tokio::task::JoinHandle<()>) {
        let (near, far) = tokio::io::duplex(1 << 16);
        let server = tokio::spawn(async move {
            let mut conn = h2::server::handshake(far).await.unwrap();
            while conn.accept().await.is_some() {}
        });
        let (send, connection) = h2::client::handshake(near).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        (send, server)
    }

    // H1: an HTTP/2 connection closes after `keepAliveTimeout` without a stream (undici `client-h2.js`
    // `setHttp2IdleTimeout`), and a stream that starts in the meantime restarts the count.
    #[tokio::test(start_paused = true)]
    async fn an_idle_h2_connection_is_closed_after_its_keep_alive_and_not_while_a_stream_is_open() {
        let pool = Arc::new(Pool::default());
        let (send, _server) = h2_connection().await;
        let id = pool.birth();
        let stream = pool.put_h2("k".into(), id, send, pool.generation());
        tokio::time::advance(Duration::from_secs(600)).await;
        tokio::task::yield_now().await;
        assert_eq!(pool.idle_count("k"), 1, "never idle while a stream is open");
        drop(stream);
        tokio::time::advance(Duration::from_secs(30)).await;
        let again = pool.take("k").await.expect("the idle connection"); // restarts the idle period
        tokio::time::advance(Duration::from_secs(40)).await;
        tokio::task::yield_now().await;
        assert_eq!(pool.idle_count("k"), 1, "the first period's timer does not end the connection");
        drop(again);
        tokio::time::advance(Duration::from_secs(59)).await;
        tokio::task::yield_now().await;
        assert_eq!(pool.idle_count("k"), 1, "still inside its keep-alive");
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        assert_eq!(pool.idle_count("k"), 0, "closed at the end of its keep-alive");
    }

    // H2: a connection that was checked out when the route changed is closed when its response ends, not kept.
    #[tokio::test(start_paused = true)]
    async fn a_connection_checked_out_across_a_route_change_is_closed_when_it_comes_back() {
        let pool = Arc::new(Pool::default());
        let (near, mut far) = tokio::io::duplex(64);
        let conn = Conn::open(Box::new(near), pool.birth(), pool.generation()).await.unwrap();
        pool.clear(); // the route changes while `conn` is out
        pool.put_h1("k".into(), conn, Duration::from_secs(60));
        assert_eq!(pool.idle_count("k"), 0, "not kept under the old route");
        assert_eq!(eof(&mut far).await, 0, "the peer sees the close");
    }

    /// What the peer reads next: 0 is the close. Bounded: a connection kept open would leave it waiting.
    async fn eof(far: &mut tokio::io::DuplexStream) -> usize {
        let mut byte = [0u8; 1];
        tokio::time::timeout(Duration::from_secs(20), far.read(&mut byte)).await.expect("the peer reads within 20 s").unwrap()
    }

    /// An HTTP/2 connection idle in `pool` under "k", its first stream over: its idle timer is armed for the stamp returned.
    async fn idle_h2(pool: &Arc<Pool>) -> (u64, u64, tokio::task::JoinHandle<()>) {
        let (send, server) = h2_connection().await;
        let id = pool.birth();
        drop(pool.put_h2("k".into(), id, send, pool.generation()));
        (id, pool.h2_stamp(id), server)
    }

    // H1 (recheck): the expiry of an idle HTTP/2 connection and a checkout of it are each one critical section. Held at
    // the moment its timer has fired, the expiry lets a checkout run; the checked-out connection stays in the pool.
    #[tokio::test(start_paused = true)]
    async fn a_checkout_while_an_h2_expiry_runs_keeps_the_connection() {
        let pool = Arc::new(Pool::default());
        let (id, stamp, _server) = idle_h2(&pool).await;
        let taken = Arc::new(Mutex::new(None));
        let (during, slot) = (pool.clone(), taken.clone());
        pool.hook(At::Expire, move || *slot.lock().unwrap() = during.checkout("k"));
        pool.expire_h2("k", id, stamp);
        assert!(matches!(*taken.lock().unwrap(), Some(Taken::H2 { .. })), "the checkout found the connection");
        assert_eq!(pool.idle_count("k"), 1, "the connection checked out during the expiry is still pooled");
    }

    // H1 (recheck): the expiry that runs between a checkout's finding of the connection and its use finds it busy.
    #[tokio::test(start_paused = true)]
    async fn an_h2_expiry_right_after_a_checkout_finds_the_connection_busy() {
        let pool = Arc::new(Pool::default());
        let (id, stamp, _server) = idle_h2(&pool).await;
        let during = pool.clone();
        pool.hook(At::Checkout, move || during.expire_h2("k", id, stamp));
        let taken = pool.checkout("k");
        assert!(matches!(taken, Some(Taken::H2 { .. })), "the checkout found the connection");
        assert_eq!(pool.idle_count("k"), 1, "the expiry left the checked-out connection in the pool");
        drop(taken);
        assert_eq!(pool.idle_count("k"), 1, "idle again, for a whole new keep-alive");
    }

    // H2 (recheck): a route change that lands while a connection goes back to the pool closes it.
    #[tokio::test(start_paused = true)]
    async fn a_route_change_while_a_connection_goes_back_closes_it() {
        let pool = Arc::new(Pool::default());
        let (near, mut far) = tokio::io::duplex(64);
        let conn = Conn::open(Box::new(near), pool.birth(), pool.generation()).await.unwrap();
        let during = pool.clone();
        pool.hook(At::Put, move || during.clear());
        pool.put_h1("k".into(), conn, Duration::from_secs(60));
        assert_eq!(pool.idle_count("k"), 0, "not kept under the old route");
        assert_eq!(eof(&mut far).await, 0, "the peer sees the close");
    }

    // H2 (recheck): an HTTP/2 connection dialled under a route that has since changed is not shared.
    #[tokio::test(start_paused = true)]
    async fn an_h2_connection_dialled_under_an_old_route_is_not_pooled() {
        let pool = Arc::new(Pool::default());
        let (send, _server) = h2_connection().await;
        let generation = pool.generation();
        pool.clear(); // the route changes during the dial
        let id = pool.birth();
        let stream = pool.put_h2("k".into(), id, send, generation);
        assert_eq!(pool.idle_count("k"), 0, "not offered to another request");
        drop(stream);
        assert_eq!(pool.idle_count("k"), 0);
    }
}