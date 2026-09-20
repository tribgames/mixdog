// cycle1/cycle1-window.mjs
// One classifier window: prefilter structurally empty rows, generate chunks
// through the LLM, commit each chunk as one transaction, and mark what was
// left out. Rows within the window are one session in chronological order.
import { __mixdogMemoryLog } from '../memory-log.mjs';
import { throwIfAborted } from '../memory-cycle2-shared.mjs';
import { assessChunkQuality, generateCycle1Chunks } from '../memory-chunk-quality.mjs';
import { inferChunkProjectId, syncRootEmbedding } from '../memory-embed.mjs';
import { isStructurallyUnchunkableInput, markOmittedRows, markTerminalRows, selectRootId } from './cycle1-rows.mjs';

const emptyWindowResult = (rowsConsidered, extra = {}) => ({
  committedChunks: 0,
  committedMembers: 0,
  skippedChunks: 0,
  rowsConsidered,
  invalidChunks: [],
  failedRowIds: [],
  omittedRowIds: [],
  ...extra,
});

/** Commits one chunk in one DB transaction: the members are locked and
 *  re-checked (unchanged source, usable quality), the root carries the
 *  category — recall filters member leaves via parent root — and the other
 *  members point at it. Throws when the source changed under the classifier. */
async function commitCycle1Chunk(db, chunk, rootId, memberIds) {
  const { element, category, summary, quality } = chunk;
  const projectId = inferChunkProjectId(chunk.members);
  await db.transaction(async (tx) => {
    const locked = await tx.query(
      `SELECT id, ts, role, content, session_id, chunk_root
       FROM entries WHERE id = ANY($1::bigint[]) FOR UPDATE`,
      [memberIds]
    );
    if (
      locked.rows.some((row) => row.chunk_root != null) ||
      !assessChunkQuality({ summary, chunk_quality: quality }, locked.rows).usable
    ) {
      throw new Error('cycle1 source changed before commit');
    }
    await tx.query(
      `UPDATE entries
       SET chunk_root = $1, is_root = 1, element = $2, category = $3, summary = $4,
           status = 'pending', project_id = $5,
           last_seen_at = $7, chunk_quality = $8::jsonb, cycle2_reviewed_at = NULL, duplicate_of = NULL
       WHERE id = $6`,
      [rootId, element, category, summary, projectId, rootId, Date.now(), JSON.stringify(quality)]
    );
    const nonRootIds = memberIds.filter((mid) => mid !== rootId);
    if (nonRootIds.length > 0) {
      await tx.query(`UPDATE entries SET chunk_root = $1, project_id = $2 WHERE id = ANY($3::bigint[])`, [
        rootId,
        projectId,
        nonRootIds,
      ]);
    }
  });
}

/** Commits every generated chunk; returns the commit tallies for the window. */
async function commitGeneratedChunks(db, generated, signal) {
  const committedRowIds = new Set();
  let committedChunks = 0;
  let committedMembers = 0;
  let skippedChunks = generated.rawRowIds.length;
  const invalidChunks = generated.invalidChunks;
  const invalidRowIds = new Set(invalidChunks.flatMap((chunk) => chunk.member_ids || []));
  const failedRowIds = generated.rawRowIds.filter((id) => invalidRowIds.has(id));
  const commitStartedAt = Date.now();
  for (const chunk of generated.chunks) {
    // A chunk commit is one DB transaction; do not split it with an abort
    // checkpoint. Cancellation is honored before the next chunk.
    throwIfAborted(signal);
    const memberIds = chunk.members.map((member) => Number(member.id));
    const rootId = selectRootId(chunk.members);
    if (rootId === null) {
      invalidChunks.push({ reason: 'no_root_id', member_ids: memberIds });
      skippedChunks += 1;
      continue;
    }
    try {
      await commitCycle1Chunk(db, chunk, rootId, memberIds);
      committedChunks += 1;
      committedMembers += memberIds.length;
      for (const mid of memberIds) {
        committedRowIds.add(mid);
      }
      // Real-time embedding: embed this episode the moment it is committed so
      // dense recall sees fresh roots without waiting for the end-of-cycle flush.
      // Fire-and-forget on a separate pool connection (independent of the
      // just-finished chunk transaction); never await — the chunk loop must
      // not block. The end-of-cycle flushEmbeddingDirty remains as a safety
      // net that sweeps any NULL embeddings this per-root path raced/missed.
      syncRootEmbedding(db, rootId, { signal }).catch((err) =>
        __mixdogMemoryLog(`[cycle1] realtime embed failed (root=${rootId}): ${err.message}\n`)
      );
    } catch (err) {
      __mixdogMemoryLog(`[cycle1] chunk commit failed (root=${rootId}): ${err.message}\n`);
      skippedChunks += 1;
      for (const mid of memberIds) failedRowIds.push(mid);
    }
  }
  return {
    committedRowIds,
    committedChunks,
    committedMembers,
    skippedChunks,
    invalidChunks,
    failedRowIds,
    commitStartedAt,
  };
}

