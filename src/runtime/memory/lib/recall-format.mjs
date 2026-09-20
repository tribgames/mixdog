import { cleanMemoryText } from './memory.mjs';
import { formatRecallTimestamp, localTimestampParts } from '../../shared/time-format.mjs';
import { compareRecallNewestFirst, compareRecallOldestFirst } from './recall-order.mjs';
import { tokenizeRecallQuery } from './memory-text-utils.mjs';
import { memberTsInWindow } from './recall-scoring.mjs';

// Recall query/format helpers. Pure string/date logic plus row rendering.

// Calendar-day windows: 'today' anchors at local midnight rather than
// rolling 24h. Without this, a query asking 'today' at 01:30 would silently
// include yesterday's last 22.5h of activity, mislabelling them as
// 'today's work'. 'yesterday' is the previous calendar day.
function calendarDayWindow(period) {
  if (period === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { startMs: start.getTime(), endMs: Date.now() };
  }
  if (period !== 'yesterday') return null;
  const start = new Date();
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

// R6 P9: calendar Mon-Sun previous/current week. Mon-start ISO convention.
// Replaces R5 rolling 7-14d range which was empty for sessions where "last
// week" decisions actually fell on Mon (4/27) of this week. Precise calendar
// bounds match natural-language intuition.
function calendarWeekWindow(period) {
  if (period !== 'this_week' && period !== 'last_week') return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const daysSinceMon = (d.getDay() + 6) % 7;
  const thisWeekMon = new Date(d);
  thisWeekMon.setDate(d.getDate() - daysSinceMon);
  if (period === 'this_week') return { startMs: thisWeekMon.getTime(), endMs: Date.now() };
  const lastWeekMon = new Date(thisWeekMon);
  lastWeekMon.setDate(thisWeekMon.getDate() - 7);
  const lastWeekSunEnd = new Date(thisWeekMon.getTime() - 1);
  return { startMs: lastWeekMon.getTime(), endMs: lastWeekSunEnd.getTime() };
}

// Rolling 'Nm' / 'Nh' / 'Nd' windows ending now. Minute granularity is for
// "resume from the previous turn / pick up where we left off" style recall —
// sub-hour windows where 1h is too coarse. n=0 is a zero-width window that
// returns no rows; left as a caller-supplied no-op.
function rollingWindow(period) {
  const relMatch = period.match(/^(\d+)(m|h|d)$/);
  if (!relMatch) return null;
  const n = parseInt(relMatch[1], 10);
  const unit = relMatch[2];
  const now = new Date();
  if (unit === 'm') return { startMs: now.getTime() - n * 60_000, endMs: now.getTime() };
  if (unit === 'h') return { startMs: now.getTime() - n * 3600_000, endMs: now.getTime() };
  const start = new Date(now);
  start.setDate(start.getDate() - n);
  return { startMs: start.getTime(), endMs: now.getTime() };
}

function dateRangeWindow(period) {
  const rangeMatch = period.match(/^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$/);
  if (!rangeMatch) return null;
  return {
    startMs: Date.parse(`${rangeMatch[1]}T00:00:00`),
    endMs: Date.parse(`${rangeMatch[2]}T23:59:59.999`),
  };
}

// Time-of-day windows: 'HH:MM~HH:MM' (today) or 'YYYY-MM-DD HH:MM~HH:MM'
// (specific day). Covers "this afternoon 12:00-14:00" style recall that the
// day-granular date/range forms cannot express. End is inclusive to the
// minute (:59.999). An end at or before start is an invalid window (null)
// rather than a guessed overnight wrap.
function timeOfDayWindow(period) {
  const todMatch = period.match(/^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})$/);
  if (!todMatch) return null;
  const [, day, h1, m1, h2, m2] = todMatch;
  const base = day ? new Date(`${day}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  const [sh, sm, eh, em] = [h1, m1, h2, m2].map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const start = new Date(base);
  start.setHours(sh, sm, 0, 0);
  const end = new Date(base);
  end.setHours(eh, em, 59, 999);
  if (end.getTime() <= start.getTime()) return null;
  return { startMs: start.getTime(), endMs: end.getTime(), exact: true };
}

function singleDayWindow(period) {
  const dateMatch = period.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (!dateMatch) return null;
  return {
    startMs: Date.parse(`${dateMatch[1]}T00:00:00`),
    endMs: Date.parse(`${dateMatch[1]}T23:59:59.999`),
    exact: true,
  };
}

// The period forms are disjoint, so the first parser that recognizes the
// text owns it — including its own invalid-window null.
const PERIOD_WINDOW_PARSERS = [
  calendarDayWindow,
  calendarWeekWindow,
  rollingWindow,
  dateRangeWindow,
  timeOfDayWindow,
  singleDayWindow,
];

export function parsePeriod(period, hasQuery) {
  if (!period && hasQuery) period = '30d';
  if (!period) return null;
  if (period === 'all') return null;
  if (period === 'last') return { mode: 'last' };
  for (const parse of PERIOD_WINDOW_PARSERS) {
    const window = parse(period);
    if (window) return window;
  }
  return null;
}

export function inferRecallPeriod(query) {
  const text = String(query ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;

  const explicitRange = text.match(/\b(\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2})\b/);
  if (explicitRange) return explicitRange[1];
  const explicitDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicitDate) return explicitDate[1];

  if (/(?:지난|저번)\s*주|last\s+week/.test(text)) return 'last_week';
  if (/이번\s*주|this\s+week/.test(text)) return 'this_week';
  if (/어제|yesterday/.test(text)) return 'yesterday';
  if (/오늘|today/.test(text)) return 'today';
  if (/방금(?:\s*전)?|just\s+now/.test(text)) return '3h';

  const koRelative = text.match(/(?:최근|지난)\s*(\d+)\s*(분|시간|일)(?:\s*(?:동안|이내|전))?/);
  if (koRelative) return `${Number(koRelative[1])}${relativeUnit(koRelative[2])}`;
  const enRelative = text.match(/(?:last|past)\s*(\d+)\s*(minutes?|hours?|days?)/);
  if (enRelative) return `${Number(enRelative[1])}${relativeUnit(enRelative[2])}`;
  return undefined;
}

function relativeUnit(word) {
  if (word === '분' || word.startsWith('minute')) return 'm';
  if (word === '시간' || word.startsWith('hour')) return 'h';
  return 'd';
}

export function formatTs(tsMs, options = {}) {
  const n = Number(tsMs);
  if (Number.isFinite(n) && n > 1e12) {
    return formatRecallTimestamp(n, options);
  }
  return String(tsMs ?? '').slice(0, 16);
}

function formatLocalMinute(tsMs) {
  const parts = localTimestampParts(Number(tsMs));
  return parts ? `${parts.date} ${parts.time.slice(0, 5)}` : String(tsMs ?? '').slice(0, 16);
}

const CORE_RECALL_STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'before',
  'check',
  'color',
  'decision',
  'decided',
  'earlier',
  'memory',
  'previous',
  'routing',
  'stored',
  'tell',
]);

export function coreRecallTerms(query) {
  return [...new Set(tokenizeRecallQuery(query, 12))]
    .filter((term) => Array.from(term).length >= 3 || /[\uAC00-\uD7AF]/u.test(term) || /[_./:-]/.test(term))
    .filter((term) => !CORE_RECALL_STOPWORDS.has(term))
    .slice(0, 8);
}

export function normalizeRecallProjectScope(projectScope) {
  const raw = String(projectScope || 'common').trim();
  if (!raw || raw.toLowerCase() === 'common') return null;
  if (raw.toLowerCase() === 'all') return '*';
  return raw;
}

export function sessionRecallTerms(query) {
  return [...new Set(tokenizeRecallQuery(query, 12))];
}

export function recallSearchHaystack(row) {
  return `${row?.content ?? ''} ${row?.element ?? ''} ${row?.summary ?? ''}`.toLowerCase();
}

function recallRoleTag(role) {
  if (role === 'user') return 'u';
  if (role === 'assistant') return 'a';
  return role || '?';
}

function historicalEventMark(row, enabled = true) {
  if (!enabled) return '';
  const rootElement = cleanMemoryText(String(row?._historicalRootElement ?? ''));
  const rootSummary = cleanMemoryText(String(row?._historicalRootSummary ?? ''));
  if (!rootElement && !rootSummary) return '';
  return ` [event: ${[rootElement, rootSummary].filter(Boolean).join(' — ')}]`;
}

function recallStandaloneBody(r, preserveSource) {
  const element = r?.element ?? '';
  const summary = r?.summary ?? '';
  if (element || summary) return `${element}${summary ? ` — ${summary}` : ''}`;
  return preserveSource || r?._compactRaw ? String(r.content ?? '') : cleanMemoryText(String(r.content ?? ''));
}

export function interleaveRawRows(hybridRows, rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) return hybridRows;
  const out = [];
  const stride = Math.max(1, Math.round(hybridRows.length / (rawRows.length + 1)));
  let rawIdx = 0;
  for (let i = 0; i < hybridRows.length; i += 1) {
    out.push(hybridRows[i]);
    if ((i + 1) % stride === 0 && rawIdx < rawRows.length) {
      out.push(rawRows[rawIdx]);
      rawIdx += 1;
    }
  }
  while (rawIdx < rawRows.length) out.push(rawRows[rawIdx++]);
  return out;
}

function isCollectedRow(row) {
  return row?.time_source === 'collected';
}

// The per-line text helpers one render call shares.
//
// compactTimestamps (compact handoff only).
//   collected row -> no stamp at all. Its ts is the ingest instant, not the
//     event time, and inside one compaction every such row carries the same
//     second, so the stamp is pure noise.
//   recorded row  -> local minute instead of the full recall stamp. Only
//     rows whose ts came from the source reach this branch, and a handoff is
//     ONE chronological session timeline, so minute precision preserves the
//     ordering a reader needs. The recall stamp spends ~78 chars restating a
//     single instant three ways (local + zone/offset + UTC) because a recall
//     answer must survive being read out of order and across zones; a
//     handoff never is. Measured on a real 759-row handoff, the full stamps
//     alone were ~59k chars / ~12k tokens of the injected context.
// The #id and row order remain in both cases. Browsable recall keeps a loose
// per-line body cap; lossless compact handoff disables it and relies on its
// strict final token budget instead.
function entryLineRenderer({ compactTimestamps, maxBodyChars }) {
  const bodyLimit =
    Number.isFinite(Number(maxBodyChars)) && Number(maxBodyChars) > 0 ? Math.floor(Number(maxBodyChars)) : null;
  return {
    stamp(row) {
      if (!compactTimestamps) return `[${formatTs(row?.ts)}] `;
      return isCollectedRow(row) ? '' : `[${formatLocalMinute(row?.ts)}] `;
    },
    boundBody(value) {
      const text = String(value ?? '');
      return bodyLimit == null ? text : text.slice(0, bodyLimit);
    },
    timeSourceMark(row) {
      if (isCollectedRow(row)) return compactTimestamps ? '' : ' [time=collected]';
      if (row?.time_source == null && /^(?:transcript|session):/i.test(String(row?.source_ref || ''))) {
        return ' [time=legacy; event-time=unverified]';
      }
      return '';
    },
  };
}

// One emitted line, tracked with the row identity the order comparators use.
function entryUnit(row, text) {
  return { id: row.id, ts: Number(row.ts) || 0, source_turn: row.source_turn, session_id: row.session_id, text };
}

// The root row itself joins its members when it carries source content
// inside the requested window and is not already listed among them.
function rowMembers(r, { includeRootSource, sourceWindow }) {
  const members = Array.isArray(r.members) ? r.members : [];
  const includeRoot =
    includeRootSource &&
    Number(r.is_root) === 1 &&
    memberTsInWindow(r, sourceWindow?.startMs, sourceWindow?.endMs) &&
    typeof r.content === 'string' &&
    r.content.length > 0 &&
    !members.some((member) => String(member.id) === String(r.id));
  return includeRoot ? [r, ...members] : members;
}

// Chunks present: each member is its own line. The root row is a grouping
// artifact for retrieval — the caller wants the chunk content (cycle1 raw),
// not the cycle2-compressed summary.
function memberUnits(r, members, render, preserveSource) {
  return members.map((m, memberIndex) => {
    const source = String(m.content ?? '');
    const content = render.boundBody(preserveSource ? source : cleanMemoryText(source));
    return entryUnit(
      m,
      `${render.stamp(m)}${recallRoleTag(m.role)}: ${content}${historicalEventMark(r, memberIndex === 0)}${render.timeSourceMark(m)} #${m.id}`
    );
  });
}

