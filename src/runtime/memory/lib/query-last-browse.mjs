// period='last': session-grouped browse. Pick the N most-recently-active
// sessions (limit = session count, default 5; offset = session-level paging)
// ranked by MAX(ts) DESC, then fill each with its newest rows under a
// per-session row cap. Session selection and per-session fetch reuse the same
// projectScope / excludeStatuses filters as the generic browse; the grouped
// renderer adds activity-span headers. Output size is bounded by session
// count x per-session row cap plus the orchestrator-level tool-output KB cap
// — no recall-local line budget.
import { renderSessionGroupedLines, sessionRecallTerms } from './recall-format.mjs';
import { retrieveEntries } from './memory-retrievers.mjs';
import { VALID_CATEGORY, projectScopePredicate } from './memory-recall-scope-filter.mjs';
import { decodeRecallPageCursor, encodeRecallPageCursor } from './recall-page-cursor.mjs';
import { mergeUnseenRawRows, rowMatchesQueryTerms } from './query-raw-merge.mjs';

const PER_SESSION_ROW_CAP = 10;
const PER_SESSION_SEARCH_CAP = 50;

function requestedCategoryList(category) {
  let categoryValues = [];
  if (Array.isArray(category)) categoryValues = category;
  else if (category != null) categoryValues = [category];
  const requestedCats = [
    ...new Set(categoryValues.map((c) => String(c).trim().toLowerCase()).filter((c) => VALID_CATEGORY.has(c))),
  ];
  // Asking for every public category is semantically unfiltered. Keeping
  // it as a restrictive filter drops fresh unclassified raw turns before
  // cycle1 assigns a category, which can hide the immediately prior chat.
  return requestedCats.length === VALID_CATEGORY.size ? [] : requestedCats;
}

// 1) Rank sessions by the timestamps the renderer actually exposes.
//    A root with members renders those members instead of its own ts, so
//    ranking by root MAX(ts) can disagree with the visible group head and
//    invert adjacent sessions/pages. Roots without members and raw leaves
//    keep their own ts. Scope and status filters match the fill below.
function sessionSelectionWhere({ includeRaw, projectScope, catList, excludeStatuses }) {
  const selWhere = [
    'e.session_id IS NOT NULL',
    "btrim(e.session_id) <> ''",
    includeRaw ? '(e.is_root = 1 OR e.chunk_root IS NULL OR e.chunk_root = e.id)' : 'e.is_root = 1',
  ];
  const selParams = [];
  const scopePred = projectScopePredicate(
    typeof projectScope === 'string' ? projectScope : undefined,
    selParams.length + 1,
    { column: 'e.project_id' }
  );
  if (scopePred.clause) {
    selWhere.push(scopePred.clause);
    selParams.push(...scopePred.params);
  }
  if (catList.length > 0) {
    const ph = catList
      .map((c) => {
        selParams.push(c);
        return `$${selParams.length}`;
      })
      .join(',');
    selWhere.push(`lower(coalesce(e.category, '')) IN (${ph})`);
  }
  if (excludeStatuses.length > 0) {
    const ph = excludeStatuses
      .map((s) => {
        selParams.push(s);
        return `$${selParams.length}`;
      })
      .join(',');
    selWhere.push(`(e.status IS NULL OR e.status NOT IN (${ph}))`);
  }
  return { selWhere, selParams };
}

