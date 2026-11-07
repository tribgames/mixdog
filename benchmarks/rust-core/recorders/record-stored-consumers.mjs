#!/usr/bin/env node
// Golden of `storedWorkspaceConsumers` (`native/core/fixtures/stored-consumers/golden.json`):
// real Node code stores sessions (`saveSessionDurably`, one legacy `<id>.json`, one real
// `deleteSession`) and `maintenance.storedWorkspaceConsumers()` runs over the store dir. Recorded:
// the store dir's files (Rust migrates the same files), the consumers Node returns in order with the
// fields the folder checks read (`id`, `cwd`, `closed`, `owner`, `ownerSessionId`, `parentSessionId`,
// and `active`: `session.status` in activity-guards.mjs ACTIVE_STAGES, which `isSessionActive`
// reads for a stored session when no live runtime speaks for it), then the fail-closed refusal
// once a record cannot be read, and the failure when the store folder cannot be listed.
//
//   node benchmarks/rust-core/recorders/record-stored-consumers.mjs --tree <tree>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const home = mkdtempSync(join(tmpdir(), 'mixdog-stored-consumers-'));
const data = join(home, 'data');
mkdirSync(join(data, 'sessions'), { recursive: true });
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(home, dir), { recursive: true });
  process.env[name] = join(home, dir);
}
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
const at = (p) => import(pathToFileURL(join(repo, p)).href);

const store = await at('src/runtime/agent/orchestrator/session/store.mjs');
const { getStoreDir } = await at('src/runtime/agent/orchestrator/session/store/session-paths.mjs');
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

await store.saveSessionDurably(base('sess_idle', { status: 'idle' }));
await store.saveSessionDurably(base('sess_streaming', { status: 'Streaming', cwd: 'C:\\mixdog-golden\\project\\wt' }));
await store.saveSessionDurably(base('sess_closed', { closed: true, status: 'running' }));
await store.saveSessionDurably(base('sess_nocwd', { cwd: undefined }));
await store.saveSessionDurably(
  base('sess_child', { owner: 'agent', agent: 'worker', sourceType: 'agent', ownerSessionId: 'sess_idle', parentSessionId: 'sess_idle', status: 'running' })
);
await store.saveSessionDurably(base('sess_victim', {}));
if ((await store.deleteSession('sess_victim', { fenceWrites: true })) !== true) throw new Error('delete failed');
const dir = getStoreDir();
writeFileSync(join(dir, 'sess_legacy.json'), JSON.stringify(base('sess_legacy', { status: 'tool_running' })));
(await at('src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs')).releaseHeldSessionWriters();

const project = (session) => ({
  id: session.id,
  cwd: typeof session.cwd === 'string' ? session.cwd : null,
  active: ['connecting', 'requesting', 'streaming', 'tool_running', 'running', 'cancelling'].includes(String(session.status ?? '').toLowerCase()),
  closed: session.closed === true,
  ownerSessionId: session.ownerSessionId ?? null,
  parentSessionId: session.parentSessionId ?? null,
});
const names = readdirSync(dir);
const files = Object.fromEntries(
  names.filter((name) => statSync(join(dir, name)).isFile()).map((name) => [name, readFileSync(join(dir, name), 'utf8')])
);
const consumers = (await maintenance.storedWorkspaceConsumers()).map(project);

// A record that exists and cannot be read refuses the whole listing.
writeFileSync(join(dir, 'sess_broken.log.jsonl'), '{ this is not a session record\n');
let refusal = null;
try {
  await maintenance.storedWorkspaceConsumers();
} catch (error) {
  refusal = error.message;
}
if (refusal === null) throw new Error('an unreadable record did not refuse');

// The store folder itself cannot be listed: Node's readdir error reaches the user as it is, with the
// folder standing as <sessions>.
const unlistable = {};
const listingFailure = async () => {
  try {
    await maintenance.storedWorkspaceConsumers();
  } catch (error) {
    return error.message.split(dir).join('<sessions>');
  }
  throw new Error('an unlistable store did not refuse');
};
rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
unlistable.absent = await listingFailure();
writeFileSync(dir, 'not a folder');
unlistable.notAFolder = await listingFailure();
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const set = join(FIXTURES_ROOT, 'stored-consumers');
writeJson(join(set, 'golden.json'), { files, consumers, refusal, unlistable, brokenFile: { name: 'sess_broken.log.jsonl', text: '{ this is not a session record\n' } });
writeSetManifest(set, {
  set: 'stored-consumers',
  recorder: 'benchmarks/rust-core/recorders/record-stored-consumers.mjs',
  command: 'node <repo>/benchmarks/rust-core/recorders/record-stored-consumers.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${consumers.length} consumers; refusal: ${refusal}`);
process.exit(0);
