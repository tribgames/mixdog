//! What a handler is given for one call, and the call's side of the credit window and the browser request.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use serde_json::Value;
use tokio::sync::Notify;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::error::CodedError;
use crate::pathguard;
use crate::wire;
use crate::wire::MAX_CHUNK_BYTES;

/// What the writer task takes: frames in order, then the end.
pub(crate) enum Message {
    Frame(Bytes),
    Close,
}

/// The one place frames leave the worker from, so they never interleave.
#[derive(Clone)]
pub(crate) struct Output(pub(crate) UnboundedSender<Message>);

impl Output {
    pub(crate) fn frame(&self, frame: Bytes) {
        // The writer is gone only when the process is leaving.
        let _ = self.0.send(Message::Frame(frame));
    }
}

/// The answer to NEED_BROWSER: the DevTools endpoint, or why there is none.
type BrowserAnswer = Result<String, String>;

/// The state of the running call that the frame loop and the handler share.
pub(crate) struct CallLink {
    id: u32,
    out: Output,
    cancel: CancellationToken,
    /// Chunk bytes the pool has granted and the handler has not yet sent.
    credit: Mutex<u64>,
    credit_wake: Notify,
    browser_requested: AtomicBool,
    browser_answer: watch::Sender<Option<BrowserAnswer>>,
}

impl CallLink {
    pub(crate) fn new(id: u32, out: Output, cancel: CancellationToken, window: u64) -> Arc<Self> {
        Arc::new(Self {
            id,
            out,
            cancel,
            credit: Mutex::new(window),
            credit_wake: Notify::new(),
            browser_requested: AtomicBool::new(false),
            browser_answer: watch::channel(None).0,
        })
    }

    pub(crate) fn id(&self) -> u32 {
        self.id
    }

    pub(crate) fn cancel(&self) {
        self.cancel.cancel();
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// The pool took chunk bytes: the emitters may send that many more.
    pub(crate) fn add_credit(&self, bytes: u32) {
        {
            let mut credit = self.credit.lock().unwrap_or_else(|e| e.into_inner());
            *credit = credit.saturating_add(u64::from(bytes));
        }
        self.credit_wake.notify_waiters();
    }

    /// Whether a NEED_BROWSER went out and has no answer yet.
    pub(crate) fn browser_pending(&self) -> bool {
        self.browser_requested.load(Ordering::Acquire) && self.browser_answer.borrow().is_none()
    }

    pub(crate) fn answer_browser(&self, answer: BrowserAnswer) {
        self.browser_answer.send_if_modified(|slot| {
            let open = slot.is_none();
            if open {
                *slot = Some(answer);
            }
            open
        });
    }

    /// Up to `want` bytes of credit, waiting while there is none.
    async fn take_credit(&self, want: usize) -> Result<usize, CodedError> {
        loop {
            let woken = self.credit_wake.notified();
            tokio::pin!(woken);
            woken.as_mut().enable();
            if self.cancel.is_cancelled() {
                return Err(CodedError::cancelled());
            }
            {
                let mut credit = self.credit.lock().unwrap_or_else(|e| e.into_inner());
                if *credit > 0 {
                    let size = want
                        .min(MAX_CHUNK_BYTES)
                        .min(usize::try_from(*credit).unwrap_or(usize::MAX));
                    *credit -= size as u64;
                    return Ok(size);
                }
            }
            tokio::select! {
                () = &mut woken => {}
                () = self.cancel.cancelled() => return Err(CodedError::cancelled()),
            }
        }
    }
}

/// One call, as its handler sees it.
///
/// Everything a handler prints must stay off the frame stream: the worker points its standard output at standard error, and a
/// child a handler starts gets its standard output piped or null, never inherited.
pub struct CallCtx {
    pub id: u32,
    pub method: String,
    pub params: Value,
    /// The absolute paths the call is approved to touch.
    pub paths: Vec<String>,
    pub thread: String,
    pub cwd: String,
    /// Cancelled when the pool cancels the call or the worker leaves. A CPU-bound handler polls it.
    pub cancel: CancellationToken,
    link: Arc<CallLink>,
}

impl CallCtx {
    pub(crate) fn new(
        link: Arc<CallLink>,
        method: String,
        params: Value,
        paths: Vec<String>,
        thread: String,
        cwd: String,
    ) -> Self {
        Self {
            id: link.id,
            method,
            params,
            paths,
            thread,
            cwd,
            cancel: link.cancel.clone(),
            link,
        }
    }

    /// Sends result bytes as chunks of at most 64 KiB, each within the credit the pool has granted; waits while the credit is
    /// spent, and fails with code `cancelled` once the call is cancelled.
    pub async fn emit(&self, bytes: &[u8]) -> Result<(), CodedError> {
        let mut offset = 0;
        while offset < bytes.len() {
            let size = self.link.take_credit(bytes.len() - offset).await?;
            self.link
                .out
                .frame(wire::chunk(self.id, &bytes[offset..offset + size]));
            offset += size;
        }
        Ok(())
    }

    /// The DevTools endpoint of the shared render browser, which the pool owns. Asked of the pool once per call; a refusal is
    /// code `browser_unavailable` with the pool's reason, and a cancel while waiting is code `cancelled`.
    pub async fn request_browser(&self) -> Result<String, CodedError> {
        if self.cancel.is_cancelled() {
            return Err(CodedError::cancelled());
        }
        if !self.link.browser_requested.swap(true, Ordering::AcqRel) {
            self.link.out.frame(wire::need_browser(self.id));
        }
        let mut answers = self.link.browser_answer.subscribe();
        let answer = tokio::select! {
            () = self.cancel.cancelled() => return Err(CodedError::cancelled()),
            answer = answers.wait_for(Option::is_some) => answer.map(|a| (*a).clone()),
        };
        match answer {
            Ok(Some(Ok(ws))) => Ok(ws),
            Ok(Some(Err(reason))) => Err(CodedError::new("browser_unavailable", reason)),
            Ok(None) | Err(_) => Err(CodedError::failed("the browser answer was lost")),
        }
    }

    /// [`pathguard::approved_path`] over this call's approved paths.
    pub fn approved_path(&self, path: &str, base: &str) -> Result<PathBuf, CodedError> {
        pathguard::approved_path(&self.paths, path, base)
    }
}
