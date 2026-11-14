//! Owner: s4-engine-settle
//! When a page is done moving (`settle.ts`, with the DOM observer of `dom-quiet.ts` run by the host as `page/domQuiet`). A gesture
//! is followed by three independent quiet signals, load, DOM mutations and in-flight requests, and a postcondition is sampled the
//! same way whether it was asked for before or after the action. Nothing here decides what to do next; it only reports that the
//! page stopped changing.
//!
//! The engine reads the page through a [`PageProbe`] (the facts the host pushed and the page's network ledger), polled on
//! `mixdog_rt` timers: the old engine's `did-stop-loading` listener became a [`LOAD_POLL`] poll of the page's `loading` fact, and
//! the network observer keeps its 75 ms poll. The host is only asked for what the engine cannot see: a render checkpoint, a DOM
//! quiet window, the page text and a stop.

use std::convert::Infallible;
use std::fmt;
use std::future::Future;
use std::future::poll_fn;
use std::pin::pin;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;

use mixdog_app_protocol::v2::browser_engine::HostBrowserPageDomQuietParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageRenderCheckpointParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageStopParams;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_rt::CancelView;
use mixdog_rt::CancellationToken;
use mixdog_rt::time;

use crate::error::HostCallError;
use crate::ledger::network::NetworkLedger;
use crate::limits::ACTION_SETTLE_DOM_TIMEOUT;
use crate::limits::ACTION_SETTLE_LOAD_TIMEOUT;
use crate::limits::ACTION_SETTLE_QUIET;
use crate::limits::CDP_REQUEST_TIMEOUT;
use crate::port::BrowserHost;

/// How often the page's `loading` fact is read while a load is awaited.
const LOAD_POLL: Duration = Duration::from_millis(25);
/// How often the network observer reads the ledger.
const NETWORK_POLL: Duration = Duration::from_millis(75);
/// How long the host may take to confirm a render checkpoint (`CHECKPOINT_DEADLINE_MS`): an unconfirmed frame is not a failure.
const CHECKPOINT_TIMEOUT_MS: u32 = 1_000;
/// A request still in flight after this long no longer holds a gesture back (`recentInflight`'s default age).
const RECENT_INFLIGHT_MAX_AGE_MS: i64 = 15_000;

/// How CDP reports that the document a checkpoint was awaiting in went away: the gesture itself navigated (Enter in a search box,
/// a submit button). The host forwards the CDP message in its failure.
const DOCUMENT_REPLACED: [&str; 2] = ["Inspected target navigated or closed", "Execution context was destroyed"];

/// The command's own cancellation, with the reason its canceller gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cancelled {
    pub reason: Option<Arc<str>>,
}

impl fmt::Display for Cancelled {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.reason {
            Some(reason) => out.write_str(reason),
            None => out.write_str("browser command cancelled"),
        }
    }
}

impl std::error::Error for Cancelled {}

/// Why a settle ended without the page being observed settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleError {
    Cancelled(Cancelled),
    /// The page could not be read after the gesture (the text says where to go next).
    Failed(String),
}

impl From<Cancelled> for SettleError {
    fn from(cancelled: Cancelled) -> Self {
        Self::Cancelled(cancelled)
    }
}

impl fmt::Display for SettleError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled(cancelled) => fmt::Display::fmt(cancelled, out),
            Self::Failed(text) => out.write_str(text),
        }
    }
}

impl std::error::Error for SettleError {}

/// `browserCancellation`: the error of a cancelled command.
pub fn cancelled(cancel: &CancelView) -> Cancelled {
    Cancelled { reason: cancel.reason() }
}

/// `throwIfBrowserCancelled`: stops a command whose caller has already cancelled it.
pub fn throw_if_cancelled(cancel: &CancelView) -> Result<(), Cancelled> {
    if cancel.is_cancelled() { Err(cancelled(cancel)) } else { Ok(()) }
}

/// `pause`: a sleep that a cancelled command wakes from at once.
pub async fn pause(duration: Duration, cancel: &CancelView) -> Result<(), Cancelled> {
    throw_if_cancelled(cancel)?;
    match race(time::sleep(duration), cancel.cancelled()).await {
        Either::Left(()) => Ok(()),
        Either::Right(()) => Err(cancelled(cancel)),
    }
}

