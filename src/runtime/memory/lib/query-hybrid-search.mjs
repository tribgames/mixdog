// Query recall: embed the query, retrieve hybrid (lexical + dense) candidates
// inside the requested window, order them by the plan's intent, backfill raw
// and core rows, expand/bound/dedupe, page, trace and render.
import {
  collapseNearDuplicateRows,
  interleaveRawRows,
  recallSearchHaystack,
  renderEntryLines,
  sessionRecallTerms,
} from './recall-format.mjs';
import { searchRelevantHybrid } from './memory-recall-store.mjs';
import { retrieveEntries } from './memory-retrievers.mjs';
import { compareRecallNewestFirst } from './recall-order.mjs';
import { expandRecallEventContext } from './recall-event-context.mjs';
import { insertTraceEvents } from './trace-store.mjs';
import {
  annotateRecallRootContext,
  boundRecallRowsToTemporal,
  hasVagueLatestWorkIntent,
  latestRecallTopicTerms,
  mergeHistoricalRecallRows,
  preserveLatestConceptRows,
  prioritizeHistoricalRootEvidence,
  rankLatestRecallRows,
  sampleRecallTimeline,
  topicTermCoverage,
  uniqueRowsById,
} from './query-ranking.mjs';
import { embedText, isEmbeddingModelReady, warmupEmbeddingProvider } from './embedding-provider.mjs';
import { embedRecallQuery } from './recall-embedding-readiness.mjs';
import { isSemanticOnlyRecall } from './recall-fusion.mjs';
import { collapseHistoryDuplicates } from './history-duplicates.mjs';
import { RECALL_LIMIT_CAP } from './recall-limits.mjs';

const debugMemory = () => Boolean(process.env.MIXDOG_DEBUG_MEMORY);

async function embedQuery(retrievalQuery, signal, { log, embeddingOnDemandCanStart, noteColdRecall }) {
  const embedding = await embedRecallQuery(retrievalQuery, {
    isReady: isEmbeddingModelReady,
    canWarmup: embeddingOnDemandCanStart,
    warmup: warmupEmbeddingProvider,
    embed: embedText,
    signal,
    onWarmupError: (err) => {
      log(`[memory-service] embedding warmup after cold recall failed: ${err?.message || err}\n`);
    },
  });
  const queryVector = Array.isArray(embedding.vector) ? embedding.vector : null;
  if (!queryVector) noteColdRecall(embedding);
  return queryVector;
}

// Push ts and status filters into the hybrid candidate query so FTS / vec
// rank inside the requested window, not the whole tree. The previous post-
// filter approach silently emptied results when relevant matches sat
// outside `period` (default 30d) and could not bubble through.
// Recall is history-first: archived roots hold most prior work. Callers
// that need only live invariants can pass includeArchived:false.
async function retrieveCandidates(db, plan, args, queryVector) {
  const { retrievalQuery, temporal, projectScope, category, excludeStatuses, limit, offset } = plan;
  const retrievalLimit = Math.max(limit + offset, Math.min(RECALL_LIMIT_CAP, (limit + offset) * 3));
  const searchOptions = {
    limit: retrievalLimit,
    queryVector: Array.isArray(queryVector) ? queryVector : null,
    includeMembers: plan.structuredTimeMode ? false : plan.includeMembers,
    ts_from: temporal?.startMs,
    ts_to: temporal?.endMs,
    projectScope,
    category,
    excludeStatuses,
    latestByConcept: plan.latestIntent && args.period == null,
  };
  const windowRootFilters = {
    is_root: true,
    ts_from: temporal?.startMs,
    ts_to: temporal?.endMs,
    projectScope,
    category,
    excludeStatuses,
    sort: 'date',
  };
  const vagueLatestRootMode = plan.latestRootMode && hasVagueLatestWorkIntent(plan.query);
  const [results, historicalRootRows] = await Promise.all([
    vagueLatestRootMode
      ? retrieveEntries(db, { ...windowRootFilters, limit: retrievalLimit })
      : searchRelevantHybrid(db, retrievalQuery, searchOptions),
    plan.boundedHistoricalMode
      ? searchRelevantHybrid(db, retrievalQuery, {
          ...searchOptions,
          includeMembers: false,
          rootOnly: true,
        })
      : Promise.resolve([]),
  ]);
  const primaryRootCandidates = plan.deepHistoricalMode
    ? results.filter((row) => Number(row?.is_root) === 1).map((row) => ({ ...row, members: [] }))
    : [];
  let historicalRootCandidates = uniqueRowsById([...primaryRootCandidates, ...historicalRootRows]);
  const lowHistoricalResultMode = plan.deepHistoricalMode
    ? results.length <= 2
    : results.length <= 5 && historicalRootRows.length <= 2;
  if (plan.boundedHistoricalMode && lowHistoricalResultMode) {
    const windowRoots = await retrieveEntries(db, { ...windowRootFilters, limit: 50 });
    const terms = sessionRecallTerms(retrievalQuery);
    historicalRootCandidates = uniqueRowsById([...primaryRootCandidates, ...windowRoots, ...historicalRootRows]).sort(
      (a, b) =>
        topicTermCoverage(b, terms) - topicTermCoverage(a, terms) ||
        Number(b?.retrievalScore ?? b?.rrf ?? 0) - Number(a?.retrievalScore ?? a?.rrf ?? 0) ||
        compareRecallNewestFirst(a, b)
    );
  }
  return {
    results,
    retrievalLimit,
    vagueLatestRootMode,
    historicalRootCandidates,
    lowHistoricalResultMode,
    semanticOnlyRetrieval: isSemanticOnlyRecall(results),
  };
}

