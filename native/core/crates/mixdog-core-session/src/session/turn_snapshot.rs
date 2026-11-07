//! The turn's review boundary (`turn-run/snapshot-tracker.mjs`): the worktree baseline is taken
//! once the turn's workspace is final, never on the first-token path, and every tool execution
//! of the turn waits for it, so no tool changes the worktree before the baseline exists.

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_agent::env::GateCall;
use mixdog_agent::env::GateDecision;
use mixdog_agent::env::ToolGate;
use mixdog_core_api::turn_review::TurnOpen;
use mixdog_core_api::turn_review::TurnReviewApi;
use mixdog_core_api::turn_review::TurnToken;
use mixdog_rt::TaskClass;
use tokio::sync::watch;

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
    /// is sealed before it reports settled. A turn that never began a review seals nothing.
    pub async fn finish(&self, aborted: bool) {
        if self.inner.started.get().is_none() {
            return;
        }
        if aborted && !self.inner.open.continue_turn {
            let this = self.clone();
            drop(mixdog_rt::spawn("turn-review-seal", TaskClass::Work, async move {
                if let Some(token) = this.ready().await {
                    this.inner.review.complete_turn(&this.inner.session, Some(&token)).await;
                }
            }));
            return;
        }
        let token = self.ready().await;
        self.inner.review.complete_turn(&self.inner.session, token.as_ref()).await;
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

    fn pre_dispatch_deny(&self, call: &GateCall) -> Option<String> {
        self.inner.pre_dispatch_deny(call)
    }

    fn apply_approval(&self, call: &GateCall, decision: &mixdog_protocol::ToolApprovalDecision) -> GateCall {
        self.inner.apply_approval(call, decision)
    }
}
