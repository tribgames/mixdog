#!/usr/bin/env node
// The catalog the `session` tool lists through, recorded from Node's REAL code over a seeded data directory (the other recorders,
// session-control-cases and session-tool-control, script this seam: their catalog rows and cursors are the recorder's own input).
// The sessions are written as records under `<data dir>/sessions/`; then:
//  - `createStoredSessionViews(...).listSessions({ page })` (daemon-stored-session-views.mjs), over the real
//    `listStoredSessionSummaryPage` (store-summary-reader.mjs: the JSON path, as this process keeps no catalog DB), is walked page by
//    page for several page sizes, idle and with turns in flight (`runtimeState`, whose `inFlightSessionActivity()` is recorded);
//  - the same listing is asked for each malformed and each well-formed foreign cursor;
//  - `readStoredSessionCatalogRow(id)` is read for every seeded id, an unknown id and an exec run;
//  - the desktop's archived flags are the sidebar host's `state()` (`readSessionSidebarState`), the flags of the sessions whose record
//    carries `archivedAt` (the core keeps that flag in the store's index beside the row).
//
//   node benchmarks/rust-core/recorders/record-session-listing.mjs --tree <git export of b6f10295a with node_modules>
// Output: native/core/fixtures/session-listing/golden.json
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'session-listing-')));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const common = await import('./lib/common.mjs');
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = common;
const { recorderProvenance } = await import('./lib/provenance.mjs');

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const { listStoredSessionSummaryPage, readStoredSessionCatalogRow } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
const { createStoredSessionViews } = await importFrom(tree, 'src/standalone/daemon-stored-session-views.mjs');
const { inFlightSessionActivity, runtimeState } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/runtime-state.mjs');
const { encodeCatalogCursor } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/catalog-db/schema.mjs');
const { registerSessionSidebarHost, readSessionSidebarState } = await importFrom(tree, 'src/runtime/shared/session-sidebar-host.mjs');

const s = (id, extra) => ({ id, updatedAt: 1000, createdAt: 500, cwd: 'C:/w', messages: [], ...extra });
const records = [
  s('s_a', { title: 'first', updatedAt: 3000 }),
  s('s_b', { title: 'second', updatedAt: 3000 }), // ties s_a on activity: id order
  s('s_c', { title: 'used later', updatedAt: 1000, lastUsedAt: 5000, archivedAt: 5100 }), // archived
  s('s_d', { title: 'cli', sourceType: 'cli', updatedAt: 2500 }),
  s('s_e', { title: 'exec run', sourceType: 'exec', updatedAt: 2600 }), // exec: hidden
  s('s_f', { title: 'schedule', sourceType: 'schedule', updatedAt: 2400 }),
  s('s_g', { title: 'webhook', sourceType: 'webhook', updatedAt: 2300 }),
  s('s_h', { title: 'by a bot', sourceType: 'bot', sourceName: 'newsbot', updatedAt: 2200 }), // not lead shaped
  s('s_i', { title: 'worker', owner: 'agent', agent: 'worker', ownerSessionId: 's_a', updatedAt: 2100 }), // agent session: listed
  s('s_j', { title: 'foreign owner', owner: 'importer', updatedAt: 2000 }), // owner not visible
  s('s_k', { updatedAt: 1900 }), // no title, nothing: scratch
  s('s_l', { title: 'lead', agent: 'lead', updatedAt: 1800 }),
  s('s_m', { title: 'lead with a self link', agent: 'lead', ownerSessionId: 's_m', owner: 'agent', updatedAt: 1700 }),
  s('s_n', { title: 'named', updatedAt: 1600, archivedAt: 1650 }), // archived
  s('s_o', { title: 'declared agent-only', visibility: 'agent-only', updatedAt: 1500 }),
  s('s_p', { title: 'mixed case owner', owner: ' User ', updatedAt: 1400 }),
];
const sessionsDir = join(process.env.MIXDOG_DATA_DIR, 'sessions');
mkdirSync(sessionsDir, { recursive: true });
// A record younger than the catalog's racy window is never trusted: stamp every file in a fixed past (the row's storageMtimeMs).
const past = new Date('2026-01-01T00:00:00Z');
for (const record of records) {
  const file = join(sessionsDir, `${record.id}.json`);
  writeFileSync(file, JSON.stringify(record));
  utimesSync(file, past, past);
}

const archived = Object.fromEntries(records.filter((record) => record.archivedAt > 0).map((record) => [record.id, record.archivedAt]));
registerSessionSidebarHost(async () => {}, { state: async () => ({ archived }) });
const sidebar = (await readSessionSidebarState()).archived;

const views = createStoredSessionViews({
  desktopRuntime: { loadSessionStore: async () => ({ listStoredSessionSummaryPage, listStoredSessionSummariesAsync: async () => [] }) },
  dataDir: process.env.MIXDOG_DATA_DIR,
});
// What the service asks of the listing: a page, `includeAgentOnly: false`.
const listed = (cursor, limit) => views.listSessions({ page: { limit, cursor }, includeAgentOnly: false });
const walk = async (limit) => {
  const pages = [];
  let cursor = null;
  do {
    const page = await listed(cursor, limit);
    pages.push({ cursor, sessions: page.sessions, nextCursor: page.nextCursor });
    cursor = page.nextCursor;
  } while (cursor);
  return { limit, pages };
};
const limits = [1, 2, 3, 5, 100];
const idle = [];
for (const limit of limits) idle.push(await walk(limit));

