//! The engine-side types the ports share: what an approval asks and is answered, a takeover guard, and file facts.
//! The wire types of the host lane themselves are `mixdog_app_protocol::v2::browser_engine`.

use std::path::PathBuf;
use std::time::SystemTime;

use mixdog_app_protocol::v2::browser_engine::BrowserApprovalFile;
use mixdog_app_protocol::v2::browser_engine::BrowserApprovalRememberKind;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;

/// Why a step asks (the classes of `action-approval.ts`; no class is added).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BrowserApprovalKind {
    #[default]
    Submit,
    Post,
    Upload,
    /// Always asks: nothing standing covers it.
    Confirm,
    /// The page holds payment evidence: the step asks once, every time.
    Payment,
}

/// What the person (or the core gate's standing rules) is shown: one Browser Use step awaiting an answer
/// (`BrowserApprovalRequest` of `action-approval.ts`, plus the thread it runs in).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BrowserApprovalPrompt {
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

/// One file of an upload as it was when the person was asked.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BoundFile {
    pub path: String,
    pub size: u64,
    /// The last modification time; `None` when the platform does not report one.
    pub mtime: Option<SystemTime>,
    /// The canonical path: the approved file is this one.
    pub realpath: PathBuf,
}

/// What an approval was given for: a precondition of every dispatch of the approved step (the TOCTOU rebind). The
/// document is the one the person was asked about, the command is the one shown, and an upload's files still have the
/// canonical path, size and modification time they had.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Binding {
    pub url: String,
    pub document_id: String,
    pub command_hash: String,
    pub files: Vec<BoundFile>,
    /// The receiving frame document's key; empty when it could not be confirmed.
    pub receiver_key: String,
}

/// A classified step: its class, what the person is shown, and what an approval of it binds (what
/// `s4-engine-approval`'s `classify` returns; `None` there when the step needs no approval).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BrowserApprovalAsk {
    pub kind: BrowserApprovalKind,
    pub prompt: BrowserApprovalPrompt,
    pub binding: Binding,
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

/// The person's (or a standing rule's) answer to a [`BrowserApprovalPrompt`].
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

    /// What the stopped command fails with once [`Self::cancelled`] fired (`drainOperations` aborts with this text).
    pub const STOPPED: &'static str = "Browser Use stopped: the user took over this session";
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

/// What a path is, as the file port reads it (`realpath` then `stat`, as `action-approval.ts` binds an upload's files: the
/// approved file is the canonical one, and it must still have the size and modification time it had when the person was asked).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileFacts {
    pub exists: bool,
    pub is_file: bool,
    pub size: u64,
    /// The path with every link resolved; `None` when it could not be resolved.
    pub canonical: Option<PathBuf>,
    /// The last modification time; `None` when the platform does not report one.
    pub modified: Option<SystemTime>,
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
        assert_eq!(TakeoverGuard::STOPPED, "Browser Use stopped: the user took over this session");
        token.cancel();
        assert!(guard.cancelled().is_cancelled());
        assert!(!released.load(Ordering::SeqCst));
        drop(guard);
        assert!(released.load(Ordering::SeqCst));
    }
}
