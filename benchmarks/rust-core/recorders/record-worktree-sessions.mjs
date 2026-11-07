#!/usr/bin/env node
// Golden of the session layer the worktree maintenance reads (`native/core/fixtures/worktree-sessions/golden.json`):
// real Node code stores sessions (`saveSessionDurably`, one legacy `<id>.json`, one real `deleteSession`) and
// `maintenance.storedSessionIds()` runs over the store dir. Recorded: the store dir's files (Rust migrates the same
// files), the ids Node lists, the activity map `storedSessionActivity` builds (`maintenance.mjs`, private: the same
// `loadSession` + `subAgentActivityAt` + `title || name` lines), and the sidebar marks the records carry
// (`favoriteAt`, `archivedAt`: Rust keeps the desktop's marks in the header).
//
//   node benchmarks/rust-core/recorders/record-worktree-sessions.mjs --tree <tree>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const home = mkdtempSync(join(tmpdir(), 'mixdog-worktree-sessions-'));
const data = join(home, 'data');
mkdirSync(join(data, 'sessions'), { recursive: true });
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(home, dir), { recursive: true });
  process.env[name] = join(home, dir);
}
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const at = (p) => import(pathToFileURL(join(repo, p)).href);

const store = await at('src/runtime/agent/orchestrator/session/store.mjs');
const { getStoreDir } = await at('src/runtime/agent/orchestrator/session/store/session-paths.mjs');
const { loadSession } = await at('src/runtime/agent/orchestrator/session/store/load-session.mjs');
const { subAgentActivityAt } = await at('src/runtime/agent/orchestrator/session/store/sweep/sub-agent-retention.mjs');
const maintenance = await at('src/runtime/shared/worktrees/maintenance.mjs');

const T = 1_700_000_000_000;
const base = (id, extra) => ({
  id,
  owner: 'user',
  agent: 'lead',
  sourceType: 'lead',
  closed: false,
  generation: 0,
  createdAt: T,
  updatedAt: T + 10_000,
  cwd: 'C:\\mixdog-golden\\project',
  messages: [{ role: 'user', content: 'hello', ts: T + 1_000 }],
  ...extra,
});

await store.saveSessionDurably(base('sess_titled', { title: 'Titled one', lastUsedAt: T + 5_000, favoriteAt: T + 1 }));
await store.saveSessionDurably(base('sess_named', { name: 'Named one', updatedAt: T + 20_000, lastHeartbeatAt: T + 30_000 }));
await store.saveSessionDurably(base('sess_bare', { updatedAt: undefined, archivedAt: T + 7 }));
await store.saveSessionDurably(base('sess_blank', { title: '', name: 'Fallback', lastUsedAt: T + 40_000, favoriteAt: T + 2, archivedAt: T + 8 }));
await store.saveSessionDurably(base('sess_closed', { closed: true, lastUsedAt: T + 2_000 }));
await store.saveSessionDurably(base('sess_victim', {}));
if ((await store.deleteSession('sess_victim', { fenceWrites: true })) !== true) throw new Error('delete failed');
const dir = getStoreDir();
writeFileSync(join(dir, 'sess_legacy.json'), JSON.stringify(base('sess_legacy', { title: 'Legacy', updatedAt: T + 3_000 })));
(await at('src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs')).releaseHeldSessionWriters();

const files = Object.fromEntries(
  readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile()).map((name) => [name, readFileSync(join(dir, name), 'utf8')])
);
const ids = (await maintenance.storedSessionIds()).sort();
// `storedSessionActivity(ids)` of maintenance.mjs.
const activity = {};
for (const id of ids) {
  const doc = loadSession(id);
  if (doc) activity[id] = { lastActiveAt: subAgentActivityAt(doc) || null, title: doc.title || doc.name || null };
}
const marks = (key) => ids.filter((id) => Number(loadSession(id)?.[key]) > 0);
const favorites = marks('favoriteAt');
const archived = marks('archivedAt');
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const set = join(FIXTURES_ROOT, 'worktree-sessions');
writeJson(join(set, 'golden.json'), { files, ids, activity, favorites, archived });
writeSetManifest(set, {
  set: 'worktree-sessions',
  recorder: 'benchmarks/rust-core/recorders/record-worktree-sessions.mjs',
  command: 'node <repo>/benchmarks/rust-core/recorders/record-worktree-sessions.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${ids.length} ids; favorites ${favorites.length}, archived ${archived.length}`);
process.exit(0);