pub(super) enum Either<A, B> {
    Left(A),
    Right(B),
}

/// Whichever of the two is ready first (the left one when both are).
pub(super) async fn race<A: Future, B: Future>(left: A, right: B) -> Either<A::Output, B::Output> {
    let mut left = pin!(left);
    let mut right = pin!(right);
    poll_fn(|cx| {
        if let Poll::Ready(done) = left.as_mut().poll(cx) {
            return Poll::Ready(Either::Left(done));
        }
        if let Poll::Ready(done) = right.as_mut().poll(cx) {
            return Poll::Ready(Either::Right(done));
        }
        Poll::Pending
    })
    .await
}

/// All three, or the first failure (`Promise.all`): the others are dropped at once.
pub(super) async fn try_join3<A, B, C, TA, TB, TC, E>(first: A, second: B, third: C) -> Result<(TA, TB, TC), E>
where
    A: Future<Output = Result<TA, E>>,
    B: Future<Output = Result<TB, E>>,
    C: Future<Output = Result<TC, E>>,
{
    let mut first = pin!(first);
    let mut second = pin!(second);
    let mut third = pin!(third);
    let (mut done_first, mut done_second, mut done_third) = (None, None, None);
    poll_fn(|cx| {
        if done_first.is_none() {
            if let Poll::Ready(done) = first.as_mut().poll(cx) {
                match done {
                    Ok(value) => done_first = Some(value),
                    Err(error) => return Poll::Ready(Err(error)),
                }
            }
        }
        if done_second.is_none() {
            if let Poll::Ready(done) = second.as_mut().poll(cx) {
                match done {
                    Ok(value) => done_second = Some(value),
                    Err(error) => return Poll::Ready(Err(error)),
                }
            }
        }
        if done_third.is_none() {
            if let Poll::Ready(done) = third.as_mut().poll(cx) {
                match done {
                    Ok(value) => done_third = Some(value),
                    Err(error) => return Poll::Ready(Err(error)),
                }
            }
        }
        match (done_first.take(), done_second.take(), done_third.take()) {
            (Some(first), Some(second), Some(third)) => Poll::Ready(Ok((first, second, third))),
            (first, second, third) => {
                (done_first, done_second, done_third) = (first, second, third);
                Poll::Pending
            }
        }
    })
    .await
}

/// How long the page must stay quiet, and the bounds of each observation (`quietMs`, `loadTimeoutMs`, `domTimeoutMs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlePolicy {
    pub quiet: Duration,
    pub load: Duration,
    pub dom: Duration,
}

impl Default for SettlePolicy {
    fn default() -> Self {
        Self { quiet: ACTION_SETTLE_QUIET, load: ACTION_SETTLE_LOAD_TIMEOUT, dom: ACTION_SETTLE_DOM_TIMEOUT }
    }
}

/// What the engine knows of a page at one moment, read together.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageState {
    /// A document (or a frame of it) is still loading.
    pub loading: bool,
    pub url: String,
    /// The page is closed: nothing can be read from it any more.
    pub destroyed: bool,
    /// The type of the JavaScript dialog that blocks the page, if one does.
    pub dialog: Option<String>,
    /// Requests in flight, whatever their age (`pendingCount`).
    pub network_pending: usize,
    /// Requests in flight that began recently (`recentInflight`).
    pub recent_inflight: usize,
}

impl PageState {
    /// The state a page's last facts and its network ledger describe; `now_ms` is the epoch time the ledger's request times use.
    pub fn from_facts(facts: &PageFacts, network: &NetworkLedger, now_ms: i64) -> Self {
        Self {
            loading: facts.loading,
            url: facts.url.clone(),
            destroyed: !facts.alive,
            dialog: facts.pending_dialog.as_ref().map(|dialog| dialog.kind.clone()),
            network_pending: network.pending_count(),
            recent_inflight: network.recent_inflight(now_ms, RECENT_INFLIGHT_MAX_AGE_MS).len(),
        }
    }
}

/// Where the engine reads a page's current state (the lane's mirror of the host's facts and the page's ledgers).
pub trait PageProbe: Send + Sync {
    fn state(&self) -> PageState;
}

/// The page a settle observes: the host to ask what only it can see, the page's id, and how to read its state.
#[derive(Clone, Copy)]
pub struct Page<'a> {
    pub host: &'a dyn BrowserHost,
    pub id: &'a str,
    pub probe: &'a dyn PageProbe,
}

