// cycle1/cycle1-result.mjs
// The shape a cycle1 run reports: the quick-exit result, the window tallies
// summed, and the full result with its quality and timing blocks.
const EMPTY_EMBEDDING_DIRTY = { deferred: true, attempted: 0, succeeded: 0, failed: 0, failed_ids: [] };

export const emptyCycle1Result = (pendingRows) => ({
  processed: 0,
  chunks: 0,
  skipped: 0,
  sessions: 0,
  skippedInFlight: false,
  pendingRows,
  failed_row_ids: [],
  omitted_row_ids: [],
  invalid_chunks: [],
  quality: {
    rows_considered: 0,
    committed_members: 0,
    skipped_chunks: 0,
    omitted_rows: 0,
    failed_rows: 0,
    invalid_chunks: 0,
  },
  embedding_dirty: { ...EMPTY_EMBEDDING_DIRTY, failed_ids: [] },
});

export function aggregateWindowResults(results) {
  const totals = {
    chunks: 0,
    members: 0,
    skipped: 0,
    rowsConsidered: 0,
    invalidChunks: [],
    failedRowIds: [],
    omittedRowIds: [],
    prefilteredRowIds: [],
    prefilterMarked: 0,
    prefilterMarkFailed: 0,
    omittedMarked: 0,
    omittedDeferred: 0,
    omittedMarkFailed: 0,
    timing: {
      groupingCalls: 0,
      verificationCalls: 0,
      llmMs: 0,
      verificationMs: 0,
      retries: 0,
      fragments: 0,
      commitMs: 0,
    },
  };
  for (const r of results) {
    totals.chunks += r.committedChunks;
    totals.members += r.committedMembers;
    totals.skipped += r.skippedChunks;
    totals.rowsConsidered += r.rowsConsidered;
    if (Array.isArray(r.invalidChunks)) totals.invalidChunks.push(...r.invalidChunks);
    if (Array.isArray(r.failedRowIds)) totals.failedRowIds.push(...r.failedRowIds);
    if (Array.isArray(r.omittedRowIds)) totals.omittedRowIds.push(...r.omittedRowIds);
    if (Array.isArray(r.prefilteredRowIds)) totals.prefilteredRowIds.push(...r.prefilteredRowIds);
    totals.prefilterMarked += Number(r.prefilterMarked || 0);
    totals.prefilterMarkFailed += Number(r.prefilterMarkFailed || 0);
    totals.omittedMarked += Number(r.omittedMarked || 0);
    totals.omittedDeferred += Number(r.omittedDeferred || 0);
    totals.omittedMarkFailed += Number(r.omittedMarkFailed || 0);
    for (const key of Object.keys(totals.timing)) totals.timing[key] += Number(r.timing?.[key] || 0);
  }
  return totals;
}

export const cycle1SummaryLine = (windowCount, t) =>
  `[cycle1] windows=${windowCount} rows=${t.rowsConsidered} chunks=${t.chunks}` +
  ` members=${t.members} skipped_chunks=${t.skipped}` +
  ` omitted=${t.omittedRowIds.length} prefiltered=${t.prefilteredRowIds.length}` +
  ` prefilter_marked=${t.prefilterMarked} prefilter_mark_failed=${t.prefilterMarkFailed}` +
  ` omitted_deferred=${t.omittedDeferred} omitted_marked=${t.omittedMarked}` +
  ` omitted_mark_failed=${t.omittedMarkFailed}` +
  ` failed_rows=${t.failedRowIds.length}` +
  ` invalid_chunks=${t.invalidChunks.length}\n`;

export function buildCycle1Result({ totals: t, windowCount, pendingRowsAtStart, fetchMs, cycleStartedAt }) {
  return {
    processed: t.members,
    chunks: t.chunks,
    skipped: t.skipped,
    sessions: windowCount,
    skippedInFlight: false,
    pendingRows: pendingRowsAtStart,
    failed_row_ids: t.failedRowIds,
    omitted_row_ids: t.omittedRowIds,
    prefiltered_row_ids: t.prefilteredRowIds,
    invalid_chunks: t.invalidChunks,
    quality: {
      rows_considered: t.rowsConsidered,
      committed_members: t.members,
      skipped_chunks: t.skipped,
      omitted_rows: t.omittedRowIds.length,
      prefiltered_rows: t.prefilteredRowIds.length,
      prefilter_marked_rows: t.prefilterMarked,
      prefilter_mark_failed_rows: t.prefilterMarkFailed,
      omitted_deferred_rows: t.omittedDeferred,
      omitted_marked_rows: t.omittedMarked,
      omitted_mark_failed_rows: t.omittedMarkFailed,
      failed_rows: t.failedRowIds.length,
      invalid_chunks: t.invalidChunks.length,
      grouping_calls: t.timing.groupingCalls,
      verification_calls: t.timing.verificationCalls,
      raw_fallback_rows: t.rowsConsidered - t.members,
    },
    timing: { ...t.timing, fetchMs, totalMs: Date.now() - cycleStartedAt },
    embedding_dirty: { ...EMPTY_EMBEDDING_DIRTY, failed_ids: [] },
  };
}
