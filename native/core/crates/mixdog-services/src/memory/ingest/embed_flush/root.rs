//! Root-entry embedding (`memory-embed.mjs` `flushEmbeddingDirty`, `syncBatchEmbeddings`,
//! `rootEmbedText`, `sweepRootEmbedText`; `memory.mjs` `startRootEmbedSweep`): chunk roots
//! without a vector are embedded newest first in `FOR UPDATE SKIP LOCKED` batches, and a paced
//! sweep replaces the vectors made under the older root text.
//!
//! Each batch owns its row locks until `COMMIT`/`ROLLBACK`, so the work runs on one claimed
//! connection. A connection whose transaction state is unknown is destroyed, never pooled.

use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use mixdog_js::{js_trim, to_number};
use mixdog_rt::TaskClass;
use serde_json::Value;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use super::{BATCH_SIZE, RawEmbedFlush, is_raw_embeddable};
use crate::memory::error::MemoryError;
use crate::memory::pg::db::Db;
use crate::memory::recall::hybrid::embedding_to_sql;
use crate::tool_state::onnx_runtime_supported;

/// `ROOT_EMBED_SWEEP_META_KEY`.
pub const ROOT_EMBED_SWEEP_META_KEY: &str = "embedding.root_text_v2";
/// `EMBED_FLUSH_TIMEOUT_MS`' default: one flush stops claiming after this.
const DEFAULT_FLUSH_TIMEOUT: Duration = Duration::from_secs(30);
/// `ROOT_SWEEP_BATCH`.
pub const ROOT_SWEEP_BATCH: usize = 8;

/// What one root flush did (`flushEmbeddingDirty`'s answer).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RootFlush {
    pub attempted: usize,
    pub succeeded: usize,
    /// Ids that received no vector (no text, dimension mismatch, text changed since read).
    pub failed: Vec<i64>,
    /// The flush hit its deadline with work possibly left.
    pub timed_out: bool,
}

/// Why a flush or a sweep step ended without an answer.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FlushFailure {
    #[error("cancelled")]
    Cancelled,
    /// The store's own failure (`markStoreFault`): a claim, a commit or a rollback that did not
    /// land. It is kept as it was, never reported as an empty successful flush.
    #[error("{0}")]
    Store(String),
}

impl From<MemoryError> for FlushFailure {
    fn from(error: MemoryError) -> Self {
        match error {
            MemoryError::Cancelled => Self::Cancelled,
            other => Self::Store(other.message()),
        }
    }
}

impl From<tokio_postgres::Error> for FlushFailure {
    fn from(error: tokio_postgres::Error) -> Self {
        Self::Store(error.to_string())
    }
}

/// One step of the root-text sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepStep {
    pub claimed: usize,
    pub replaced: usize,
    pub done: bool,
}

/// A flush in progress, shared by every caller that asks while it runs.
pub(super) type Flight = Shared<BoxFuture<'static, Result<RootFlush, FlushFailure>>>;

fn check(cancel: &CancellationToken) -> Result<(), FlushFailure> {
    if cancel.is_cancelled() { Err(FlushFailure::Cancelled) } else { Ok(()) }
}

/// `MIXDOG_EMBED_FLUSH_TIMEOUT_MS`: a finite positive number, else 30 s.
fn flush_timeout() -> Duration {
    std::env::var("MIXDOG_EMBED_FLUSH_TIMEOUT_MS")
        .ok()
        .map(|raw| mixdog_js::string_to_number(&raw))
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .map_or(DEFAULT_FLUSH_TIMEOUT, |ms| Duration::from_secs_f64(ms / 1000.0))
}

/// `rootEmbedText`: a chunk root is also the chunk's first message, so the summary leads and the
/// message's own words follow (a long message cut at the model window keeps the summary).
pub fn root_embed_text(element: Option<&str>, summary: Option<&str>, role: Option<&str>, content: Option<&str>) -> String {
    let head = [element, summary].into_iter().flatten().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" — ");
    let head = js_trim(&head);
    if head.is_empty() {
        return String::new();
    }
    let content = content.unwrap_or("");
    let content = if is_raw_embeddable(role.unwrap_or(""), content) { js_trim(content) } else { "" };
    if content.is_empty() { head.to_owned() } else { format!("{head}\n\n{content}") }
}

/// A claimed connection whose transaction state is unknown goes away with its error.
fn destroy(client: deadpool_postgres::Object) {
    drop(deadpool_postgres::Object::take(client));
}

