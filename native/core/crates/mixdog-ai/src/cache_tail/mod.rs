//! The owner side of the transcript-cache admission seam (`mixdog_core_api::domain::cache_tail`): one live book per open
//! session of a session store ([`Books`], held by that store's session owner), loaded once from the session's persisted
//! snapshot, judged at each attempt's admission with the current clock, and fed only by evidence the adapter's manifest
//! and the response's counters prove.

pub mod book;
pub mod evidence;
pub mod manifest;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use mixdog_core_api::domain::cache_tail::{Admission, Claim, ColdRequest, Counters, Permit, Resolution, TailGate, TailGateHandle, Unreduced, Verdict};
use serde_json::Value;
use tokio::sync::Notify;

use self::book::Book;

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type Setting = Arc<dyn Fn() -> bool + Send + Sync>;

/// Owns a write's admission across awaits, including the wait for the response head.
pub(crate) struct AdmittedWrite(Option<(TailGateHandle, Permit)>);

impl AdmittedWrite {
    pub(crate) fn new(gate: TailGateHandle, permit: Permit) -> Self {
        Self(Some((gate, permit)))
    }

    pub(crate) fn settle(mut self, counters: Option<Counters>) {
        if let Some((gate, permit)) = self.0.take() {
            gate.0.settle(&permit, counters);
        }
    }
}

impl Drop for AdmittedWrite {
    fn drop(&mut self) {
        if let Some((gate, permit)) = self.0.take() {
            gate.0.settle(&permit, None);
        }
    }
}

/// What one turn's attempts are judged with, as that turn assembled them. They belong to the gate handed to that turn, not
/// to the book: another open of the same session judges with its own.
pub struct GateSettings {
    /// Read at each admission and settlement.
    pub clock: Clock,
    /// The user's auto-clear setting, read at each admission.
    pub auto_clear: Setting,
    /// A key of the session's compaction sizing policy: a cold disposition decided under another one does not hold.
    pub sizing: u64,
    /// The session has nothing sent before (a new session's first prompt), for a book the header does not hold.
    pub fresh: bool,
    /// When the session last sent, as its header records it (`lastProviderSendAt`): what a book the header does not
    /// hold, or one that holds no send time, knows of the tail's age.
    pub last_send_at: Option<i64>,
}

/// A session's live book and the waiters of its rewrite in flight.
struct Held {
    book: Mutex<Book>,
    decided: Notify,
    /// The session left memory ([`Books::release`]): a gate still held judges nothing on this book (its attempts are
    /// stale and rebuilt on the book the header holds) and its rewrite waiters are woken.
    retired: AtomicBool,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The gate of one turn's attempts on its session's book.
pub struct SessionGate {
    held: Arc<Held>,
    clock: Clock,
    auto_clear: Setting,
    sizing: u64,
}

impl SessionGate {
    /// The verdict at this instant, on the session's book.
    pub fn judge(&self, admission: Admission<'_>) -> Verdict {
        if self.held.retired.load(Ordering::SeqCst) {
            return Verdict::Refuse(mixdog_core_api::domain::cache_tail::TailRefusal::Stale);
        }
        let (now, auto_clear) = ((self.clock)(), (self.auto_clear)());
        lock(&self.held.book).admit(admission, now, auto_clear, self.sizing)
    }
}

impl TailGate for SessionGate {
    fn admit<'a>(&'a self, admission: Admission<'a>) -> Pin<Box<dyn Future<Output = Verdict> + Send + 'a>> {
        let verdict = self.judge(admission);
        Box::pin(std::future::ready(verdict))
    }

    fn settle(&self, permit: &Permit, counters: Option<Counters>) {
        let now = (self.clock)();
        lock(&self.held.book).settle(permit, counters, now);
    }

    fn claim(&self, request: ColdRequest) -> Claim {
        lock(&self.held.book).claim(request.ticket)
    }

