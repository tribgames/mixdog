//! The sign-in's redirect target: the loopback listener the browser is sent back to, and the
//! pasted-URL path for a remote sign-in. Only a GET of the exact callback path and host that
//! carries exactly the pending state (compared in constant time) and either one code or an
//! error finishes the login.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::page;

/// Upper bound of a pasted redirect URL.
pub const CALLBACK_MAX_BYTES: usize = 64 * 1024;
/// A pasted URL carries the authorization code and is never echoed into an error, a log or a
/// status.
pub const INVALID_CALLBACK_PASTE: &str =
    "The pasted sign-in URL is invalid. Paste the full address the browser was redirected to after signing in.";
pub const CALLBACK_NOT_PENDING: &str = "MCP OAuth sign-in is not waiting for a callback";
pub const CALLBACK_PATH: &str = "/oauth/callback";

const REQUEST_HEAD_MAX: usize = 16 * 1024;
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest a callback page is held waiting for the login to report its outcome.
const OUTCOME_WAIT: Duration = Duration::from_secs(5 * 60);

pub fn same_state(supplied: Option<&str>, expected: &str) -> bool {
    let supplied = supplied.unwrap_or_default().as_bytes();
    let expected = expected.as_bytes();
    !expected.is_empty()
        && supplied.len() == expected.len()
        && supplied.iter().zip(expected).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// What a pasted redirect URL carries.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Pasted {
    Code(String),
    Denied,
}

/// The outcome of a redirect URL pasted from the browser for a pending login whose redirect URI
/// is `redirect_url` and state `state`. Anything that is not exactly that login's callback is
/// refused with a fixed message.
pub fn parse_pasted(pasted: &str, redirect_url: &str, state: &str) -> Result<Pasted, &'static str> {
    let invalid = INVALID_CALLBACK_PASTE;
    if pasted.len() > CALLBACK_MAX_BYTES {
        return Err(invalid);
    }
    let raw = mixdog_js::js_trim(pasted);
    let target = Url::parse(raw).map_err(|_| invalid)?;
    let expected = Url::parse(redirect_url).map_err(|_| invalid)?;
    if raw.contains('#')
        || !target.username().is_empty()
        || target.password().is_some()
        || target.origin() != expected.origin()
        || target.path() != expected.path()
    {
        return Err(invalid);
    }
    let mut seen = HashSet::new();
    for (key, value) in target.query_pairs() {
        if !seen.insert(key.to_string()) {
            return Err(invalid);
        }
        // The redirect URI's own parameters come back unchanged; any others an authorization
        // server adds (Google's scope/authuser/prompt) are ignored.
        if let Some((_, own)) = expected.query_pairs().find(|(k, _)| *k == key)
            && own != value
        {
            return Err(invalid);
        }
    }
    if expected.query_pairs().any(|(k, _)| !seen.contains(k.as_ref())) {
        return Err(invalid);
    }
    let value_of = |name: &str| target.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    if !same_state(value_of("state").as_deref(), state) {
        return Err(invalid);
    }
    match (seen.contains("code"), seen.contains("error")) {
        (true, false) => value_of("code").filter(|c| !c.is_empty()).map(Pasted::Code).ok_or(invalid),
        (false, true) => Ok(Pasted::Denied),
        _ => Err(invalid),
    }
}

/// How the login ended, reported back so the held browser page can say so.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PageOutcome {
    Done,
    Failed { scope_not_granted: bool },
    /// Nobody is waiting for this callback any more.
    Stale,
}

/// The flush of a held page: done once the page was written, or its connection went away. Waiting for it is bounded,
/// as Node bounds the flush it awaits at a second (`oauth-callback.mjs` `settle`): one promise, so one deadline,
/// fixed when the page is answered and shared by every waiter (the login's `settle` and the listener's shutdown).
#[derive(Clone)]
pub struct Flush {
    done: CancellationToken,
    bound: Arc<std::sync::OnceLock<Bound>>,
}