/// How a step of a sequence ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    Completed,
    /// The input executed, but the page could not be read afterwards.
    Inconclusive,
    /// A dialog blocks the sequence.
    Blocked,
}

/// What `stepSettleResult` answers: how the step ended and what to tell the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepResult {
    pub outcome: StepKind,
    pub text: String,
}

impl StepResult {
    fn completed() -> Self {
        Self { outcome: StepKind::Completed, text: String::new() }
    }
}

/// The two ways a wait ends early: the command's cancellation, and `until` (the caller's own postcondition holding: an early exit,
/// not a cancellation).
#[derive(Clone, Copy)]
struct Stop<'a> {
    cancel: &'a CancelView,
    until: Option<&'a CancellationToken>,
}

impl Stop<'_> {
    fn fired(&self) -> bool {
        self.cancel.is_cancelled() || self.until.is_some_and(CancellationToken::is_cancelled)
    }

    async fn wait(&self) {
        match self.until {
            Some(until) => {
                race(self.cancel.cancelled(), until.cancelled()).await;
            }
            None => self.cancel.cancelled().await,
        }
    }
}

/// Waits for the page to stop loading, for at most `timeout`; a blocked page (a dialog holds its load) is not waited for.
async fn wait_for_load_settle(page: &Page<'_>, timeout: Duration, stop: Stop<'_>) {
    let state = page.probe.state();
    if stop.fired() || !state.loading || state.dialog.is_some() {
        return;
    }
    let loaded = async {
        while page.probe.state().loading {
            time::sleep(LOAD_POLL).await;
        }
    };
    race(race(loaded, time::sleep(timeout)), stop.wait()).await;
}

/// `waitForLoadSettle`, for a caller that only waits for a load (a navigation).
pub async fn wait_for_load(page: &Page<'_>, timeout: Duration, cancel: &CancelView) {
    wait_for_load_settle(page, timeout, Stop { cancel, until: None }).await;
}

/// The page's DOM stays unchanged for the quiet window, or the DOM timeout ends. The host runs the observer; ending the wait early
/// cancels its request (a cooperative stop: the page's own scripts are not terminated by the engine).
async fn wait_for_dom_quiet(page: &Page<'_>, policy: &SettlePolicy, stop: Stop<'_>) {
    if stop.fired() {
        return;
    }
    let millis = |duration: Duration| u32::try_from(duration.as_millis()).unwrap_or(u32::MAX);
    let quiet_ms = millis(policy.quiet).max(1);
    let params = HostBrowserPageDomQuietParams { page_id: page.id.to_string(), quiet_ms, timeout_ms: millis(policy.dom).max(quiet_ms) };
    let local = stop.cancel.token().child_token();
    // A failed observer (the document went away mid-observation) only ends the wait: the caller's own checks decide what is next.
    if let Either::Right(()) = race(page.host.page_dom_quiet(params, &local), stop.wait()).await {
        local.cancel();
    }
}

/// No request has started or been in flight for the quiet window, within the DOM timeout.
async fn wait_for_network_quiet(page: &Page<'_>, policy: &SettlePolicy, stop: Stop<'_>) {
    let started = time::Instant::now();
    let mut quiet_since = (page.probe.state().network_pending == 0).then(time::Instant::now);
    while started.elapsed() < policy.dom {
        if stop.fired() {
            return;
        }
        let state = page.probe.state();
        if state.dialog.is_some() {
            return;
        }
        if state.recent_inflight == 0 {
            if quiet_since.get_or_insert_with(time::Instant::now).elapsed() >= policy.quiet {
                return;
            }
        } else {
            quiet_since = None;
        }
        if let Either::Right(()) = race(time::sleep(NETWORK_POLL), stop.wait()).await {
            return;
        }
    }
}

/// Load, DOM and network observation together, each bounded by its timeout. A failure of one observer only ends it; the command's
/// own cancellation is the only error.
async fn observe_quiet(page: &Page<'_>, policy: &SettlePolicy, stop: Stop<'_>) -> Result<(), Cancelled> {
    let observed = try_join3(
        async {
            wait_for_load_settle(page, policy.load, stop).await;
            Ok::<(), Infallible>(())
        },
        async {
            wait_for_dom_quiet(page, policy, stop).await;
            Ok::<(), Infallible>(())
        },
        async {
            wait_for_network_quiet(page, policy, stop).await;
            Ok::<(), Infallible>(())
        },
    );
    // Racing the group, not only stopping it: an early exit must not wait for an observer that never looks at the cutoff.
    match stop.until {
        Some(until) => {
            let _ = race(observed, until.cancelled()).await;
        }
        None => {
            let _ = observed.await;
        }
    }
    throw_if_cancelled(stop.cancel)
}

