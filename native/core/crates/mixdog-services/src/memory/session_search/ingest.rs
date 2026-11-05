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
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::memory::error::{MemoryError, Result};
use crate::memory::session_search::db::SessionSearchDb;

const LAST_INGESTED_LIMIT: usize = 500;
const BACKFILL_PACE: Duration = Duration::from_millis(25);

/// Values a user marked sensitive in a session, which must never reach the index.
pub trait SensitiveValues: Send + Sync {
    /// Identity of the session's current set of marked values; None when it has none.
    fn version(&self, session_id: &str) -> Option<String>;
    fn redact_messages(&self, session_id: &str, messages: &[Value]) -> Vec<Value>;
    fn redact_text(&self, session_id: &str, text: &str) -> String;
}

/// A session as the search copy sees it.
#[derive(Debug, Clone)]
pub struct IngestSession {
    pub id: String,
    pub messages: Vec<Value>,
    /// A session of agent-to-agent traffic only: never indexed.
    pub agent_only: bool,
}

/// The session store, for backfill.
#[async_trait]
pub trait StoredSessions: Send + Sync {
    async fn session_ids(&self) -> Vec<String>;
    /// The change stamp of a session's stored record.
    async fn record_stamp(&self, session_id: &str) -> Option<String>;
    async fn read(&self, session_id: &str) -> Option<IngestSession>;
}

struct Queue {
    gate: tokio::sync::Mutex<()>,
    /// The lifetime the queued writes run under; `close` cancels it.
    token: Mutex<CancellationToken>,
    waiting: std::sync::atomic::AtomicUsize,
}

pub struct SessionSearchIngest {
    db: SessionSearchDb,
    sensitive: Arc<dyn SensitiveValues>,
    /// session → (transcript length, sensitive-values version) of the last stored ingest.
    last_ingested: Mutex<HashMap<String, (usize, Option<String>)>>,
    queues: Mutex<HashMap<String, Arc<Queue>>>,
}

fn log_failure(what: &str, error: &MemoryError) {
    if !matches!(error, MemoryError::Cancelled) {
        eprintln!("[session-search] {what} failed: {}", error.message());
    }
}

impl SessionSearchIngest {
    pub fn new(db: SessionSearchDb, sensitive: Arc<dyn SensitiveValues>) -> Arc<Self> {
        Arc::new(Self { db, sensitive, last_ingested: Mutex::default(), queues: Mutex::default() })
    }

    pub fn db(&self) -> &SessionSearchDb {
        &self.db
    }