async function selectSessionPage(db, plan, args, { sessionCount, catList, cursorContext }) {
  const { includeMembers, includeRaw, projectScope, excludeStatuses, offset } = plan;
  const { selWhere, selParams } = sessionSelectionWhere({ includeRaw, projectScope, catList, excludeStatuses });
  const pageCursor = args.cursor ? decodeRecallPageCursor(args.cursor, cursorContext) : null;
  // Deterministic tie-breaker: equal visible activity timestamps use
  // session_id DESC. The cursor carries that exact pair, so newly-created
  // sessions ahead of page 1 cannot shift page 2.
  const visibleFirstTs = includeMembers
    ? `CASE WHEN e.is_root = 1
                              THEN coalesce(member_span.first_ts, e.ts)
                              ELSE e.ts END`
    : 'e.ts';
  const visibleLastTs = includeMembers
    ? `CASE WHEN e.is_root = 1
                             THEN coalesce(member_span.last_ts, e.ts)
                             ELSE e.ts END`
    : 'e.ts';
  let cursorHaving = '';
  if (pageCursor) {
    selParams.push(pageCursor.lastTs, pageCursor.sessionId);
    const tsParam = `$${selParams.length - 1}`;
    const sidParam = `$${selParams.length}`;
    cursorHaving = `HAVING (MAX(${visibleLastTs}) < ${tsParam}
                          OR (MAX(${visibleLastTs}) = ${tsParam} AND e.session_id < ${sidParam}))`;
  }
  const fetchSessionCount = sessionCount + 1;
  selParams.push(fetchSessionCount, pageCursor ? 0 : offset);
  const sessSql = `SELECT e.session_id,
                              MIN(${visibleFirstTs}) AS first_ts,
                              MAX(${visibleLastTs}) AS last_ts
                       FROM entries e
                       LEFT JOIN LATERAL (
                         SELECT MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts
                         FROM entries m
                         WHERE e.is_root = 1 AND m.is_root = 0 AND m.chunk_root = e.id
                       ) member_span ON true
                       WHERE ${selWhere.join(' AND ')}
                       GROUP BY e.session_id
                       ${cursorHaving}
                       ORDER BY last_ts DESC, e.session_id DESC
                       LIMIT $${selParams.length - 1} OFFSET $${selParams.length}`;
  const selectedSessionRows = (await db.query(sessSql, selParams)).rows;
  const hasMoreSessions = selectedSessionRows.length > sessionCount;
  const sessRows = selectedSessionRows.slice(0, sessionCount);
  const lastSession = sessRows.at(-1);
  const nextCursor =
    hasMoreSessions && lastSession
      ? encodeRecallPageCursor({
          lastTs: Number(lastSession.last_ts),
          sessionId: lastSession.session_id,
          context: cursorContext,
        })
      : null;
  return { sessRows, nextCursor };
}

async function sessionRawRows(db, readRawRowsInWindow, { sid, projectScope, queryTerms, perSessionFetchCap }) {
  if (queryTerms.length === 0) {
    return readRawRowsInWindow(db, null, Date.now(), perSessionFetchCap, { projectScope, sessionId: sid, terms: [] });
  }
  // Keep a full unfiltered recency window for the newest-row floor,
  // while separately retaining the deeper term-matched raw window.
  const [recentRawRows, matchedRawRows] = await Promise.all([
    readRawRowsInWindow(db, null, Date.now(), perSessionFetchCap, {
      projectScope,
      sessionId: sid,
      terms: [],
    }),
    readRawRowsInWindow(db, null, Date.now(), perSessionFetchCap, {
      projectScope,
      sessionId: sid,
      terms: queryTerms,
      minHits: 1,
    }),
  ]);
  const rawIds = new Set();
  return [...recentRawRows, ...matchedRawRows].filter((r) => {
    const id = Number(r.id);
    if (rawIds.has(id)) return false;
    rawIds.add(id);
    return true;
  });
}

// readRawRowsInWindow carries no category/status filter, so a
// category-scoped last and includeArchived:false browse must gate raw rows
// to match the ranking/fill predicates.
const rawRowPassesFilters = (catList, excludeStatuses) => (r) => {
  if (
    catList.length > 0 &&
    !catList.includes(
      String(r.category || '')
        .trim()
        .toLowerCase()
    )
  )
    return false;
  if (excludeStatuses.length > 0) {
    const st = String(r.status || '')
      .trim()
      .toLowerCase();
    if (st && excludeStatuses.includes(st)) return false;
  }
  return true;
};

