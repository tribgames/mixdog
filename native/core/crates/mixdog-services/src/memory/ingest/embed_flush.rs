//! Raw-row embedding (`flushRawEmbeddings` of `memory-embed.mjs`): freshly
//! ingested transcript rows become dense-searchable without waiting for a
//! background cycle. Local inference only. Rows are claimed `FOR UPDATE SKIP
//! LOCKED` in batches, so concurrent flushes embed disjoint rows, and a vector
//! cache keyed by (model, text hash) spares repeated texts.

use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use mixdog_js::{JsRegex, js_trim, slice_utf16, string_to_number, utf16_len};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

use crate::memory::embed::config::InputType;
use crate::memory::embed::engine::Embedder;
use crate::memory::embed::provider::EmbeddingProvider;
use crate::memory::error::{MemoryError, Result};
use crate::memory::pg::db::Db;
use crate::memory::recall::hybrid::embedding_to_sql;
use crate::tool_state::onnx_runtime_supported;

mod root;

pub use root::{FlushFailure, ROOT_EMBED_SWEEP_META_KEY, ROOT_SWEEP_BATCH, RootFlush, SweepStep, root_embed_text, start_root_embed_sweep};

const BATCH_SIZE: usize = 32;
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
    pruned_at: Mutex<Option<Instant>>,
    /// The cache cap, read from `MIXDOG_EMBED_CACHE_MAX_ROWS` once (Node reads it at module load).
    cache_max_rows: i64,
    /// The root flush running now, if any: `_flushInFlight`.
    roots_in_flight: Mutex<Option<root::Flight>>,
}

pub struct FlushOutcome {
    pub attempted: usize,
    pub embedded: usize,
    /// The cache prune this flush ran, if one was due: what it removed, or the error it met (the flush goes on, as
    /// Node's, which only logs it).
    pub pruned: Option<Result<PruneOutcome>>,
}

impl RawEmbedFlush {
    pub fn new(db: Db, provider: Option<Arc<EmbeddingProvider>>) -> Self {
        Self {
            db,
            provider,
            cache_ready: AtomicBool::new(false),
            pruned_at: Mutex::new(None),
            cache_max_rows: resolve_cache_max_rows(std::env::var("MIXDOG_EMBED_CACHE_MAX_ROWS").ok().as_deref()),
            roots_in_flight: Mutex::new(None),
        }
    }

    /// Embeds up to `limit` unembedded raw rows; `ids` restricts the claim to
    /// those rows (an empty list means nothing to do, never a backlog sweep).
    pub async fn flush(&self, limit: usize, ids: Option<&[i64]>) -> FlushOutcome {
        let idle = FlushOutcome { attempted: 0, embedded: 0, pruned: None };
        if !onnx_runtime_supported() || ids.is_some_and(<[i64]>::is_empty) {
            return idle;
        }
        if let Err(error) = self.ensure_cache_table().await {
            tracing::warn!(%error, "[embed] raw flush: cache table failed");
            return idle;
        }
        let (mut attempted, mut embedded, mut cursor, mut pruned) = (0usize, 0usize, 0i64, None);
        while attempted < limit {
            let batch_cap = BATCH_SIZE.min(limit - attempted);
            let client = match self.db.client().await {
                Ok(client) => client,
                Err(error) => {
                    tracing::warn!(%error, "[embed] raw flush: no connection");
                    break;
                }
            };
            let claimed = self.claim(&client, batch_cap, cursor, ids).await;
            let claimed = match claimed {
                Ok(claimed) => claimed,
                Err(error) => {
                    let _ = client.batch_execute("ROLLBACK").await;
                    mixdog_rt::memory_stderr!("[embed] raw flush SKIP LOCKED claim failed: {error}");
                    break;
                }
            };
            if claimed.is_empty() {
                let _ = client.batch_execute("COMMIT").await;
                break;
            }
            cursor = claimed[claimed.len() - 1];
            attempted += claimed.len();
            match self.sync_batch(&client, &claimed, &mut pruned).await {
                Ok(written) => {
                    embedded += written;
                    let _ = client.batch_execute("COMMIT").await;
                }
                Err(error) => {
                    mixdog_rt::memory_stderr!("[embed] raw batch failed (ids={}..{}): {error}", claimed[0], claimed[claimed.len() - 1]);
                    let _ = client.batch_execute("ROLLBACK").await;
                }
            }
            if claimed.len() < batch_cap {
                break;
            }
        }
        FlushOutcome { attempted, embedded, pruned }
    }