// No chunks (root not yet chunked by cycle1, or orphan leaf): the row itself
// in the same shape; element/summary fall back to raw content when both are
// absent. Standalone leaf rows (is_root=0, no parent chunks_root resolved
// into a `members` list) carry their u/a role just like inline chunk members
// so the format stays consistent across the two emission paths. An
// unchunked raw leaf (cycle1 hasn't classified it yet) is marked so callers
// can tell fresh-but-unprocessed rows from chunked memory.
function standaloneUnit(r, render, { preserveSource, pendingMarks }) {
  const rolePrefix = r.is_root === 0 && r.role ? `${recallRoleTag(r.role)}: ` : '';
  const body = recallStandaloneBody(r, preserveSource);
  const pendingMark = pendingMarks && r.is_root === 0 && r.chunk_root == null ? ' [pending]' : '';
  return entryUnit(
    r,
    `${render.stamp(r)}${rolePrefix}${render.boundBody(body)}${historicalEventMark(r)}${pendingMark}${render.timeSourceMark(r)} #${r.id}`
  );
}

// Every line one row contributes. A collapsed near-duplicate (search path
// only — set by collapseNearDuplicateRows) is a one-line stub carrying its
// #id so an id-lookup follow-up can still fetch the full body; id-lookup
// output never carries _dupStub.
function rowUnits(r, render, options) {
  if (r?._dupStub) {
    return [
      entryUnit(
        r,
        `[${formatTs(r.ts)}] (near-duplicate of #${r._dupOf} — collapsed)${render.timeSourceMark(r)} #${r.id}`
      ),
    ];
  }
  if (r?._compactBody) return [entryUnit(r, String(r.summary ?? ''))];
  const members = rowMembers(r, options);
  if (members.length > 0) return memberUnits(r, members, render, options.preserveSource);
  return [standaloneUnit(r, render, options)];
}