// 2) per selected session, fetch its newest rows (roots+members, sort by
//    date) plus the fresh raw window, capped at PER_SESSION_ROW_CAP.
async function fillSession(db, readRawRowsInWindow, plan, { sid, queryTerms, catList }) {
  const { includeMembers, includeRaw, projectScope, excludeStatuses } = plan;
  const perSessionFetchCap = queryTerms.length > 0 ? PER_SESSION_SEARCH_CAP : PER_SESSION_ROW_CAP;
  const sf = { limit: perSessionFetchCap, session_id: sid, projectScope, sort: 'date' };
  if (includeMembers) sf.includeMembers = true;
  if (excludeStatuses.length > 0) sf.excludeStatuses = excludeStatuses;
  if (catList.length > 0) sf.category = catList;
  const sRows = await retrieveEntries(db, sf);
  let merged = sRows;
  if (includeRaw) {
    const rawRows = await sessionRawRows(db, readRawRowsInWindow, {
      sid,
      projectScope,
      queryTerms,
      perSessionFetchCap,
    });
    merged = mergeUnseenRawRows(sRows, rawRows, rawRowPassesFilters(catList, excludeStatuses));
  }
  const fetchedCount = merged.length;
  let queryFiltered = false;
  if (queryTerms.length > 0) {
    const newestRows = merged.slice(0, 3);
    const newestIds = new Set(newestRows.map((r) => r.id));
    const matchedRows = merged.filter((row) => rowMatchesQueryTerms(row, queryTerms));
    // A topic query must not obscure a session's latest activity: keep
    // its three newest rows, then use term matches for the remaining
    // display slots without duplicating rows already kept for recency.
    merged = [...newestRows, ...matchedRows.filter((r) => !newestIds.has(r.id))];
    // Only mark query filtering when its floor+match union actually
    // excludes fetched rows. The later display cap is independent.
    queryFiltered = merged.length < fetchedCount;
  }
  merged = merged.slice(0, PER_SESSION_ROW_CAP);
  return { rows: merged, fetchedCount, queryFiltered };
}

export async function browseLastSessions({ db, args, plan, readRawRowsInWindow }) {
  const { query, requestedLimit, limit, includeMembers, includeRaw, includeArchived, projectScope } = plan;
  const sessionCount = Number.isFinite(requestedLimit) ? limit : 5;
  const queryTerms = sessionRecallTerms(query);
  const catList = requestedCategoryList(plan.category);
  const cursorContext = {
    query,
    projectScope,
    categories: catList,
    includeArchived,
    includeMembers,
    includeRaw,
  };
  const { sessRows, nextCursor } = await selectSessionPage(db, plan, args, { sessionCount, catList, cursorContext });
  const allRows = [];
  const sessionMeta = new Map();
  for (const s of sessRows) {
    const sid = String(s?.session_id || '').trim();
    if (!sid) continue;
    const { rows, fetchedCount, queryFiltered } = await fillSession(db, readRawRowsInWindow, plan, {
      sid,
      queryTerms,
      catList,
    });
    sessionMeta.set(sid, {
      minTs: Number(s.first_ts),
      maxTs: Number(s.last_ts),
      fetchedCount,
      shownCount: rows.length,
      queryFiltered,
    });
    for (const r of rows) allRows.push(r);
  }
  const _currentSessionHint = String(args?.currentSessionId || '').trim();
  const cursorPrefix = nextCursor ? `[nextCursor: ${nextCursor}]\n` : '';
  return {
    text:
      plan.recallCapPrefix +
      cursorPrefix +
      renderSessionGroupedLines(allRows, {
        currentSessionId: _currentSessionHint,
        recencyOrder: true,
        spanHeaders: true,
        sessionMeta,
        preserveSource: includeMembers || includeRaw,
        includeRootSource: includeMembers,
      }),
    nextCursor,
  };
}
