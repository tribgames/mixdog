// Raw-row (unchunked transcript turn) merge helpers shared by the recall
// browse paths: raw rows backfill what cycle1 has not chunked yet.
import { recallSearchHaystack } from './recall-format.mjs';
import { compareRecallNewestFirst } from './recall-order.mjs';

export function mergeUnseenRawRows(rows, rawRows, extraFilter) {
  const seenIds = new Set();
  for (const r of rows || []) {
    seenIds.add(Number(r.id));
    if (Array.isArray(r.members)) for (const m of r.members) seenIds.add(Number(m.id));
  }
  let newRaw = (rawRows || []).filter((r) => !seenIds.has(Number(r.id)));
  if (typeof extraFilter === 'function') newRaw = newRaw.filter(extraFilter);
  if (newRaw.length === 0) return rows;
  const merged = [...rows, ...newRaw];
  merged.sort(compareRecallNewestFirst);
  return merged;
}

export function rowMatchesQueryTerms(row, terms) {
  if (!Array.isArray(terms) || terms.length === 0) return true;
  if (terms.some((term) => recallSearchHaystack(row).includes(term))) return true;
  if (Array.isArray(row?.members)) {
    return row.members.some((member) => terms.some((term) => recallSearchHaystack(member).includes(term)));
  }
  return false;
}
