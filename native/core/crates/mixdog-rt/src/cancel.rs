//! Cancellation with a reason (the `controller.abort(new Error("…"))` of the Node runtime).
//!
//! A [`CancelSource`] owns a [`CancellationToken`] plus a write-once reason. The token is the
//! ordinary one, so lanes, tasks and `select!` arms take it unchanged through
//! [`CancelSource::token`]; a [`CancelView`] additionally reads the reason after the token
//! fired. Children made with [`CancelSource::child`] are cancelled by their parent and report
//! the parent's reason.

use std::sync::Arc;
use std::sync::OnceLock;

use tokio_util::sync::CancellationToken;

struct Node {
    /// Set once, strictly before the token is cancelled.
    reason: OnceLock<Arc<str>>,
    parent: Option<Arc<Node>>,
}

impl Node {
    /// This node's own reason, else the nearest ancestor's.
    fn reason(&self) -> Option<Arc<str>> {
        let mut node = self;
        loop {
            if let Some(reason) = node.reason.get() {
                return Some(reason.clone());
            }
            node = node.parent.as_deref()?;
        }
    }
}

/// The cancelling side. Cloning shares the same source.
#[derive(Clone)]
pub struct CancelSource {
    token: CancellationToken,
    node: Arc<Node>,
}

impl Default for CancelSource {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelSource {
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            node: Arc::new(Node {
                reason: OnceLock::new(),
                parent: None,
            }),
        }
    }

    /// A source cancelled whenever `self` is (and reporting its reason then), which can also
    /// be cancelled on its own without touching the parent.
    pub fn child(&self) -> Self {
        Self {
            token: self.token.child_token(),
            node: Arc::new(Node {
                reason: OnceLock::new(),
                parent: Some(self.node.clone()),
            }),
        }
    }

    /// Cancels with `reason`. The first reason wins: returns `true` if this call set it,
    /// `false` if the source was already cancelled (by an earlier reason, the parent, or a
    /// bare [`CancellationToken::cancel`] on [`Self::token`]); then nothing changes.
    pub fn cancel(&self, reason: impl Into<Arc<str>>) -> bool {
        if self.token.is_cancelled() {
            return false;
        }
        if self.node.reason.set(reason.into()).is_err() {
            return false;
        }
        self.token.cancel();
        true
    }

    /// The plain token, for every API that takes a [`CancellationToken`] (lane `submit`,
    /// `submit_wait`, task code). Cancelling it directly leaves the reason `None`.
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }

    /// A read-only handle to hand to the code that must only observe the cancellation.
    pub fn view(&self) -> CancelView {
        CancelView {
            token: self.token.clone(),
            node: self.node.clone(),
        }
    }

    /// See [`CancelView::reason`].
    pub fn reason(&self) -> Option<Arc<str>> {
        self.view().reason()
    }
}

/// The observing side: the token plus the reason.
#[derive(Clone)]
pub struct CancelView {
    token: CancellationToken,
    node: Arc<Node>,
}

/// A view of a plain token: it reports cancellation and never a reason.
impl From<CancellationToken> for CancelView {
    fn from(token: CancellationToken) -> Self {
        Self {
            token,
            node: Arc::new(Node {
                reason: OnceLock::new(),
                parent: None,
            }),
        }
    }
}

impl CancelView {
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Resolves once cancelled; [`Self::reason`] is then readable.
    pub async fn cancelled(&self) {
        self.token.cancelled().await;
    }

    /// The reason, or `None` while not cancelled and after a cancellation that carried none.
    pub fn reason(&self) -> Option<Arc<str>> {
        if !self.token.is_cancelled() {
            return None;
        }
        self.node.reason()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_before_cancellation_is_none() {
        let source = CancelSource::new();
        assert_eq!(source.reason(), None);
        assert_eq!(source.view().reason(), None);
        assert!(!source.token().is_cancelled());
    }

    #[test]
    fn the_first_reason_wins() {
        let source = CancelSource::new();
        let view = source.view();
        assert!(source.cancel("Run now was stopped"));
        assert!(!source.cancel("webhook dispatch timed out"));
        assert!(view.is_cancelled());
        assert_eq!(view.reason().as_deref(), Some("Run now was stopped"));
    }

    #[test]
    fn a_child_inherits_the_parents_reason_and_can_cancel_alone() {
        let parent = CancelSource::new();
        let child = parent.child();
        let sibling = parent.child();

        assert!(sibling.cancel("sibling only"));
        assert!(!parent.token().is_cancelled());
        assert_eq!(child.reason(), None);

        assert!(parent.cancel("shutdown"));
        assert!(child.token().is_cancelled());
        assert_eq!(child.reason().as_deref(), Some("shutdown"));
        assert_eq!(sibling.reason().as_deref(), Some("sibling only"));
        assert!(!child.cancel("too late"));
    }

    #[test]
    fn a_bare_token_cancel_has_no_reason() {
        let source = CancelSource::new();
        source.token().cancel();
        assert!(source.view().is_cancelled());
        assert_eq!(source.reason(), None);
        assert!(!source.cancel("late"));
    }
}
