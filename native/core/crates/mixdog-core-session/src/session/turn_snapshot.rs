//! The turn's review boundary (`turn-run/snapshot-tracker.mjs`): the worktree baseline is taken
//! once the turn's workspace is final, never on the first-token path, and every tool execution
//! of the turn waits for it, so no tool changes the worktree before the baseline exists.

use std::sync::Arc;
use std::sync::OnceLock;

use std::time::Duration;

use async_trait::async_trait;
use mixdog_agent::cancel::Cancel;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateDecision;
use mixdog_agent::env::ToolGate;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_api::turn_review::TurnToken;
use mixdog_rt::TaskClass;
use tokio::sync::watch;

/// `turnCleanupSettleMs` (`turn-run.mjs`): how long a finishing turn waits for its review to seal.
pub const TURN_CLEANUP_SETTLE: Duration = Duration::from_millis(2_000);

/// One turn's review: begun with [`start`](Self::start), sealed by the actor at settle.
#[derive(Clone)]
pub struct TurnSnapshot {
    inner: Arc<Inner>,
}

struct Inner {
    review: Arc<dyn TurnReviewApi>,
    session: String,
    open: TurnOpen,
    /// Set by the first `start`: resolves to `begin_turn`'s token (`None` when nothing began).
    started: OnceLock<watch::Receiver<Option<Option<TurnToken>>>>,
}

impl TurnSnapshot {
    /// The review the turn's tools record their changes to.
    pub fn api(&self) -> Arc<dyn TurnReviewApi> {
        self.inner.review.clone()
    }

    /// `checkpoint_id` is the turn's first submitted row; a completion wake continues the turn
    /// that launched the worker (`continue_turn`).
    pub fn new(review: Arc<dyn TurnReviewApi>, session: &str, checkpoint_id: &str, continue_turn: bool) -> Self {
        let open = TurnOpen { checkpoint_id: mixdog_js::js_trim(checkpoint_id).to_owned(), continue_turn };
        Self { inner: Arc::new(Inner { review, session: session.to_owned(), open, started: OnceLock::new() }) }
    }

    /// `tracker.start`: the turn's workspace is final at `worktree`; the baseline is taken in the
    /// background. Only the first call begins.
    pub fn start(&self, worktree: &str) {
        let (tx, rx) = watch::channel(None);
        if self.inner.started.set(rx).is_err() {
            return;
        }
        let (inner, worktree) = (self.inner.clone(), worktree.to_owned());
        drop(mixdog_rt::spawn("turn-review-begin", TaskClass::Work, async move {
            let token = inner.review.begin_turn(&worktree, &inner.session, inner.open.clone()).await;
            let _ = tx.send(Some(token));
        }));
    }

    /// `beforeToolExecution`: resolves once the baseline exists (at once when the turn never
    /// began a review).
    pub async fn ready(&self) -> Option<TurnToken> {
        let mut rx = self.inner.started.get()?.clone();
        rx.wait_for(Option::is_some).await.ok().and_then(|token| token.clone()).flatten()
    }

    /// `tracker.finish(signal)`: a cancelled turn keeps its edits as a change record, sealed in
    /// the background once its baseline exists, and only the generation it began; any other turn
    /// is sealed before it reports settled, for at most [`TURN_CLEANUP_SETTLE`]: the seal then
    /// goes on detached, and the run's cancel ends the wait at once. A turn that never began a
    /// review seals nothing.
    pub async fn finish(&self, cancel: &Cancel) {
        if self.inner.started.get().is_none() {
            return;
        }
        let background = cancel.is_aborted() && !self.inner.open.continue_turn;
        let this = self.clone();
        let mut seal = mixdog_rt::spawn("turn-review-seal", TaskClass::Work, async move {
            let token = this.ready().await;
            if token.is_some() || !background {
                this.inner.review.complete_turn(&this.inner.session, token.as_ref()).await;
            }
        });
        if background {
            return;
        }
        tokio::select! {
            _ = &mut seal => {}
            _ = mixdog_rt::time::sleep(TURN_CLEANUP_SETTLE) => {}
            _ = cancel.cancelled() => {}
        }
    }
}

/// The run's tool gate with the turn's review in front: no call is judged (and so none
/// executes) before the baseline exists.
pub struct ReviewGate {
    snapshot: TurnSnapshot,
    inner: Arc<dyn ToolGate>,
}

impl ReviewGate {
    pub fn new(snapshot: TurnSnapshot, inner: Arc<dyn ToolGate>) -> Self {
        Self { snapshot, inner }
    }
}

#[async_trait]
impl ToolGate for ReviewGate {
    async fn check_call(&self, call_id: &str, call: &GateCall) -> GateDecision {
        self.snapshot.ready().await;
        self.inner.check_call(call_id, call).await
    }

    async fn refresh_policy(&self, call: &GateCall) {
        self.inner.refresh_policy(call).await
    }

    fn pre_dispatch_deny(&self, call: &GateCall) -> Option<String> {
        self.inner.pre_dispatch_deny(call)
    }

