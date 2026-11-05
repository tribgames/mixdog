//! The core's pending waits on a UI report: the page id of the tab an agent's `visualize` open
//! asked the pane to create (`ui/newTab/created`, Node's `watchNewTab`), and the claim that a
//! pane shows the terminal a `terminal` run revealed (`ui/terminalRun/claimed`, Node's
//! `createTerminalRunRequests`). One registry serves both: a wait is keyed by its kind and
//! request id, settles at most once, and ends with no value on its deadline, on cancel, when the
//! same key is watched again, or (new-tab waits only) when the session's browser is released.
//! Deadlines run on the core ticker.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_rt::Ticker;
use mixdog_rt::TimerHandle;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// How long an open waits for the pane to create its tab.
pub const NEW_TAB_WAIT: Duration = Duration::from_millis(3000);
/// The renderer's 1500 ms shown-wait plus 500 ms for the claim's trip back.
pub const TERMINAL_CLAIM_WAIT: Duration = Duration::from_millis(2000);

const NEW_TAB_CREATED: &str = "ui/newTab/created";
const TERMINAL_RUN_CLAIMED: &str = "ui/terminalRun/claimed";

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
enum WaitKey {
    NewTab(String),
    TerminalRun(String),
}

struct Waiter {
    generation: u64,
    session: String,
    settle: oneshot::Sender<Option<String>>,
    timer: TimerHandle,
}

#[derive(Default)]
struct State {
    next: u64,
    waiting: HashMap<WaitKey, Waiter>,
}

fn locked(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|p| p.into_inner())
}

fn settle(waiter: Waiter, value: Option<String>) {
    let _ = waiter.timer.cancel();
    let _ = waiter.settle.send(value);
}

fn expire(state: &Mutex<State>, key: &WaitKey, generation: u64) {
    let mut state = locked(state);
    if state.waiting.get(key).is_some_and(|w| w.generation == generation) {
        if let Some(waiter) = state.waiting.remove(key) {
            settle(waiter, None);
        }
    }
}

#[derive(Clone)]
pub struct PendingWaits {
    new_tab_wait: Duration,
    terminal_wait: Duration,
    state: Arc<Mutex<State>>,
    ticker: Ticker,
}

impl PendingWaits {
    /// Production passes `mixdog_rt::ticker().clone()` with [`NEW_TAB_WAIT`] and
    /// [`TERMINAL_CLAIM_WAIT`]; a test passes the ticker of its own runtime.
    pub fn new(ticker: Ticker, new_tab_wait: Duration, terminal_wait: Duration) -> Self {
        Self { new_tab_wait, terminal_wait, state: Arc::default(), ticker }
    }

    fn watch(&self, key: WaitKey, session: &str, wait: Duration) -> PendingWait {
        let (tx, rx) = oneshot::channel();
        let mut state = locked(&self.state);
        if let Some(old) = state.waiting.remove(&key) {
            settle(old, None);
        }
        state.next += 1;
        let generation = state.next;
        let timer = self.ticker.register(Instant::now() + wait, {
            let shared = Arc::clone(&self.state);
            let key = key.clone();
            move || expire(&shared, &key, generation)
        });
        state.waiting.insert(key.clone(), Waiter { generation, session: session.to_owned(), settle: tx, timer });
        PendingWait { rx, waits: self.clone(), key, generation }
    }

    fn settle_key(&self, key: &WaitKey, session: Option<&str>, value: Option<String>) -> bool {
        let mut state = locked(&self.state);
        if state.waiting.get(key).is_none_or(|w| session.is_some_and(|s| s != w.session)) {
            return false;
        }
        let waiter = state.waiting.remove(key).expect("checked above");
        settle(waiter, value);
        true
    }

    fn end(&self, key: &WaitKey, generation: u64) {
        let mut state = locked(&self.state);
        if state.waiting.get(key).is_some_and(|w| w.generation == generation) {
            if let Some(waiter) = state.waiting.remove(key) {
                settle(waiter, None);
            }
        }
    }

    /// Starts waiting for the page of the tab that open `request_id` asked `session`'s pane for.
    pub fn watch_new_tab(&self, session: &str, request_id: &str) -> PendingWait {
        self.watch(WaitKey::NewTab(request_id.to_owned()), session, self.new_tab_wait)
    }

    /// The session's pane made `page_id` for `request_id`. Settles only the wait of that
    /// session and request, once; a tab nobody named (empty request id) settles nothing.
    pub fn new_tab_created(&self, session: &str, request_id: &str, page_id: &str) -> bool {
        // Node's truthiness: an empty page id still settles the wait, but names no page.
        !request_id.is_empty()
            && self.settle_key(
                &WaitKey::NewTab(request_id.to_owned()),
                Some(session),
                Some(page_id.to_owned()).filter(|p| !p.is_empty()),
            )
    }