export function renderEntryLines(
  rows,
  {
    recencyOrder = false,
    chronologicalOrder = false,
    pendingMarks = true,
    maxBodyChars = 8000,
    compactTimestamps = false,
    preserveSource = false,
    includeRootSource = false,
    sourceWindow = null,
  } = {}
) {
  if (!rows || rows.length === 0) return '(no results)';
  const render = entryLineRenderer({ compactTimestamps, maxBodyChars });
  const options = { pendingMarks, preserveSource, includeRootSource, sourceWindow };
  // Each emitted line is tracked as a { ts, text } unit so the recencyOrder
  // path can sort the WHOLE stream (roots + their members, plus leaf/raw rows)
  // strictly newest-first. Members are fetched ts-ASC per chunk, so without
  // this global re-sort a multi-member chunk would emit oldest-first lines and
  // break a strict newest-first contract (bench: recency-today). No
  // line-count cap here: the orchestrator enforces a global tool-output KB
  // cap (builtin.mjs tool_output_token_limit), so recall need not
  // self-truncate.
  const units = rows.flatMap((r) => rowUnits(r, render, options));
  if (chronologicalOrder) {
    units.sort(compareRecallOldestFirst);
  } else if (recencyOrder) {
    units.sort(compareRecallNewestFirst);
  }
  return units.map((u) => u.text).join('\n');
}

