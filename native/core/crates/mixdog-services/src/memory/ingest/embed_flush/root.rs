//! Root-entry embedding: chunk roots without a vector are embedded newest first in
//! `FOR UPDATE SKIP LOCKED` batches, and a paced sweep replaces the vectors made under the
//! older root text.
//!
//! Each batch owns its row locks until `COMMIT`/`ROLLBACK`, so the work runs on one claimed
//! connection. A connection whose transaction state is unknown is destroyed, never pooled.

use std::sync::Arc;
use std::time::Duration;

use mixdog_js::{js_trim, to_number};
use serde_json::Value;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use super::{BatchDemand, RawEmbedFlush, is_raw_embeddable};
use crate::memory::error::MemoryError;
use crate::memory::pg::db::{Db, Lease};
use crate::memory::recall::hybrid::embedding_to_sql;
use crate::tool_state::onnx_runtime_supported;

const BATCH_SIZE: usize = 32;

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

/// Writes each vector where the root's text is unchanged since it was read: one VALUES update, never split
/// by a cancel checkpoint. `replace` overwrites an existing vector instead of filling a missing one. Answers the
/// ids written.
async fn write_root_vectors(client: &deadpool_postgres::Object, updates: &[Update], replace: bool) -> Result<Vec<i64>, FlushFailure> {
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
    let params: Vec<Param<'_>> = updates.iter().flat_map(|u| [&u.id as Param<'_>, &u.vector, &u.element, &u.summary, &u.content]).collect();
    Ok(client.query(&sql, &params).await?.iter().map(|row| row.get::<_, i64>(0)).collect())
}

impl RawEmbedFlush {
    /// A process with no embedding provider (the ONNX runtime is unsupported on this platform) embeds
    /// nothing, and a root written without a vector is kept.
    fn embeds(&self) -> bool {
        self.provider.is_some() && onnx_runtime_supported()
    }

    /// Embeds roots that have no vector, newest first, until none are left or the deadline
    /// passes. Callers that ask while a flush runs share it (the first caller's `cancel`
    /// governs it). The flight is a keyed slot of the database's owner, retired with the slot
    /// however the work ends.
    pub async fn flush_roots(self: &Arc<Self>, cancel: &CancellationToken) -> Result<RootFlush, FlushFailure> {
        check(cancel)?;
        if !self.embeds() {
            return Ok(RootFlush::default());
        }
        let key = ("services.memory.root-flush", Arc::as_ptr(self) as usize);
        let (this, cancel) = (self.clone(), cancel.clone());
        let flight = self.db.scope().coalesce(key, "services.memory.root-flush", move || async move { this.run_root_flush(&cancel).await });
        let Some(flight) = flight else { return Err(FlushFailure::Cancelled) };
        flight.await.unwrap_or(Err(FlushFailure::Cancelled))
    }