    /// Starts waiting for a pane to claim the terminal reveal `request_id`.
    pub fn watch_terminal_run(&self, session: &str, request_id: &str) -> PendingWait {
        self.watch(WaitKey::TerminalRun(request_id.to_owned()), session, self.terminal_wait)
    }

    /// True exactly once per still-waiting reveal.
    pub fn claim_terminal_run(&self, request_id: &str) -> bool {
        // A claim is the value: the wait reports `shown` as "got a value".
        self.settle_key(&WaitKey::TerminalRun(request_id.to_owned()), None, Some(request_id.to_owned()))
    }

    /// The session's browser is released: no tab it was asked for will arrive.
    pub fn cancel_session(&self, session: &str) {
        let mut state = locked(&self.state);
        let keys: Vec<WaitKey> = state
            .waiting
            .iter()
            .filter(|(key, w)| matches!(key, WaitKey::NewTab(_)) && w.session == session)
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            if let Some(waiter) = state.waiting.remove(&key) {
                settle(waiter, None);
            }
        }
    }

    pub fn cancel_all(&self) {
        let waiters: Vec<Waiter> = locked(&self.state).waiting.drain().map(|(_, w)| w).collect();
        for waiter in waiters {
            settle(waiter, None);
        }
    }
}

/// One armed wait. Dropping it stops the wait.
pub struct PendingWait {
    rx: oneshot::Receiver<Option<String>>,
    waits: PendingWaits,
    key: WaitKey,
    generation: u64,
}

impl PendingWait {
    /// The reported value, or `None` once the wait ended without one.
    pub async fn wait(&mut self) -> Option<String> {
        (&mut self.rx).await.ok().flatten()
    }

    /// As [`wait`](Self::wait), ending with `None` when `cancel` fires.
    pub async fn wait_or_cancel(&mut self, cancel: &CancellationToken) -> Option<String> {
        tokio::select! {
            biased;
            value = &mut self.rx => value.ok().flatten(),
            _ = cancel.cancelled() => {
                self.cancel();
                None
            }
        }
    }

    /// Stops waiting (the request failed before it asked the UI).
    pub fn cancel(&self) {
        self.waits.end(&self.key, self.generation);
    }
}