/// The deadline of a flush's bound: a second after it was fixed. Under `test-support` it counts on the test's
/// controlled clock ([`seam::CLOCK`]) instead of the wall clock.
struct Bound(
    #[cfg(not(feature = "test-support"))] tokio::time::Instant,
    #[cfg(feature = "test-support")] u64,
);

impl Bound {
    const MS: u64 = 1000;

    fn from_now() -> Self {
        #[cfg(not(feature = "test-support"))]
        return Self(tokio::time::Instant::now() + Duration::from_millis(Self::MS));
        #[cfg(feature = "test-support")]
        return Self(seam::CLOCK.now() + Self::MS);
    }

    async fn passed(&self) {
        #[cfg(not(feature = "test-support"))]
        tokio::time::sleep_until(self.0).await;
        #[cfg(feature = "test-support")]
        seam::CLOCK.reached(self.0).await;
    }
}

impl Flush {
    fn pending() -> Self {
        Self { done: CancellationToken::default(), bound: Arc::default() }
    }

    /// Fixes the deadline of the bound now: the page is being answered (Node starts the timer in `respond`).
    pub fn start(&self) {
        self.bound.get_or_init(Bound::from_now);
    }

    /// A flush that is over already (no page is held).
    pub fn finished() -> Self {
        let flush = Self::pending();
        flush.done.cancel();
        flush
    }

    pub fn is_done(&self) -> bool {
        self.done.is_cancelled()
    }

    /// Returns when the page is flushed, or when the bound passed.
    pub async fn wait(&self) {
        let bound = self.bound.get_or_init(Bound::from_now);
        tokio::select! {
            () = self.done.cancelled() => {}
            () = bound.passed() => {}
        }
    }
}

/// Marks a flush done when its page task ends, whichever way it ends (written, or the connection destroyed).
struct FlushGuard(Flush, CancellationToken);

impl Drop for FlushGuard {
    fn drop(&mut self) {
        (self.0).done.cancel();
        self.1.cancel();
    }
}

/// A valid callback: `code` is `None` when the authorization server answered with an error.
pub struct Callback {
    pub code: Option<String>,
    /// Answers the held browser page once the code exchange and scope check ended.
    pub respond: oneshot::Sender<PageOutcome>,
    /// Cancelled once the held page task took the outcome and began writing the page, so the caller's next step
    /// (closing the listener) comes after it, as Node's `answer(failure)` writes the page synchronously.
    pub begun: CancellationToken,
    /// Resolves once the held page was written (or at once when no page is held), as Node's `settle()`
    /// awaits the page's flush before the listener closes.
    pub flushed: Flush,
}

impl Callback {
    /// A callback with no held page: a pasted URL, or a denial (already answered).
    pub fn unheld(code: Option<String>) -> Self {
        let (respond, _) = oneshot::channel();
        let begun = CancellationToken::new();
        begun.cancel();
        Self { code, respond, begun, flushed: Flush::finished() }
    }
}

/// Test seams (feature `test-support`): every wait that Node bounds by a timer is driven by the test instead, and the
/// listener's lifecycle is recorded as the events Node's recorder observed.
#[cfg(feature = "test-support")]
pub mod seam {
    use std::sync::Mutex;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use tokio::sync::Notify;

    /// A counter a test fires and waiters wait to pass: a stand-in for a timer the test controls.
    pub struct Tick {
        count: AtomicUsize,
        notify: Notify,
    }

    impl Tick {
        pub const fn new() -> Self {
            Self { count: AtomicUsize::new(0), notify: Notify::const_new() }
        }

        pub fn count(&self) -> usize {
            self.count.load(Ordering::SeqCst)
        }

        pub fn fire(&self) {
            self.count.fetch_add(1, Ordering::SeqCst);
            self.notify.notify_waiters();
        }

