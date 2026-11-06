//! `cycle1/cycle1-window.mjs`: one classifier window - prefilter structurally empty rows, generate
//! chunks through the LLM, commit each chunk as one transaction, mark what was left out.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::log;
use super::quality::{Generation, Generated, InvalidChunk, Row, assess_chunk_quality, generate_cycle1_chunks};
use super::requests::spawn_work;
use super::rows::{Plan, is_structurally_unchunkable, mark_omitted_rows, mark_terminal_rows, select_root_id};
use super::{Cycle1Llm, Cycle1Request, CycleEmbeddings};
use crate::memory::error::{MemoryError, Result};
use crate::memory::ingest::NowMs;
use crate::memory::pg::db::Db;

/// The timing block of a window: the generator's stats plus the commit time.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Timing {
    pub grouping_calls: i64,
    pub verification_calls: i64,
    pub llm_ms: i64,
    pub verification_ms: i64,
    pub retries: i64,
    pub fragments: i64,
    pub commit_ms: i64,
}

#[derive(Clone, Debug, Default)]
pub struct WindowResult {
    pub committed_chunks: i64,
    pub committed_members: i64,
    pub skipped_chunks: i64,
    pub rows_considered: usize,
    pub invalid_chunks: Vec<InvalidChunk>,
    pub failed_row_ids: Vec<i64>,
    pub omitted_row_ids: Vec<i64>,
    pub prefiltered_row_ids: Vec<i64>,
    pub prefilter_marked: usize,
    pub prefilter_mark_failed: usize,
    pub omitted_marked: usize,
    pub omitted_deferred: usize,
    pub omitted_mark_failed: usize,
    pub timing: Timing,
}

/// `inferChunkProjectId`: the one project every member carries, else none.
fn infer_chunk_project_id(members: &[Row]) -> Option<String> {
    let stored: HashSet<&String> = members.iter().filter_map(|m| m.project_id.as_ref()).collect();
    if stored.len() == 1 { stored.into_iter().next().cloned() } else { None }
}

/// Everything a window needs besides its rows.
pub struct WindowEnv {
    pub db: Db,
    pub llm: Arc<dyn Cycle1Llm>,
    pub embeddings: Arc<dyn CycleEmbeddings>,
    pub now: NowMs,
}

/// `commitCycle1Chunk`: the members are locked and re-checked (unchanged source, usable quality),
/// the root carries the category and the other members point at it.
async fn commit_chunk(env: &WindowEnv, chunk: &super::quality::Chunk, root_id: i64, member_ids: &[i64]) -> Result<()> {
    let project_id = infer_chunk_project_id(&chunk.members);
    let mut client = env.db.client().await?;
    let tx = client.transaction().await?;
    let locked = tx
        .query("SELECT id, ts, role, content, session_id, chunk_root FROM entries WHERE id = ANY($1::bigint[]) FOR UPDATE", &[&member_ids])
        .await?;
    let members: Vec<Row> = locked.iter().map(super::rows::row_of).collect();
    let taken = locked.iter().any(|row| row.get::<_, Option<i64>>("chunk_root").is_some());
    if taken || !assess_chunk_quality(&chunk.summary, Some(&chunk.quality), &members).0 {
        return Err(MemoryError::Runtime("cycle1 source changed before commit".into()));
    }
    let now = (env.now)();
    tx.execute(
        "UPDATE entries
       SET chunk_root = $1, is_root = 1, element = $2, category = $3, summary = $4,
           status = 'pending', project_id = $5,
           last_seen_at = $7, chunk_quality = $8::jsonb, duplicate_of = NULL
       WHERE id = $6",
        &[&root_id, &chunk.element, &chunk.category, &chunk.summary, &project_id, &root_id, &now, &chunk.quality],
    )
    .await?;
    let non_root: Vec<i64> = member_ids.iter().copied().filter(|&id| id != root_id).collect();
    if !non_root.is_empty() {
        tx.execute("UPDATE entries SET chunk_root = $1, project_id = $2 WHERE id = ANY($3::bigint[])", &[&root_id, &project_id, &non_root]).await?;
    }
    tx.commit().await?;
    Ok(())
}

struct Committed {
    row_ids: HashSet<i64>,
    chunks: i64,
    members: i64,
    skipped: i64,
    invalid: Vec<InvalidChunk>,
    failed: Vec<i64>,
    transient: Vec<i64>,
    started_at: i64,
}

/// `commitGeneratedChunks`: cancellation is honoured before each chunk, never inside one.
async fn commit_generated(env: &WindowEnv, generated: Generated, cancel: &CancellationToken) -> Result<Committed> {
    let mut invalid = generated.invalid_chunks;
    let invalid_rows: HashSet<i64> = invalid.iter().flat_map(|c| c.member_ids.iter().copied()).collect();
    let mut failed: Vec<i64> = generated.raw_row_ids.iter().copied().filter(|id| invalid_rows.contains(id)).collect();
    let mut transient: Vec<i64> = invalid.iter().filter(|c| c.reason == "llm_error").flat_map(|c| c.member_ids.iter().copied()).collect();
    let mut done = Committed {
        row_ids: HashSet::new(),
        chunks: 0,
        members: 0,
        skipped: generated.raw_row_ids.len() as i64,
        invalid: Vec::new(),
        failed: Vec::new(),
        transient: Vec::new(),
        started_at: (env.now)(),
    };
    for chunk in &generated.chunks {
        if cancel.is_cancelled() {
            return Err(MemoryError::Cancelled);
        }
        let member_ids: Vec<i64> = chunk.members.iter().map(|m| m.id).collect();
        let Some(root_id) = select_root_id(&chunk.members) else {
            invalid.push(InvalidChunk { reason: "no_root_id".into(), idx_list: None, member_ids, error: None });
            done.skipped += 1;
            continue;
        };
        match commit_chunk(env, chunk, root_id, &member_ids).await {
            Ok(()) => {
                done.chunks += 1;
                done.members += member_ids.len() as i64;
                done.row_ids.extend(member_ids.iter().copied());
                // Real-time embedding: fire and forget, so dense recall sees the root without
                // waiting for the end-of-cycle flush.
                let (embeddings, cancel) = (Arc::clone(&env.embeddings), cancel.clone());
                spawn_work("memory-cycle-root-embed", async move {
                    if let Err(error) = embeddings.sync_root(root_id, &cancel).await {
                        log(&format!("[cycle1] realtime embed failed (root={root_id}): {error}\n"));
                    }
                });
            }
            Err(error) => {
                log(&format!("[cycle1] chunk commit failed (root={root_id}): {}\n", error.message()));
                done.skipped += 1;
                for id in member_ids {
                    failed.push(id);
                    transient.push(id);
                }
            }
        }
    }
    done.invalid = invalid;
    done.failed = failed;
    done.transient = transient;
    Ok(done)
}