    async fn run_root_flush(&self, cancel: &CancellationToken) -> Result<RootFlush, FlushFailure> {
        let timeout = flush_timeout();
        let started = tokio::time::Instant::now();
        let mut done = RootFlush::default();
        let mut cursor: Option<i64> = None;
        // Admit a pass only when its first cache miss is known. Keep the
        // demand across claim transactions, not across paced reindex passes.
        let mut demand = None;
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
            let client = Lease::take(&self.db).await?;
            let (ids, more_visible) = match self.claim_roots(&client, cursor).await {
                Ok(claim) => claim,
                Err(error) => {
                    let rollback = client.rollback().await;
                    // Discarded whatever the rollback did: the claim's state is unknown.
                    drop(client);
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
                drop(demand.take());
                client.commit().await?;
                client.release(None).await;
                break;
            }
            cursor = ids.last().copied();
            done.attempted += ids.len();
            let (mut batch_done, mut aborted) = (false, false);
            let short_claim = ids.len() < BATCH_SIZE;
            let batch_demand = if short_claim || !more_visible { BatchDemand::Finish(demand.take()) } else { BatchDemand::Continue(&mut demand) };
            let synced = match check(cancel) {
                Ok(()) => self.sync_roots(&client, &ids, false, cancel, batch_demand).await,
                Err(cancelled) => {
                    drop(batch_demand);
                    Err(cancelled)
                }
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
            let ended = if batch_done { client.commit().await } else { client.rollback().await };
            match ended {
                Ok(()) => client.release(None).await,
                // The lease is dropped here, so the connection is discarded.
                Err(error) => {
                    drop(client);
                    // Cancelled work reports as cancelled: a store fault here would replace it.
                    if !aborted {
                        return Err(error.into());
                    }
                    mixdog_rt::memory_stderr!("[embed] rollback after cancellation failed: {error}");
                }
            }
            if aborted {
                return Err(FlushFailure::Cancelled);
            }
            // Lookahead only controls model lifetime. After a full claim, still
            // probe below the cursor: an older row may have committed meanwhile.
            if short_claim {
                break;
            }
        }
        Ok(done)
    }

    /// `syncRootEmbedding(db, rootId)`: embeds one root now; true when its vector was written.
    pub async fn sync_root(&self, root_id: i64, cancel: &CancellationToken) -> Result<bool, FlushFailure> {
        let client = self.db.client().await?;
        Ok(!self.sync_roots(&client, &[root_id], false, cancel, BatchDemand::Finish(None)).await?.is_empty())
    }

    async fn claim_roots(&self, client: &Lease, cursor: Option<i64>) -> Result<(Vec<i64>, bool), tokio_postgres::Error> {
        client.begin().await?;
        const PENDING: &str = "is_root = 1 AND embedding IS NULL AND (element IS NOT NULL OR summary IS NOT NULL)";
        let sql = format!(
            "SELECT id FROM entries WHERE {PENDING} AND ($2::bigint IS NULL OR id < $2)
             ORDER BY id DESC LIMIT $1 FOR UPDATE SKIP LOCKED"
        );
        let rows = client.query(&sql, &[&(BATCH_SIZE as i64), &cursor]).await?;
        let ids: Vec<i64> = rows.iter().map(|row| row.get(0)).collect();
        let mut more = false;
        if ids.len() == BATCH_SIZE
            && let Some(last) = ids.last()
        {
            // A row that the next claim would skip is not outstanding inference demand.
            // Release the probe's lock without releasing any row in the actual claim.
            client.batch_execute("SAVEPOINT next_root").await?;
            more = client
                .query_opt(&format!("SELECT id FROM entries WHERE {PENDING} AND id < $1 ORDER BY id DESC LIMIT 1 FOR UPDATE SKIP LOCKED"), &[last])
                .await?
                .is_some();
            client.batch_execute("ROLLBACK TO SAVEPOINT next_root; RELEASE SAVEPOINT next_root").await?;
        }
        Ok((ids, more))
    }

    /// `syncBatchEmbeddings`: embeds the roots `ids` from their current text and writes each vector
    /// where the text is unchanged since it was read. `replace` writes over an existing vector
    /// (the sweep) instead of filling a missing one. Answers the ids that received a vector.
    async fn sync_roots(
        &self,
        client: &deadpool_postgres::Object,
        ids: &[i64],
        replace: bool,
        cancel: &CancellationToken,
        demand: BatchDemand<'_>,
    ) -> Result<Vec<i64>, FlushFailure> {
        check(cancel)?;
        if !self.embeds() {
            return Ok(Vec::new());
        }
        let rows = client.query("SELECT id, element, summary, content, role FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 1", &[&ids]).await?;
        check(cancel)?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Vec<Row> = rows.iter().map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4))).collect();
        let texts: Vec<String> = rows
            .iter()
            .map(|(_, element, summary, content, role)| root_embed_text(element.as_deref(), summary.as_deref(), role.as_deref(), content.as_deref()))
            .collect();
        let wanted: Vec<String> = texts.iter().filter(|text| !text.is_empty()).cloned().collect();
        let vectors = self.cached_embed_batch(client, &wanted, &mut None, demand).await?;
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
            updates.push(Update { id, vector: embedding_to_sql(vector), element, summary, content });
        }
        if updates.is_empty() {
            return Ok(Vec::new());
        }
        let written = write_root_vectors(client, &updates, replace).await?;
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
        type CurrentRoot = (bool, Option<String>, Option<String>, Option<String>);
        let current: std::collections::HashMap<i64, CurrentRoot> = current.iter().map(|r| (r.get(0), (r.get(1), r.get(2), r.get(3), r.get(4)))).collect();
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

    /// One paced step of the root-text sweep: claims the next roots below the stored cursor that
    /// still have a vector, replaces each vector with one of the current text where the text is
    /// unchanged, and advances the cursor in the same transaction. The meta row lock serializes
    /// concurrent sweepers; a failure rolls back vectors and cursor. Roots without a vector are
    /// left to the ordinary flush.
    pub async fn sweep_root_text(&self, batch: usize, cancel: &CancellationToken) -> Result<SweepStep, FlushFailure> {
        check(cancel)?;
        let finished = SweepStep { claimed: 0, replaced: 0, done: true };
        if !self.embeds() || batch == 0 {
            return Ok(finished);
        }
        self.ensure_cache_table().await?;
        let client = Lease::take(&self.db).await?;
        client.begin().await?;
        let stepped = self.sweep_in_transaction(&client, batch, cancel).await;
        match &stepped {
            Ok(_) => {
                if let Err(error) = client.commit().await {
                    if client.rollback().await.is_ok() {
                        client.release(None).await;
                    }
                    return Err(error.into());
                }
            }
            Err(_) => {
                if client.rollback().await.is_err() {
                    return stepped;
                }
            }
        }
        client.release(None).await;
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
        let written = if ids.is_empty() { Vec::new() } else { self.sync_roots(client, &ids, true, cancel, BatchDemand::Finish(None)).await? };
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