        /// Returns once the counter passed `seen`.
        pub async fn after(&self, seen: usize) {
            loop {
                let notified = self.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.count() > seen {
                    return;
                }
                notified.await;
            }
        }
    }

    /// The controlled clock of the 1 s bound of a page flush: it passes only when the test advances it.
    pub struct Clock {
        now_ms: AtomicU64,
        notify: Notify,
    }

    impl Clock {
        pub const fn new() -> Self {
            Self { now_ms: AtomicU64::new(0), notify: Notify::const_new() }
        }

        pub fn now(&self) -> u64 {
            self.now_ms.load(Ordering::SeqCst)
        }

        pub fn advance(&self, ms: u64) {
            self.now_ms.fetch_add(ms, Ordering::SeqCst);
            self.notify.notify_waiters();
        }

        /// Returns once the clock reached `at`.
        pub async fn reached(&self, at: u64) {
            loop {
                let notified = self.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.now() >= at {
                    return;
                }
                notified.await;
            }
        }
    }

    pub static CLOCK: Clock = Clock::new();
    /// The login deadline fires when the test fires this (unless `LOGIN_DEADLINE_MS` is set).
    pub static DEADLINE: Tick = Tick::new();
    /// The next held page waits, before it is written, until `PAGE_RELEASE` fires; `PAGE_HELD` fires when it waits.
    pub static HOLD_NEXT_PAGE: AtomicBool = AtomicBool::new(false);
    pub static PAGE_HELD: Tick = Tick::new();
    pub static PAGE_RELEASE: Tick = Tick::new();
    /// Listeners whose port was released so far, and a fire for each.
    pub static LISTENERS_CLOSED: Tick = Tick::new();
    /// A fire for every chunk a listener read from a connection.
    pub static READS: Tick = Tick::new();
    /// A fire for every connection a listener accepted.
    pub static CONNECTIONS: Tick = Tick::new();
    /// The port of the listener that came up last.
    pub static LISTENER_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
    /// The events of the listener's lifecycle, in order (`listener-up`, `listener.close`, `page-end-held`, ...).
    pub static EVENTS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

    pub fn event(name: &'static str) {
        EVENTS.lock().unwrap_or_else(|e| e.into_inner()).push(name);
    }
}

fn event(_name: &'static str) {
    #[cfg(feature = "test-support")]
    seam::event(_name);
}