    async fn claim(&self, client: &deadpool_postgres::Object, cap: usize, cursor: i64, ids: Option<&[i64]>) -> Result<Vec<i64>> {
        client.batch_execute("BEGIN").await?;
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
        let expected = client
            .query_opt("SELECT value FROM meta WHERE key = 'embedding.current_dims'", &[])
            .await?
            .and_then(|row| row.get::<_, serde_json::Value>(0).as_f64())
            .unwrap_or(0.0);
        let rows: Vec<(i64, String, String)> = rows.iter().map(|r| (r.get(0), r.get(1), r.get(2))).collect();
        let texts: Vec<String> =
            rows.iter().map(|(_, role, content)| if is_raw_embeddable(role, content) { js_trim(content).to_owned() } else { String::new() }).collect();
        let wanted: Vec<String> = texts.iter().filter(|t| !t.is_empty()).cloned().collect();
        let vectors = self.cached_embed_batch(client, &wanted, pruned).await?;
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
            if expected > 0.0 && vector.len() as f64 != expected {
                mixdog_rt::memory_stderr!("[embed] raw dim mismatch (id={id} got={} expected={expected})", vector.len());
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

    async fn embedder(&self) -> Result<Embedder> {
        let provider = self.provider.as_ref().ok_or_else(|| MemoryError::Embedding("no embedding model".into()))?;
        match provider.warmup().await {
            Ok(Some(embedder)) => Ok(embedder),
            Ok(None) => Err(MemoryError::Embedding("embedding model is not installed".into())),
            Err(error) => Err(MemoryError::Embedding(error)),
        }
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
    ) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let provider = self.provider.as_ref().ok_or_else(|| MemoryError::Embedding("no embedding model".into()))?;
        let model = provider.model_id().to_owned();
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
        if !misses.is_empty() {
            let embedder = self.embedder().await?;
            let mut miss_hashes = Vec::new();
            let mut miss_sql = Vec::new();
            for chunk in misses.chunks(BATCH_SIZE) {
                let batch: Vec<String> = chunk.iter().map(|(text, _)| text.clone()).collect();
                let vectors = embedder.embed_batch(&batch, InputType::Document).await.map_err(|e| MemoryError::Embedding(e.message()))?;
                for ((_, hash), vector) in chunk.iter().zip(vectors) {
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
        Ok(entries.iter().map(|(_, hash)| found.get(hash).cloned().unwrap_or_default()).collect())
    }

    /// Row-count retention for the cache, at most once per interval: the
    /// oldest rows go first; far over the cap the regenerable table is truncated.
    /// It runs on the batch's connection, as Node's (a TRUNCATE on another one
    /// would wait for this transaction's lock on the cache table).
    async fn maybe_prune(&self, client: &deadpool_postgres::Object) -> Option<Result<PruneOutcome>> {
        {
            let mut at = self.pruned_at.lock().expect("prune clock");
            if at.is_some_and(|last| last.elapsed() < PRUNE_EVERY) {
                return None;
            }
            *at = Some(Instant::now());
        }
        let outcome = prune(client, self.cache_max_rows).await;
        if let Err(error) = &outcome {
            mixdog_rt::memory_stderr!("[embed] cache prune skipped: {error}");
        }
        Some(outcome)
    }
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

impl RawEmbedFlush {
}
