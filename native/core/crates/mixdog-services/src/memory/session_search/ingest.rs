//! Keeps the session-search copy in step with the session store: per-turn
//! ingest, a once-per-run backfill of stored sessions, and deletion.
//! Everything is best-effort.
//!
//! A session's writes run one at a time, in the order they were issued. That
//! order keeps a value marked sensitive out of the index: the replacement that
//! redacts stored rows locks only rows that already exist, so an earlier
//! plaintext append still in flight would otherwise land after it and bring
//! the value back. A write also redacts with the values known when it runs,
//! not when it was issued. Sessions never wait on each other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::memory::error::{MemoryError, Result};
use crate::memory::session_search::db::{SessionSearchDb, search_row};

const LAST_INGESTED_LIMIT: usize = 500;

/// Values a user marked sensitive in a session, which must never reach the index.
pub trait SensitiveValues: Send + Sync {
    /// Identity of the session's current set of marked values; None when it has none.
    fn version(&self, session_id: &str) -> Option<String>;
    /// Redact one message without changing its position in the transcript.
    fn redact_message(&self, session_id: &str, message: &Value) -> Value;
    fn redact_messages(&self, session_id: &str, messages: &[Value]) -> Vec<Value> {
        messages.iter().map(|message| self.redact_message(session_id, message)).collect()
    }
    fn redact_text(&self, session_id: &str, text: &str) -> String;
}

/// A session's transcript length, sensitive-values version and transcript digest at its last stored ingest.
type LastIngest = (usize, Option<String>, TranscriptDigest);

/// A session as the search copy sees it.
#[derive(Debug, Clone)]
pub struct IngestSession {
    pub id: String,
    pub messages: Vec<Value>,
    /// A session of agent-to-agent traffic only: never indexed.
    pub agent_only: bool,
}

/// A session record's stamp as [`StoredSessions::stamp`] observes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStamp {
    At(String),
    /// Being written now: no stamp can be paired with a read.
    Busy,
    /// No record.
    Gone,
}

/// The session store, for backfill.
#[async_trait]
pub trait StoredSessions: Send + Sync {
    /// Every stored session, in listing order. A failed listing fails the backfill before it
    /// drops anything (Node's `readdirSync` throws out of `backfillSessionSearch`).
    async fn session_ids(&self) -> Result<Vec<String>>;
    /// Observe this session's full source identity, including rewrites that do
    /// not move its append cursor. Persist and compare it as an opaque value.
    /// Only the listing authorizes cleanup, not a missing stamp.
    async fn record_stamp(&self, session_id: &str) -> Result<Option<String>>;
    /// [`Self::record_stamp`], telling a record that cannot be stamped now (its log being written or rewritten) from one
    /// that is gone: a busy one is tried again, never taken as gone.
    async fn stamp(&self, session_id: &str) -> Result<SessionStamp> {
        Ok(self.record_stamp(session_id).await?.map_or(SessionStamp::Gone, SessionStamp::At))
    }
    /// One coherent transcript and header, or `None` when a read cannot establish them.
    async fn read(&self, session_id: &str) -> Option<IngestSession>;
}

/// A session's write queue, present only while a write of it is queued or running.
struct Queue {
    /// The lifetime the queued writes run under; `close` cancels it.
    token: CancellationToken,
    /// Closes (its sender is dropped) when the last write queued has settled.
    tail: Option<watch::Receiver<()>>,
    waiting: usize,
}

type Queues = Arc<Mutex<HashMap<String, Queue>>>;

/// A place in a session's write queue, taken when the write is issued, so
/// writes run in the order they were issued however the runtime schedules them.
struct Slot {
    queues: Queues,
    session_id: String,
    token: CancellationToken,
    /// The write queued before this one.
    after: Option<watch::Receiver<()>>,
    /// Dropped when this write has settled: the next one starts.
    _done: watch::Sender<()>,
}

