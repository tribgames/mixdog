//! The pool of idle connections, by hand: undici's pool hands a request to the first free client in the order the
//! clients were created, and a client's idle socket closes when its keep-alive runs out (`client-h1.js`
//! `keepAliveTimeout`), not when another request next looks at it. A client whose socket has ended stays in its place
//! and connects again for the next request it is given ([`Idle::Vacant`]).

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

use super::goaway::ConnState;
use super::h1::Conn;

pub enum Idle {
    /// `conn.born` is the connection's creation number; the list of a key is kept in that order. `stamp` tells one
    /// idle period of the connection from the next, so a timer armed for an earlier one cannot end a later one.
    H1 { conn: Conn, until: Instant, stamp: u64 },
    /// An HTTP/2 connection is shared by every request: `id` is its creation number.
    H2 { id: u64, send: h2::client::SendRequest<Bytes> },
    /// The client `slot` (an h1 connection's `born`) whose socket has ended ([`Conn`]'s drop): free, in its place in the
    /// order, and connected again by the request that takes it until its keep-alive (`until`, `stamp`) runs out.
    Vacant { slot: u64, until: Instant, stamp: u64 },
}

impl Idle {
    /// The place in the pool's order of an HTTP/1.1 client.
    fn slot(&self) -> Option<u64> {
        match self {
            Idle::H1 { conn, .. } => Some(conn.born),
            Idle::Vacant { slot, .. } => Some(*slot),
            Idle::H2 { .. } => None,
        }
    }
}

/// A connection handed out by [`Pool::take`]. An HTTP/2 connection comes with its stream already counted open, in the
/// same critical section that found it, so its idle expiry cannot end it between the two.
pub enum Taken {
    H1(Conn),
    H2 {
        id: u64,
        send: h2::client::SendRequest<Bytes>,
        guard: H2Guard,
    },
    /// A client without a socket: the request dials, and the new connection takes the client's number.
    Vacant(u64),
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
}

/// Puts `idle` into `list` in the clients' order.
fn insert_ordered(list: &mut Vec<Idle>, idle: Idle) {
    let slot = idle.slot();
    let at = list.iter().position(|other| other.slot().zip(slot).is_some_and(|(other, slot)| other > slot)).unwrap_or(list.len());
    list.insert(at, idle);
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
    /// An HTTP/2 exchange has its connection and is about to open its stream.
    Stream,
    /// An HTTP/2 stream is open and its body not queued yet: held, the body waits until the peer has closed the stream.
    Body,
    /// A stream refused its body, and its response gave the error that closed it.
    Refused,
}

#[cfg(test)]
type Hook = Box<dyn FnOnce() + Send>;

#[cfg(test)]
type Gate = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

#[derive(Default)]
pub struct Pool {
    state: Mutex<State>,
    counter: AtomicU64,
    conns: Mutex<HashMap<u64, Arc<ConnState>>>,
    #[cfg(test)]
    hooks: Mutex<HashMap<At, Hook>>,
    #[cfg(test)]
    gates: Mutex<HashMap<At, Gate>>,
    /// The exchanges whose connection's fate is not settled yet ([`Flight`]), and a wake for [`Pool::settled`].
    #[cfg(any(test, feature = "test-support"))]
    flights: (std::sync::atomic::AtomicUsize, tokio::sync::Notify),
}

/// An exchange of the pool, counted from its dispatch until what came of its connection is settled: back in the pool,
/// its client vacated, or closed ([`Pool::settled`]). A connection carries one while the exchange is on it. Counted only
/// in a test build; elsewhere it is nothing.
pub struct Flight(#[cfg(any(test, feature = "test-support"))] Arc<Pool>);

impl Clone for Flight {
    fn clone(&self) -> Self {
        #[cfg(any(test, feature = "test-support"))]
        {
            self.0.flights.0.fetch_add(1, Ordering::SeqCst);
            Flight(self.0.clone())
        }
        #[cfg(not(any(test, feature = "test-support")))]
        Flight()
    }
}

#[cfg(any(test, feature = "test-support"))]
impl Drop for Flight {
    fn drop(&mut self) {
        if self.0.flights.0.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.flights.1.notify_waiters();
        }
    }
}

/// A stream open on an HTTP/2 connection; the connection is idle again when the last one drops.
pub struct H2Guard {
    pool: Arc<Pool>,
    key: String,
    id: u64,
    /// The connection's frame facts once the guard is about to open a stream, with the stream's number once it holds it.
    conn: Option<(Arc<ConnState>, Option<u32>)>,
}