struct Step {
    result: StepResult,
    /// A frame never confirmed the checkpoint: its pending work is unknown.
    unconfirmed: bool,
}

/// Lets input handlers and their rendering work run without waiting for unrelated DOM mutations. The next gesture still owns its
/// target's actionability checks; the final reply waits for pending load/network work. A hidden page may throttle animation
/// frames, so the checkpoint is bounded.
async fn step_settle(page: &Page<'_>, cancel: &CancelView) -> Result<Step, Cancelled> {
    throw_if_cancelled(cancel)?;
    let mut unconfirmed = false;
    if page.probe.state().dialog.is_none() {
        let params = HostBrowserPageRenderCheckpointParams { page_id: page.id.to_string(), timeout_ms: CHECKPOINT_TIMEOUT_MS };
        match page.host.page_render_checkpoint(params, cancel.token()).await {
            // A frame that never confirmed (scripts blocked, no timers) is not a failure and the input is never replayed, but its
            // pending work is unknown, so the caller must not treat an idle network as settled.
            Ok(checkpoint) => unconfirmed = !checkpoint.reached,
            Err(error) => {
                if cancel.is_cancelled() || error == HostCallError::Cancelled {
                    return Err(cancelled(cancel));
                }
                // The old document has nothing left to render; the navigation the input started is what the caller's load settle
                // and reply observe next.
                let state = page.probe.state();
                if state.dialog.is_none() {
                    let message = error.to_string();
                    let replaced = !state.destroyed
                        && matches!(error, HostCallError::Failed { .. })
                        && DOCUMENT_REPLACED.iter().any(|marker| message.contains(marker));
                    if replaced {
                        return Ok(Step { result: StepResult::completed(), unconfirmed: false });
                    }
                    return Ok(Step {
                        result: StepResult {
                            outcome: StepKind::Inconclusive,
                            // The page itself is loaded and the gesture landed; only this reading of it failed. Say so, or the
                            // caller abandons a page that is fine.
                            text: format!(
                                "The browser input executed, but its rendering checkpoint failed; input was not replayed. The page is still there \u{2014} observe it again instead of repeating the action. {message}"
                            ),
                        },
                        unconfirmed: false,
                    });
                }
            }
        }
    }
    throw_if_cancelled(cancel)?;
    let result = match page.probe.state().dialog {
        Some(kind) => StepResult { outcome: StepKind::Blocked, text: format!("A {kind} dialog is blocking the sequence.") },
        None => StepResult::completed(),
    };
    Ok(Step { result, unconfirmed })
}

/// `stepSettleResult`: the settle between the steps of a sequence. A step whose frame never confirmed the checkpoint gets the same
/// bounded load/DOM/network quiet observation as a final settle; the input is neither replayed nor failed.
pub async fn step_settle_result(page: &Page<'_>, policy: &SettlePolicy, cancel: &CancelView) -> Result<StepResult, Cancelled> {
    let step = step_settle(page, cancel).await?;
    if step.unconfirmed && step.result.outcome == StepKind::Completed {
        observe_quiet(page, policy, Stop { cancel, until: None }).await?;
    }
    Ok(step.result)
}

/// What a post-gesture settle is told besides the policy.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AfterAction {
    /// Observe the quiet windows even when nothing looks pending (a postcondition that was already true proves nothing).
    pub require_quiet: bool,
    /// Where the page was before the gesture: a URL that changed without a load means the view is still being replaced.
    pub previous_url: Option<String>,
}