/// `startRootEmbedSweep`: records where the sweep starts (above the newest root) unless a sweep
/// already has progress. One statement, so the start is atomic.
pub async fn start_root_embed_sweep(db: &Db) -> Result<(), MemoryError> {
    db.execute(
        "INSERT INTO meta(key, value)
         SELECT $1::text, jsonb_build_object('cursor', COALESCE(MAX(id), 0) + 1, 'done', false)
         FROM entries WHERE is_root = 1
         ON CONFLICT (key) DO NOTHING",
        &[&ROOT_EMBED_SWEEP_META_KEY],
    )
    .await?;
    Ok(())
}

/// `id, element, summary, content, role` of a root.
type Row = (i64, Option<String>, Option<String>, Option<String>, Option<String>);
type Param<'a> = &'a (dyn tokio_postgres::types::ToSql + Sync);

struct Update {
    id: i64,
    vector: String,
    element: Option<String>,
    summary: Option<String>,
    content: Option<String>,
}

impl RawEmbedFlush {
    /// `flushEmbeddingDirty`: embeds roots that have no vector, newest first, until none are left
    /// or the deadline passes. Callers that ask while a flush runs share it (the first caller's
    /// `cancel` governs it); the work is a task of its own, so a caller that stops waiting never
    /// leaves a transaction open.
    pub async fn flush_roots(self: &Arc<Self>, cancel: &CancellationToken) -> Result<RootFlush, FlushFailure> {
        check(cancel)?;
        if !onnx_runtime_supported() {
            return Ok(RootFlush::default());
        }
        let (flight, started) = {
            let mut slot = self.roots_in_flight.lock().expect("flush flight");
            match slot.as_ref() {
                Some(flight) => (flight.clone(), false),
                None => {
                    let (this, cancel) = (self.clone(), cancel.clone());
                    let task = mixdog_rt::spawn("services.memory.root-flush", TaskClass::Work, async move { this.run_root_flush(&cancel).await });
                    let flight: Flight = async move { task.await.unwrap_or_else(|e| Err(FlushFailure::Store(format!("root flush task: {e}")))) }.boxed().shared();
                    *slot = Some(flight.clone());
                    (flight, true)
                }
            }
        };
        let outcome = flight.await;
        if started {
            self.roots_in_flight.lock().expect("flush flight").take();
        }
        outcome
    }

    async fn run_root_flush(&self, cancel: &CancellationToken) -> Result<RootFlush, FlushFailure> {
        let timeout = flush_timeout();
        let started = tokio::time::Instant::now();
        let mut done = RootFlush::default();
        let mut cursor: Option<i64> = None;
        self.ensure_cache_table().await?;
        check(cancel)?;
        loop {
            check(cancel)?;
            if started.elapsed() >= timeout {
                mixdog_rt::memory_stderr!("[embed] flush timed out after {}s; proceeding with partial state", timeout.as_secs_f64());
                done.timed_out = true;
                break;
            }
            // Newest roots first, so a model migration restores current work before deep history.
            let client = self.db.client().await?;
            let ids = match self.claim_roots(&client, cursor).await {
                Ok(ids) => ids,
                Err(error) => {
                    let rollback = client.batch_execute("ROLLBACK").await;
                    destroy(client);
                    if cancel.is_cancelled() {
                        return Err(FlushFailure::Cancelled);
                    }
                    mixdog_rt::memory_stderr!("[embed] flush SKIP LOCKED claim failed: {error}");
                    // `memory-embed.mjs:258-271`: a rollback that fails too is part of the fault's text.
                    return Err(match rollback {
                        Err(rollback) => FlushFailure::Store(format!("{error}; rollback failed: {rollback}")),
                        Ok(()) => error.into(),
                    });
                }
            };
            if ids.is_empty() {
                if let Err(error) = client.batch_execute("COMMIT").await {
                    destroy(client);
                    return Err(error.into());
                }
                break;
            }
            cursor = ids.last().copied();
            done.attempted += ids.len();
            let (mut batch_done, mut aborted) = (false, false);
            let synced = match check(cancel) {
                Ok(()) => self.sync_roots(&client, &ids, false, cancel).await,
                Err(cancelled) => Err(cancelled),
            };
            match synced {
                Ok(written) => {
                    done.succeeded += written.len();
                    done.failed.extend(ids.iter().filter(|id| !written.contains(id)));
                    batch_done = true;
                }
                Err(FlushFailure::Cancelled) => aborted = true,
                Err(error) => {
                    mixdog_rt::memory_stderr!("[embed] batch failed (ids={}..{}): {error}", ids[0], ids[ids.len() - 1]);
                    done.failed.extend(&ids);
                }
            }
            if let Err(error) = client.batch_execute(if batch_done { "COMMIT" } else { "ROLLBACK" }).await {
                destroy(client);
                // Cancelled work reports as cancelled: a store fault here would replace it.
                if !aborted {
                    return Err(error.into());
                }
                mixdog_rt::memory_stderr!("[embed] rollback after cancellation failed: {error}");
            }
            if aborted {
                return Err(FlushFailure::Cancelled);
            }
            if ids.len() < BATCH_SIZE {
                break;
            }
        }
        Ok(done)
    }

