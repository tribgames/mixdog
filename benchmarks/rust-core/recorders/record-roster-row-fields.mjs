#!/usr/bin/env node
// Genuine 1.4.5 roster rows: the desktop's own catalog projection (`SessionHost.sessionCatalog`) over crafted
// session records under a fixed clock: `_sessionSummary` of each record (the store's list row, with the runtime
// overlay's `working` / `agentWorking`), then `desktopSessionSummaries`, `withArchiveFlags`, `withRetiredFlags`,
// `withFavoriteFlags` and `withReadCursors` of a real `DesktopSessionMetadata` that favorited, read and retired some of
// them. The Rust list row replays each record over the header keys that metadata is stored in (`favoriteAt`,
// `readState`, `retiredAt`) and must answer the same row.
//
//   (cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs \
//        <repo>/benchmarks/rust-core/recorders/record-roster-row-fields.mjs --tree <tree>
// Output: native/core/fixtures/roster-row-fields/golden.json
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, exactProductIdentity, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const root = mkdtempSync(join(tmpdir(), 'roster-row-fields-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const { DesktopSessionMetadata } = await importFrom(tree, 'apps/desktop/src/main/desktop-session-metadata.ts');
const { desktopSessionSummaries } = await importFrom(tree, 'apps/desktop/src/main/desktop-state.ts');
const { _sessionSummary } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-index.mjs');

const T0 = 1_800_000_000_000;
let clock = T0;
Date.now = () => clock;

const metadata = new DesktopSessionMetadata(() => root);
await metadata.load();

const record = (id, extra) => ({
  id,
  title: `Title ${id}`,
  cwd: 'C:/proj/a',
  createdAt: T0 - 5000,
  updatedAt: T0 - 3000,
  lastUsedAt: T0 - 2000,
  desktopSession: { classification: 'project', projectPath: 'C:/proj/a' },
  messages: [],
  compactCount: 0,
  ...extra,
});
const cases = [
  { record: record('sess_plain'), overlay: {} },
  { record: record('sess_favorite'), overlay: {}, favorite: true },
  { record: record('sess_read'), overlay: {}, read: { count: 0, consumed: true, numbering: { compactCount: 0, messageCount: 0 } } },
  { record: record('sess_read_twice'), overlay: {}, read: { count: 0, consumed: true, numbering: { compactCount: 0, messageCount: 0 } }, again: { count: 0, consumed: true, numbering: { compactCount: 0, messageCount: 0 } } },
  { record: record('sess_read_compacted', { compactCount: 3 }), overlay: {}, read: { count: 9, consumed: false, numbering: { compactCount: 1, messageCount: 12 } } },
  { record: record('sess_retired'), overlay: {}, retired: true },
  { record: record('sess_working'), overlay: { working: true } },
  { record: record('sess_agent_working'), overlay: { agentWorking: true } },
  { record: record('sess_both_working'), overlay: { working: true, agentWorking: true } },
  { record: record('sess_no_created', { createdAt: 0 }), overlay: {} },
  { record: record('sess_all'), overlay: { working: true }, favorite: true, retired: true, read: { count: 0, consumed: true, numbering: { compactCount: 0, messageCount: 0 } } },
];
for (const entry of cases) {
  const id = entry.record.id;
  clock += 1000;
  if (entry.favorite) await metadata.setFavorite(id, true);
  if (entry.read) await metadata.markRead(id, entry.read.count, entry.read.consumed, entry.read.numbering);
  if (entry.again) await metadata.markRead(id, entry.again.count, entry.again.consumed, entry.again.numbering);
  if (entry.retired) await metadata.setRetired(id, true);
}
const rows = cases.map(({ record, overlay }) => ({ ..._sessionSummary(record), ...overlay }));
const roster = metadata.withReadCursors(
  metadata.withFavoriteFlags(
    metadata.withRetiredFlags(metadata.withArchiveFlags(desktopSessionSummaries(rows, metadata.titles, metadata.names, 'C:/tasks')))
  )
);
const stored = {
  favorites: { ...metadata.favorites },
  reads: JSON.parse(JSON.stringify(metadata.reads)),
  retired: { ...metadata.retiredMap },
};

const setDir = join(FIXTURES_ROOT, 'roster-row-fields');
writeJson(join(setDir, 'golden.json'), {
  domain: 'roster-row-fields',
  recorder: 'benchmarks/rust-core/recorders/record-roster-row-fields.mjs',
  t0: T0,
  cases: cases.map(({ record, overlay }) => ({ record, overlay, row: roster.find((row) => row.id === record.id) ?? null })),
  stored,
});
const rel = 'benchmarks/rust-core/recorders/record-roster-row-fields.mjs';
const command = `(cwd <tree>/apps/desktop) node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs <repo>/${rel} --tree <tree>`;
writeSetManifest(setDir, { set: 'roster-row-fields', recorder: rel, command, identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146') });
console.log(`cases=${cases.length} rows=${roster.length}`);
