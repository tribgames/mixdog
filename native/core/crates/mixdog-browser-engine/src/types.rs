//! The engine-side types the ports share: what an approval asks and is answered, a takeover guard, and file facts.
//! The wire types of the host lane themselves are `mixdog_app_protocol::v2::browser_engine`.

use mixdog_app_protocol::v2::browser_engine::BrowserApprovalFile;
use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;

/// One Browser Use step awaiting the person (`BrowserApprovalRequest` of `action-approval.ts`, plus the thread it runs in).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BrowserApprovalAsk {
    pub thread_id: Option<ThreadId>,
    pub action: String,
    pub url: String,
    pub session_id: String,
    pub target: String,
    pub paths: Vec<String>,
    /// Why it asks: which standing allows could cover it (`confirm` always asks).
    pub kinds: Vec<BrowserApprovalRememberKind>,
    /// An upload's real files (name and size read from the path).
    pub files: Vec<BrowserApprovalFile>,
    /// The origin of the frame document that receives an upload's files; empty when it could not be confirmed.
    pub receiver_origin: String,
    /// The command belongs to a schedule or webhook run: its saved routine granted submits, posts and uploads.
    pub unattended: bool,
    /// The bot that owns that run; empty when it could not be established.
    pub unattended_agent: String,
    /// Life mark of the asking session; a session allowance is made and honoured only under one.
    pub session_life: String,
    /// The page holds payment evidence: the step asks once, every time.
    pub payment: bool,
}

/// How far an allowing answer reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Remember {
    /// This step only.
    #[default]
    Once,
    /// The asking session's later steps of the same kind.
    Session,
    /// A standing allow, saved.
    Always,
}

/// The person's (or a standing rule's) answer to a [`BrowserApprovalAsk`].
#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalAnswer {
    Allow { remember: Remember },
    /// `reason` is the person's note, empty when none.
    Deny { reason: String },
}

/// The person has taken the page over (a phone's or the desktop's takeover): held until dropped. The engine's work for that
/// session ends through [`TakeoverGuard::cancelled`].
pub struct TakeoverGuard {
    cancelled: CancellationToken,
    on_drop: Option<Box<dyn FnOnce() + Send>>,
}

impl TakeoverGuard {
    pub fn new(cancelled: CancellationToken, on_drop: Option<Box<dyn FnOnce() + Send>>) -> Self {
        Self { cancelled, on_drop }
    }

    /// Fires when the takeover ends the running command.
    pub fn cancelled(&self) -> CancellationToken {
        self.cancelled.clone()
    }
}

impl Drop for TakeoverGuard {
    fn drop(&mut self) {
        if let Some(release) = self.on_drop.take() {
            release();
        }
    }
}

impl std::fmt::Debug for TakeoverGuard {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("TakeoverGuard").field("cancelled", &self.cancelled.is_cancelled()).finish()
    }
}

/// What a path is, as the file port reads it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileFacts {
    pub exists: bool,
    pub is_file: bool,
    pub size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::Ordering;

    #[test]
    fn a_takeover_guard_releases_once_when_dropped() {
        let released = Arc::new(AtomicBool::new(false));
        let flag = released.clone();
        let token = CancellationToken::new();
        let guard = TakeoverGuard::new(token.clone(), Some(Box::new(move || flag.store(true, Ordering::SeqCst))));
        assert!(!guard.cancelled().is_cancelled());
        token.cancel();
        assert!(guard.cancelled().is_cancelled());
        assert!(!released.load(Ordering::SeqCst));
        drop(guard);
        assert!(released.load(Ordering::SeqCst));
    }
}