/// Post-gesture settle: load, DOM and network observation, each bounded; long-polling pages cannot hold the command forever.
///
/// `until` is an early exit, not a cancellation: once the caller's own postcondition holds, the page has reached the state that was
/// asked for, so the generic quiet windows stop waiting for pages that never go quiet (analytics, polling widgets). A client-side
/// route change swaps the view without loading a document: nothing is loading, the network can already be quiet, and a url
/// postcondition is satisfied by `history.pushState` before the new screen renders, so that one case waits for the page to go
/// quiet and refuses the early exit.
///
/// A real cancellation stops the page's own loading (`page/stop`); an early exit only stops waiting for it.
pub async fn settle_after_action(
    page: &Page<'_>,
    policy: &SettlePolicy,
    cancel: &CancelView,
    until: Option<&CancellationToken>,
    options: &AfterAction,
) -> Result<(), SettleError> {
    let was_cancelled = cancel.is_cancelled();
    let outcome = after_action(page, policy, cancel, until, options).await;
    if !was_cancelled && cancel.is_cancelled() {
        let state = page.probe.state();
        if state.loading && !state.destroyed {
            let params = HostBrowserPageStopParams { page_id: page.id.to_string() };
            // Teardown can race the cancellation: a stop that fails or hangs changes nothing the caller is told.
            let _ = time::timeout(CDP_REQUEST_TIMEOUT, page.host.page_stop(params, &CancellationToken::new())).await;
        }
    }
    outcome
}

async fn after_action(
    page: &Page<'_>,
    policy: &SettlePolicy,
    cancel: &CancelView,
    until: Option<&CancellationToken>,
    options: &AfterAction,
) -> Result<(), SettleError> {
    let state = page.probe.state();
    let route_changed = options.previous_url.as_deref().is_some_and(|previous| !state.loading && state.url != previous);
    let stop = Stop { cancel, until: if route_changed { None } else { until } };
    if state.dialog.is_some() {
        return Ok(());
    }
    // `reload` returns before navigation completes. Observing its old contexts first races the whole frame tree being replaced.
    wait_for_load_settle(page, policy.load, stop).await;
    throw_if_cancelled(cancel)?;
    if page.probe.state().dialog.is_some() {
        return Ok(());
    }
    // Uniform for individual gestures and batches: flush queued rendering, then wait only when actual load/network work remains. A
    // future timer has no knowable completion time; an explicit expect/settleMs owns that dependency and is awaited independently
    // by the reply.
    let step = step_settle(page, cancel).await?;
    match step.result.outcome {
        StepKind::Blocked => return Ok(()),
        StepKind::Inconclusive => return Err(SettleError::Failed(step.result.text)),
        StepKind::Completed => {}
    }
    // An unconfirmed frame may still be rendering: run the bounded quiet observation instead of returning on an idle network alone.
    let now = page.probe.state();
    if !options.require_quiet && !step.unconfirmed && !route_changed && !now.loading && now.recent_inflight == 0 {
        return Ok(());
    }
    observe_quiet(page, policy, stop).await?;
    Ok(())
}

#[cfg(test)]
pub(super) mod support {
    //! A page and a host the settle tests drive: the page's state is set by the test, the host answers by wire name.

    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::Value;
    use serde_json::json;

    use super::*;
    use crate::fake::page_facts;
    use crate::port::HostWire;

    #[derive(Default)]
    pub struct TestProbe(Mutex<PageState>);

    impl TestProbe {
        pub fn new(url: &str) -> Arc<Self> {
            Arc::new(Self(Mutex::new(PageState { url: url.to_string(), ..PageState::default() })))
        }

        pub fn set(&self, change: impl FnOnce(&mut PageState)) {
            change(&mut self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
        }
    }

    impl PageProbe for TestProbe {
        fn state(&self) -> PageState {
            self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
        }
    }

    pub struct TestHost {
        probe: Arc<TestProbe>,
        /// The checkpoint's answer: whether it was reached, or the failure's message.
        pub checkpoint: Mutex<Result<bool, String>>,
        pub text: Mutex<String>,
        pub dom_quiet_delay: Mutex<Duration>,
        /// The last segment of each wire name, in the order called.
        pub calls: Mutex<Vec<String>>,
        /// Whether the page was loading when the checkpoint was asked.
        pub loading_at_checkpoint: Mutex<Option<bool>>,
        /// The page navigates while its text is read.
        pub url_after_read: Mutex<Option<String>>,
        pub read_fails: Mutex<bool>,
    }

