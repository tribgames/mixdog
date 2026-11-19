//! Raw-row embedding (`flushRawEmbeddings` of `memory-embed.mjs`): freshly
//! ingested transcript rows become dense-searchable without waiting for a
//! background cycle. Local inference only. Rows are claimed `FOR UPDATE SKIP
//! LOCKED` in batches, so concurrent flushes embed disjoint rows, and a vector
//! cache keyed by (model, text hash) spares repeated texts.

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use mixdog_js::{JsRegex, js_trim, slice_utf16, string_to_number, utf16_len};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

use crate::memory::embed::config;
use crate::memory::embed::provider::{Demand, EmbeddingProvider};
use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::{Db, Lease};
use crate::memory::recall::hybrid::embedding_to_sql;
use crate::tool_state::onnx_runtime_supported;

mod root;

pub use root::{FlushFailure, ROOT_EMBED_SWEEP_META_KEY, ROOT_SWEEP_BATCH, RootFlush, SweepStep, root_embed_text, start_root_embed_sweep};

// Claim one queued ingest window so all of its actual cache misses can be
// submitted together. The host is released before the cache and row writes.
const RAW_CLAIM_SIZE: usize = super::FLUSH_LIMIT;
const DEFAULT_MAX_CHARS: usize = 8000;
const DEFAULT_CACHE_MAX_ROWS: i64 = 10_000;
const PRUNE_EVERY: Duration = Duration::from_secs(600);
const PRUNE_BATCH: i64 = 5000;

const EXCLUDE_ROLES: [&str; 8] = ["tool", "tool_result", "tool-result", "function", "system", "log", "offload", "debug"];
const CONVERSATION_ROLES: [&str; 2] = ["user", "assistant"];
const SQL_ALWAYS_EXCLUDE: &str =
    r"^\s*(\[tool_call(?:\s|\]|$)|\[tool_result(?:\s|\]|$)|\[mixdog-runtime\]|Async .+ finished\.|background task(\s|$))";
const SQL_NON_CONVERSATION_EXCLUDE: &str = r"^\s*\[(system|log|offload|debug|trace|info|warn|warning|error|fatal)\]";

static EXCLUDE_CONTENT: LazyLock<Vec<JsRegex>> = LazyLock::new(|| {
    [
        r"^\s*\[tool_call\b",
        r"^\s*\[tool_result\b",
        r"^\s*\[mixdog-runtime\]",
        r"^\s*Async .+ finished\.",
        r"^\s*background task\b",
        r"^\s*<task-notification>",
    ]
    .into_iter()
    .map(|pattern| JsRegex::new_static(pattern, "i"))
    .collect()
});
static NON_CONVERSATION_CONTENT: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^\s*\[(?:system|log|offload|debug|trace|info|warn|warning|error|fatal)\]", "i")
});

/// Whether a raw row is useful conversational text for the dense leg: tool
/// traces and runtime/log notices carry no recall value as vectors.
fn is_raw_embeddable(role: &str, content: &str) -> bool {
    let role = js_trim(role).to_lowercase();
    if EXCLUDE_ROLES.contains(&role.as_str()) || js_trim(content).is_empty() {
        return false;
    }
    if EXCLUDE_CONTENT.iter().any(|re| re.is_match(content)) {
        return false;
    }
    CONVERSATION_ROLES.contains(&role.as_str()) || !NON_CONVERSATION_CONTENT.is_match(content)
}

/// `resolveEmbeddingCacheMaxRows`: a positive row count, else the default. A fraction below one is invalid like 0
/// (Node floors it to a zero-row cap, which wipes the cache: the fix proposed in
/// `node-fix-embedding-cache-max-rows.patch`).
pub fn resolve_cache_max_rows(value: Option<&str>) -> i64 {
    let rows = value.map_or(f64::NAN, string_to_number).floor();
    if rows.is_finite() && rows > 0.0 { rows as i64 } else { DEFAULT_CACHE_MAX_ROWS }
}

/// What one cache prune did (`pruneEmbeddingCache`'s result).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PruneOutcome {
    pub removed: i64,
    pub truncated: bool,
    pub remaining: i64,
}

