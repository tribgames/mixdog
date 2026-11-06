#!/usr/bin/env node
// Genuine 1.4.5 thread list: Node's own `_sessionSummary` (store-summary-index.mjs),
// `isLeadVisibleRow` (store-summary-catalog.mjs: the catalog DB's `lead_visible`), and the catalog
// keyset helpers `byActivityThenId`, `isAfterCursor`, `encodeCatalogCursor`, `decodeCatalogCursor`
// (catalog-db/schema.mjs) over crafted session records, paged as `listStoredSessionSummaryPage`
// pages them (store-summary-reader.mjs: limit floor, 1..1000, default 50; `nextCursor` names the
// last row when more follow). The Rust `SqliteStore::lead_page` must return the same pages.
//
//   node benchmarks/rust-core/recorders/record-session-list.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/session-list/golden.json
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { _sessionSummary } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-index.mjs');
const { isLeadVisibleRow } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-catalog.mjs');
const { activityOf, byActivityThenId, decodeCatalogCursor, encodeCatalogCursor, isAfterCursor } = await importFrom(
  tree,
  'src/runtime/agent/orchestrator/session/catalog-db/schema.mjs'
);

const s = (id, extra) => ({ id, updatedAt: 1000, createdAt: 500, cwd: 'C:/w', messages: [], ...extra });
const records = [
  s('s_a', { title: 'first', updatedAt: 3000 }),
  s('s_b', { title: 'second', updatedAt: 3000 }), // ties s_a on activity: id order
  s('s_c', { title: 'used later', updatedAt: 1000, lastUsedAt: 5000 }),
  s('s_d', { title: 'cli', sourceType: 'cli', updatedAt: 2500 }),
  s('s_e', { title: 'exec run', sourceType: 'exec', updatedAt: 2600 }), // exec: hidden
  s('s_f', { title: 'schedule', sourceType: 'schedule', updatedAt: 2400 }),
  s('s_g', { title: 'webhook', sourceType: 'webhook', updatedAt: 2300 }),
  s('s_h', { title: 'by a bot', sourceType: 'bot', sourceName: 'newsbot', updatedAt: 2200 }), // not lead shaped
  s('s_i', { title: 'worker', owner: 'agent', agent: 'worker', ownerSessionId: 's_a', updatedAt: 2100 }), // agent session: listed
  s('s_j', { title: 'foreign owner', owner: 'importer', updatedAt: 2000 }), // owner not visible
  s('s_k', { updatedAt: 1900 }), // no preview, no messages, no title: scratch
  s('s_l', { title: 'lead', agent: 'lead', updatedAt: 1800 }),
  s('s_m', { title: 'lead with a self link', agent: 'lead', ownerSessionId: 's_m', owner: 'agent', updatedAt: 1700 }),
  s('s_n', { messages: [{ role: 'user', content: 'hello there' }], updatedAt: 1600 }), // previewed
  s('s_o', { title: 'declared agent-only', visibility: 'agent-only', updatedAt: 1500 }),
  s('s_p', { title: 'mixed case owner', owner: ' User ', updatedAt: 1400 }),
];
const sessions = records.map((record) => {
  const summary = _sessionSummary(record);
  return { record, summary, leadVisible: isLeadVisibleRow(summary), activity: activityOf(summary) };
});

// Paged sessions are header-only: the Rust index derives a list row's preview and message count from the
// message log, which a header-only upsert has none of (the predicate is tested on every summary above).
const ordered = sessions.filter((entry) => entry.leadVisible && entry.record.messages.length === 0).map((entry) => entry.summary).sort(byActivityThenId);
const page = (limit, cursor) => {
  const requested = Math.floor(Number(limit));
  const size = requested > 0 ? Math.min(requested, 1000) : 50;
  const after = decodeCatalogCursor(cursor);
  const rest = ordered.filter((row) => isAfterCursor(row, after));
  const rows = rest.slice(0, size);
  return { ids: rows.map((row) => row.id), nextCursor: rest.length > size ? encodeCatalogCursor(rows.at(-1)) : null };
};
const walks = [];
for (const limit of [1, 2, 3, 5, 100, undefined, 0, -4, 2.9, 5000]) {
  const pages = [];
  let cursor = null;
  do {
    const answer = page(limit, cursor);
    pages.push({ cursor, ...answer });
    cursor = answer.nextCursor;
  } while (cursor);
  walks.push({ limit: limit ?? null, pages });
}
const cursors = ['', null, 'bm90IGpzb24', encodeCatalogCursor({ id: 'x', updatedAt: 7 }), Buffer.from('[1,2]').toString('base64url'), Buffer.from('["a","b"]').toString('base64url'), Buffer.from('[5]').toString('base64url'), '!!!'].map((cursor) => {
  try {
    return { cursor, decoded: decodeCatalogCursor(cursor) };
  } catch (error) {
    return { cursor, error: error.code };
  }
});

const finalOut = join(FIXTURES_ROOT, 'session-list');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: '_sessionSummary + isLeadVisibleRow + the catalog keyset helpers over crafted records, paged as listStoredSessionSummaryPage pages (limit rules, nextCursor)',
  sessions,
  walks,
  cursors,
});
writeSetManifest(out, {
  set: 'session-list',
  recorder: 'benchmarks/rust-core/recorders/record-session-list.mjs',
  command: 'node benchmarks/rust-core/recorders/record-session-list.mjs --tree <tree>',
  extra: { sessions: sessions.length, walks: walks.length },
});
commitStage(out, finalOut);
console.log(`sessions=${sessions.length} leadVisible=${ordered.length} walks=${walks.length}`);