impl Slot {
    /// Runs `task` once every earlier write of the session has settled; a
    /// write cancelled before it starts never does. A failed task does not stop
    /// the queue: that failure is the caller's.
    async fn run<T, F, Fut>(mut self, task: F) -> Result<T>
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        if let Some(after) = self.after.as_mut() {
            // Closes when the earlier write settles; a cancelled one settles at once.
            let _ = after.changed().await;
        }
        if self.token.is_cancelled() {
            return Err(MemoryError::Cancelled);
        }
        tokio::select! {
            result = task(self.token.clone()) => result,
            () = self.token.cancelled() => Err(MemoryError::Cancelled),
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut queues = self.queues.lock().expect("queue map");
        if let Some(queue) = queues.get_mut(&self.session_id) {
            queue.waiting -= 1;
            if queue.waiting == 0 {
                queues.remove(&self.session_id);
            }
        }
    }
}

pub struct SessionSearchIngest {
    db: SessionSearchDb,
    sensitive: Arc<dyn SensitiveValues>,
    /// session → (transcript length, sensitive-values version, transcript digest) of the last stored ingest.
    last_ingested: Mutex<HashMap<String, LastIngest>>,
    queues: Queues,
}

fn log_failure(what: &str, error: &MemoryError) {
    if !matches!(error, MemoryError::Cancelled) {
        mixdog_rt::node_stderr!("[session-search] {what} failed: {}", error.message());
    }
}

impl SessionSearchIngest {
    pub fn new(db: SessionSearchDb, sensitive: Arc<dyn SensitiveValues>) -> Arc<Self> {
        Arc::new(Self { db, sensitive, last_ingested: Mutex::default(), queues: Queues::default() })
    }

    pub fn db(&self) -> &SessionSearchDb {
        &self.db
    }

    /// Takes the next place in the session's write queue, now: the caller's
    /// order is the write order.
    fn enqueue(&self, session_id: &str) -> Slot {
        let mut queues = self.queues.lock().expect("queue map");
        let queue = queues.entry(session_id.to_owned()).or_insert_with(|| Queue {
            token: CancellationToken::new(),
            tail: None,
            waiting: 0,
        });
        // A closed session's queue starts a new lifetime for the writes after the close.
        if queue.token.is_cancelled() {
            queue.token = CancellationToken::new();
        }
        queue.waiting += 1;
        let (done, tail) = watch::channel(());
        Slot {
            queues: self.queues.clone(),
            session_id: session_id.to_owned(),
            token: queue.token.clone(),
            after: queue.tail.replace(tail),
            _done: done,
        }
    }

    /// Resolves once every write the session has queued so far has settled.
    pub async fn settle(&self, session_id: &str) {
        let tail = self.queues.lock().expect("queue map").get(session_id).and_then(|q| q.tail.clone());
        if let Some(mut tail) = tail {
            let _ = tail.changed().await;
        }
    }

    /// Stops the session's search writes for a runtime close: queued ones never
    /// start and the running one is cancelled. Resolves when the queue has
    /// settled, so nothing this session issued writes afterwards. The rows are
    /// derived: the stored-session backfill restores what a cancelled write
    /// left out.
    pub async fn close_session(&self, session_id: &str) {
        if let Some(queue) = self.queues.lock().expect("queue map").get(session_id) {
            queue.token.cancel();
        }
        self.settle(session_id).await;
    }