    /// `syncRootEmbedding(db, rootId)`: embeds one root now; true when its vector was written.
    pub async fn sync_root(&self, root_id: i64, cancel: &CancellationToken) -> Result<bool, FlushFailure> {
        let client = self.db.client().await?;
        Ok(!self.sync_roots(&client, &[root_id], false, cancel).await?.is_empty())
    }

    async fn claim_roots(&self, client: &deadpool_postgres::Object, cursor: Option<i64>) -> Result<Vec<i64>, tokio_postgres::Error> {
        client.batch_execute("BEGIN").await?;
        let rows = client
            .query(
                "SELECT id FROM entries
                 WHERE is_root = 1 AND embedding IS NULL
                   AND (element IS NOT NULL OR summary IS NOT NULL)
                   AND ($2::bigint IS NULL OR id < $2)
                 ORDER BY id DESC
                 LIMIT $1
                 FOR UPDATE SKIP LOCKED",
                &[&(BATCH_SIZE as i64), &cursor],
            )
            .await?;
        Ok(rows.iter().map(|row| row.get::<_, i64>(0)).collect())
    }

    /// `syncBatchEmbeddings`: embeds the roots `ids` from their current text and writes each vector
    /// where the text is unchanged since it was read. `replace` writes over an existing vector
    /// (the sweep) instead of filling a missing one. Answers the ids that received a vector.
    pub(super) async fn sync_roots(
        &self,
        client: &deadpool_postgres::Object,
        ids: &[i64],
        replace: bool,
        cancel: &CancellationToken,
    ) -> Result<Vec<i64>, FlushFailure> {
        check(cancel)?;
        if !onnx_runtime_supported() {
            return Ok(Vec::new());
        }
        let rows = client
            .query("SELECT id, element, summary, content, role FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1", &[&ids])
            .await?;
        check(cancel)?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let expected = client
            .query_opt("SELECT value FROM meta WHERE key = 'embedding.current_dims'", &[])
            .await?
            .and_then(|row| row.get::<_, Value>(0).as_f64())
            .unwrap_or(0.0);
        check(cancel)?;
        let rows: Vec<Row> = rows.iter().map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4))).collect();
        let texts: Vec<String> =
            rows.iter().map(|(_, element, summary, content, role)| root_embed_text(element.as_deref(), summary.as_deref(), role.as_deref(), content.as_deref())).collect();
        let wanted: Vec<String> = texts.iter().filter(|text| !text.is_empty()).cloned().collect();
        let vectors = self.cached_embed_batch(client, &wanted, &mut None).await?;
        check(cancel)?;
        let mut updates: Vec<Update> = Vec::new();
        let mut next = 0usize;
        for ((id, element, summary, content, _), text) in rows.into_iter().zip(&texts) {
            check(cancel)?;
            if text.is_empty() {
                continue;
            }
            let vector = &vectors[next];
            next += 1;
            if vector.is_empty() {
                continue;
            }
            if expected > 0.0 && vector.len() as f64 != expected {
                mixdog_rt::memory_stderr!("[embed] dim mismatch (id={id} got={} expected={expected})", vector.len());
                continue;
            }
            updates.push(Update { id, vector: embedding_to_sql(vector), element, summary, content });
        }
        if updates.is_empty() {
            return Ok(Vec::new());
        }
        // The VALUES update is one statement; it is not split by a cancel checkpoint.
        let values: Vec<String> = (0..updates.len())
            .map(|i| {
                let base = i * 5;
                format!("(${}::bigint, ${}::text::halfvec, ${}::text, ${}::text, ${}::text)", base + 1, base + 2, base + 3, base + 4, base + 5)
            })
            .collect();
        let sql = format!(
            "UPDATE entries AS e SET embedding = t.vector
             FROM (VALUES {}) AS t(id, vector, element, summary, content)
             WHERE e.id = t.id AND e.is_root = 1
               AND e.embedding IS {}NULL
               AND e.element IS NOT DISTINCT FROM t.element
               AND e.summary IS NOT DISTINCT FROM t.summary
               AND e.content IS NOT DISTINCT FROM t.content
             RETURNING e.id",
            values.join(","),
            if replace { "NOT " } else { "" }
        );
        let params: Vec<Param<'_>> =
            updates.iter().flat_map(|u| [&u.id as Param<'_>, &u.vector, &u.element, &u.summary, &u.content]).collect();
        let written: Vec<i64> = client.query(&sql, &params).await?.iter().map(|row| row.get::<_, i64>(0)).collect();
        check(cancel)?;
        if written.len() < updates.len() {
            self.report_skipped(client, &updates, &written).await?;
        }
        Ok(written)
    }

    /// The log lines of `syncBatchEmbeddings` for updates that did not land: the text changed
    /// since it was read (stale), or another writer embedded the root first (concurrent).
    async fn report_skipped(&self, client: &deadpool_postgres::Object, updates: &[Update], written: &[i64]) -> Result<(), FlushFailure> {
        let missed: Vec<&Update> = updates.iter().filter(|u| !written.contains(&u.id)).collect();
        let missed_ids: Vec<i64> = missed.iter().map(|u| u.id).collect();
        let current = client
            .query(
                "SELECT id, embedding IS NOT NULL AS has_embedding, element, summary, content
                 FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1",
                &[&missed_ids],
            )
            .await?;
        let current: std::collections::HashMap<i64, (bool, Option<String>, Option<String>, Option<String>)> =
            current.iter().map(|r| (r.get(0), (r.get(1), r.get(2), r.get(3), r.get(4)))).collect();
        let (mut stale, mut concurrent) = (0usize, 0usize);
        for update in missed {
            let Some((has_embedding, element, summary, content)) = current.get(&update.id) else { continue };
            let unchanged = *element == update.element && *summary == update.summary && *content == update.content;
            if unchanged && *has_embedding {
                concurrent += 1;
            } else {
                stale += 1;
            }
        }
        if stale > 0 {
            mixdog_rt::memory_stderr!("[embed-sync] {stale} stale-write(s) skipped — text changed since read");
        }
        if concurrent > 0 {
            tracing::debug!("[embed-sync] {concurrent} concurrent embed write(s) skipped: already embedded");
        }
        Ok(())
    }

    /// `sweepRootEmbedText`: one paced step. Existing vectors stay searchable until replaced: the
    /// step claims the next roots below the stored cursor that still HAVE a vector, embeds their
    /// current text, replaces each vector only where the text is unchanged, and advances the cursor
    /// in the same transaction. The meta row lock serializes concurrent sweepers; any failure rolls
    /// back both vectors and cursor. Roots without a vector are left to the ordinary flush.
    pub async fn sweep_root_text(&self, batch: usize, cancel: &CancellationToken) -> Result<SweepStep, FlushFailure> {
        check(cancel)?;
        let finished = SweepStep { claimed: 0, replaced: 0, done: true };
        if !onnx_runtime_supported() {
            return Ok(finished);
        }
        self.ensure_cache_table().await?;
        let client = self.db.client().await?;
        client.batch_execute("BEGIN").await?;
        let stepped = self.sweep_in_transaction(&client, batch, cancel).await;
        match &stepped {
            Ok(_) => {
                if let Err(error) = client.batch_execute("COMMIT").await {
                    let _ = client.batch_execute("ROLLBACK").await;
                    return Err(error.into());
                }
            }
            Err(_) => {
                let _ = client.batch_execute("ROLLBACK").await;
            }
        }
        stepped
    }

    async fn sweep_in_transaction(&self, client: &deadpool_postgres::Object, batch: usize, cancel: &CancellationToken) -> Result<SweepStep, FlushFailure> {
        let finished = SweepStep { claimed: 0, replaced: 0, done: true };
        let state = client.query_opt("SELECT value FROM meta WHERE key = $1 FOR UPDATE", &[&ROOT_EMBED_SWEEP_META_KEY]).await?;
        let Some(value) = state.map(|row| row.get::<_, Value>(0)) else { return Ok(finished) };
        let cursor = to_number(&value["cursor"]);
        if value.is_null() || value["done"] == Value::Bool(true) || !cursor.is_finite() {
            return Ok(finished);
        }
        let cursor = cursor as i64;
        let rows = client
            .query(
                "SELECT id FROM entries
                 WHERE is_root = 1 AND id < $1 AND embedding IS NOT NULL
                   AND (element IS NOT NULL OR summary IS NOT NULL)
                 ORDER BY id DESC
                 LIMIT $2
                 FOR UPDATE",
                &[&cursor, &(batch as i64)],
            )
            .await?;
        let ids: Vec<i64> = rows.iter().map(|row| row.get::<_, i64>(0)).collect();
        check(cancel)?;
        let written = if ids.is_empty() { Vec::new() } else { self.sync_roots(client, &ids, true, cancel).await? };
        let done = ids.len() < batch;
        let next = ids.iter().min().copied().unwrap_or(cursor);
        client
            .execute(
                "UPDATE meta SET value = jsonb_build_object('cursor', $2::bigint, 'done', $3::boolean) WHERE key = $1",
                &[&ROOT_EMBED_SWEEP_META_KEY, &next, &done],
            )
            .await?;
        Ok(SweepStep { claimed: ids.len(), replaced: written.len(), done })
    }
}