#[cfg(test)]
thread_local! {
    /// When set, each prune statement on this thread (text, and its one bound row count if any).
    pub(crate) static PRUNE_STATEMENTS: std::cell::RefCell<Option<Vec<(&'static str, Option<i64>)>>> = const { std::cell::RefCell::new(None) };
}

fn observe_prune(_sql: &'static str, _param: Option<i64>) {
    #[cfg(test)]
    PRUNE_STATEMENTS.with(|log| {
        if let Some(log) = log.borrow_mut().as_mut() {
            log.push((_sql, _param));
        }
    });
}

const PRUNE_COUNT_SQL: &str = "SELECT count(*)::bigint AS n FROM memory.embedding_cache";
const PRUNE_TRUNCATE_SQL: &str = "TRUNCATE TABLE memory.embedding_cache";
const PRUNE_DELETE_SQL: &str = "DELETE FROM memory.embedding_cache
       WHERE ctid IN (
         SELECT ctid FROM memory.embedding_cache
         ORDER BY ctid ASC
         LIMIT $1
       )";

fn parse_vector(text: &str) -> Vec<f32> {
    text.trim_start_matches('[').trim_end_matches(']').split(',').map(|n| string_to_number(n) as f32).collect()
}

/// Flushes raw rows' embeddings for one database.
pub struct RawEmbedFlush {
    db: Db,
    provider: Option<Arc<EmbeddingProvider>>,
    cache_ready: AtomicBool,
    pruned_at: Mutex<i64>,
    /// The cache cap, read from `MIXDOG_EMBED_CACHE_MAX_ROWS` once (Node reads it at module load).
    cache_max_rows: i64,
    /// Each `flush` call (limit, ids), in order.
    #[cfg(test)]
    pub(crate) calls: Mutex<Vec<(usize, Option<Vec<i64>>)>>,
    #[cfg(test)]
    claim_seam: Mutex<Option<ClaimSeam>>,
    #[cfg(test)]
    final_cache_write_seam: Mutex<Option<ClaimSeam>>,
}

enum BatchDemand<'a> {
    Continue(&'a mut Option<Demand>),
    Finish(Option<Demand>),
}

pub struct FlushOutcome {
    pub attempted: usize,
    pub embedded: usize,
    /// The cache prune this flush ran, if one was due: what it removed, or the error it met (the flush goes on, as
    /// Node's, which only logs it).
    pub pruned: Option<Result<PruneOutcome>>,
}

/// `pruneEmbeddingCache` with Node's batch of 5000.
async fn prune(client: &deadpool_postgres::Object, max_rows: i64) -> Result<PruneOutcome> {
    observe_prune(PRUNE_COUNT_SQL, None);
    let count: i64 = client.query(PRUNE_COUNT_SQL, &[]).await?[0].get(0);
    let mut over = count - max_rows;
    if over <= 0 {
        return Ok(PruneOutcome { removed: 0, truncated: false, remaining: count });
    }
    if count > max_rows * 2 {
        observe_prune(PRUNE_TRUNCATE_SQL, None);
        client.batch_execute(PRUNE_TRUNCATE_SQL).await?;
        return Ok(PruneOutcome { removed: count, truncated: true, remaining: 0 });
    }
    let (mut removed, mut guard) = (0i64, 0);
    while over > 0 && guard < 1000 {
        guard += 1;
        let requested = PRUNE_BATCH.min(over);
        observe_prune(PRUNE_DELETE_SQL, Some(requested));
        let deleted = client.execute(PRUNE_DELETE_SQL, &[&requested]).await? as i64;
        if deleted == 0 {
            break;
        }
        removed += deleted;
        over -= deleted;
    }
    Ok(PruneOutcome { removed, truncated: false, remaining: (count - removed).max(0) })
}

/// A test's hold on the next flush batch, right after its claim (the transaction open, the rows locked): `entered` is told, then the batch waits
/// for `release`.
#[cfg(test)]
pub(crate) struct ClaimSeam {
    pub(crate) entered: tokio::sync::mpsc::UnboundedSender<()>,
    pub(crate) release: Arc<tokio::sync::Semaphore>,
}

#[cfg(test)]
impl RawEmbedFlush {
    pub(crate) fn hold_after_claim(&self, seam: ClaimSeam) {
        *self.claim_seam.lock().expect("claim seam") = Some(seam);
    }

    pub(crate) fn hold_before_final_cache_write(&self, seam: ClaimSeam) {
        *self.final_cache_write_seam.lock().expect("cache write seam") = Some(seam);
    }

    async fn before_final_cache_write(&self) {
        let held = self.final_cache_write_seam.lock().expect("cache write seam").take();
        if let Some(ClaimSeam { entered, release }) = held {
            let _ = entered.send(());
            let _ = release.acquire().await.map(tokio::sync::SemaphorePermit::forget);
        }
    }

    async fn claimed_seam(&self) {
        let held = self.claim_seam.lock().expect("claim seam").as_ref().map(|seam| (seam.entered.clone(), seam.release.clone()));
        if let Some((entered, release)) = held {
            let _ = entered.send(());
            let _ = release.acquire().await.map(tokio::sync::SemaphorePermit::forget);
        }
    }
}


/// The text is bounded before it is hashed or embedded: a huge row would
/// otherwise build a giant tensor, and identical truncations share a cache row.
fn truncate_for_embed(text: &str) -> String {
    let limit = std::env::var("MIXDOG_EMBED_MAX_CHARS")
        .ok()
        .map(|raw| string_to_number(&raw))
        .filter(|n| n.is_finite() && *n > 0.0)
        .map_or(DEFAULT_MAX_CHARS, |n| n.floor() as usize);
    if utf16_len(text) > limit { slice_utf16(text, limit) } else { text.to_owned() }
}
impl RawEmbedFlush {
    pub fn new(db: Db, provider: Option<Arc<EmbeddingProvider>>) -> Self {
        Self {
            db,
            provider,
            cache_ready: AtomicBool::new(false),
            pruned_at: Mutex::new(0),
            cache_max_rows: resolve_cache_max_rows(std::env::var("MIXDOG_EMBED_CACHE_MAX_ROWS").ok().as_deref()),
            #[cfg(test)]
            calls: Mutex::new(Vec::new()),
            #[cfg(test)]
            claim_seam: Mutex::new(None),
            #[cfg(test)]
            final_cache_write_seam: Mutex::new(None),
        }
    }

    /// The owner of the flushes' work: the database's scope.
    pub(crate) fn scope(&self) -> &crate::memory::lifecycle::Scope {
        self.db.scope()
    }

    /// Embeds up to `limit` unembedded raw rows; `ids` restricts the claim to
    /// those rows (an empty list means nothing to do, never a backlog sweep).
    pub async fn flush(&self, limit: usize, ids: Option<&[i64]>) -> FlushOutcome {
        #[cfg(test)]
        self.calls.lock().expect("flush calls").push((limit, ids.map(<[i64]>::to_vec)));
        let idle = FlushOutcome { attempted: 0, embedded: 0, pruned: None };
        if !onnx_runtime_supported() || limit == 0 || ids.is_some_and(<[i64]>::is_empty) {
            return idle;
        }
        if let Err(error) = self.ensure_cache_table().await {
            tracing::warn!(%error, "[embed] raw flush: cache table failed");
            return idle;
        }
        let (mut attempted, mut embedded, mut cursor, mut pruned) = (0usize, 0usize, 0i64, None);
        while attempted < limit {
            let batch_cap = RAW_CLAIM_SIZE.min(limit - attempted);
            // Each batch's row locks live in its transaction on this lease: a failed end or a cancelled flush discards the connection.
            let lease = match Lease::take(&self.db).await {
                Ok(lease) => lease,
                Err(error) => {
                    tracing::warn!(%error, "[embed] raw flush: no connection");
                    break;
                }
            };
            let claimed = self.claim(&lease, batch_cap, cursor, ids).await;
            let claimed = match claimed {
                Ok(claimed) => claimed,
                Err(error) => {
                    if lease.rollback().await.is_ok() {
                        lease.release(None).await;
                    }
                    mixdog_rt::memory_stderr!("[embed] raw flush SKIP LOCKED claim failed: {error}");
                    break;
                }
            };
            if claimed.is_empty() {
                if lease.commit().await.is_ok() {
                    lease.release(None).await;
                }
                break;
            }
            cursor = claimed[claimed.len() - 1];
            attempted += claimed.len();
            #[cfg(test)]
            self.claimed_seam().await;
            let ended = match self.sync_batch(&lease, &claimed, &mut pruned).await {
                Ok(written) => {
                    embedded += written;
                    lease.commit().await
                }
                Err(error) => {
                    mixdog_rt::memory_stderr!("[embed] raw batch failed (ids={}..{}): {error}", claimed[0], claimed[claimed.len() - 1]);
                    lease.rollback().await
                }
            };
            if ended.is_ok() {
                lease.release(None).await;
            }
            if claimed.len() < batch_cap {
                break;
            }
        }
        FlushOutcome { attempted, embedded, pruned }
    }

    async fn claim(&self, client: &Lease, cap: usize, cursor: i64, ids: Option<&[i64]>) -> Result<Vec<i64>> {
        client.begin().await?;
        let id_clause = if ids.is_some() { " AND id = ANY($7::bigint[])" } else { "" };
        let sql = format!(
            "SELECT id FROM entries
             WHERE is_root = 0 AND chunk_root IS NULL AND embedding IS NULL
               AND NULLIF(btrim(session_id), '') IS NOT NULL
               AND content IS NOT NULL
               AND id > $2{id_clause}
               AND lower(COALESCE(role, '')) <> ALL($3::text[])
               AND content !~* $5
               AND (lower(COALESCE(role, '')) = ANY($4::text[]) OR content !~* $6)
             ORDER BY id
             LIMIT $1
             FOR UPDATE SKIP LOCKED"
        );
        let cap = cap as i64;
        let exclude: Vec<&str> = EXCLUDE_ROLES.to_vec();
        let conversation: Vec<&str> = CONVERSATION_ROLES.to_vec();
        let mut params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            vec![&cap, &cursor, &exclude, &conversation, &SQL_ALWAYS_EXCLUDE, &SQL_NON_CONVERSATION_EXCLUDE];
        if let Some(ids) = &ids {
            params.push(ids);
        }
        Ok(client.query(&sql, &params).await?.iter().map(|row| row.get::<_, i64>(0)).collect())
    }

    async fn sync_batch(&self, client: &deadpool_postgres::Object, ids: &[i64], pruned: &mut Option<Result<PruneOutcome>>) -> Result<usize> {
        let rows = client
            .query(
                "SELECT id, role, content FROM entries WHERE id = ANY($1::bigint[]) AND is_root = 0 AND chunk_root IS NULL",
                &[&ids],
            )
            .await?;
        if rows.is_empty() {
            return Ok(0);
        }
        let rows: Vec<(i64, String, String)> = rows.iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect();
        let texts: Vec<String> =
            rows.iter().map(|(_, role, content)| if is_raw_embeddable(role, content) { js_trim(content).to_owned() } else { String::new() }).collect();
        let wanted: Vec<String> = texts.iter().filter(|t| !t.is_empty()).cloned().collect();
        let vectors = self.cached_embed_batch(client, &wanted, pruned, BatchDemand::Finish(None)).await?;
        let mut updates: Vec<(i64, String, String)> = Vec::new();
        let mut next = 0usize;
        for ((id, _, content), text) in rows.iter().zip(&texts) {
            if text.is_empty() {
                continue;
            }
            let vector = &vectors[next];
            next += 1;
            if vector.is_empty() {
                continue;
            }
            updates.push((*id, embedding_to_sql(vector), content.clone()));
        }
        if updates.is_empty() {
            return Ok(0);
        }
        let values: Vec<String> =
            (0..updates.len()).map(|i| format!("(${}::bigint, ${}::text::halfvec, ${}::text)", i * 3 + 1, i * 3 + 2, i * 3 + 3)).collect();
        let sql = format!(
            "UPDATE entries AS e SET embedding = t.vector
             FROM (VALUES {}) AS t(id, vector, content)
             WHERE e.id = t.id AND e.is_root = 0 AND e.chunk_root IS NULL
               AND e.embedding IS NULL
               AND e.content IS NOT DISTINCT FROM t.content
             RETURNING e.id",
            values.join(",")
        );
        let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> =
            updates.iter().flat_map(|(id, vector, content)| [id as &(dyn tokio_postgres::types::ToSql + Sync), vector, content]).collect();
        let written = client.query(&sql, &params).await?.len();
        if written < updates.len() {
            tracing::warn!(skipped = updates.len() - written, "[embed-sync] raw stale-write(s) skipped: content changed since read");
        }
        Ok(written)
    }

    async fn ensure_cache_table(&self) -> Result<()> {
        if self.cache_ready.load(Ordering::Acquire) {
            return Ok(());
        }
        self.db
            .batch(
                "CREATE TABLE IF NOT EXISTS memory.embedding_cache (
                   model_id  text   NOT NULL,
                   text_hash bytea  NOT NULL,
                   vector    halfvec NOT NULL,
                   PRIMARY KEY (model_id, text_hash)
                 )",
            )
            .await?;
        self.cache_ready.store(true, Ordering::Release);
        Ok(())
    }

    /// One vector per text, in order: cache hits in one query, misses embedded
    /// in batches and stored. The model is loaded only for misses (Node keys the cache by the configured model id).
    /// A prune that ran is put in `pruned`.
    async fn cached_embed_batch(
        &self,
        client: &deadpool_postgres::Object,
        texts: &[String],
        pruned: &mut Option<Result<PruneOutcome>>,
        mut demand: BatchDemand<'_>,
    ) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let provider = self.provider.as_ref().ok_or_else(|| MemoryError::Embedding("no embedding model".into()))?;
        let model_id = provider.model_id();
        // Legacy keys are kept for the default dtype; other variants
        // must not trust that cache to establish a custom schema's dimensions.
        let model = if config::normalize_dtype(model_id, provider.dtype()) == config::normalize_dtype(model_id, None) {
            model_id.to_owned()
        } else {
            config::identity(None, model_id, provider.dtype()).to_string()
        };
        let entries: Vec<(String, Vec<u8>)> = texts
            .iter()
            .map(|t| {
                let text = truncate_for_embed(t);
                let hash = Sha256::digest(text.as_bytes()).to_vec();
                (text, hash)
            })
            .collect();
        let hashes: Vec<Vec<u8>> = entries.iter().map(|(_, hash)| hash.clone()).collect();
        let mut found: std::collections::HashMap<Vec<u8>, Vec<f32>> = client
            .query(
                "SELECT text_hash, vector::text FROM memory.embedding_cache WHERE model_id = $1 AND text_hash = ANY($2::bytea[])",
                &[&model, &hashes],
            )
            .await?
            .iter()
            .map(|row| (row.get::<_, Vec<u8>>(0), parse_vector(&row.get::<_, String>(1))))
            .collect();
        let misses: Vec<&(String, Vec<u8>)> = entries.iter().filter(|(_, hash)| !found.contains_key(hash)).collect();
        let vectors = if misses.is_empty() {
            Vec::new()
        } else {
            if let BatchDemand::Continue(continuation) = &mut demand {
                continuation.get_or_insert_with(|| provider.document_demand());
            }
            let batch = misses.iter().map(|(text, _)| text.clone()).collect();
            provider.embed_documents(batch).await.map_err(MemoryError::Embedding)?
        };
        if let BatchDemand::Finish(inherited) = demand {
            drop(inherited);
            #[cfg(test)]
            if !misses.is_empty() {
                self.before_final_cache_write().await;
            }
        }
        if !misses.is_empty() {
            let mut miss_hashes = Vec::new();
            let mut miss_sql = Vec::new();
            for ((_, hash), vector) in misses.into_iter().zip(vectors) {
                if !vector.is_empty() {
                    miss_hashes.push(hash.clone());
                    miss_sql.push(embedding_to_sql(&vector));
                    found.insert(hash.clone(), vector.to_vec());
                }
            }
            client
                .execute(
                    "INSERT INTO memory.embedding_cache (model_id, text_hash, vector)
                     SELECT $1, unnest($2::bytea[]), unnest($3::text[])::halfvec
                     ON CONFLICT (model_id, text_hash) DO NOTHING",
                    &[&model, &miss_hashes, &miss_sql],
                )
                .await?;
        }
        if let Some(outcome) = self.maybe_prune(client).await {
            *pruned = Some(outcome);
        }
        if let Some(first) = found.values().next() {
            let dims = first.len();
            if found.values().any(|v| v.len() != dims) {
                return Err(MemoryError::Embedding("mixed dimensions in an indexing batch".into()));
            }
            crate::memory::schema::record_vector_dims(client, dims).await?;
        }
        Ok(entries.iter().map(|(_, hash)| found.get(hash).cloned().unwrap_or_default()).collect())
    }

    /// Row-count retention for the cache, at most once per interval: the
    /// oldest rows go first; far over the cap the regenerable table is truncated.
    /// It runs on the batch's connection, as Node's (a TRUNCATE on another one
    /// would wait for this transaction's lock on the cache table).
    async fn maybe_prune(&self, client: &deadpool_postgres::Object) -> Option<Result<PruneOutcome>> {
        {
            // `maybePruneEmbCache` (memory-embed.mjs:25-29): the next allowed prune, in `Date.now()` ms.
            let now = crate::memory::core::store::now_ms();
            let mut next = self.pruned_at.lock().expect("prune clock");
            if now < *next {
                return None;
            }
            *next = now + PRUNE_EVERY.as_millis() as i64;
        }
        let outcome = prune(client, self.cache_max_rows).await;
        if let Err(error) = &outcome {
            mixdog_rt::memory_stderr!("[embed] cache prune skipped: {error}");
        }
        Some(outcome)
    }
}