function orderCandidates(results, plan, vagueLatestRootMode) {
  let filtered = results;
  if (plan.sort === 'date') {
    // NaN guard — entries with null/undefined ts default to 0 so the
    // comparator stays numeric and stable.
    filtered.sort(compareRecallNewestFirst);
  } else {
    filtered.sort((a, b) => {
      const sa = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      return (
        sa(b.retrievalScore ?? b.rrf ?? 0) - sa(a.retrievalScore ?? a.rrf ?? 0) ||
        sa(b.score ?? 0) - sa(a.score ?? 0) ||
        sa(b.ts ?? 0) - sa(a.ts ?? 0) ||
        Number(a.id ?? 0) - Number(b.id ?? 0)
      );
    });
  }
  if (plan.structuredTimeMode) {
    const rootRows = filtered.filter((row) => Number(row?.is_root) === 1);
    const roots =
      plan.latestIntent && !vagueLatestRootMode
        ? rankLatestRecallRows(rootRows, plan.retrievalQuery)
        : rootRows.sort(compareRecallNewestFirst);
    const other = filtered.filter((row) => Number(row?.is_root) !== 1);
    filtered = [...roots, ...other];
  } else if (plan.latestEntityMode) {
    filtered = rankLatestRecallRows(filtered, plan.retrievalQuery);
  }
  return filtered;
}

// Raw rows (chunk_root IS NULL) carry no retrievalScore, so a naive
// append-after-hybrid under sort=importance always lands them past
// slice(offset, offset+limit) once the hybrid pool exceeds one page —
// every page beyond the first silently drops them. Fetch a wider raw
// window (bounded like the hybrid candidate pool) so every offset page
// gets its proportional share instead of only page 0. Same
// projectScope/ts window as the hybrid leg — filter parity is deliberate.
async function mergeRawWindow(db, filtered, plan, retrievalLimit, readRawRowsInWindow) {
  const { retrievalQuery, temporal, projectScope } = plan;
  const RAW_FETCH = Math.min(500, Math.max(20, retrievalLimit));
  const rawTerms = sessionRecallTerms(retrievalQuery);
  const rawRows = await readRawRowsInWindow(db, temporal?.startMs ?? null, temporal?.endMs ?? Date.now(), RAW_FETCH, {
    projectScope,
    terms: rawTerms,
  });
  const seenIds = new Set(filtered.map((r) => r.id));
  let newRaw = rawRows.filter((r) => !seenIds.has(r.id));
  // Relevance gate: readRawRowsInWindow's SQL term filter is loose
  // (minHits 1 for <3-term queries), so unscored raw rows that share a
  // single common token still get stride-interleaved into a ranked
  // result set and push real hits down the page. In the query branch,
  // keep only raw rows whose body actually contains >=1 query term.
  if (rawTerms.length > 0) {
    newRaw = newRaw.filter((r) => rawTerms.some((t) => recallSearchHaystack(r).includes(t)));
  }
  if (plan.sort === 'date') {
    for (const r of newRaw) filtered.push(r);
    filtered.sort(compareRecallNewestFirst);
    return filtered;
  }
  // The hybrid entries-table legs already rank indexed raw rows. This
  // auxiliary SQL window only backfills rows not yet present there, so
  // it must not stride unscored progress narration through ranked
  // decisions. Append it as a recall fallback after scored candidates.
  return [...filtered, ...newRaw];
}