export async function processCycle1Window({ db, rows: originalRows, windowIdx, plan, signal, callLlm }) {
  throwIfAborted(signal);
  if (originalRows.length === 0) return emptyWindowResult(0);

  const prefilteredRowIds = [];
  let prefilterMarked = 0;
  let prefilterMarkFailed = 0;
  const rows = originalRows.filter((row) => {
    if (!isStructurallyUnchunkableInput(row)) return true;
    prefilteredRowIds.push(Number(row.id));
    return false;
  });
  if (prefilteredRowIds.length > 0) {
    const mark = await markTerminalRows(db, prefilteredRowIds, 'prefilter');
    prefilterMarked = mark.marked;
    prefilterMarkFailed = mark.failed;
  }
  if (rows.length === 0) {
    return emptyWindowResult(originalRows.length, {
      omittedRowIds: prefilteredRowIds,
      prefilteredRowIds,
      prefilterMarked,
      prefilterMarkFailed,
    });
  }

  const generated = await generateCycle1Chunks(rows, {
    callLlm,
    inputTokenBudget: plan.inputTokenBudget,
    signal,
    request: {
      agent: 'cycle1-agent',
      taskType: 'maintenance',
      preset: plan.preset,
      timeout: plan.timeout,
      cwd: null,
    },
  });
  __mixdogMemoryLog(`[cycle1-time] window=${windowIdx} ${JSON.stringify(generated.stats)}\n`);
  for (const invalid of generated.invalidChunks) {
    __mixdogMemoryLog(
      `[cycle1] window=${windowIdx} ${invalid.reason}: ${invalid.error || 'source validation failed'}\n`
    );
  }
  const commit = await commitGeneratedChunks(db, generated, signal);
  throwIfAborted(signal);

  const rawRowIds = rows.map((r) => Number(r.id)).filter((id) => !commit.committedRowIds.has(id));
  const llmOmittedRowIds = rawRowIds.filter((id) => !commit.failedRowIds.includes(id));
  const omittedMark = await markOmittedRows(db, rawRowIds);
  const omittedRowIds = llmOmittedRowIds.concat(prefilteredRowIds);

  __mixdogMemoryLog(
    `[cycle1] window=${windowIdx} entries=${originalRows.length} prompt_entries=${rows.length} chunks=${commit.committedChunks}` +
      ` members=${commit.committedMembers} skipped_chunks=${commit.skippedChunks}` +
      ` omitted=${omittedRowIds.length} prefiltered=${prefilteredRowIds.length}` +
      ` prefilter_marked=${prefilterMarked} prefilter_mark_failed=${prefilterMarkFailed}` +
      ` omitted_deferred=${omittedMark.deferred} omitted_marked=${omittedMark.marked}` +
      ` omitted_mark_failed=${omittedMark.failed}` +
      ` failed_rows=${commit.failedRowIds.length}` +
      ` invalid_chunks=${commit.invalidChunks.length}\n`
  );

  return {
    committedChunks: commit.committedChunks,
    committedMembers: commit.committedMembers,
    skippedChunks: commit.skippedChunks,
    rowsConsidered: originalRows.length,
    invalidChunks: commit.invalidChunks,
    failedRowIds: commit.failedRowIds,
    omittedRowIds,
    prefilteredRowIds,
    prefilterMarked,
    prefilterMarkFailed,
    omittedMarked: omittedMark.marked,
    omittedDeferred: omittedMark.deferred,
    omittedMarkFailed: omittedMark.failed,
    timing: { ...generated.stats, commitMs: Date.now() - commit.commitStartedAt },
  };
}