    async fn store_transcript(&self, session_id: &str, messages: &[Value]) -> Result<()> {
        let length = messages.len();
        let version = self.sensitive.version(session_id);
        let prior = self.last_ingested.lock().expect("last ingested").get(session_id).cloned();
        let check = prior.as_ref().filter(|(len, ver, _)| *len <= length && *ver == version);
        let prefix = check.map_or(0, |(len, _, _)| *len);
        let mut hash = Sha256::new();
        let mut bytes = Vec::new();
        hash_messages(&mut hash, &mut bytes, &messages[..prefix])?;
        let same_prefix = check.is_some_and(|(_, _, digest)| TranscriptDigest::from(hash.clone().finalize()) == *digest);
        if same_prefix && prefix == length {
            return Ok(());
        }
        hash_messages(&mut hash, &mut bytes, &messages[prefix..])?;
        let digest = hash.finalize().into();
        if same_prefix {
            let tail = self.sensitive.redact_messages(session_id, &messages[prefix..]);
            self.db.append_from(session_id, &tail, prefix).await?;
        } else {
            // A new sensitive mark must also replace older rows, including ones
            // for messages the current transcript dropped.
            let redacted = self.sensitive.redact_messages(session_id, messages);
            if version.is_some() && prior.as_ref().is_none_or(|(_, applied, _)| *applied != version) {
                let redact = |text: &str| self.sensitive.redact_text(session_id, text);
                self.db.replace(session_id, messages, &redacted, &redact).await?;
            } else {
                self.db.append(session_id, &redacted).await?;
            }
        }
        let mut last = self.last_ingested.lock().expect("last ingested");
        if last.len() >= LAST_INGESTED_LIMIT {
            last.clear();
        }
        last.insert(session_id.to_owned(), (length, version, digest));
        Ok(())
    }

    /// Fire-and-forget for the caller: store a completed turn's transcript. Never fails the caller. The write is work of the database's scope,
    /// registered before it is queued: the stop waits for it or revokes it, and a stopping scope refuses it before it touches the database (the
    /// stored-session backfill restores the derived rows).
    pub fn ingest_turn(self: &Arc<Self>, session: IngestSession) {
        if session.id.is_empty() || session.messages.is_empty() || session.agent_only {
            return;
        }
        let this = self.clone();
        let slot = self.enqueue(&session.id);
        let _queued = self.db.scope().spawn("services.memory.session-search-turn", async move {
            let id = session.id.clone();
            let messages = session.messages;
            let result = slot.run(|_| this.store_transcript(&id, &messages)).await;
            if let Err(error) = result {
                log_failure(&format!("ingest {id}"), &error);
            }
        });
    }

    /// Removal of a deleted session's rows as a scoped operation of the database's owner, queued after the session's pending writes: the stop drains
    /// or revokes it, and a stopping owner refuses it before it touches the database (the backfill drops the rows of a session whose record is gone).
    pub fn forget_session_owned(self: &Arc<Self>, session_id: &str) {
        let (this, id) = (self.clone(), session_id.to_owned());
        let _queued = self.db.scope().spawn("services.memory.session-search-delete", async move { this.forget_session(&id).await });
    }

    /// Best-effort removal of a deleted session's rows, after its pending writes (owned work only: [`Self::forget_session_owned`]).
    pub(crate) async fn forget_session(&self, session_id: &str) {
        if let Err(error) = self.invalidate_session(session_id).await {
            log_failure(&format!("delete {session_id}"), &error);
        }
    }

    /// The session's rows and backfill stamp dropped, after its pending writes: the next backfill derives them again from
    /// its record. The failure is the caller's (a session rewritten for a sensitive mark is not answered before this holds).
    pub async fn invalidate_session(&self, session_id: &str) -> Result<()> {
        self.enqueue(session_id)
            .run(|_| async {
                self.last_ingested.lock().expect("last ingested").remove(session_id);
                self.db.delete_session(session_id).await
            })
            .await
    }

    /// The session indexed again from its record, as a scoped operation of the database's owner after its pending writes
    /// (a session whose rows were dropped after the once-a-run backfill passed it is not left unindexed until the next run).
    /// `Ok(true)` once that is done (its rows written, or its stamp for a session not indexed, or its record gone);
    /// `Ok(false)` when its record could not be read now (a fork whose base still owes its sensitive rewrite) or the owner
    /// admits no more work: the caller tries it again.
    pub async fn reindex_session_owned(self: &Arc<Self>, stored: Arc<dyn StoredSessions>, session_id: &str) -> Result<bool> {
        let (this, id) = (self.clone(), session_id.to_owned());
        let Some(owned) = self.db.scope().spawn("services.memory.session-search-reindex", async move { this.backfill_one(stored.as_ref(), &id, None).await })
        else {
            return Ok(false);
        };
        match owned.await {
            Some(outcome) => outcome.map(|outcome| !matches!(outcome, Backfilled::Unread)),
            None => Ok(false),
        }
    }