// Search-result de-duplication. Within a SINGLE formatted result set, hybrid
// recall frequently returns several long rows that restate the same design in
// slightly different words (e.g. a root summary plus a chunk that paraphrases
// it). They each spend a large slice of the envelope on near-identical text.
// Cheap heuristic (no embeddings): normalize each row's body to word tokens,
// build 3-gram shingle sets, and measure containment overlap = |A∩B| /
// min(|A|,|B|) against already-kept rows. Rows arrive rank/date-ordered, so the
// FIRST occurrence is the newest/highest-ranked and is kept full; a later
// high-overlap row is dropped (near-total) or rendered as an id-stub.
//   - drop  when overlap >= DROP_OVERLAP (0.9): body adds nothing.
//   - stub  when overlap >= STUB_OVERLAP (0.65): keep the #id reachable.
// Short bodies (< MIN_TOKENS words) are never collapsed — they can't carry
// enough signal for the overlap metric to be meaningful and are cheap anyway.
// Applies to search results only; id-lookup output must never call this.
function normalizedRowText(r) {
  if (Array.isArray(r?.members) && r.members.length > 0) {
    return r.members
      .map((m) => cleanMemoryText(String(m.content ?? '')))
      .join(' ')
      .toLowerCase();
  }
  const element = r?.element ?? '';
  const summary = r?.summary ?? '';
  const body = element || summary ? `${element} ${summary}` : cleanMemoryText(String(r?.content ?? ''));
  return String(body).toLowerCase();
}

function exactDuplicateKey(r) {
  if (Array.isArray(r?.members) && r.members.length > 0) {
    return JSON.stringify([
      'members',
      r.members.map((m) => [m?.role ?? '', cleanMemoryText(String(m?.content ?? ''))]),
    ]);
  }
  return JSON.stringify([r?.role ?? '', recallStandaloneBody({ ...r, _compactRaw: false })]);
}