    impl TestHost {
        pub fn new(probe: &Arc<TestProbe>) -> Self {
            Self {
                probe: probe.clone(),
                checkpoint: Mutex::new(Ok(true)),
                text: Mutex::new(String::new()),
                dom_quiet_delay: Mutex::new(Duration::ZERO),
                calls: Mutex::new(Vec::new()),
                loading_at_checkpoint: Mutex::new(None),
                url_after_read: Mutex::new(None),
                read_fails: Mutex::new(false),
            }
        }

        pub fn called(&self) -> Vec<String> {
            self.calls.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
        }

        pub fn count(&self, name: &str) -> usize {
            self.called().iter().filter(|call| *call == name).count()
        }
    }

    #[async_trait]
    impl HostWire for TestHost {
        async fn call(&self, method: &'static str, _params: Value, cancel: &CancellationToken) -> Result<Value, HostCallError> {
            let name = method.rsplit('/').next().unwrap_or(method).to_string();
            self.calls.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(name.clone());
            let facts = page_facts("p1", 1);
            match name.as_str() {
                "renderCheckpoint" => {
                    *self.loading_at_checkpoint.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(self.probe.state().loading);
                    match self.checkpoint.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
                        Ok(reached) => Ok(json!({"reached": reached, "facts": facts})),
                        Err(message) => Err(HostCallError::Failed { message }),
                    }
                }
                "domQuiet" => {
                    let delay = *self.dom_quiet_delay.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    tokio::select! {
                        () = time::sleep(delay) => Ok(json!({"quiet": true, "mutations": 0, "facts": facts})),
                        () = cancel.cancelled() => Err(HostCallError::Cancelled),
                    }
                }
                "stop" => Ok(json!({"facts": facts})),
                "read" => {
                    if *self.read_fails.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) {
                        return Err(HostCallError::Failed { message: "read failed".into() });
                    }
                    if let Some(url) = self.url_after_read.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
                        self.probe.set(|state| state.url = url);
                    }
                    let text = self.text.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
                    Ok(json!({"payload": {"url": "u", "title": "", "text": text}, "truncated": false, "facts": facts}))
                }
                other => Err(HostCallError::Failed { message: format!("unscripted {other}") }),
            }
        }

        fn notify(&self, _method: &'static str, _params: Value) -> Result<(), HostCallError> {
            Ok(())
        }
    }

    pub fn fast_policy() -> SettlePolicy {
        SettlePolicy { quiet: Duration::from_millis(20), load: Duration::from_millis(200), dom: Duration::from_millis(200) }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_rt::CancelSource;

    use super::support::*;
    use super::*;

    const URL: &str = "https://example.test/app";

    fn rig(reached: bool) -> (Arc<TestProbe>, Arc<TestHost>) {
        let probe = TestProbe::new(URL);
        let host = Arc::new(TestHost::new(&probe));
        *host.checkpoint.lock().expect("lock") = Ok(reached);
        (probe, host)
    }

    fn page<'a>(host: &'a TestHost, probe: &'a TestProbe) -> Page<'a> {
        Page { host, id: "p1", probe }
    }

    fn live() -> CancelView {
        CancelSource::new().view()
    }

    #[tokio::test]
    async fn a_confirmed_checkpoint_with_nothing_pending_returns_without_observing_the_dom() {
        let (probe, host) = rig(true);
        settle_after_action(&page(&host, &probe), &fast_policy(), &live(), None, &AfterAction::default()).await.expect("settled");
        assert_eq!(host.called(), ["renderCheckpoint"]);
    }

    #[tokio::test]
    async fn an_unconfirmed_checkpoint_is_not_settled_on_an_idle_network_alone_and_never_fails_the_input() {
        let (probe, host) = rig(false);
        settle_after_action(&page(&host, &probe), &fast_policy(), &live(), None, &AfterAction::default()).await.expect("settled");
        assert_eq!(host.called(), ["renderCheckpoint", "domQuiet"]);
    }

    #[tokio::test]
    async fn a_sequence_step_with_an_unconfirmed_checkpoint_runs_the_quiet_observation_without_failing() {
        let (probe, host) = rig(true);
        let confirmed = step_settle_result(&page(&host, &probe), &fast_policy(), &live()).await.expect("step");
        assert_eq!(confirmed, StepResult { outcome: StepKind::Completed, text: String::new() });
        assert_eq!(host.called(), ["renderCheckpoint"]);

        let (probe, host) = rig(false);
        let unconfirmed = step_settle_result(&page(&host, &probe), &fast_policy(), &live()).await.expect("step");
        assert_eq!(unconfirmed, StepResult { outcome: StepKind::Completed, text: String::new() });
        assert_eq!(host.called(), ["renderCheckpoint", "domQuiet"]);

        let (probe, host) = rig(false);
        *host.dom_quiet_delay.lock().expect("lock") = Duration::from_secs(5);
        let source = CancelSource::new();
        let view = source.view();
        let canceller = tokio::spawn(async move {
            time::sleep(Duration::from_millis(15)).await;
            source.cancel("step cancelled");
        });
        let error = step_settle_result(&page(&host, &probe), &fast_policy(), &view).await.expect_err("cancelled");
        assert_eq!(error.to_string(), "step cancelled");
        canceller.await.expect("canceller");
    }

    #[tokio::test]
    async fn a_route_swapped_without_a_load_waits_for_the_new_view_and_a_url_condition_cannot_cut_it_short() {
        let (probe, host) = rig(true);
        probe.set(|state| state.url = "https://example.test/app/learn".into());
        let satisfied = CancellationToken::new();
        satisfied.cancel();
        let options = AfterAction { require_quiet: false, previous_url: Some(URL.into()) };
        settle_after_action(&page(&host, &probe), &fast_policy(), &live(), Some(&satisfied), &options).await.expect("settled");
        assert_eq!(host.count("domQuiet"), 1, "the quiet windows ran although the condition already held");

        // An address that did not move keeps the early exit, so ordinary gestures are not slowed down.
        let (probe, host) = rig(true);
        settle_after_action(&page(&host, &probe), &fast_policy(), &live(), Some(&satisfied), &options).await.expect("settled");
        assert_eq!(host.called(), ["renderCheckpoint"]);
    }

    #[tokio::test]
    async fn settlement_still_waits_for_in_flight_requests_and_document_completion() {
        let (probe, host) = rig(true);
        probe.set(|state| {
            state.loading = true;
            state.network_pending = 1;
            state.recent_inflight = 1;
        });
        let flipper = probe.clone();
        let finisher = tokio::spawn(async move {
            time::sleep(Duration::from_millis(25)).await;
            flipper.set(|state| {
                state.loading = false;
                state.network_pending = 0;
                state.recent_inflight = 0;
            });
        });
        settle_after_action(&page(&host, &probe), &fast_policy(), &live(), None, &AfterAction::default()).await.expect("settled");
        finisher.await.expect("finisher");
        let state = probe.state();
        assert!(!state.loading);
        assert_eq!(state.network_pending, 0);
        assert_eq!(*host.loading_at_checkpoint.lock().expect("lock"), Some(false), "the checkpoint waited for the load");
    }

    #[tokio::test]
    async fn settlement_fails_closed_on_cancellation_and_failed_rendering() {
        let (probe, host) = rig(true);
        let source = CancelSource::new();
        source.cancel("cancelled");
        let error = settle_after_action(&page(&host, &probe), &fast_policy(), &source.view(), None, &AfterAction::default()).await.expect_err("cancelled");
        assert_eq!(error, SettleError::Cancelled(Cancelled { reason: Some("cancelled".into()) }));
        assert!(host.called().is_empty());

        *host.checkpoint.lock().expect("lock") = Err("renderer unavailable".into());
        let error = settle_after_action(&page(&host, &probe), &fast_policy(), &live(), None, &AfterAction::default()).await.expect_err("broken");
        match error {
            SettleError::Failed(text) => assert!(text.contains("checkpoint failed") && text.contains("renderer unavailable"), "{text}"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_step_whose_reading_fails_reports_the_cause_and_where_to_go_next() {
        let (probe, host) = rig(true);
        *host.checkpoint.lock().expect("lock") = Err("frame topology changed during observation".into());
        let result = step_settle_result(&page(&host, &probe), &fast_policy(), &live()).await.expect("step");
        assert_eq!(result.outcome, StepKind::Inconclusive);
        assert!(result.text.contains("input was not replayed"));
        assert!(result.text.contains("observe it again instead of repeating the action"));
        assert!(result.text.contains("frame topology changed during observation"));
    }

    #[tokio::test]
    async fn a_step_that_navigated_its_own_document_completes_instead_of_failing_its_checkpoint() {
        let (probe, host) = rig(true);
        for message in ["Inspected target navigated or closed", "Execution context was destroyed."] {
            *host.checkpoint.lock().expect("lock") = Err(message.into());
            let result = step_settle_result(&page(&host, &probe), &fast_policy(), &live()).await.expect("step");
            assert_eq!(result, StepResult { outcome: StepKind::Completed, text: String::new() });
            settle_after_action(&page(&host, &probe), &fast_policy(), &live(), None, &AfterAction::default()).await.expect("settled");
        }
        // A closed page is not a navigation: its reading still fails.
        *host.checkpoint.lock().expect("lock") = Err("Inspected target navigated or closed".into());
        probe.set(|state| state.destroyed = true);
        let result = step_settle_result(&page(&host, &probe), &fast_policy(), &live()).await.expect("step");
        assert_eq!(result.outcome, StepKind::Inconclusive);
    }

    #[tokio::test]
    async fn a_blocking_dialog_ends_the_step_as_blocked_and_the_settle_without_error() {
        let (probe, host) = rig(true);
        probe.set(|state| state.dialog = Some("confirm".into()));
        let result = step_settle_result(&page(&host, &probe), &fast_policy(), &live()).await.expect("step");
        assert_eq!(result, StepResult { outcome: StepKind::Blocked, text: "A confirm dialog is blocking the sequence.".into() });
        settle_after_action(&page(&host, &probe), &fast_policy(), &live(), None, &AfterAction::default()).await.expect("settled");
        assert!(host.called().is_empty(), "a blocked page is never asked");
    }

    #[tokio::test]
    async fn reload_settlement_waits_for_replacement_frames_before_its_rendering_checkpoint() {
        let (probe, host) = rig(true);
        probe.set(|state| state.loading = true);
        let flipper = probe.clone();
        let finisher = tokio::spawn(async move {
            time::sleep(Duration::from_millis(30)).await;
            flipper.set(|state| state.loading = false);
        });
        settle_after_action(&page(&host, &probe), &fast_policy(), &live(), None, &AfterAction::default()).await.expect("settled");
        finisher.await.expect("finisher");
        assert_eq!(*host.loading_at_checkpoint.lock().expect("lock"), Some(false));
        assert_eq!(host.count("renderCheckpoint"), 1);
    }

    #[tokio::test]
    async fn cancellation_during_reload_settling_stops_the_page_without_inspecting_replaced_frames() {
        let (probe, host) = rig(true);
        probe.set(|state| state.loading = true);
        let source = CancelSource::new();
        let view = source.view();
        let canceller = tokio::spawn(async move {
            time::sleep(Duration::from_millis(15)).await;
            source.cancel("user stopped it");
        });
        let error = settle_after_action(&page(&host, &probe), &fast_policy(), &view, None, &AfterAction::default()).await.expect_err("cancelled");
        canceller.await.expect("canceller");
        assert_eq!(error, SettleError::Cancelled(Cancelled { reason: Some("user stopped it".into()) }));
        assert_eq!(host.called(), ["stop"]);
    }

    #[tokio::test]
    async fn a_cutoff_during_the_quiet_observation_ends_it_without_an_error() {
        let (probe, host) = rig(false);
        *host.dom_quiet_delay.lock().expect("lock") = Duration::from_secs(5);
        probe.set(|state| state.recent_inflight = 1);
        let satisfied = CancellationToken::new();
        let trigger = satisfied.clone();
        let canceller = tokio::spawn(async move {
            time::sleep(Duration::from_millis(15)).await;
            trigger.cancel();
        });
        settle_after_action(&page(&host, &probe), &fast_policy(), &live(), Some(&satisfied), &AfterAction::default()).await.expect("settled");
        canceller.await.expect("canceller");
    }

    #[tokio::test]
    async fn try_join3_returns_the_first_failure_at_once() {
        let slow = async {
            time::sleep(Duration::from_secs(30)).await;
            Ok::<u8, &str>(1)
        };
        let failing = async { Err::<u8, &str>("boom") };
        let fine = async { Ok::<u8, &str>(3) };
        assert_eq!(try_join3(slow, failing, fine).await, Err("boom"));
        assert_eq!(try_join3(async { Ok::<u8, &str>(1) }, async { Ok::<u8, &str>(2) }, async { Ok::<u8, &str>(3) }).await, Ok((1, 2, 3)));
    }
}
