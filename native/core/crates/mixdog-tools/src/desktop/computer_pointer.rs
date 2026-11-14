//! A foreground session's pointer between its commands, and the overlay's arrow before a pointer action
//! (`host/pointer-hold.ts`, `overlay/cursor-readiness.ts`, `host/input-run-prepare.ts` `recordCursorFeedback`).
//!
//! A foreground session keeps the system cursor blanked between its commands, so the overlay arrow is the only pointer on screen
//! while the agent thinks. The hold ends when the arrow does: after the thinking grace, when the user moves the mouse, when the
//! session's turn ends, or when another session takes the one physical pointer. The helper's watchdog restores the cursor by
//! itself on user input or helper exit; [`PointerHold`] only ends the holds nobody else would.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::ids::Method;
use serde_json::Value;
use serde_json::json;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const METHOD: &str = "host/computer/cursorPrepare";
/// The longest the core waits for the overlay (the desktop answers within 750 ms, `cursor-readiness.ts`); the action goes on
/// without it.
pub const PREPARE_CAP: Duration = Duration::from_millis(900);
/// How long a session's pointer is held after its command, however it ended (`DEFAULT_TARGET_LEASE_GRACE_MS`).
pub const HOLD: Duration = Duration::from_millis(10_000);

/// Whether the overlay's arrow was ready for a pointer action (`prepareCursorFeedback`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorPrepare {
    Ready,
    Unavailable,
    Timeout,
}

impl CursorPrepare {
    /// The `cursor_preparation` diagnostic's code.
    pub fn code(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Unavailable => "unavailable",
            Self::Timeout => "timeout",
        }
    }

    fn of(state: &str) -> Self {
        match state {
            "ready" => Self::Ready,
            "timeout" => Self::Timeout,
            _ => Self::Unavailable,
        }
    }
}

/// The sessions whose arrow is live: the overlay drew it (a pointer event relayed, or a prepare answered ready), so the next
/// pointer action needs no round trip. Ended with the session's hold or turn.
static READY: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

fn ready() -> MutexGuard<'static, HashSet<String>> {
    READY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Marks `session`'s arrow live (`computer_feedback` calls it for each pointer event it relays).
pub(super) fn mark_ready(session: &str) {
    ready().insert(session.to_owned());
}

fn forget_ready(session: &str) {
    ready().remove(session);
}

#[cfg(test)]
pub(super) fn is_ready(session: &str) -> bool {
    ready().contains(session)
}

/// Asks the desktop to have `session`'s arrow drawn at `(x, y)` of `window_id` before a pointer action. Never a refusal of the
/// action: a desktop that cannot (none serving Computer, the method unknown to it, any error) is `Unavailable`, one that does
/// not answer within [`PREPARE_CAP`] is `Timeout`, and a cancelled action is `Unavailable` with nothing left asking.
pub async fn prepare_cursor(desktop: Option<&Arc<dyn HostChannel>>, session: &str, window_id: Option<&str>, x: f64, y: f64, cancel: &CancellationToken) -> CursorPrepare {
    let Some(desktop) = desktop.filter(|desktop| desktop.serves(HostCapability::Computer)) else {
        return CursorPrepare::Unavailable;
    };
    if ready().contains(session) {
        return CursorPrepare::Ready;
    }
    let mut params = json!({"sessionThreadId": session, "x": x, "y": y});
    if let Some(window) = window_id {
        params["windowId"] = json!(window);
    }
    let ask = desktop.request_scoped(HostCapability::Computer, Method(METHOD), params, cancel);
    let state = match mixdog_rt::time::timeout(PREPARE_CAP, ask).await {
        Err(_) => return CursorPrepare::Timeout,
        // Method not found and every other failure alike: the action goes on without an arrow.
        Ok(Err(_)) => return CursorPrepare::Unavailable,
        Ok(Ok(answer)) => CursorPrepare::of(answer.get("state").and_then(Value::as_str).unwrap_or_default()),
    };
    if state == CursorPrepare::Ready {
        mark_ready(session);
    }
    state
}

/// What a hold acts on, in the session runtime that owns the helpers and the presence of sessions.
#[async_trait]
pub trait PointerHost: Send + Sync {
    /// The session's pointer is given up in the presence the overlay and the pill read (`coordinator.releasePointer`).
    fn release_pointer(&self, session: &str);
    /// Whether a command of `session` is running now.
    fn is_running(&self, session: &str) -> bool;
    /// Sends `release_cursor_theme` to `session`'s helper. Never starts a helper (a retired one already restored the cursor) and
    /// swallows a failure: the helper's watchdog restores the cursor when the helper cannot.
    async fn release_cursor_theme(&self, session: &str);
}

