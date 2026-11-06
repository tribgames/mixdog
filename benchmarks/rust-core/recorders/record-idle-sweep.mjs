#!/usr/bin/env node
// Golden twin of the idle session sweep (`session/store/sweep/stale-sweep.mjs` `sweepStaleSessions`, as
// `session/manager/idle-cleanup.mjs` calls it: 5 min idle TTL, 1 h tombstone age, open-session cap on):
// session records written into a real temp store, one real sweep, the tally it returned and which records
// were left. Rust `mixdog_app_server_daemon::session_sweep::sweep_once` must answer every scenario the same.
//
//   node benchmarks/rust-core/recorders/record-idle-sweep.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const root = mkdtempSync(join(tmpdir(), 'record-idle-sweep-'));
process.env.MIXDOG_DATA_DIR = root;
const store = await import(new URL(`file:///${join(tree, 'src/runtime/agent/orchestrator/session/store/listing.mjs').replaceAll('\\', '/')}`).href);
const { sweepStaleSessions } = await import(new URL(`file:///${join(tree, 'src/runtime/agent/orchestrator/session/store/sweep/stale-sweep.mjs').replaceAll('\\', '/')}`).href);

const MIN = 60_000;
const CONVERSATION = [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }];

/** A row as the Rust sweep reads it: ages in ms before the sweep's `now`. */
const row = (id, ageMs, extra = {}) => ({ id, owner: '', status: 'idle', closed: false, ageMs, conversation: 2, ...extra });

const scenarios = {
  idleClose: [row('sess_old', 6 * MIN), row('sess_fresh', 2 * MIN), row('sess_live', 30 * MIN)],
  ownedAndScratch: [
    row('sess_chat', 9000 * MIN, { owner: 'user' }),
    row('sess_blank', 61 * MIN, { owner: 'user', conversation: 0 }),
    row('sess_young', 30 * MIN, { owner: 'user', conversation: 0 }),
  ],
  tombstones: [
    row('sess_old', 61 * MIN, { owner: 'user', closed: true, status: 'closed' }),
    row('sess_young', 59 * MIN, { owner: 'user', closed: true, status: 'closed' }),
    row('sess_held', 90 * MIN, { owner: 'user', closed: true, status: 'closed' }),
  ],
  permanent: [row('sess_home_lead', 99_999 * MIN, { closed: true, status: 'closed' }), row('sess_home_watcher', 99_999 * MIN, { owner: 'cli' })],
  running: [row('sess_quiet', 9 * MIN, { status: 'running' }), row('sess_zombie', 11 * MIN, { status: 'running' })],
  // An older process beside this one (mid-upgrade) keeps a fresh `.own` marker naming a live pid: the close or delete
  // lands nothing and the row is kept. The Rust store answers Ok(false) for the same sessions.
  legacyOwnerVeto: [
    row('sess_busy', 6 * MIN),
    row('sess_free', 6 * MIN),
    row('sess_tomb_busy', 90 * MIN, { owner: 'user', closed: true, status: 'closed' }),
    row('sess_blank_busy', 61 * MIN, { owner: 'user', conversation: 0 }),
  ],
  // 302 ownerless sessions inside the idle window: the cap keeps the 300 newest.
  cap: [row('sess_ancient', 15 * 24 * 60 * MIN), ...Array.from({ length: 302 }, (_, i) => row(`sess_n${String(i).padStart(3, '0')}`, 1000 + i * 700))],
};
const live = { idleClose: ['sess_live'], tombstones: ['sess_held'] };
const legacyMarkers = { legacyOwnerVeto: ['sess_busy', 'sess_tomb_busy', 'sess_blank_busy'] };
const dir = join(root, 'sessions');
const out = {};
for (const [name, rows] of Object.entries(scenarios)) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const r of rows) {
    const at = now - r.ageMs;
    const path = join(dir, `${r.id}.json`);
    writeFileSync(path, JSON.stringify({
      id: r.id, createdAt: at, updatedAt: at, status: r.status, messages: r.conversation ? CONVERSATION : [],
      ...(r.owner ? { owner: r.owner } : {}), ...(r.closed ? { closed: true } : {}),
    }));
    utimesSync(path, at / 1000, at / 1000);
  }
  for (const id of legacyMarkers[name] ?? []) writeFileSync(join(dir, `${id}.own`), `${now}\n${process.pid}\n`);
  const liveIds = new Set(live[name] ?? []);
  const result = await sweepStaleSessions(5 * MIN, { isSessionLive: (id) => liveIds.has(id), tombstoneMaxAgeMs: 60 * MIN });
  await store.settleSessionSummaryIndex();
  out[name] = {
    rows, live: [...liveIds],
    cleaned: result.details.map((d) => d.id).sort(),
    tombstonesCleaned: result.tombstoneDetails.map((d) => d.id).sort(),
    openPruned: result.openPrunedDetails.map((d) => d.id).sort(),
    remaining: result.remaining,
    // The sessions an older process still held (close/delete refused), and those whose unlink threw.
    vetoed: legacyMarkers[name] ?? [],
    tombstoneErrors: (result.tombstoneErrors ?? []).map((e) => e.id).sort(),
  };}
rmSync(root, { recursive: true, force: true });

writeJson(join(FIXTURES_ROOT, 'idle-sweep', 'golden.json'), { ttlMs: 5 * MIN, tombstoneMaxAgeMs: 60 * MIN, scenarios: out });
writeSetManifest(join(FIXTURES_ROOT, 'idle-sweep'), {
  set: 'idle-sweep',
  recorder: 'benchmarks/rust-core/recorders/record-idle-sweep.mjs',
  command: 'node benchmarks/rust-core/recorders/record-idle-sweep.mjs --tree <tree>',
  identityTree: tree,
});
console.log(`recorded ${Object.keys(out).length} idle sweep scenarios`);
process.exit(0);