    /// Runs `task` once every earlier task of `session_id` has settled. The
    /// queue moves on past a failed task: that failure is the caller's.
    async fn serialized<T, F, Fut>(&self, session_id: &str, task: F) -> Result<T>
    where
        F: FnOnce(CancellationToken) -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        use std::sync::atomic::Ordering;
        let queue = {
            let mut queues = self.queues.lock().expect("queue map");
            let queue = queues.entry(session_id.to_owned()).or_insert_with(|| {
                Arc::new(Queue {
                    gate: tokio::sync::Mutex::new(()),
                    token: Mutex::new(CancellationToken::new()),
                    waiting: 0.into(),
                })
            });
            queue.waiting.fetch_add(1, Ordering::AcqRel);
            queue.clone()
        };
        let token = {
            let mut current = queue.token.lock().expect("token");
            if current.is_cancelled() {
                *current = CancellationToken::new();
            }
            current.clone()
        };
        let result = async {
            let _turn = tokio::select! {
                guard = queue.gate.lock() => guard,
                () = token.cancelled() => return Err(MemoryError::Cancelled),
            };
            if token.is_cancelled() {
                return Err(MemoryError::Cancelled);
            }
            tokio::select! {
                result = task(token.clone()) => result,
                () = token.cancelled() => Err(MemoryError::Cancelled),
            }
        }
        .await;
        if queue.waiting.fetch_sub(1, Ordering::AcqRel) == 1 {
            let mut queues = self.queues.lock().expect("queue map");
            if queues.get(session_id).is_some_and(|q| Arc::ptr_eq(q, &queue)) && queue.waiting.load(Ordering::Acquire) == 0 {
                queues.remove(session_id);
            }
        }
        result
    }

    /// Stops the session's search writes for a runtime close: queued ones never
    /// start and the running one is cancelled. Resolves when the queue has
    /// settled, so nothing this session issued writes afterwards. The rows are
    /// derived: the stored-session backfill restores what a cancelled write
    /// left out.
    pub async fn close_session(&self, session_id: &str) {
        let queue = self.queues.lock().expect("queue map").get(session_id).cloned();
        if let Some(queue) = queue {
            queue.token.lock().expect("token").cancel();
            let _settled = queue.gate.lock().await;
        }
    }

    async fn store_transcript(&self, session_id: &str, messages: &[Value]) -> Result<()> {
        // A turn always grows the transcript; an unchanged length means nothing
        // new. This is only a shortcut: the insert itself is idempotent.
        let length = messages.len();
        let version = self.sensitive.version(session_id);
        let unchanged = self
            .last_ingested
            .lock()
            .expect("last ingested")
            .get(session_id)
            .is_some_and(|(len, ver)| *len == length && *ver == version);
        if unchanged {
            return Ok(());
        }
        // A marked value is stored as a marker here too. While the session has
        // values not yet applied to its stored rows (rows made before the mark,
        // compacted ones included), the rows that hold one are replaced in one
        // transaction instead of only appending.
        let redacted = self.sensitive.redact_messages(session_id, messages);
        let applied = self
            .last_ingested
            .lock()
            .expect("last ingested")
            .get(session_id)
            .map(|(_, ver)| ver.clone());
        if version.is_some() && applied != Some(version.clone()) {
            let redact = |text: &str| self.sensitive.redact_text(session_id, text);
            self.db.replace(session_id, messages, &redacted, &redact).await?;
        } else {
            self.db.append(session_id, &redacted).await?;
        }
        let mut last = self.last_ingested.lock().expect("last ingested");
        if last.len() >= LAST_INGESTED_LIMIT {
            last.clear();
        }
        last.insert(session_id.to_owned(), (length, version));
        Ok(())
    }

    /// Fire-and-forget: store a completed turn's transcript. Never fails the caller.
    pub fn ingest_turn(self: &Arc<Self>, session: IngestSession) {
        if session.id.is_empty() || session.messages.is_empty() || session.agent_only {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            let id = session.id.clone();
            let messages = session.messages;
            let result = this.serialized(&id, |_| this.store_transcript(&id, &messages)).await;
            if let Err(error) = result {
                log_failure(&format!("ingest {id}"), &error);
            }
        });
    }

    /// Best-effort removal of a deleted session's rows, after its pending writes.
    pub async fn forget_session(&self, session_id: &str) {
        let result = self
            .serialized(session_id, |_| async {
                self.last_ingested.lock().expect("last ingested").remove(session_id);
                self.db.delete_session(session_id).await
            })
            .await;
        if let Err(error) = result {
            log_failure(&format!("delete {session_id}"), &error);
        }
    }

    /// Ingests stored ordinary sessions whose record stamp changed since the
    /// last recorded backfill (agent-only ones are stamped, not indexed), then
    /// drops the rows of sessions whose record is gone. Sequential, with a
    /// short pace between sessions. Returns the number of sessions indexed.
    pub async fn backfill(&self, stored: &dyn StoredSessions) -> Result<usize> {
        let stamps = self.db.backfill_stamps().await?;
        let session_ids = stored.session_ids().await;
        let mut ingested = 0;
        for session_id in &session_ids {
            if let Err(error) = self.backfill_one(stored, &stamps, session_id, &mut ingested).await {
                log_failure(&format!("backfill {session_id}"), &error);
            }
            tokio::time::sleep(BACKFILL_PACE).await;
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
        stamps: &std::collections::BTreeMap<String, String>,
        session_id: &str,
        ingested: &mut usize,
    ) -> Result<()> {
        let Some(stamp) = stored.record_stamp(session_id).await else { return Ok(()) };
        if stamps.get(session_id) == Some(&stamp) {
            return Ok(());
        }
        let Some(session) = stored.read(session_id).await.filter(|s| !s.id.is_empty()) else {
            return Ok(());
        };
        // An agent-only session is never indexed, but its stamp is recorded all
        // the same: without one it would be read in full on every start.
        let indexed = !session.agent_only;
        self.serialized(&session.id, |_| async {
            if indexed {
                let redacted = self.sensitive.redact_messages(&session.id, &session.messages);
                self.db.append(&session.id, &redacted).await?;
            }
            self.db.record_backfill_stamp(&session.id, &stamp).await
        })
        .await?;
        if indexed {
            *ingested += 1;
        }
        Ok(())
    }
}