type Timers = HashMap<String, (u64, JoinHandle<()>)>;

struct Inner {
    host: Arc<dyn PointerHost>,
    hold: Duration,
    /// The armed timers by session, each with the generation that armed it.
    timers: Mutex<Timers>,
    generation: AtomicU64,
}

impl Inner {
    fn timers(&self) -> MutexGuard<'_, Timers> {
        self.timers.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether a hold was armed for `session`; its timer is ended.
    fn drop_timer(&self, session: &str) -> bool {
        match self.timers().remove(session) {
            Some((_, timer)) => {
                timer.abort();
                true
            }
            None => false,
        }
    }

    async fn release(&self, session: &str) {
        self.drop_timer(session);
        forget_ready(session);
        self.host.release_pointer(session);
        self.host.release_cursor_theme(session).await;
    }

    fn held(&self) -> Vec<String> {
        self.timers().keys().cloned().collect()
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        for (_, (_, timer)) in self.timers().drain() {
            timer.abort();
        }
    }
}

/// Decides when a session's pointer hold ends and the helper is told to give the cursor back.
#[derive(Clone)]
pub struct PointerHold {
    inner: Arc<Inner>,
}

impl PointerHold {
    pub fn new(host: Arc<dyn PointerHost>) -> Self {
        Self::with_hold(host, HOLD)
    }

    fn with_hold(host: Arc<dyn PointerHost>, hold: Duration) -> Self {
        Self { inner: Arc::new(Inner { host, hold, timers: Mutex::default(), generation: AtomicU64::new(0) }) }
    }

    /// After a session's foreground command, however it ended: the pointer is held for the grace, then given up unless a command
    /// of the session is running (that one arms the hold again when it ends). Where there is no runtime to run the timer on, no
    /// hold is kept.
    pub fn command_ended(&self, session: &str) {
        self.inner.drop_timer(session);
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let generation = self.inner.generation.fetch_add(1, Ordering::Relaxed);
        let weak = Arc::downgrade(&self.inner);
        let name = session.to_owned();
        let hold = self.inner.hold;
        let timer = runtime.spawn(async move {
            mixdog_rt::time::sleep_unrefed(hold).await;
            let Some(inner) = weak.upgrade() else { return };
            {
                let mut timers = inner.timers();
                if timers.get(&name).map(|(armed, _)| *armed) != Some(generation) {
                    return;
                }
                timers.remove(&name);
            }
            if !inner.host.is_running(&name) {
                inner.release(&name).await;
            }
        });
        self.inner.timers().insert(session.to_owned(), (generation, timer));
    }

    /// The session's turn is over: a held pointer is the user's again at once.
    pub async fn turn_ended(&self, session: &str) {
        forget_ready(session);
        if self.inner.drop_timer(session) {
            self.inner.release(session).await;
        }
    }

    /// Before `session`'s foreground command: every other hold gives the pointer up, and this session's own timer ends.
    pub async fn other_session(&self, session: &str) {
        self.inner.drop_timer(session);
        let others: Vec<String> = self.inner.held().into_iter().filter(|held| held != session).collect();
        futures::future::join_all(others.iter().map(|held| self.inner.release(held))).await;
    }

    /// The user moved the real pointer over the session's arrow (`computer/pointerReleased`): a held pointer is given up.
    pub fn released_by_user(&self, session: &str) {
        if !self.inner.timers().contains_key(session) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        let inner = self.inner.clone();
        let session = session.to_owned();
        runtime.spawn(async move { inner.release(&session).await });
    }