/// `processCycle1Window`.
pub async fn process_cycle1_window(env: &WindowEnv, original: &[Row], window_idx: usize, plan: &Plan, cancel: &CancellationToken) -> Result<WindowResult> {
    if cancel.is_cancelled() {
        return Err(MemoryError::Cancelled);
    }
    if original.is_empty() {
        return Ok(WindowResult::default());
    }
    let (prefiltered, rows): (Vec<&Row>, Vec<&Row>) = original.iter().partition(|r| is_structurally_unchunkable(r));
    let prefiltered_ids: Vec<i64> = prefiltered.iter().map(|r| r.id).collect();
    let rows: Vec<Row> = rows.into_iter().cloned().collect();
    let (mut prefilter_marked, mut prefilter_mark_failed) = (0, 0);
    if !prefiltered_ids.is_empty() {
        let (_, marked, failed) = mark_terminal_rows(&env.db, &prefiltered_ids, "prefilter", (env.now)()).await;
        (prefilter_marked, prefilter_mark_failed) = (marked, failed);
    }
    if rows.is_empty() {
        return Ok(WindowResult {
            rows_considered: original.len(),
            omitted_row_ids: prefiltered_ids.clone(),
            prefiltered_row_ids: prefiltered_ids,
            prefilter_marked,
            prefilter_mark_failed,
            ..WindowResult::default()
        });
    }
    let request = Cycle1Request { preset: plan.preset.clone(), timeout_ms: plan.timeout };
    let now = Arc::clone(&env.now);
    let generation = Generation { llm: env.llm.as_ref(), request: &request, cancel, input_token_budget: plan.input_token_budget, now: now.as_ref() };
    let generated = generate_cycle1_chunks(&rows, &generation).await?;
    log(&format!("[cycle1-time] window={window_idx} {}\n", mixdog_js::json_stringify(&generated.stats.to_json(generated.total_ms))));
    for invalid in &generated.invalid_chunks {
        log(&format!("[cycle1] window={window_idx} {}: {}\n", invalid.reason, invalid.error.as_deref().unwrap_or("source validation failed")));
    }
    let stats = generated.stats.clone();
    let commit = commit_generated(env, generated, cancel).await?;
    if cancel.is_cancelled() {
        return Err(MemoryError::Cancelled);
    }
    let raw_row_ids: Vec<i64> = rows.iter().map(|r| r.id).filter(|id| !commit.row_ids.contains(id)).collect();
    let llm_omitted: Vec<i64> = raw_row_ids.iter().copied().filter(|id| !commit.failed.contains(id)).collect();
    let (_, omitted_deferred, omitted_mark_failed) = mark_omitted_rows(&env.db, &raw_row_ids, &commit.transient, (env.now)()).await;
    let omitted_marked = 0;
    let omitted_row_ids: Vec<i64> = llm_omitted.into_iter().chain(prefiltered_ids.iter().copied()).collect();
    log(&format!(
        "[cycle1] window={window_idx} entries={} prompt_entries={} chunks={} members={} skipped_chunks={} omitted={} prefiltered={} prefilter_marked={prefilter_marked} prefilter_mark_failed={prefilter_mark_failed} omitted_deferred={omitted_deferred} omitted_marked={omitted_marked} omitted_mark_failed={omitted_mark_failed} failed_rows={} invalid_chunks={}\n",
        original.len(),
        rows.len(),
        commit.chunks,
        commit.members,
        commit.skipped,
        omitted_row_ids.len(),
        prefiltered_ids.len(),
        commit.failed.len(),
        commit.invalid.len(),
    ));
    Ok(WindowResult {
        committed_chunks: commit.chunks,
        committed_members: commit.members,
        skipped_chunks: commit.skipped,
        rows_considered: original.len(),
        invalid_chunks: commit.invalid,
        failed_row_ids: commit.failed,
        omitted_row_ids,
        prefiltered_row_ids: prefiltered_ids,
        prefilter_marked,
        prefilter_mark_failed,
        omitted_marked,
        omitted_deferred,
        omitted_mark_failed,
        timing: Timing {
            grouping_calls: stats.grouping_calls,
            verification_calls: stats.verification_calls,
            llm_ms: stats.llm_ms,
            verification_ms: stats.verification_ms,
            retries: stats.retries,
            fragments: stats.fragments,
            commit_ms: (env.now)() - commit.started_at,
        },
    })
}

pub(crate) fn invalid_json(items: &[InvalidChunk]) -> Value {
    Value::Array(items.iter().map(InvalidChunk::to_json).collect())
}
