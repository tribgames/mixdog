// id mode (follow-up lookup): the caller passed `#N` markers from a prior
// recall result. Fetch those rows directly + their chunk members, bypassing
// hybrid search entirely. Output reuses renderEntryLines so the shape stays
// identical to the search path (chunk members first, root summary fallback).
import { parsePeriod, renderEntryLines } from './recall-format.mjs';
import { fetchEntriesByIdsScoped } from './memory-recall-id-patch.mjs';
import { resolveQueryProjectScope } from './query-search-plan.mjs';

async function attachRootMembers(db, rows) {
  const rootIds = rows.filter((r) => r.is_root === 1).map((r) => Number(r.id));
  const memberLeafIds = new Set();
  if (rootIds.length === 0) return memberLeafIds;
  const { rows: memberRows } = await db.query(
    `SELECT id, ts, role, content, source_ref, session_id, source_turn, time_source, chunk_root
     FROM entries WHERE chunk_root = ANY($1::bigint[]) AND is_root = 0
     ORDER BY ts ASC, id ASC`,
    [rootIds]
  );
  const membersByRoot = new Map();
  for (const m of memberRows) {
    const k = Number(m.chunk_root);
    if (!membersByRoot.has(k)) membersByRoot.set(k, []);
    membersByRoot.get(k).push(m);
    memberLeafIds.add(Number(m.id));
  }
  for (const r of rows) {
    if (r.is_root === 1) r.members = membersByRoot.get(Number(r.id)) ?? [];
  }
  return memberLeafIds;
}

export async function searchByIds(db, args, resolveProjectScope) {
  const ids = args.ids.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
  if (ids.length === 0) return { text: '(no valid ids)' };
  const includeArchived = args.includeArchived !== false;
  const category = args.category;
  const period = String(args.period ?? '').trim() || undefined;
  const temporal = parsePeriod(period, false);
  const projectScope = resolveQueryProjectScope(args, resolveProjectScope);
  const excludeStatuses = includeArchived ? [] : ['archived'];
  const rows = await fetchEntriesByIdsScoped(db, ids, {
    ts_from: temporal?.startMs,
    ts_to: temporal?.endMs,
    excludeStatuses,
    category,
    projectScope,
  });
  if (rows.length === 0) return { text: '(no results)' };
  // Members for any root rows in the result set.
  const memberLeafIds = await attachRootMembers(db, rows);
  // Preserve caller-supplied id order; drop leaves already inlined as a
  // root's chunk member to prevent double emission when the caller names
  // a root and one of its leaves in the same batch.
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .filter((r) => !(r.is_root === 0 && memberLeafIds.has(Number(r.id))));
  return { text: renderEntryLines(ordered, { preserveSource: true, includeRootSource: true }) };
}