impl Drop for PendingWait {
    fn drop(&mut self) {
        self.cancel();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewTabCreated {
    session_id: String,
    open_request_id: String,
    page_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalRunClaimed {
    request_id: String,
}

/// The client notifications that settle the waits. The composition root routes
/// `ui/newTab/created` and `ui/terminalRun/claimed` here.
#[async_trait]
impl DomainService for PendingWaits {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Err(CoreError::InvalidParams {
            path: "method".into(),
            expected: format!("a notification, not the request {}", req.method.as_str()).into(),
        })
    }

    fn methods(&self) -> &'static [&'static str] {
        &[NEW_TAB_CREATED, TERMINAL_RUN_CLAIMED]
    }

    fn notify(&self, method: Method, params: Value, _from: ConnectionId) -> Admit {
        // A notification has no reply to carry a refusal: params that do not decode are dropped.
        match method.as_str() {
            NEW_TAB_CREATED => {
                if let Ok(p) = serde_json::from_value::<NewTabCreated>(params) {
                    self.new_tab_created(&p.session_id, &p.open_request_id, &p.page_id);
                }
            }
            TERMINAL_RUN_CLAIMED => {
                if let Ok(p) = serde_json::from_value::<TerminalRunClaimed>(params) {
                    self.claim_terminal_run(&p.request_id);
                }
            }
            _ => {}
        }
        Admit::Accepted
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use serde_json::json;

    use super::*;

    /// A ticker on the test's own runtime: the process-wide one would die with the first test's.
    pub(crate) fn waits(new_tab_ms: u64, terminal_ms: u64) -> PendingWaits {
        mixdog_rt::testing::tokens();
        PendingWaits::new(Ticker::start(), Duration::from_millis(new_tab_ms), Duration::from_millis(terminal_ms))
    }

    fn notify(waits: &PendingWaits, method: &'static str, params: Value) {
        waits.notify(Method(method), params, ConnectionId(1));
    }

    #[tokio::test]
    async fn only_the_wait_named_by_the_created_tab_settles_whatever_order_tabs_arrive() {
        let w = waits(1000, 1000);
        let (mut a, mut b, mut other) = (w.watch_new_tab("s1", "ra"), w.watch_new_tab("s1", "rb"), w.watch_new_tab("s2", "rc"));
        assert!(w.new_tab_created("s1", "rb", "p5"));
        assert_eq!(b.wait().await.as_deref(), Some("p5"));
        assert!(w.new_tab_created("s1", "ra", "p7"));
        assert_eq!(a.wait().await.as_deref(), Some("p7"));
        assert!(w.new_tab_created("s2", "rc", "p6"));
        assert_eq!(other.wait().await.as_deref(), Some("p6"));
    }

    #[tokio::test]
    async fn a_tab_nobody_named_or_from_another_session_settles_nothing() {
        let w = waits(40, 1000);
        let mut wait = w.watch_new_tab("s1", "ra");
        assert!(!w.new_tab_created("s1", "", "p9"));
        assert!(!w.new_tab_created("s1", "unknown-request", "p9"));
        assert!(!w.new_tab_created("other-session", "ra", "p9"));
        assert_eq!(wait.wait().await, None, "only the bounded wait ends it");
    }

    #[tokio::test]
    async fn an_empty_page_id_settles_the_wait_with_no_page() {
        let w = waits(1000, 1000);
        let mut wait = w.watch_new_tab("s1", "ra");
        assert!(w.new_tab_created("s1", "ra", ""));
        assert_eq!(wait.wait().await, None);
        assert!(!w.new_tab_created("s1", "ra", "p1"), "the empty report consumed the wait");
    }

    #[tokio::test]
    async fn a_page_settles_its_wait_once() {
        let w = waits(1000, 1000);
        let mut wait = w.watch_new_tab("s1", "ra");
        assert!(w.new_tab_created("s1", "ra", "p1"));
        assert!(!w.new_tab_created("s1", "ra", "p2"));
        assert_eq!(wait.wait().await.as_deref(), Some("p1"));
    }

    #[tokio::test]
    async fn a_request_that_gets_no_tab_ends_with_the_wait_while_the_next_has_its_own() {
        let w = waits(40, 1000);
        let (mut a, mut b) = (w.watch_new_tab("s1", "ra"), w.watch_new_tab("s1", "rb"));
        w.new_tab_created("s1", "rb", "p3");
        assert_eq!((a.wait().await, b.wait().await), (None, Some("p3".to_owned())));
    }

    #[tokio::test]
    async fn watching_a_request_id_again_ends_the_earlier_wait() {
        let w = waits(1000, 1000);
        let mut first = w.watch_new_tab("s1", "ra");
        let mut second = w.watch_new_tab("s1", "ra");
        assert_eq!(first.wait().await, None);
        assert!(w.new_tab_created("s1", "ra", "p4"));
        assert_eq!(second.wait().await.as_deref(), Some("p4"));
    }

    #[tokio::test]
    async fn a_released_session_ends_its_new_tab_waits_but_not_a_terminal_claim() {
        let w = waits(60_000, 60_000);
        let (mut one, mut two) = (w.watch_new_tab("s1", "ra"), w.watch_new_tab("s2", "rb"));
        let mut run = w.watch_terminal_run("s1", "tr");
        w.cancel_session("s1");
        assert_eq!(one.wait().await, None);
        assert!(w.claim_terminal_run("tr"));
        assert_eq!(run.wait().await.is_some(), true);
        w.cancel_all();
        assert_eq!(two.wait().await, None);
    }

    #[tokio::test]
    async fn cancelling_ends_the_wait_with_no_page() {
        let w = waits(60_000, 1000);
        let mut by_token = w.watch_new_tab("s1", "ra");
        let token = CancellationToken::new();
        token.cancel();
        assert_eq!(by_token.wait_or_cancel(&token).await, None);
        assert!(!w.new_tab_created("s1", "ra", "p1"), "the cancelled wait no longer takes a page");
        let by_call = w.watch_new_tab("s1", "rb");
        by_call.cancel();
        assert!(!w.new_tab_created("s1", "rb", "p1"));
    }

    #[tokio::test]
    async fn the_first_terminal_claim_shows_the_run_and_a_second_does_nothing() {
        let w = waits(1000, 5000);
        let mut run = w.watch_terminal_run("s1", "t1");
        assert!(w.claim_terminal_run("t1"));
        assert!(!w.claim_terminal_run("t1"));
        assert!(run.wait().await.is_some());
        assert!(!w.claim_terminal_run("never-asked"));
    }

    #[tokio::test]
    async fn an_unclaimed_terminal_run_ends_at_its_deadline() {
        let w = waits(1000, 40);
        let mut run = w.watch_terminal_run("s1", "t1");
        assert!(run.wait().await.is_none());
        assert!(!w.claim_terminal_run("t1"), "a claim after the deadline does nothing");
    }

    #[tokio::test]
    async fn client_notifications_settle_the_waits() {
        let w = waits(1000, 1000);
        let (mut tab, mut run) = (w.watch_new_tab("s1", "ra"), w.watch_terminal_run("s1", "tr"));
        notify(&w, "ui/newTab/created", json!({"sessionId": "s1", "openRequestId": "ra", "pageId": "p8"}));
        notify(&w, "ui/terminalRun/claimed", json!({"requestId": "tr"}));
        notify(&w, "ui/newTab/created", json!({"sessionId": "s1"}));
        assert_eq!(tab.wait().await.as_deref(), Some("p8"));
        assert!(run.wait().await.is_some());
    }
}