// Promote fresh unclassified turns only when they cover more of the
// requested topic than every classified root. Vague latest-work queries
// must keep their root-only summaries, while a specific fresh setting or
// identifier can still surface before cycle1 classifies it.
function promoteLatestRawRows(filtered, plan) {
  const terms = latestRecallTopicTerms(plan.retrievalQuery);
  const rawCoverage = filtered
    .filter((row) => Number(row?.is_root) === 0 && row?.chunk_root == null)
    .reduce((max, row) => Math.max(max, topicTermCoverage(row, terms)), -1);
  const rootCoverage = filtered
    .filter((row) => Number(row?.is_root) === 1)
    .reduce((max, row) => Math.max(max, topicTermCoverage(row, terms)), -1);
  const promoteLatestRaw = rawCoverage > rootCoverage;
  return {
    promoteLatestRaw,
    filtered: promoteLatestRaw ? rankLatestRecallRows(filtered, plan.retrievalQuery) : filtered,
  };
}

async function expandAndBound(db, filtered, plan, candidates, promoteLatestRaw) {
  const { retrievalQuery, temporal, projectScope, category, excludeStatuses, latestIntent } = plan;
  const { retrievalLimit, historicalRootCandidates, lowHistoricalResultMode } = candidates;
  if (plan.sort !== 'date' && plan.includeRaw && (!plan.structuredTimeMode || promoteLatestRaw)) {
    const latestConceptRows = latestIntent ? filtered.filter((row) => row?._conceptExpanded === true) : [];
    filtered = await expandRecallEventContext(db, filtered, {
      query: retrievalQuery,
      limit: retrievalLimit,
      tsFrom: temporal?.startMs,
      tsTo: temporal?.endMs,
      excludeStatuses,
      category,
      projectScope,
      dedupeEvents: latestIntent,
    });
    if (latestConceptRows.length > 0) {
      filtered = preserveLatestConceptRows(filtered, latestConceptRows, retrievalLimit);
    }
  }
  if (plan.boundedHistoricalMode) {
    let rootReserve = 1;
    if (plan.deepHistoricalMode) rootReserve = 6;
    else if (lowHistoricalResultMode) rootReserve = 5;
    filtered = mergeHistoricalRecallRows(filtered, historicalRootCandidates, retrievalLimit, {
      includeMatchedRootSummary: true,
      rootReserve,
    });
    if (plan.deepHistoricalMode) filtered = prioritizeHistoricalRootEvidence(filtered);
  }
  filtered = annotateRecallRootContext(filtered);
  return boundRecallRowsToTemporal(filtered, temporal);
}

function pageRows(filtered, plan) {
  // De-duplicate before pagination so member/root pairs do not consume the
  // page and then collapse into a half-empty result set.
  const deduped = collapseNearDuplicateRows(collapseHistoryDuplicates(filtered));
  let rows = plan.latestIntent ? deduped.filter((row) => row?._dupStub !== true) : deduped;
  if (plan.timelineMode) {
    const roots = rows.filter((row) => Number(row?.is_root) === 1);
    rows = sampleRecallTimeline(roots.length > 1 ? roots : rows, plan.limit + plan.offset);
  }
  return rows.slice(plan.offset, plan.offset + plan.limit);
}