    fn resolve(&self, ticket: u64, resolution: Resolution) -> Option<Unreduced> {
        let leave = lock(&self.held.book).resolve(ticket, resolution);
        self.held.decided.notify_waiters();
        leave
    }

    fn rebuilt(&self) -> u64 {
        let generation = {
            let mut book = lock(&self.held.book);
            book.rebuilt();
            book.generation()
        };
        self.held.decided.notify_waiters();
        generation
    }

    fn snapshot(&self) -> Option<Value> {
        lock(&self.held.book).take_snapshot()
    }

    fn generation(&self) -> u64 {
        lock(&self.held.book).generation()
    }

    fn wait_for(&self, ticket: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let held = self.held.clone();
        Box::pin(async move {
            loop {
                let decided = held.decided.notified();
                tokio::pin!(decided);
                decided.as_mut().enable();
                if lock(&held.book).pending_ticket() != Some(ticket) {
                    return;
                }
                decided.await;
            }
        })
    }
}

/// Where the book of a session that is not loaded is kept when a use of it outside the session (a warm) taught it something:
/// the session's header is written only by its loaded owner, so this is what its next load reads beside the header.
pub trait KeptBooks: Send + Sync {
    fn kept(&self, session_id: &str) -> Option<Value>;
    fn keep(&self, session_id: &str, book: Value);
    fn drop_kept(&self, session_id: &str);
}

/// The live books of one session store's open sessions, held by that store's session owner: a session id names a book of
/// this store only, so another store (another data directory) has books of its own, whatever its ids.
#[derive(Default)]
pub struct Books {
    held: Mutex<HashMap<String, Arc<Held>>>,
    kept: Option<Arc<dyn KeptBooks>>,
}

/// The book's history position: a rewrite moves the generation, a send the last send time.
fn position(book: &Value) -> (u64, i64) {
    (book.get("generation").and_then(Value::as_u64).unwrap_or(0), book.get("lastSendAt").and_then(Value::as_i64).unwrap_or(0))
}

impl Books {
    /// Books whose sessions' books, when a use outside a loaded session taught them something, are kept in `kept`.
    pub fn kept_in(kept: Arc<dyn KeptBooks>) -> Self {
        Self { held: Mutex::default(), kept: Some(kept) }
    }

    fn held(&self, session_id: &str) -> Option<Arc<Held>> {
        lock(&self.held).get(session_id).cloned()
    }

    /// The book to open for `session_id`, none being open: the kept one while the header holds no later history (no send or
    /// rewrite the session's own owner committed since it was kept), else `persisted`. A kept book is unsaved: the session's
    /// owner commits it to the header.
    fn opened(&self, session_id: &str, persisted: Option<&Value>, now: i64, last_send: Option<i64>) -> Option<Book> {
        let kept = self.kept.as_ref()?.kept(session_id)?;
        if persisted.is_some_and(|header| position(header) > position(&kept)) {
            return None;
        }
        let mut book = Book::from_json(&kept, now, last_send);
        book.mark_unsaved();
        Some(book)
    }

    /// The gate of one turn of `session_id`, judging with that turn's `settings`. `persisted` is the session header's
    /// `cacheTailBook`, read only when no book of the session is open yet (with none, `settings.fresh` says whether the
    /// session is new); a later open of the session is the same book, and its settings stay its own.
    pub fn gate(&self, session_id: &str, persisted: Option<&Value>, settings: GateSettings) -> TailGateHandle {
        let GateSettings { clock, auto_clear, sizing, fresh, last_send_at } = settings;
        let held = lock(&self.held)
            .entry(session_id.to_owned())
            .or_insert_with(|| {
                let now = clock();
                let book = self
                    .opened(session_id, persisted, now, last_send_at)
                    .unwrap_or_else(|| persisted.map_or_else(|| Book::unrecorded(fresh, last_send_at), |value| Book::from_json(value, now, last_send_at)));
                Arc::new(Held { book: Mutex::new(book), decided: Notify::new(), retired: AtomicBool::new(false) })
            })
            .clone();
        TailGateHandle(Arc::new(SessionGate { held, clock, auto_clear, sizing }))
    }