const cursors = [];
const foreign = [null, '', '!!!', 'bm90IGpzb24', Buffer.from('[1,2]').toString('base64url'), Buffer.from('["a","b"]').toString('base64url'), Buffer.from('[5]').toString('base64url'), encodeCatalogCursor({ id: 'x', updatedAt: 7 }), encodeCatalogCursor({ id: 's_a', updatedAt: 3000 }), encodeCatalogCursor({ id: 'earlier', updatedAt: 99999 })];
for (const cursor of foreign) {
  try {
    const page = await listed(cursor, 3);
    cursors.push({ cursor, limit: 3, sessions: page.sessions, nextCursor: page.nextCursor });
  } catch (error) {
    cursors.push({ cursor, limit: 3, threw: { message: error.message, code: error.code } });
  }
}

const rows = [...records.map((record) => record.id), 'sess_absent'].map((id) => ({ id, row: readStoredSessionCatalogRow(id) }));

// Turns in flight: s_b runs its own turn; the worker s_i (owner agent, owner session s_a) runs one, which makes its Lead s_a work.
runtimeState.set('s_b', { stage: 'streaming', session: records[1] });
runtimeState.set('s_i', { stage: 'tool_running', session: records[8] });
const { working, agentWorking } = inFlightSessionActivity();
const live = { working: [...working].sort(), agentWorking: [...agentWorking].sort() };
const liveWalks = [];
for (const limit of [2, 5]) liveWalks.push(await walk(limit));

const finalDir = join(FIXTURES_ROOT, 'session-listing');
const out = stageSet(finalDir);
writeJson(join(out, 'golden.json'), {
  note: "Node's real listing over seeded session records: the daemon's listSessions({ page }) walked, malformed and foreign cursors, readStoredSessionCatalogRow by id, the sidebar's archived flags and the turns in flight",
  sessions: records,
  archived: Object.keys(sidebar).sort(),
  walks: idle,
  cursors,
  rows,
  live,
  liveWalks,
});
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
writeSetManifest(out, {
  set: 'session-listing',
  recorder: 'benchmarks/rust-core/recorders/record-session-listing.mjs',
  command: `node benchmarks/rust-core/recorders/record-session-listing.mjs --tree <export of ${NODE_COMMIT} with node_modules>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    sessions: records.length,
    entry: "daemon-stored-session-views.mjs createStoredSessionViews().listSessions({ page }) over store-summary-reader.mjs listStoredSessionSummaryPage and readStoredSessionCatalogRow, on session records written to a data directory",
    replay: {
      entry: 'StoreListing (mixdog-core/src/run_host/tool_pool/session_control.rs) over a SqliteStore seeded with the same sessions: page (rows whole, order, page size, nextCursor, malformed cursor) and row, with the live overlay of the recorded turns in flight',
      compare: 'every page of every walk whole and in recorded order, every foreign cursor, every row by id, the archived flag of each row, the live overlay',
    },
    exclusions: {
      'records without messages': "the sessions are header-only (messages: []): the store derives a row's preview and message count from the message log, which the replay's seeded store does not hold; the preview and count of a session with messages are not compared here",
      'storage stamp': "a Node row carries `storageMtimeMs` and `storageSize`, the stat of the session's JSON file; the core's store has no such file (its rows hold 0), so the replay drops both from the two rows before comparing",
      'index-only fields': "the core's rows are the store index's summary, which also holds parentSessionId, presetName, effort, fast, modelParameters, permissionMode, schemaAllowedTools, taskType and compactCount; Node's JSON catalog rows (store-summary-catalog.mjs normalizedRow) do not carry them and the session tool never reads them from a list row, so the replay checks Node's row has none of them and drops them from the core's row before comparing the rest whole",
      'json listing': "this Node's catalog DB is disabled (the bundled SQLite lacks the WAL-reset fix: `[session-catalog-db] disabled`, `catalog stays JSON`), and this process is not the desktop daemon's writer anyway, so Node answers from the JSON listing (store-summary-reader.mjs listJsonSummariesAsync)",
      'archived flag': "the session tool's archived flag is the desktop sidebar's (`readSessionSidebarState`); the core keeps it in the store index from the record's archivedAt, so the recorder's sidebar flags the sessions whose record carries archivedAt",
      'page size': 'every walk asks an explicit page size, as the session tool does; the clamp of an absent or out-of-range limit is the session-list set',
      'live overlay': "the sessions with turns in flight are Node's runtimeState entries; the replay's overlay reports the recorded inFlightSessionActivity() as the runtime's facts",
    },
    values: 'JSON of the listing as Node answered',
  },
});
commitStage(out, finalDir);
console.log(`sessions=${records.length} walks=${idle.length + liveWalks.length} cursors=${cursors.length} rows=${rows.length}`);