    /// The user's hold of the desktop began (a pause): the holds end without a release, the helpers restore the cursor. The
    /// overlay hides the arrows while paused, so a held session's next pointer action asks for its arrow again.
    pub fn paused(&self) {
        for session in self.inner.held() {
            self.inner.drop_timer(&session);
            forget_ready(&session);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;

    use mixdog_core_api::CoreError;
    use mixdog_core_api::HostError;
    use tokio::sync::mpsc;

    use super::*;

    const GRACE: Duration = Duration::from_millis(40);
    /// JSON-RPC "method not found": a desktop that does not serve the call has no overlay to prepare.
    const METHOD_NOT_FOUND: i64 = -32601;

    /// A session runtime that records what the hold did.
    struct Host {
        running: AtomicBool,
        seen: mpsc::UnboundedSender<String>,
    }

    #[async_trait]
    impl PointerHost for Host {
        fn release_pointer(&self, session: &str) {
            let _ = self.seen.send(format!("pointer {session}"));
        }
        fn is_running(&self, _: &str) -> bool {
            self.running.load(Ordering::Relaxed)
        }
        async fn release_cursor_theme(&self, session: &str) {
            let _ = self.seen.send(format!("theme {session}"));
        }
    }

    fn hold() -> (PointerHold, Arc<Host>, mpsc::UnboundedReceiver<String>) {
        let (seen, receive) = mpsc::unbounded_channel();
        let host = Arc::new(Host { running: AtomicBool::new(false), seen });
        (PointerHold::with_hold(host.clone(), GRACE), host, receive)
    }

    async fn next(seen: &mut mpsc::UnboundedReceiver<String>) -> String {
        mixdog_rt::time::timeout(Duration::from_secs(5), seen.recv()).await.expect("in time").expect("sent")
    }

    async fn quiet(seen: &mut mpsc::UnboundedReceiver<String>) -> bool {
        mixdog_rt::time::timeout(GRACE * 4, seen.recv()).await.is_err()
    }

    #[tokio::test]
    async fn the_grace_ends_the_hold_and_gives_the_cursor_back() {
        let (hold, _, mut seen) = hold();
        hold.command_ended("a");
        assert_eq!((next(&mut seen).await, next(&mut seen).await), ("pointer a".to_owned(), "theme a".to_owned()));
    }

    #[tokio::test]
    async fn a_command_running_when_the_grace_ends_keeps_the_hold_for_the_one_that_ends_it() {
        let (hold, host, mut seen) = hold();
        host.running.store(true, Ordering::Relaxed);
        hold.command_ended("a");
        assert!(quiet(&mut seen).await);
        host.running.store(false, Ordering::Relaxed);
        hold.command_ended("a");
        assert_eq!(next(&mut seen).await, "pointer a");
    }

    #[tokio::test]
    async fn a_new_command_end_rearms_instead_of_stacking() {
        let (hold, _, mut seen) = hold();
        hold.command_ended("a");
        hold.command_ended("a");
        assert_eq!(next(&mut seen).await, "pointer a");
        assert_eq!(next(&mut seen).await, "theme a");
        assert!(quiet(&mut seen).await, "one release for two arms");
    }

    #[tokio::test]
    async fn the_end_of_a_turn_releases_a_held_pointer_at_once_and_only_a_held_one() {
        let (hold, _, mut seen) = hold();
        hold.turn_ended("a").await;
        assert!(quiet(&mut seen).await, "nothing was held");
        hold.command_ended("a");
        hold.turn_ended("a").await;
        assert_eq!((next(&mut seen).await, next(&mut seen).await), ("pointer a".to_owned(), "theme a".to_owned()));
        assert!(quiet(&mut seen).await, "the timer ended with it");
    }

    #[tokio::test]
    async fn another_session_takes_the_pointer_from_every_other_hold() {
        let (hold, _, mut seen) = hold();
        hold.command_ended("a");
        hold.command_ended("b");
        hold.command_ended("c");
        hold.other_session("b").await;
        let mut released = vec![next(&mut seen).await, next(&mut seen).await, next(&mut seen).await, next(&mut seen).await];
        released.sort();
        assert_eq!(released, ["pointer a", "pointer c", "theme a", "theme c"]);
        // b's own timer ended too: its command is starting.
        assert!(quiet(&mut seen).await);
    }

    #[tokio::test]
    async fn the_user_moving_the_pointer_releases_a_held_session_only() {
        let (hold, _, mut seen) = hold();
        hold.released_by_user("a");
        assert!(quiet(&mut seen).await, "nothing was held");
        hold.command_ended("a");
        hold.released_by_user("a");
        assert_eq!(next(&mut seen).await, "pointer a");
        assert_eq!(next(&mut seen).await, "theme a");
    }

    #[tokio::test]
    async fn a_pause_ends_every_hold_without_a_release() {
        let (hold, _, mut seen) = hold();
        hold.command_ended("a");
        hold.command_ended("b");
        mark_ready("a");
        hold.paused();
        assert!(!is_ready("a"), "the paused overlay hid the arrow");
        assert!(quiet(&mut seen).await);
        hold.released_by_user("a");
        assert!(quiet(&mut seen).await);
    }

    /// A desktop whose answer to cursorPrepare the test sets; none is no answer.
    struct Desktop {
        serving: bool,
        answer: Mutex<Option<Result<Value, HostError>>>,
        asked: mpsc::UnboundedSender<Value>,
    }

    #[async_trait]
    impl HostChannel for Desktop {
        fn serves(&self, _: HostCapability) -> bool {
            self.serving
        }
        async fn request(&self, capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
            assert_eq!((capability, method.0), (HostCapability::Computer, METHOD));
            let _ = self.asked.send(params);
            let answer = self.answer.lock().unwrap().take();
            match answer {
                Some(answer) => answer,
                None => std::future::pending().await,
            }
        }
        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    fn desktop(serving: bool, answer: Option<Result<Value, HostError>>) -> (Arc<dyn HostChannel>, mpsc::UnboundedReceiver<Value>) {
        let (asked, receive) = mpsc::unbounded_channel();
        let desktop: Arc<dyn HostChannel> = Arc::new(Desktop { serving, answer: Mutex::new(answer), asked });
        (desktop, receive)
    }

    #[tokio::test]
    async fn a_ready_answer_is_cached_and_the_next_prepare_asks_nothing() {
        let (desktop, mut asked) = desktop(true, Some(Ok(json!({"state": "ready"}))));
        let cancel = CancellationToken::new();
        assert_eq!(prepare_cursor(Some(&desktop), "prep-ready", Some("hwnd:0x3"), 4.0, 5.5, &cancel).await, CursorPrepare::Ready);
        assert_eq!(asked.try_recv().unwrap(), json!({"sessionThreadId": "prep-ready", "windowId": "hwnd:0x3", "x": 4.0, "y": 5.5}));
        assert_eq!(prepare_cursor(Some(&desktop), "prep-ready", None, 1.0, 1.0, &cancel).await, CursorPrepare::Ready);
        assert!(asked.try_recv().is_err());
        // The turn's end clears it, and a pointer event marks it live again.
        forget_ready("prep-ready");
        assert!(!is_ready("prep-ready"));
        mark_ready("prep-ready");
        assert!(is_ready("prep-ready"));
    }

    #[tokio::test]
    async fn an_unsupported_method_an_error_or_no_desktop_is_unavailable_and_nothing_is_cached() {
        let cancel = CancellationToken::new();
        let unknown = HostError::Rpc { code: METHOD_NOT_FOUND, message: "no such method".into(), data: None };
        let (old, _) = desktop(true, Some(Err(unknown)));
        assert_eq!(prepare_cursor(Some(&old), "prep-old", None, 0.0, 0.0, &cancel).await, CursorPrepare::Unavailable);
        let (failing, _) = desktop(true, Some(Err(HostError::Rpc { code: -32000, message: "boom".into(), data: None })));
        assert_eq!(prepare_cursor(Some(&failing), "prep-fail", None, 0.0, 0.0, &cancel).await, CursorPrepare::Unavailable);
        let (odd, _) = desktop(true, Some(Ok(json!({"state": "soon"}))));
        assert_eq!(prepare_cursor(Some(&odd), "prep-odd", None, 0.0, 0.0, &cancel).await, CursorPrepare::Unavailable);
        let (absent, mut asked) = desktop(false, None);
        assert_eq!(prepare_cursor(Some(&absent), "prep-absent", None, 0.0, 0.0, &cancel).await, CursorPrepare::Unavailable);
        assert!(asked.try_recv().is_err(), "a desktop not serving Computer is not asked");
        assert_eq!(prepare_cursor(None, "prep-none", None, 0.0, 0.0, &cancel).await, CursorPrepare::Unavailable);
        for session in ["prep-old", "prep-fail", "prep-odd", "prep-absent", "prep-none"] {
            assert!(!is_ready(session), "{session}");
        }
    }

    #[tokio::test]
    async fn an_answer_that_does_not_come_in_time_is_a_timeout_and_the_desktops_own_timeout_passes_through() {
        let cancel = CancellationToken::new();
        let (silent, _) = desktop(true, None);
        let started = std::time::Instant::now();
        assert_eq!(prepare_cursor(Some(&silent), "prep-slow", None, 0.0, 0.0, &cancel).await, CursorPrepare::Timeout);
        assert!(started.elapsed() >= PREPARE_CAP && started.elapsed() < Duration::from_secs(5));
        let (late, _) = desktop(true, Some(Ok(json!({"state": "timeout"}))));
        assert_eq!(prepare_cursor(Some(&late), "prep-late", None, 0.0, 0.0, &cancel).await, CursorPrepare::Timeout);
        assert!(!is_ready("prep-slow") && !is_ready("prep-late"));
    }

    #[tokio::test]
    async fn a_cancelled_action_stops_asking() {
        let (silent, _) = desktop(true, None);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let started = std::time::Instant::now();
        assert_eq!(prepare_cursor(Some(&silent), "prep-cancel", None, 0.0, 0.0, &cancel).await, CursorPrepare::Unavailable);
        assert!(started.elapsed() < PREPARE_CAP);
    }
}