// Legacy object-identity-only ingest could mint duplicate rows on JSON reload.
// Keep the newest/highest-ranked exact body once, including short acknowledgments
// that shingle dedupe intentionally ignores.
function collapseExactDuplicateRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = exactDuplicateKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

// Word trigram set of a row's text; null for rows too short to compare.
function rowShingles(row, minTokens) {
  const toks = normalizedRowText(row).match(/[\p{L}\p{N}_]+/gu) || [];
  if (toks.length < minTokens) return null;
  const set = new Set();
  if (toks.length < 3) {
    for (const t of toks) set.add(t);
    return set;
  }
  for (let i = 0; i + 3 <= toks.length; i += 1) set.add(`${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`);
  return set;
}

// Two metrics per kept row:
//   containment = |A∩B| / min(|A|,|B|)  — catches paraphrase/superset
//   jaccard     = |A∩B| / |A∪B|         — size-aware, immune to the
//                                         short-vs-long 1.0 false positive
// Dropping on containment alone let a short distinct UPDATE fully contained
// in a long earlier row score 1.0 and vanish. Drop only on high jaccard OR
// high containment between comparably-sized rows (size ratio >= 0.5). Stub
// stays containment-based so paraphrase restatements still collapse to a
// reachable id-stub.
function duplicateVerdict(sh, kept, dropOverlap) {
  let bestStub = 0;
  let bestStubId = null;
  let drop = false;
  for (const k of kept) {
    const [small, large] = sh.size <= k.shingles.size ? [sh, k.shingles] : [k.shingles, sh];
    let inter = 0;
    for (const g of small) if (large.has(g)) inter += 1;
    const containment = small.size ? inter / small.size : 0;
    const union = sh.size + k.shingles.size - inter;
    const jaccard = union ? inter / union : 0;
    const sizeRatio = large.size ? small.size / large.size : 0;
    if (jaccard >= 0.85 || (containment >= dropOverlap && sizeRatio >= 0.5)) drop = true;
    if (containment > bestStub) {
      bestStub = containment;
      bestStubId = k.row.id;
    }
  }
  return { drop, bestStub, bestStubId };
}

export function collapseNearDuplicateRows(rows, { stubOverlap = 0.65, dropOverlap = 0.9, minTokens = 12 } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const kept = []; // { row, shingles }
  const out = [];
  for (const r of rows) {
    const sh = rowShingles(r, minTokens);
    if (!sh) {
      out.push(r);
      continue;
    }
    const { drop, bestStub, bestStubId } = duplicateVerdict(sh, kept, dropOverlap);
    if (drop) continue;
    if (bestStub >= stubOverlap) {
      out.push({ ...r, _dupStub: true, _dupOf: bestStubId });
      continue;
    }
    kept.push({ row: r, shingles: sh });
    out.push(r);
  }
  return out;
}

// Compact handoffs are authoritative state, not browsable search output.
// Remove exact and near-duplicate bodies completely (no id stubs) so polluted
// legacy rows cannot crowd distinct recent work out of the digest.
export function compactDigestRows(rows, limit = 30) {
  const cap = Math.max(1, Math.floor(Number(limit) || 30));
  return collapseNearDuplicateRows(collapseExactDuplicateRows(rows))
    .filter((row) => !row?._dupStub)
    .slice(0, cap);
}

// Compact session label for group headers: keep short ids verbatim, shorten
// long ones to a recognizable tail (ids are typically unique in the suffix —
// timestamp/counter — not the prefix).
function shortSessionLabel(sid) {
  const s = String(sid || '').trim();
  if (s.length <= 20) return s;
  return `…${s.slice(-16)}`;
}

// Collect every ts in a session group (roots + their inline members) so the
// span header reflects the true activity window, not just the root ts.
function collectGroupTs(groupRows) {
  const all = [];
  for (const r of groupRows) {
    const t = Number(r?.ts);
    if (Number.isFinite(t)) all.push(t);
    if (Array.isArray(r?.members))
      for (const m of r.members) {
        const mt = Number(m?.ts);
        if (Number.isFinite(mt)) all.push(mt);
      }
  }
  return all;
}

