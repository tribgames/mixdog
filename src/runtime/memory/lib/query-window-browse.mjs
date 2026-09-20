// Generic browse: a query-less recall inside a time window (or the default
// window), newest-first, grouped per session when the page spans several.
import { renderSessionGroupedLines } from './recall-format.mjs';
import { retrieveEntries } from './memory-retrievers.mjs';
import { RECALL_WINDOW_CAP } from './recall-limits.mjs';
import { mergeUnseenRawRows } from './query-raw-merge.mjs';
import { readRawRowsInWindow } from './query-raw-window.mjs';

function browseFilters(plan) {
  const { limit, offset, temporal, projectScope, category, sort, includeArchived, includeMembers } = plan;
  const filters = { limit: limit + offset };
  if (temporal?.startMs != null) {
    filters.ts_from = temporal.startMs;
    filters.ts_to = temporal.endMs;
  }
  filters.projectScope = projectScope;
  if (category != null) filters.category = category;
  filters.sort = sort;
  if (!includeArchived) filters.excludeStatuses = ['archived'];
  if (includeMembers) filters.includeMembers = true;
  return filters;
}

export async function browseEntries(db, args, plan) {
  const { limit, offset, temporal, projectScope, sort, includeMembers, includeRaw } = plan;
  const filters = browseFilters(plan);
  const rows = await retrieveEntries(db, filters);
  // Recent-browsing raw merge: a query-less recall must show the freshest
  // turns even when cycle1 hasn't chunked them yet. Roots lag ingest by up
  // to a cycle interval, so on sort=date pull the raw (unchunked) window
  // too and merge chronologically — original text first, no summaries.
  // Query-less + includeRaw:false callers keep the roots-only view.
  let merged = rows;
  if (sort === 'date' && includeRaw) {
    const rawRows = await readRawRowsInWindow(
      db,
      filters.ts_from ?? temporal?.startMs ?? null,
      filters.ts_to ?? temporal?.endMs ?? Date.now(),
      Math.min(RECALL_WINDOW_CAP, Math.max(20, limit + offset)),
      { projectScope }
    );
    // Drop raw leaves already inlined as some returned root's member.
    merged = mergeUnseenRawRows(rows, rawRows);
  }
  const sliced = merged.slice(offset, offset + limit);
  // Multi-session grouping: a GLOBAL query-less browse ("recent work") spans
  // sessions — render grouped per session (newest activity first) with the
  // caller's own session marked "(current)" via the currentSessionId hint.
  // Falls through to the flat list when everything is one session.
  // recencyOrder on the date path: without it, chunk members (stored ts-ASC
  // per root) interleave out of order with raw rows inside each session
  // group (e.g. 04:33 rendered above 04:41).
  return {
    text:
      plan.recallCapPrefix +
      renderSessionGroupedLines(sliced, {
        currentSessionId: String(args?.currentSessionId || '').trim(),
        recencyOrder: sort === 'date',
        preserveSource: includeMembers || includeRaw,
        includeRootSource: includeMembers,
      }),
  };
}
