//! Owner: s4-engine-lane
//! What the core knows of the claimed host's pages: the ledgers fed by the host's ordered notifications ([`Ingest`]), the pages
//! whose notifications skipped, and the claim they were learned under. A command's result carries the page's facts at their
//! `seq`; the engine reads the ledgers only once the mirror has caught up to it ([`Mirror::caught_up`]), so a reply never says
//! less than the page already did when the host answered.
//!
//! The claim is the host's claim on the `desktopHost` role: when it ends ([`Mirror::host_gone`]) every page it held is gone, and
//! what was learned under it must not reach the next claimant's pages (the latest claimant wins, and a command that began under
//! the earlier one fails instead of mixing the two).

use std::collections::HashSet;
use std::future::poll_fn;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::task::Poll;
use std::task::Waker;

use mixdog_app_protocol::v2::browser_engine::HostBrowserEventsParams;
use mixdog_app_protocol::v2::browser_engine::PageFacts;
use mixdog_rt::CancelSource;
use mixdog_rt::CancellationToken;

use crate::ledger::ingest::Ingest;
use crate::ledger::ingest::PageLedgers;

/// Where a page's cursor stands against a result's `seq`, as [`Mirror::caught_up`] reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caught {
    /// The notifications reached the result's `seq`.
    Up,
    /// A notification of the page skipped: the cursor will not move until the page is synced.
    Gapped,
    /// The mirror has never heard of the page: the result's facts are its first word.
    Unseen,
}

struct State {
    ingest: Ingest,
    gapped: HashSet<String>,
    wakers: Vec<Waker>,
    claim: CancelSource,
}

/// The ledgers of the claimed host's pages, shared by the sink that feeds them and the lane that waits on them.
pub struct Mirror {
    state: Mutex<State>,
}

impl Default for Mirror {
    fn default() -> Self {
        Self::new()
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn wake(wakers: Vec<Waker>) {
    for waker in wakers {
        waker.wake();
    }
}

impl Mirror {
    pub fn new() -> Self {
        Self { state: Mutex::new(State { ingest: Ingest::new(), gapped: HashSet::new(), wakers: Vec::new(), claim: CancelSource::new() }) }
    }

    /// Fires when the claim this call was made under ends. A command takes it before it sends and fails if it fired by the time
    /// the answer comes.
    pub fn claim(&self) -> CancellationToken {
        lock(&self.state).claim.token().clone()
    }

    /// One `host/browser/events` batch. A gap marks the page, and the lane syncs it before it trusts a result's `seq`.
    pub fn events(&self, params: HostBrowserEventsParams) {
        let page_id = params.page_id.clone();
        let mut state = lock(&self.state);
        if state.ingest.apply_events(params).is_err() {
            state.gapped.insert(page_id);
        }
        let wakers = std::mem::take(&mut state.wakers);
        drop(state);
        wake(wakers);
    }

    /// One `host/browser/page/facts` notification.
    pub fn facts(&self, facts: &PageFacts) {
        let mut state = lock(&self.state);
        if state.ingest.apply_facts(facts).is_err() {
            state.gapped.insert(facts.page_id.clone());
        }
        let wakers = std::mem::take(&mut state.wakers);
        drop(state);
        wake(wakers);
    }

    /// The page's facts from an answer (`page/sync`, or the first result that names the page): the cursor moves to their `seq`
    /// and a gap is closed. `false` when `claim` ended meanwhile: nothing a dead claim learned is kept.
    pub fn resync(&self, claim: &CancellationToken, facts: &PageFacts) -> bool {
        let mut state = lock(&self.state);
        if claim.is_cancelled() {
            return false;
        }
        state.ingest.resync(facts);
        state.gapped.remove(&facts.page_id);
        let wakers = std::mem::take(&mut state.wakers);
        drop(state);
        wake(wakers);
        true
    }

    /// The page is closed: its ledgers go with it.
    pub fn forget(&self, page_id: &str) {
        let mut state = lock(&self.state);
        state.ingest.forget(page_id);
        state.gapped.remove(page_id);
    }

    /// The host's claim ended: every page it held is gone, commands under the claim are told so, and the next call is made under a
    /// new claim.
    pub fn host_gone(&self) {
        let mut state = lock(&self.state);
        state.claim.cancel("hostGone");
        state.claim = CancelSource::new();
        state.ingest.clear();
        state.gapped.clear();
        let wakers = std::mem::take(&mut state.wakers);
        drop(state);
        wake(wakers);
    }

    /// The `seq` of the last notification applied for the page.
    pub fn cursor(&self, page_id: &str) -> Option<u64> {
        lock(&self.state).ingest.cursor(page_id)
    }

    /// Reads or edits one page's ledgers (the console and network logs, the failure list); `None` when the page is not known.
    pub fn with_ledgers<R>(&self, page_id: &str, read: impl FnOnce(&mut PageLedgers) -> R) -> Option<R> {
        lock(&self.state).ingest.ledgers_mut(page_id).map(read)
    }

    /// Ends when the page's cursor has reached `seq`, the page's notifications skipped, or the page is unknown. It never ends on
    /// its own otherwise: the caller bounds it.
    pub async fn caught_up(&self, page_id: &str, seq: u64) -> Caught {
        poll_fn(|cx| {
            let mut state = lock(&self.state);
            if state.gapped.contains(page_id) {
                return Poll::Ready(Caught::Gapped);
            }
            match state.ingest.cursor(page_id) {
                None => Poll::Ready(Caught::Unseen),
                Some(cursor) if cursor >= seq => Poll::Ready(Caught::Up),
                Some(_) => {
                    if !state.wakers.iter().any(|waker| waker.will_wake(cx.waker())) {
                        state.wakers.push(cx.waker().clone());
                    }
                    Poll::Pending
                }
            }
        })
        .await
    }
}