// Activity-span header suffix: `(MM-DD HH:mm ~ HH:mm, n entries)`; the end keeps the
// MM-DD prefix only when it falls on a different calendar day than the start.
function spanHeaderSuffix(minTs, maxTs, n) {
  const min = formatLocalMinute(minTs); // "YYYY-MM-DD HH:mm"
  const max = formatLocalMinute(maxTs);
  const startPart = min.slice(5); // "MM-DD HH:mm"
  const endPart = min.slice(0, 10) === max.slice(0, 10) ? max.slice(11) : max.slice(5);
  return `(${startPart} ~ ${endPart}, ${n} entries)`;
}

// Session-grouped rendering for the GLOBAL query-less browse ("what did we
// work on recently") when the window spans multiple sessions. A flat ts-desc
// list interleaves sessions into one indistinguishable stream and lets one
// chatty session crowd the page; grouping keeps each work-unit readable.
// Group order = newest activity first (rows arrive ts-desc, first-seen wins).
// The caller's own session (currentSessionId hint) is marked "(current)".
// Single-session (or session-less) result sets fall through to the flat
// renderer — no headers when grouping adds nothing.
// recencyOrder (date-sorted browse) is forwarded to renderEntryLines so each
// group's lines are globally ts-desc: without it a chunk root's members (stored
// ts-ASC) interleave with raw rows and invert the visible timeline within a
// session (e.g. 04:33 rendered above 04:41).
export function renderSessionGroupedLines(
  rows,
  {
    currentSessionId,
    recencyOrder = false,
    spanHeaders = false,
    sessionMeta,
    preserveSource = false,
    includeRootSource = false,
  } = {}
) {
  const renderOptions = { recencyOrder, preserveSource, includeRootSource };
  const hasSessionMeta = spanHeaders && Number(sessionMeta?.size) > 0;
  if ((!rows || rows.length === 0) && !hasSessionMeta) return '(no results)';
  const groups = groupRowsBySession(rows, hasSessionMeta ? sessionMeta : null);
  if (!spanHeaders && groups.size <= 1) return renderEntryLines(rows, renderOptions);
  const current = String(currentSessionId || '').trim();
  const groupLabel = (sid) => {
    const mark = current && sid === current ? ' (current)' : '';
    return `${sid === '(no session)' ? sid : `session ${shortSessionLabel(sid)}`}${mark}`;
  };
  // period='last' session-grouped browse: activity-span headers over each
  // group's body. No line budget — the orchestrator's global tool-output KB
  // cap bounds total size; each group's body is already row-capped by the
  // caller.
  if (spanHeaders) {
    const parts = [];
    for (const [sid, groupRows] of groups) {
      parts.push(`## ${groupLabel(sid)}${spanGroupSuffix(groupRows, sessionMeta?.get?.(sid))}`);
      const bodyStr = renderEntryLines(groupRows, renderOptions);
      const bodyLines = bodyStr === '(no results)' ? [] : bodyStr.split('\n');
      for (const l of bodyLines) parts.push(l);
    }
    return parts.join('\n');
  }
  const parts = [];
  for (const [sid, groupRows] of groups) {
    parts.push(`## ${groupLabel(sid)}`);
    parts.push(renderEntryLines(groupRows, renderOptions));
  }
  return parts.join('\n');
}

// Rows keyed by session id, in first-seen order. Selected sessions from
// `sessionMeta` are seeded first so an entirely query-filtered session still
// reports its real activity span and filtering status.
function groupRowsBySession(rows, sessionMeta) {
  const groups = new Map();
  if (sessionMeta) {
    for (const sid of sessionMeta.keys()) groups.set(sid, []);
  }
  for (const r of rows || []) {
    const sid = String(r?.session_id || '').trim();
    const key = sid || '(no session)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

// The activity-span header suffix: the recorded session span when known,
// else the rows' own timestamp range, else just the entry count.
function spanGroupSuffix(groupRows, meta) {
  const tsAll = collectGroupTs(groupRows);
  const minTs = Number(meta?.minTs);
  const maxTs = Number(meta?.maxTs);
  let suffix = ` (${groupRows.length} entries)`;
  if (Number.isFinite(minTs) && Number.isFinite(maxTs)) {
    suffix = ` ${spanHeaderSuffix(minTs, maxTs, groupRows.length)}`;
  } else if (tsAll.length) {
    suffix = ` ${spanHeaderSuffix(Math.min(...tsAll), Math.max(...tsAll), groupRows.length)}`;
  }
  const filterNote = meta?.queryFiltered ? ` · query-filtered ${meta.shownCount}/${meta.fetchedCount} rows` : '';
  return `${suffix}${filterNote}`;
}