    fn deferred_call_denial(&self, call: &GateCall) -> Option<String> {
        self.inner.deferred_call_denial(call)
    }

    fn apply_approval(&self, call: &GateCall, decision: &mixdog_protocol::ToolApprovalDecision) -> GateCall {
        self.inner.apply_approval(call, decision)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::time::Duration;

    use async_trait::async_trait;
    use mixdog_agent::cancel::Cancel;
    use mixdog_core_api::turn_review as tr;
    use tokio::sync::Notify;

    use super::TURN_CLEANUP_SETTLE;
    use super::TurnSnapshot;

    /// A review whose baseline answers a token and whose seal never returns.
    #[derive(Default)]
    struct Wedged {
        sealing: Notify,
        sealed: Mutex<Vec<Option<u64>>>,
    }

    #[async_trait]
    impl tr::TurnReviewApi for Wedged {
        async fn record_call(&self, _: &str, _: &str, _: &str, _: Vec<tr::CallChange>) {}
        async fn record_tool_changes(&self, _: &str, _: &str, _: Vec<tr::CallChange>) {}
        fn take_call_diff(&self, _: &str) -> Option<String> {
            None
        }
        fn note_change(&self, _: Option<&[String]>) {}
        async fn begin_turn(&self, _: &str, _: &str, open: tr::TurnOpen) -> Option<tr::TurnToken> {
            Some(tr::TurnToken { generation: 1, checkpoint_id: open.checkpoint_id })
        }
        async fn complete_turn(&self, _: &str, expected: Option<&tr::TurnToken>) -> bool {
            self.sealed.lock().unwrap().push(expected.map(|t| t.generation));
            self.sealing.notify_one();
            std::future::pending().await
        }
        fn begin_agent_review(&self, _: &str, _: &str, _: &str, _: &str) -> Option<Box<dyn tr::AgentReview>> {
            None
        }
        fn forget_session(&self, _: &str) {}
        async fn turn_review_diff(&self, _: &str, _: &str, _: tr::ReviewRead) -> tr::Reply {
            unimplemented!()
        }
        async fn turn_review_file_patch(&self, _: &str, _: &str, _: &str) -> tr::Reply {
            unimplemented!()
        }
        async fn session_review_diff(&self, _: &str, _: &str) -> tr::Reply {
            unimplemented!()
        }
        async fn session_review_file_patch(&self, _: &str, _: &str, _: &str, _: &str) -> tr::Reply {
            unimplemented!()
        }
        async fn revert_turn_review(&self, _: &str, _: &str, _: &str) -> Result<tr::Reply, tr::ReviewError> {
            unimplemented!()
        }
        async fn revert_turn_review_file(&self, _: &str, _: &str, _: &str, _: &str) -> Result<tr::Reply, tr::ReviewError> {
            unimplemented!()
        }
        async fn turn_changes(&self, _: &str, _: tr::ChangesRead) -> Result<tr::Reply, tr::ReviewError> {
            unimplemented!()
        }
        async fn revert_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<tr::Reply, tr::ReviewError> {
            unimplemented!()
        }
        async fn reapply_turn_changes(&self, _: &str, _: &str, _: Option<&str>, _: f64) -> Result<tr::Reply, tr::ReviewError> {
            unimplemented!()
        }
        async fn clear_change_history(&self, _: &str) -> Result<tr::Reply, tr::ReviewError> {
            unimplemented!()
        }
    }

    fn started() -> (Arc<Wedged>, TurnSnapshot) {
        mixdog_rt::testing::tokens();
        let review = Arc::new(Wedged::default());
        let snapshot = TurnSnapshot::new(review.clone(), "s1", "cp-1", false);
        snapshot.start("/work");
        (review, snapshot)
    }

    /// A seal that never returns does not hold the turn's end past `turnCleanupSettleMs`; it goes on detached.
    #[tokio::test(start_paused = true)]
    async fn a_seal_that_never_returns_ends_at_the_settle_limit() {
        let (review, snapshot) = started();
        let cancel = Cancel::new();
        let ended = mixdog_rt::time::timeout(TURN_CLEANUP_SETTLE + Duration::from_millis(1), snapshot.finish(&cancel)).await;
        assert!(ended.is_ok(), "finish waited past the settle limit");
        assert_eq!(*review.sealed.lock().unwrap(), vec![Some(1)]);
    }

    /// The run's cancel ends the wait for the seal at once.
    #[tokio::test(start_paused = true)]
    async fn a_cancel_ends_the_wait_for_the_seal() {
        let (review, snapshot) = started();
        let cancel = Cancel::new();
        let waiting = {
            let (snapshot, cancel) = (snapshot.clone(), cancel.clone());
            tokio::spawn(async move { snapshot.finish(&cancel).await })
        };
        review.sealing.notified().await;
        cancel.abort_default();
        let ended = mixdog_rt::time::timeout(Duration::from_millis(1), waiting).await;
        assert!(ended.is_ok(), "finish outlived the cancel");
    }
}