    /// A compaction outside any run (a manual one) replaced the session's transcript: the session's book, open here or else
    /// as `persisted` (the header's `cacheTailBook`) read at `now`, records the rewrite. Returns the book to persist with
    /// the compacted transcript.
    pub fn rebuilt(&self, session_id: &str, persisted: Option<&Value>, now: i64) -> Value {
        match self.held(session_id) {
            Some(held) => {
                let json = {
                    let mut book = lock(&held.book);
                    book.rebuilt();
                    book.to_json()
                };
                held.decided.notify_waiters();
                json
            }
            None => {
                let mut book = self
                    .opened(session_id, persisted, now, None)
                    .unwrap_or_else(|| persisted.map_or_else(|| Book::unrecorded(false, None), |value| Book::from_json(value, now, None)));
                book.rebuilt();
                book.to_json()
            }
        }
    }

    /// The generation of `session_id`'s history: the open book's, else the one its next open reads (kept, or `persisted`,
    /// the header's `cacheTailBook`). Read with the transcript it describes, as one value of its load: a request built from
    /// that transcript carries it, and a rewrite committed since refuses the request as stale instead of letting it be
    /// stamped as current.
    pub fn generation(&self, session_id: &str, persisted: Option<&Value>) -> u64 {
        match self.held(session_id) {
            Some(held) => lock(&held.book).generation(),
            None => self
                .opened(session_id, persisted, 0, None)
                .map_or_else(|| persisted.map_or(0, |value| Book::from_json(value, 0, None).generation()), |book| book.generation()),
        }
    }

    /// What `session_id`'s open book learned since it was last persisted, as the header's `cacheTailBook`: the session's
    /// owner commits it before it lets the session leave memory ([`Self::release`]). `None`: nothing new, or no open book.
    pub fn unsaved(&self, session_id: &str) -> Option<Value> {
        lock(&self.held(session_id)?.book).take_snapshot()
    }

    /// `session_id` left memory (unloaded, closed or deleted): its book is no longer open and is loaded again from the
    /// header, which its owner committed it to, on its next use; a kept one is no longer needed. A rewrite in flight or
    /// offered is released, not orphaned: its waiters wake and admit again, on the reloaded book.
    pub fn release(&self, session_id: &str) {
        if let Some(kept) = &self.kept {
            kept.drop_kept(session_id);
        }
        self.retire(session_id);
    }

    /// The book a use outside the session opened for a session that is not loaded (a warm's rebuild) leaves memory: what it
    /// learned since it was opened is kept ([`KeptBooks`]), where the session's next open reads it.
    pub fn keep_unloaded(&self, session_id: &str) {
        let Some(snapshot) = self.retire(session_id) else { return };
        if let Some(kept) = &self.kept {
            kept.keep(session_id, snapshot);
        }
    }

    /// Closes the open book of `session_id`; what it learned since its last snapshot.
    fn retire(&self, session_id: &str) -> Option<Value> {
        let held = lock(&self.held).remove(session_id)?;
        held.retired.store(true, Ordering::SeqCst);
        let snapshot = {
            let mut book = lock(&held.book);
            book.retire();
            book.take_snapshot()
        };
        held.decided.notify_waiters();
        snapshot
    }

    /// Whether a book of `session_id` is open.
    pub fn loaded(&self, session_id: &str) -> bool {
        lock(&self.held).contains_key(session_id)
    }

    /// The open book of `session_id` as it would be persisted, for a test to read.
    #[cfg(any(test, feature = "test-support"))]
    pub fn book_json(&self, session_id: &str) -> Option<Value> {
        self.held(session_id).map(|held| lock(&held.book).to_json())
    }
}

#[cfg(test)]
mod book_tests;