    /// Ingests stored ordinary sessions whose record stamp changed since the
    /// last recorded backfill (agent-only ones are stamped, not indexed), then
    /// drops the rows of sessions whose record is gone. Sequential, with a
    /// short pace between sessions. Returns the number of sessions indexed.
    pub async fn backfill(&self, stored: &dyn StoredSessions) -> Result<usize> {
        let stamps = self.db.backfill_stamps().await?;
        let session_ids = stored.session_ids().await?;
        let mut ingested = 0;
        for session_id in &session_ids {
            match self.backfill_one(stored, session_id, stamps.get(session_id).map(String::as_str)).await {
                Ok(Backfilled::Indexed) => ingested += 1,
                Ok(_) => continue,
                Err(error) => log_failure(&format!("backfill {session_id}"), &error),
            }
            tokio::task::yield_now().await;
        }
        let present: std::collections::HashSet<&String> = session_ids.iter().collect();
        for session_id in self.db.session_ids().await? {
            if !present.contains(&session_id) {
                self.forget_session(&session_id).await;
            }
        }
        Ok(ingested)
    }

    async fn backfill_one(
        &self,
        stored: &dyn StoredSessions,
        session_id: &str,
        recorded: Option<&str>,
    ) -> Result<Backfilled> {
        self.enqueue(session_id).run(|_| async {
            // A busy record is left unstamped to be read again, never taken as gone.
            let observe = |stamp: SessionStamp| match stamp {
                SessionStamp::At(stamp) => Ok(stamp),
                SessionStamp::Busy => Err(Backfilled::Unread),
                SessionStamp::Gone => Err(Backfilled::Gone),
            };
            let mut stamp = match observe(stored.stamp(session_id).await?) {
                Ok(stamp) => stamp,
                Err(outcome) => return Ok(outcome),
            };
            for _ in 0..2 {
                if recorded == Some(stamp.as_str()) {
                    return Ok(Backfilled::Unchanged);
                }
                let session = stored.read(session_id).await.filter(|s| s.id == session_id);
                let after = match observe(stored.stamp(session_id).await?) {
                    Ok(after) => after,
                    Err(outcome) => return Ok(outcome),
                };
                if stamp != after {
                    // Retry once from the newly observed identity, never attach it to
                    // an earlier read. A busier session remains unstamped for later recovery.
                    stamp = after;
                    continue;
                }
                let Some(IngestSession { messages, agent_only, .. }) = session else { return Ok(Backfilled::Unread) };
                let indexed = !agent_only;
                let rows = if indexed {
                    // A redacted message is only needed until its search row has been derived.
                    messages
                        .into_iter()
                        .enumerate()
                        .filter_map(|(index, message)| {
                            let redacted = self.sensitive.redact_message(session_id, &message);
                            drop(message);
                            search_row(session_id, &redacted, index)
                        })
                        .collect::<Vec<_>>()
                } else {
                    drop(messages);
                    Vec::new()
                };
                self.db.store_backfill(session_id, &rows, &stamp).await?;
                return Ok(if indexed { Backfilled::Indexed } else { Backfilled::Stamped });
            }
            Ok(Backfilled::Unread)
        })
        .await
    }
}

/// What a backfill of one session did.
enum Backfilled {
    /// Its stamp is the one recorded: nothing to do.
    Unchanged,
    /// Its record is gone.
    Gone,
    /// Its rows written with its stamp.
    Indexed,
    /// Stamped as a session not indexed (agent-only).
    Stamped,
    /// Its record could not be read (refused, or written again during each read): left unstamped.
    Unread,
}

type TranscriptDigest = [u8; 32];

fn hash_messages(hash: &mut Sha256, bytes: &mut Vec<u8>, messages: &[Value]) -> Result<()> {
    for message in messages {
        bytes.clear();
        serde_json::to_writer(&mut *bytes, message).map_err(|e| MemoryError::Io(std::io::Error::other(e)))?;
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(&*bytes);
    }
    Ok(())
}