// Emit a recall trace event so getTraceWithEntries() can correlate this
// search with the top-ranked memory entry. One event per search call (not
// per returned row) — cheapest meaningful link. parent_span_id left null:
// the agent-side span id is only known after the DB insert of the loop/tool
// events, which happens async on the client side and is not available here.
function recordRecallTrace(traceDb, log, query, filtered) {
  if (!traceDb || filtered.length === 0) return;
  const topHit = filtered[0];
  const topId = topHit?.id != null ? Number(topHit.id) : null;
  if (topId === null || !Number.isFinite(topId)) return;
  insertTraceEvents(traceDb, [
    {
      ts: Date.now(),
      kind: 'recall',
      entry_id: topId,
      payload: { query: query.slice(0, 200), hit_count: filtered.length },
    },
  ]).catch((e) => log(`[trace] insertTraceEvents error: ${e?.message}\n`));
}

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.args  caller args (period/latest flags are read raw)
 * @param {ReturnType<import('./query-search-plan.mjs').resolveSearchPlan>} deps.plan
 * @param {AbortSignal} [deps.signal]
 * @param {Function} deps.log
 * @param {Function} deps.embeddingOnDemandCanStart
 * @param {(embedding: object) => void} deps.noteColdRecall  throttled cold-recall log
 * @param {Function} deps.readRawRowsInWindow
 * @param {Function} deps.recallCoreRows
 * @param {object|null} deps.traceDb
 */
export async function searchByQuery({
  db,
  args,
  plan,
  signal,
  log,
  embeddingOnDemandCanStart,
  noteColdRecall,
  readRawRowsInWindow,
  recallCoreRows,
  traceDb,
}) {
  const { query, retrievalQuery, temporal, projectScope, category, sort, latestIntent } = plan;
  const _t0 = Date.now();
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const queryVector = await embedQuery(retrievalQuery, signal, { log, embeddingOnDemandCanStart, noteColdRecall });
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
  const _t1 = Date.now();
  if (debugMemory()) {
    log(`[search-time] embed=${_t1 - _t0}ms query="${retrievalQuery.slice(0, 60)}"\n`);
  }
  const candidates = await retrieveCandidates(db, plan, args, queryVector);
  const { retrievalLimit, vagueLatestRootMode } = candidates;
  let filtered = orderCandidates(candidates.results, plan, vagueLatestRootMode);
  let promoteLatestRaw = false;
  if (plan.includeRaw) {
    filtered = await mergeRawWindow(db, filtered, plan, retrievalLimit, readRawRowsInWindow);
  }
  const coreRows = plan.structuredTimeMode
    ? []
    : await recallCoreRows(retrievalQuery, {
        projectScope,
        category,
        limit: retrievalLimit,
        tsFrom: temporal?.startMs,
        tsTo: temporal?.endMs,
      });
  if (coreRows.length > 0) {
    filtered = interleaveRawRows(filtered, coreRows);
  }
  if (sort !== 'date' && latestIntent) {
    ({ promoteLatestRaw, filtered } = promoteLatestRawRows(filtered, plan));
  }
  // Core rows are prepended by relevance and carry updated_at as ts, so on
  // the chronological (date) path they'd break strict newest-first. Re-sort
  // the merged list by ts desc before slicing so the timeline stays intact.
  if (sort === 'date') {
    filtered.sort(compareRecallNewestFirst);
  }
  filtered = await expandAndBound(db, filtered, plan, candidates, promoteLatestRaw);
  const sliced = pageRows(filtered, plan);
  const _t2 = Date.now();
  if (debugMemory()) {
    log(`[search-time] hybrid+sort+raw=${_t2 - _t1}ms rows=${filtered.length} sliced=${sliced.length}\n`);
  }
  recordRecallTrace(traceDb, log, query, filtered);
  // recencyOrder render on the date path flattens roots+members into one
  // ts-desc stream so per-chunk (ts-ASC) members can't invert the timeline.
  const latestEvidenceNote =
    latestIntent && args.period == null ? 'note: latest stored evidence; no newer stored completion is implied\n' : '';
  const semanticEvidenceNote = candidates.semanticOnlyRetrieval
    ? 'note: semantic-only candidates; no lexical corroboration was found, so treat them as possible rather than confirmed evidence\n'
    : '';
  const out = {
    text:
      plan.recallCapPrefix +
      latestEvidenceNote +
      semanticEvidenceNote +
      renderEntryLines(sliced, {
        recencyOrder: sort === 'date',
        preserveSource: plan.includeMembers || plan.includeRaw,
        includeRootSource: plan.includeMembers,
        sourceWindow: temporal,
      }),
  };
  if (debugMemory()) {
    log(`[search-time] render+trace=${Date.now() - _t2}ms total=${Date.now() - _t0}ms textLen=${out.text.length}\n`);
  }
  return out;
}