impl H2Guard {
    /// The connection's open streams and the exchanges holding a handle, as a log fragment; empty when not tracked.
    pub fn counts(&self) -> String {
        self.conn.as_ref().map_or_else(String::new, |(conn, _)| conn.counts())
    }

    /// The guard is about to open a stream on `conn` ([`ConnState::reserve`]).
    pub fn reserve(&mut self, conn: Arc<ConnState>) {
        conn.reserve();
        self.conn = Some((conn, None));
    }

    /// The reserved stream is `stream`, held until the guard drops.
    pub fn attach(&mut self, stream: u32) {
        if let Some((conn, held @ None)) = &mut self.conn {
            conn.hold(stream);
            *held = Some(stream);
        }
    }

    /// The connection this stream rides ended, or the peer is closing it: no later request is given it. Streams already on
    /// it run on, and the connection is closed by its own task when the last of them ends.
    pub fn retire(&self) {
        self.pool.remove_h2(&self.key, self.id);
    }
}

impl Drop for H2Guard {
    fn drop(&mut self) {
        match &self.conn {
            Some((conn, Some(stream))) => conn.release(*stream),
            Some((conn, None)) => conn.unreserve(),
            None => {}
        }
        self.pool.h2_closed_stream(&self.key, self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

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

    /// An HTTP/2 connection and the handle of its client-side task, which ends when the connection does. The task removes
    /// nothing from a pool: a test that wants a connection gone from it must have the pool's own code do it.
    async fn h2_pair(
        serve: impl FnOnce(h2::server::Connection<tokio::io::DuplexStream, Bytes>) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + 'static,
    ) -> (h2::client::SendRequest<Bytes>, tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
        let (near, far) = tokio::io::duplex(1 << 16);
        let server = tokio::spawn(async move { serve(h2::server::handshake(far).await.unwrap()).await });
        let (send, connection) = h2::client::handshake(near).await.unwrap();
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        (send, server, driver)
    }

    /// Whether `send`'s connection has been told to go away or has ended, as the connection's own error says it.
    async fn refuses(send: &h2::client::SendRequest<Bytes>) -> bool {
        Pool::h2_refuses_streams(send).await
    }

    // A dead connection: its server is gone and its task has seen the end, yet nothing took it out of the pool. A checkout
    // does not hand it to a request: it leaves the pool and the request dials.
    #[tokio::test(start_paused = true)]
    async fn an_h2_connection_that_ended_is_not_handed_to_the_next_request() {
        let pool = Arc::new(Pool::default());
        let (send, server, driver) = h2_pair(|mut conn| Box::pin(async move { while conn.accept().await.is_some() {} })).await;
        drop(pool.put_h2("k".into(), pool.birth(), send, pool.generation()));
        server.abort();
        driver.await.unwrap();
        assert_eq!(pool.idle_count("k"), 1, "it is still listed: the pool has not been told");
        assert!(pool.take("k").await.is_none(), "no connection: the request dials");
        assert_eq!(pool.idle_count("k"), 0, "and the dead one is gone");
    }

    // A draining connection: the peer sent GOAWAY while a response was streaming on it. It takes no new stream from that
    // moment, though the pool has not been told it is closing; the stream already on it (the peer processed it) finishes.
    #[tokio::test(start_paused = true)]
    async fn an_h2_connection_the_peer_is_closing_takes_no_new_stream_and_lets_its_open_one_finish() {
        let pool = Arc::new(Pool::default());
        let release = Arc::new(tokio::sync::Notify::new());
        let go = release.clone();
        let (send, _server, _driver) = h2_pair(move |mut conn| {
            Box::pin(async move {
                let (_request, mut respond) = conn.accept().await.unwrap().unwrap();
                let mut stream = respond.send_response(hyper::http::Response::new(()), false).unwrap();
                conn.graceful_shutdown();
                // The connection is driven until the test lets the stream finish, then until the peer closes it.
                tokio::select! {
                    _ = async { while conn.accept().await.is_some() {} } => return,
                    _ = go.notified() => {}
                }
                stream.send_data(Bytes::from_static(b"done"), true).unwrap();
                while conn.accept().await.is_some() {}
            })
        })
        .await;
        let id = pool.birth();
        let open = pool.put_h2("k".into(), id, send.clone(), pool.generation());
        let mut ready = send.clone().ready().await.unwrap();
        let (response, _) = ready.send_request(hyper::http::Request::get("https://k/x").body(()).unwrap(), true).unwrap();
        let mut body = response.await.unwrap().into_body();
        // The connection reads the GOAWAY on its own task; until it has, the connection still looks usable.
        while !refuses(&send).await {
            tokio::task::yield_now().await;
        }
        assert_eq!(pool.idle_count("k"), 1, "listed: the pool is not told of a GOAWAY");
        assert!(pool.take("k").await.is_none(), "no new stream goes to a connection that is closing");
        assert_eq!(pool.idle_count("k"), 0, "it left the pool");
        release.notify_one();
        assert_eq!(body.data().await.unwrap().unwrap(), Bytes::from_static(b"done"), "the stream the peer processed runs on");
        drop(open);
    }

    // A connection at its stream limit is busy, not dead: it stays where it is.
    #[tokio::test(start_paused = true)]
    async fn a_live_h2_connection_is_handed_out() {
        let pool = Arc::new(Pool::default());
        let (send, _server, _driver) = h2_pair(|mut conn| Box::pin(async move { while conn.accept().await.is_some() {} })).await;
        drop(pool.put_h2("k".into(), pool.birth(), send, pool.generation()));
        assert!(matches!(pool.take("k").await, Some(Taken::H2 { .. })));
        assert_eq!(pool.idle_count("k"), 1);
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
        mixdog_rt::time::timeout(Duration::from_secs(20), far.read(&mut byte)).await.expect("the peer reads within 20 s").unwrap()
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

    #[tokio::test(start_paused = true)]
    async fn closed_h1_vacant_host_keys_are_pruned_after_keep_alive() {
        let pool = Arc::new(Pool::default());
        let (near, _far) = tokio::io::duplex(64);
        let mut conn = Conn::open(Box::new(near), pool.birth(), pool.generation()).await.unwrap();
        conn.track(&pool, "closed-host");
        conn.flight = Some(pool.begin());
        drop(conn);
        pool.settled().await;
        assert!(pool.has_key("closed-host"));
        assert_eq!(pool.idle_count("closed-host"), 1);

        tokio::time::advance(Duration::from_secs(59)).await;
        tokio::task::yield_now().await;
        assert!(pool.has_key("closed-host"), "vacant slot stays inside keep-alive");

        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::task::yield_now().await;
        assert!(!pool.has_key("closed-host"), "closed H1 host key must be pruned once vacant keep-alive expires");
        assert_eq!(pool.idle_count("closed-host"), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn vacant_slot_preserves_active_h1_order_then_yields_to_live_socket_after_expiry() {
        let pool = Arc::new(Pool::default());

        // Inside keep-alive: an older closed client keeps its slot ahead of a newer idle socket.
        let (near1, _far1) = tokio::io::duplex(64);
        let (near2, _far2) = tokio::io::duplex(64);
        let mut c1 = Conn::open(Box::new(near1), pool.birth(), pool.generation()).await.unwrap();
        let born1 = c1.born;
        c1.track(&pool, "active-order");
        c1.flight = Some(pool.begin());
        let c2 = Conn::open(Box::new(near2), pool.birth(), pool.generation()).await.unwrap();
        let born2 = c2.born;
        drop(c1);
        pool.settled().await;
        pool.put_h1("active-order".into(), c2, Duration::from_secs(90));
        let Some(Taken::Vacant(slot)) = pool.checkout("active-order") else { panic!("older vacant slot first") };
        assert_eq!(slot, born1);
        let Some(Taken::H1(live)) = pool.checkout("active-order") else { panic!("newer live socket next") };
        assert_eq!(live.born, born2);

        // Past keep-alive: the expired vacant slot is pruned and the remaining live socket is reused.
        let (near3, _far3) = tokio::io::duplex(64);
        let (near4, _far4) = tokio::io::duplex(64);
        let mut c3 = Conn::open(Box::new(near3), pool.birth(), pool.generation()).await.unwrap();
        c3.track(&pool, "expired-order");
        c3.flight = Some(pool.begin());
        let c4 = Conn::open(Box::new(near4), pool.birth(), pool.generation()).await.unwrap();
        let born4 = c4.born;
        drop(c3);
        pool.settled().await;
        pool.put_h1("expired-order".into(), c4, Duration::from_secs(90));
        tokio::time::advance(Duration::from_secs(61)).await;
        tokio::task::yield_now().await;
        let Some(Taken::H1(reused)) = pool.checkout("expired-order") else { panic!("live socket reused after vacant slot expired") };
        assert_eq!(reused.born, born4);
        assert!(!pool.has_key("expired-order"));
    }
}

impl Pool {
    /// A new exchange's [`Flight`].
    pub fn begin(self: &Arc<Self>) -> Flight {
        #[cfg(any(test, feature = "test-support"))]
        {
            self.flights.0.fetch_add(1, Ordering::SeqCst);
            Flight(self.clone())
        }
        #[cfg(not(any(test, feature = "test-support")))]
        Flight()
    }

    /// Every exchange so far has settled: its connection is back in the pool, its client vacated, or closed.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn settled(&self) {
        loop {
            let settled = self.flights.1.notified();
            tokio::pin!(settled);
            settled.as_mut().enable();
            if self.flights.0.load(Ordering::SeqCst) == 0 {
                return;
            }
            settled.await;
        }
    }

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

    /// Whether a test held `at`.
    #[cfg(test)]
    pub fn at(&self, at: At) -> bool {
        let hook = self.hooks.lock().unwrap().remove(&at);
        hook.map(|hook| hook()).is_some()
    }

    /// The first operation to reach `at` waits there, once, until `wait` is done.
    #[cfg(test)]
    pub fn gate(&self, at: At, wait: impl std::future::Future<Output = ()> + Send + 'static) {
        self.gates.lock().unwrap().insert(at, Box::pin(wait));
    }

    #[cfg(test)]
    pub async fn pass(&self, at: At) {
        let gate = self.gates.lock().unwrap().remove(&at);
        if let Some(gate) = gate {
            gate.await;
        }
    }

    /// `conn` is idle for `ttl` and then closed by its timer; one opened under an earlier route is closed now.
    pub fn put_h1(self: &Arc<Self>, key: String, conn: Conn, ttl: Duration) {
        #[cfg(test)]
        self.at(At::Put);
        let until = Instant::now() + ttl;
        let stamp = self.birth();
        let mut conn = conn;
        // Settled once the connection is in the pool (or closed), whichever comes of it.
        let _settled = conn.flight.take();
        {
            let mut state = self.lock();
            if conn.generation != state.generation {
                drop(state);
                return; // `conn` is dropped: closed, not kept
            }
            insert_ordered(state.idle.entry(key.clone()).or_default(), Idle::H1 { conn, until, stamp });
        }
        // Without a runtime (a teardown) the connection is dropped with the pool.
        if tokio::runtime::Handle::try_current().is_ok() {
            let pool: Weak<Self> = Arc::downgrade(self);
            tokio::spawn(async move {
                mixdog_rt::time::sleep_until(until).await;
                if let Some(pool) = pool.upgrade() {
                    pool.expire(&key, stamp);
                }
            });
        }
    }

    /// The client `slot` of `key`, whose connection opened under route `generation`, has lost its socket: it is free and
    /// keeps its place ([`Idle::Vacant`]) for `KEEP_ALIVE`, unless the route has changed since.
    pub fn vacate(self: &Arc<Self>, key: String, slot: u64, generation: u64) {
        let until = Instant::now() + super::KEEP_ALIVE;
        let stamp = self.birth();
        let inserted = {
            let mut state = self.lock();
            if state.generation == generation {
                insert_ordered(state.idle.entry(key.clone()).or_default(), Idle::Vacant { slot, until, stamp });
                true
            } else {
                false
            }
        };
        if inserted && tokio::runtime::Handle::try_current().is_ok() {
            let pool: Weak<Self> = Arc::downgrade(self);
            tokio::spawn(async move {
                mixdog_rt::time::sleep_until(until).await;
                if let Some(pool) = pool.upgrade() {
                    pool.expire(&key, stamp);
                }
            });
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
        H2Guard { pool: self.clone(), key, id, conn: None }
    }

    /// The GOAWAY facts of HTTP/2 connection `id`, kept until its task ends.
    pub fn track_conn(&self, conn: Arc<ConnState>, id: u64) {
        self.conns.lock().unwrap_or_else(PoisonError::into_inner).insert(id, conn);
    }

    pub fn conn_state(&self, id: u64) -> Option<Arc<ConnState>> {
        self.conns.lock().unwrap_or_else(PoisonError::into_inner).get(&id).cloned()
    }

    pub fn forget_conn(&self, id: u64) {
        self.conns.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
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
                mixdog_rt::time::sleep_until(until).await;
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

    /// The idle period `stamp` of `key` is over: its connection closes, or its vacant slot is pruned.
    fn expire(&self, key: &str, stamp: u64) {
        let gone = {
            let mut state = self.lock();
            let Some(list) = state.idle.get_mut(key) else { return };
            let at = list.iter().position(|idle| matches!(idle, Idle::H1 { stamp: s, .. } | Idle::Vacant { stamp: s, .. } if *s == stamp));
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

    /// The connection [`Pool::checkout`] chooses, once [`Pool::validated`].
    #[cfg(test)]
    pub async fn take(self: &Arc<Self>, key: &str) -> Option<Taken> {
        let chosen = self.checkout(key);
        self.validated(chosen).await
    }

    /// `chosen` ready to be written to: a socket that was used is written to after one turn of the scheduler, so a close
    /// that has arrived by then is seen (`client-h1.js` `scheduleIdleSocketValidation`, a `setImmediate`: on a replay's
    /// clock, the check phase after every timer of this turn), and the request stays with its client, which connects
    /// again. Without a connection nothing waits: the caller dials within the same poll.
    pub async fn validated(self: &Arc<Self>, chosen: Option<Taken>) -> Option<Taken> {
        let taken = chosen?;
        if matches!(taken, Taken::Vacant(_)) {
            return Some(taken);
        }
        mixdog_rt::time::immediate().await;
        match taken {
            Taken::H1(conn) if conn.is_closed() => Some(Taken::Vacant(conn.into_slot())),
            // A connection that ended, or that the peer is closing with a GOAWAY, takes no new stream: it leaves the pool
            // here and the request dials, instead of being the first to learn it from a failed stream.
            Taken::H2 { id, send, guard } => {
                if Self::h2_refuses_streams(&send).await {
                    guard.retire();
                    None
                } else {
                    Some(Taken::H2 { id, send, guard })
                }
            }
            taken => Some(taken),
        }
    }

    /// Whether the HTTP/2 connection behind `send` has ended or been told to go away: h2 keeps the connection's error and
    /// answers every later stream with it. A connection that is merely at its stream limit is not one.
    async fn h2_refuses_streams(send: &h2::client::SendRequest<Bytes>) -> bool {
        let mut probe = send.clone();
        std::future::poll_fn(|cx| std::task::Poll::Ready(matches!(probe.poll_ready(cx), std::task::Poll::Ready(Err(_))))).await
    }

    /// The first free client of `key` in the pool's order: its idle connection, or the client itself when its socket has
    /// ended (closed or past its keep-alive), to be connected again. It is chosen at once, as undici's pool picks a free
    /// client inside `dispatch`, so a request after this one in the same turn finds it busy.
    pub fn checkout(self: &Arc<Self>, key: &str) -> Option<Taken> {
        let now = Instant::now();
        let found = {
            let mut state = self.lock();
            let State { idle, h2, .. } = &mut *state;
            let list = idle.get_mut(key)?;
            list.retain(|idle| !matches!(idle, Idle::Vacant { until, .. } if now >= *until));
            let found = match list.first() {
                Some(Idle::H2 { id, send }) => {
                    // The stream is counted open, and an armed idle timer outdated, before the lock is let go.
                    if let Some(meta) = h2.get_mut(id) {
                        meta.open += 1;
                        meta.stamp = self.birth();
                    }
                    Some(Idle::H2 { id: *id, send: send.clone() })
                }
                Some(Idle::H1 { .. } | Idle::Vacant { .. }) => Some(list.remove(0)),
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
            Idle::H1 { conn, until, .. } if Instant::now() < until && !conn.is_closed() => Some(Taken::H1(conn)),
            Idle::H1 { conn, .. } => Some(Taken::Vacant(conn.into_slot())),
            Idle::Vacant { slot, .. } => Some(Taken::Vacant(slot)),
            Idle::H2 { id, send } => Some(Taken::H2 { id, send, guard: H2Guard { pool: self.clone(), key: key.to_owned(), id, conn: None } }),
        }
    }

    #[cfg(test)]
    pub fn idle_count(&self, key: &str) -> usize {
        self.lock().idle.get(key).map_or(0, Vec::len)
    }

    #[cfg(test)]
    pub fn has_key(&self, key: &str) -> bool {
        self.lock().idle.contains_key(key)
    }

    /// The idle period an HTTP/2 connection's armed timer belongs to.
    #[cfg(test)]
    fn h2_stamp(&self, id: u64) -> u64 {
        self.lock().h2[&id].stamp
    }
}