/// Test seam: how long the next held page waits before it is written, so a request can land in the
/// window between the login's outcome and the flush of its page; `HELD_PAGE_DELAYING` is notified
/// when that wait starts.
#[cfg(feature = "test-support")]
pub static HELD_PAGE_DELAY_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(feature = "test-support")]
pub static HELD_PAGE_DELAYING: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Test seam: counts the listeners whose port was released, and wakes whoever waits for the next one, so a test
/// that cancels or times out a login knows that a request now meets a closed port (Node closes synchronously).
#[cfg(feature = "test-support")]
pub static LISTENERS_CLOSED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(feature = "test-support")]
pub static LISTENER_CLOSED: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Test seam: the login deadline in milliseconds for the next logins (0: Node's five minutes), so a timeout can be
/// driven through the real abort path.
#[cfg(feature = "test-support")]
pub static LOGIN_DEADLINE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The listener's handle: stops it from accepting and destroys the connections it owns.
#[derive(Clone)]
pub struct Stopper {
    stop: CancellationToken,
    closed: CancellationToken,
    /// Destroys every connection task.
    kill: CancellationToken,
    /// Ends when every connection task has ended: they each hold a sender.
    drained: Arc<tokio::sync::Mutex<mpsc::Receiver<()>>>,
    /// Set by the first `shutdown`: Node clears `flow.listener`, so a second call does nothing.
    shut: Arc<AtomicBool>,
}

impl Stopper {
    /// Stops accepting and waits until the port is released.
    pub async fn stop(&self) {
        if !self.stop.is_cancelled() {
            event("listener.close");
        }
        self.stop.cancel();
        self.closed.cancelled().await;
    }

    /// Destroys every open connection and waits for their tasks to end.
    async fn destroy(&self) {
        event("listener.closeAllConnections");
        self.kill.cancel();
        let mut drained = self.drained.lock().await;
        while drained.recv().await.is_some() {}
    }

    /// Node's `stopListening()`: the listener stops accepting at once; open connections are destroyed at once, or
    /// after the flush of the page being answered when there is one. The destruction is not awaited by the caller.
    pub async fn shutdown(&self, flushing: Option<Flush>) {
        if self.shut.swap(true, Ordering::SeqCst) {
            self.closed.cancelled().await;
            return;
        }
        event("listener.close");
        self.stop.cancel();
        self.closed.cancelled().await;
        match flushing {
            // Node destroys the connections after the flush of the page still being written, without the caller
            // waiting for it.
            Some(flush) if !flush.is_done() => {
                let listener = self.clone();
                mixdog_rt::spawn("mcp.oauth.callback.destroy", mixdog_rt::TaskClass::Work, async move {
                    flush.wait().await;
                    listener.destroy().await;
                });
            }
            _ => self.destroy().await,
        }
    }
}

pub struct Listener {
    pub port: u16,
    stopper: Stopper,
}

impl Listener {
    pub fn stopper(&self) -> Stopper {
        self.stopper.clone()
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stopper.stop.cancel();
    }
}

struct Request {
    method: String,
    target: String,
    host: Option<String>,
}

async fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    let read = async {
        loop {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            #[cfg(feature = "test-support")]
            seam::READS.fire();
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                return Some(());
            }
            if buf.len() > REQUEST_HEAD_MAX {
                return None;
            }
        }
    };
    tokio::time::timeout(REQUEST_READ_TIMEOUT, read).await.ok()??;
    let head = String::from_utf8_lossy(&buf);
    let mut lines = head.lines();
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_owned(), first.next()?.to_owned());
    let host = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.trim().to_owned());
    Some(Request { method, target, host })
}

async fn write_page(stream: &mut TcpStream, status: &str, html: &str, head_only: bool) {
    let body = if head_only { "" } else { html };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        page::CONTENT_TYPE,
        html.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn answer(mut stream: TcpStream, port: u16, state: String, server: String, tx: mpsc::UnboundedSender<Callback>, answered: Arc<AtomicBool>) {
    let invalid = page::error_html("This sign-in link is invalid or has expired.");
    let Some(request) = read_request(&mut stream).await else { return };
    let head_only = request.method == "HEAD";
    let Ok(target) = Url::parse(&format!("http://127.0.0.1:{port}{}", request.target)) else {
        return write_page(&mut stream, "400 Bad Request", &invalid, head_only).await;
    };
    let all = |name: &str| target.query_pairs().filter(|(k, _)| k == name).map(|(_, v)| v.into_owned()).collect::<Vec<_>>();
    let states = all("state");
    let valid = request.method == "GET"
        && request.host.as_deref() == Some(&format!("127.0.0.1:{port}"))
        && target.path() == CALLBACK_PATH
        && states.len() == 1
        && same_state(states.first().map(String::as_str), &state);
    let has_error = target.query_pairs().any(|(k, _)| k == "error");
    if !valid || (!has_error && all("code").len() != 1) {
        return write_page(&mut stream, "400 Bad Request", &invalid, head_only).await;
    }
    // A callback nobody is waiting for any more (the login's callback was taken already).
    if answered.swap(true, Ordering::SeqCst) {
        return write_page(&mut stream, "400 Bad Request", &invalid, false).await;
    }
    if has_error {
        // The authorization server's error text is never reflected.
        write_page(&mut stream, "400 Bad Request", &page::error_html(&format!("Sign-in to {server} was not completed.")), false).await;
        let _ = tx.send(Callback::unheld(None));
        return;
    }
    let (respond, outcome) = oneshot::channel();
    let (begun, flushed) = (CancellationToken::new(), Flush::pending());
    let _flush_done = FlushGuard(flushed.clone(), begun.clone());
    // An empty code is no code: the login fails without an exchange and the page says so.
    let code = all("code").pop().filter(|code| !code.is_empty());
    if tx.send(Callback { code, respond, begun: begun.clone(), flushed }).is_err() {
        return write_page(&mut stream, "400 Bad Request", &invalid, false).await;
    }
    // The code is only the start: the page stays open until the login reports its outcome.
    let outcome = tokio::time::timeout(OUTCOME_WAIT, outcome).await;
    #[cfg(feature = "test-support")]
    let held = seam::HOLD_NEXT_PAGE.swap(false, Ordering::SeqCst);
    #[cfg(not(feature = "test-support"))]
    let held = false;
    #[cfg(feature = "test-support")]
    if held {
        event("page-end-held");
    }
    begun.cancel();
    #[cfg(feature = "test-support")]
    {
        if held {
            let seen = seam::PAGE_RELEASE.count();
            seam::PAGE_HELD.fire();
            seam::PAGE_RELEASE.after(seen).await;
        }
        let delay = HELD_PAGE_DELAY_MS.swap(0, Ordering::SeqCst);
        if delay > 0 {
            HELD_PAGE_DELAYING.notify_one();
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }
    match outcome {
        Ok(Ok(PageOutcome::Done)) => write_page(&mut stream, "200 OK", &page::success_html(&server), false).await,
        Ok(Ok(PageOutcome::Stale)) => write_page(&mut stream, "400 Bad Request", &invalid, false).await,
        Ok(Ok(PageOutcome::Failed { scope_not_granted })) => {
            write_page(&mut stream, "400 Bad Request", &page::error_html(&page::failure_reason(&server, scope_not_granted)), false).await;
        }
        _ => {
            write_page(&mut stream, "400 Bad Request", &page::error_html(&page::failure_reason(&server, false)), false).await;
        }
    }
    // Only a page the test held back has an end to observe.
    if held {
        event("page-finished");
    }
}

/// Listens on the loopback `port` (0: any free one) for the callback of the login whose state is
/// `state`; valid callbacks arrive on `tx`. The listener owns the connections it accepted: it stops accepting and
/// destroys them through its [`Stopper`].
pub async fn listen(
    port: u16,
    state: String,
    server: String,
    tx: mpsc::UnboundedSender<Callback>,
) -> std::io::Result<Listener> {
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    let (alive, drained) = mpsc::channel::<()>(1);
    let stopper = Stopper {
        stop: CancellationToken::new(),
        closed: CancellationToken::new(),
        kill: CancellationToken::new(),
        drained: Arc::new(tokio::sync::Mutex::new(drained)),
        shut: Arc::new(AtomicBool::new(false)),
    };
    let (token, closed, kill) = (stopper.stop.clone(), stopper.closed.clone(), stopper.kill.clone());
    let answered = Arc::new(AtomicBool::new(false));
    event("listener-up");
    #[cfg(feature = "test-support")]
    seam::LISTENER_PORT.store(port, Ordering::SeqCst);
    mixdog_rt::spawn("mcp.oauth.callback", mixdog_rt::TaskClass::Work, async move {
        loop {
            let accepted = tokio::select! {
                () = token.cancelled() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _)) = accepted else { continue };
            #[cfg(feature = "test-support")]
            seam::CONNECTIONS.fire();
            let (state, server, tx, taken) = (state.clone(), server.clone(), tx.clone(), Arc::clone(&answered));
            let (alive, kill) = (alive.clone(), kill.clone());
            mixdog_rt::spawn("mcp.oauth.callback.page", mixdog_rt::TaskClass::Work, async move {
                let _alive = alive;
                tokio::select! {
                    () = kill.cancelled() => {}
                    () = answer(stream, port, state, server, tx, taken) => {}
                }
            });
        }
        drop(listener);
        drop(alive);
        closed.cancel();
        #[cfg(feature = "test-support")]
        {
            LISTENERS_CLOSED.fetch_add(1, Ordering::SeqCst);
            LISTENER_CLOSED.notify_waiters();
            seam::LISTENERS_CLOSED.fire();
        }
    });
    Ok(Listener { port, stopper })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REDIRECT: &str = "http://127.0.0.1:5555/oauth/callback";

    #[test]
    fn a_paste_must_be_exactly_the_pending_logins_callback() {
        let ok = |url: &str| parse_pasted(url, REDIRECT, "st4te");
        assert_eq!(ok(&format!("{REDIRECT}?code=abc&state=st4te&scope=x")), Ok(Pasted::Code("abc".into())));
        assert_eq!(ok(&format!("{REDIRECT}?error=access_denied&state=st4te")), Ok(Pasted::Denied));
        for bad in [
            format!("{REDIRECT}?code=abc&state=other"),
            format!("{REDIRECT}?code=abc&code=def&state=st4te"),
            format!("{REDIRECT}?code=abc&error=x&state=st4te"),
            format!("{REDIRECT}?code=abc&state=st4te#frag"),
            "http://127.0.0.1:5555/elsewhere?code=abc&state=st4te".to_owned(),
            "http://127.0.0.1:6666/oauth/callback?code=abc&state=st4te".to_owned(),
            "not a url".to_owned(),
        ] {
            assert_eq!(ok(&bad), Err(INVALID_CALLBACK_PASTE), "{bad}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_loopback_holds_the_page_until_the_outcome_and_refuses_other_requests() {
        let _runtime = mixdog_rt::testing::tokens();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let listener = listen(0, "st4te".into(), "Acme".into(), tx).await.unwrap();
        let port = listener.port;
        let get = move |path: String| async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).await.unwrap();
            let mut out = String::new();
            stream.read_to_string(&mut out).await.unwrap();
            out
        };
        assert!(get("/oauth/callback?code=c&state=wrong".into()).await.starts_with("HTTP/1.1 400"));
        let page = tokio::spawn(get("/oauth/callback?code=c0de&state=st4te".into()));
        let callback = rx.recv().await.unwrap();
        assert_eq!(callback.code.as_deref(), Some("c0de"));
        callback.respond.send(PageOutcome::Done).unwrap();
        callback.flushed.wait().await;
        let body = page.await.unwrap();
        assert!(body.starts_with("HTTP/1.1 200") && body.contains("Acme"));
    }

    /// Node waits for a page's flush on one promise bounded at a second: the login's `settle` and the listener's
    /// `stopListening` share it. A flush that never completes lets the connections live a second, not two.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_login_and_the_shutdown_share_one_flush_bound() {
        let _runtime = mixdog_rt::testing::tokens();
        let (tx, _rx) = mpsc::unbounded_channel();
        let listener = listen(0, "st4te".into(), "Acme".into(), tx).await.unwrap();
        let accepted = seam::CONNECTIONS.count();
        let mut idle = TcpStream::connect(("127.0.0.1", listener.port)).await.unwrap();
        seam::CONNECTIONS.after(accepted).await;

        let flush = Flush::pending();
        flush.start();
        let login = tokio::spawn({
            let flush = flush.clone();
            async move { flush.wait().await }
        });
        // The bound passes once, and the login's wait ends with it.
        seam::CLOCK.advance(Bound::MS);
        login.await.unwrap();

        // Shutting down now must not start a second bound: the connection is destroyed without the clock moving again.
        listener.stopper().shutdown(Some(flush)).await;
        let mut byte = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_secs(10), idle.read(&mut byte)).await;
        assert!(matches!(read, Ok(Ok(0))), "the connection was not destroyed at the shared bound: {read:?}");
    }
}
