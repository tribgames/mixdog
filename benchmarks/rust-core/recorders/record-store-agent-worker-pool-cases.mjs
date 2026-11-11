#!/usr/bin/env node
// Recording of the three store-agent-worker tests (b6f10295a): store-agent-worker-churn.test.mjs (5 cases: churn, in-place
// rewrites, 300 cached headers, async-only I/O, index rewrite), store-agent-worker-header-cache.test.mjs (the persisted header
// cache across daemon restarts and a data-dir switch) and store-agent-worker-listing-fs-ops.test.mjs (bounded fs calls). Real
// store-agent-worker-rows.mjs, one module instance per "cold pool" / "restarted daemon" (a distinct ?query URL), over stores in a
// temp data dir. Date.now is held at the recorder's fixed clock for the listing logic, but the header worker thread reads the real clock and caches a record only once its mtime is over 2 s old: the recorder ages the files' mtime as an input instead of waiting (no sleep). Every rewrite that keeps size and mtime still moves
// the change time, which is what the cases prove. Raw cache stamps (inode, change time) are machine values and are never recorded:
// the cache is recorded by its keys and by what the next restart reads.
//
//   node benchmarks/rust-core/recorders/record-store-agent-worker-pool-cases.mjs --tree <export of b6f10295a with node_modules>
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSet } from './lib/case-set.mjs';
import { parseArgs, resolveTree } from './lib/common.mjs';

const set = openSet('store-agent-worker-pool-cases', import.meta.url);
const tree = resolveTree(parseArgs());
const ROWS_URL = pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/session/store-agent-worker-rows.mjs')).href;
let instance = 0;
/** A distinct module instance: empty in-memory caches (a cold reader or a restarted daemon). */
const freshPool = () => import(`${ROWS_URL}?instance=${(instance += 1)}`);
const roots = [];
const MINUTE = 60_000;
const NOW = Date.now();
/** The header worker thread reads the real clock and caches a record only once its mtime is more than 2 s old (RACY_STAMP_WINDOW_NS in
 *  session-record.mjs). The recorder does not wait for that: it writes the age as a recorded input, setting every store file's mtime to
 *  one hour before the real clock (`age`). Records it has not aged are racy, as a freshly written one is. Only mtime counts for
 *  "settled"; the change time still moves with each rewrite, which is what the cases prove. */
const REAL_NOW_MS = Math.floor(performance.timeOrigin + performance.now());
const AGED = new Date(REAL_NOW_MS - 60 * MINUTE);
const AGE_INPUT = { mtimeAgeMs: 60 * MINUTE, note: 'every store file (sessions/*.json, agent-workers.json, lead-workers.json) gets this mtime before the read that the Node test made after its 2.2 s wait' };
function age(root) {
  for (const name of readdirSync(join(root, 'sessions'))) utimesSync(join(root, 'sessions', name), AGED, AGED);
  for (const name of ['agent-workers.json', 'lead-workers.json']) if (existsSync(join(root, name))) utimesSync(join(root, name), AGED, AGED);
}
async function withDataDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-worker-pool-'));
  roots.push(root);
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'));
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
/** The store a listing reads, as recorded input: each worker index and session record by its path under the data dir, as written
 *  (agent-worker-header-cache.json is the reader's own cache, not an input). */
function storeFiles(root) {
  const out = {};
  for (const name of ['agent-workers.json', 'lead-workers.json']) if (existsSync(join(root, name))) out[name] = readFileSync(join(root, name), 'utf8');
  for (const name of readdirSync(join(root, 'sessions')).sort()) out[`sessions/${name}`] = readFileSync(join(root, 'sessions', name), 'utf8');
  return out;
}
/** What changed between two stores: each changed path's new text, `null` for a removed file. */
function storeChanges(before, after) {
  const out = {};
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) if (before[path] !== after[path]) out[path] = after[path] ?? null;
  return out;
}
function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ---- churn -------------------------------------------------------------------------------------------------------------
const LEAD = 'churn-lead';
const RUNNING = new Set(['churn-00', 'churn-01', 'churn-02', 'churn-03', LEAD]);
function churnSessionRecord(id, index, turn) {
  const header = { id, owner: 'agent', agent: 'worker', ownerSessionId: LEAD, parentSessionId: LEAD, title: `Agent ${index} turn ${turn}`, provider: 'test-provider', model: `model-${index % 3}`, createdAt: NOW - 90 * MINUTE, updatedAt: NOW - (index % 4) * MINUTE, totalInputTokens: 100 * turn + index, totalOutputTokens: 7 * turn, totalToolCalls: turn };
  if (index % 11 === 5) Object.assign(header, { cancelStatus: 'cancel-unconfirmed', cancelledAt: NOW - 5 * MINUTE });
  if (index % 11 === 7) Object.assign(header, { status: 'cancelled', cancelledAt: NOW - 3 * MINUTE });
  const messages = Array.from({ length: 20 + turn }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: `turn ${turn} message ${n} "quoted" \\ {brace} [bracket] 한글 ${'z'.repeat(200)}` }));
  const { title, updatedAt, totalInputTokens, totalOutputTokens, totalToolCalls, ...front } = header;
  return JSON.stringify({ ...front, messages, title, updatedAt, totalInputTokens, totalOutputTokens, totalToolCalls });
}
function churnIndexRow(id, index, turn) {
  const running = RUNNING.has(id);
  const status = running ? 'running' : ['idle', 'failed', 'done', 'idle'][index % 4];
  return { tag: `tag-${index}`, sessionId: id, agent: 'worker', ownerSessionId: LEAD, parentSessionId: LEAD, status, stage: running ? 'streaming' : status, updatedAt: running ? NOW - turn : NOW - (index % 3 === 0 ? 120 * MINUTE : 10 * MINUTE), createdAt: NOW - 90 * MINUTE, startedAt: new Date(NOW - 90 * MINUTE + index * 1000).toISOString(), ...(status === 'failed' ? { failureReason: 'timeout' } : {}) };
}
await set.run('an incrementally updated pool lists exactly what a cold read of the same store lists', () => withDataDir(async (root) => {
  const ids = Array.from({ length: 40 }, (_, index) => `churn-${String(index).padStart(2, '0')}`);
  const turns = new Map(ids.map((id) => [id, 1]));
  const sessionPath = (id) => join(root, 'sessions', `${id}.json`);
  const rowsById = new Map(ids.map((id, index) => [id, churnIndexRow(id, index, 1)]));
  const tombstones = {};
  const writeIndex = () => writeAtomic(join(root, 'agent-workers.json'), JSON.stringify({ version: 2, workers: Object.fromEntries(rowsById), tombstones }));
  for (const [index, id] of ids.entries()) writeFileSync(sessionPath(id), churnSessionRecord(id, index, 1));
  const leadRecord = { id: LEAD, owner: 'user', agent: 'lead', messages: [] };
  writeFileSync(sessionPath(LEAD), JSON.stringify(leadRecord));
  const leadWorkers = { workers: [{ sessionId: LEAD, status: 'idle', updatedAt: NOW, createdAt: NOW - 100 * MINUTE }] };
  writeFileSync(join(root, 'lead-workers.json'), JSON.stringify(leadWorkers));
  writeIndex();
  let store = storeFiles(root);
  const live = await freshPool();
  const options = { runningSessionIds: RUNNING };
  const listed = live.listStoredAgentWorkers(options);
  const out = { agentCount: ids.length, running: [...RUNNING], leadRecord, leadWorkers, store, initial: { listed, listedAgain: live.listStoredAgentWorkers(options) }, rounds: [] };
  for (let round = 0; round < 6; round++) {
    for (const id of ['churn-00', 'churn-01', 'churn-02', 'churn-03']) {
      const turn = turns.get(id) + 1;
      turns.set(id, turn);
      const text = churnSessionRecord(id, ids.indexOf(id), turn);
      if (round % 2) writeAtomic(sessionPath(id), text);
      else writeFileSync(sessionPath(id), text);
      rowsById.set(id, churnIndexRow(id, ids.indexOf(id), turn));
    }
    const idle = ids[10 + round];
    writeFileSync(sessionPath(idle), churnSessionRecord(idle, ids.indexOf(idle), 2 + round));
    if (round === 2) rowsById.delete('churn-20');
    if (round === 3) { writeFileSync(sessionPath('churn-new'), churnSessionRecord('churn-new', 41, 1)); rowsById.set('churn-new', churnIndexRow('churn-new', 41, 1)); }
    if (round === 4) tombstones.reaped = { tag: rowsById.get('churn-21').tag, parentSessionId: LEAD, reapedAt: new Date(NOW).toISOString() };
    if (round === 5) rmSync(sessionPath('churn-22'));
    writeIndex();
    const next = storeFiles(root);
    const storeChanged = storeChanges(store, next);
    store = next;
    const reference = (await freshPool()).listStoredAgentWorkers(options);
    out.rounds.push({
      round, storeChanged, index: JSON.parse(readFileSync(join(root, 'agent-workers.json'), 'utf8')), reference,
      incremental: live.listStoredAgentWorkers(options), incrementalAsync: await live.listStoredAgentWorkersAsync(options), coldAsync: await (await freshPool()).listStoredAgentWorkersAsync(options), links: live.listStoredAgentWorkerLinks(), coldLinks: (await freshPool()).listStoredAgentWorkerLinks(),
    });
  }
  return out;
}));

function writeSingleWorker(root, title) {
  const path = join(root, 'sessions', 'stamp-child.json');
  writeFileSync(path, JSON.stringify({ id: 'stamp-child', owner: 'agent', title, messages: [] }));
  const index = { workers: [{ sessionId: 'stamp-child', tag: 'stamp', agent: 'worker', status: 'idle' }] };
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify(index));
  return { path, index };
}
await set.run('a session rewrite that keeps its size and mtime is still read, settled or not', () => withDataDir(async (root) => {
  const { path, index } = writeSingleWorker(root, 'AAAA');
  const { mtime } = statSync(path);
  const pool = await freshPool();
  const stores = [storeFiles(root)];
  const lists = [structuredClone(pool.listStoredAgentWorkers())];
  const rewrite = (title) => { writeFileSync(path, JSON.stringify({ id: 'stamp-child', owner: 'agent', title, messages: [] })); utimesSync(path, mtime, mtime); };
  rewrite('BBBB'); stores.push(storeFiles(root)); lists.push(structuredClone(pool.listStoredAgentWorkers()));
  age(root);
  stores.push(storeFiles(root)); lists.push(structuredClone(pool.listStoredAgentWorkers())); // settled and cached
  rewrite('CCCC'); stores.push(storeFiles(root)); lists.push(structuredClone(pool.listStoredAgentWorkers()));
  return { index, record: { id: 'stamp-child', owner: 'agent', title: 'AAAA', messages: [] }, aged: AGE_INPUT, storeAtEachList: stores, listsSeen: lists, steps: ['first read AAAA', 'rewrite BBBB same size and mtime', 'age every store file', 'read again (cached)', 'rewrite CCCC same size and mtime'] };
}));
await set.run('a settled, unchanged header is served from the cache, however many there are', () => withDataDir(async (root) => {
  const ids = Array.from({ length: 300 }, (_, index) => `many-${String(index).padStart(3, '0')}`);
  for (const id of ids) writeFileSync(join(root, 'sessions', `${id}.json`), JSON.stringify({ id, owner: 'agent', title: id, messages: [] }));
  const index = { workers: ids.map((sessionId) => ({ sessionId, tag: sessionId, agent: 'worker', status: 'idle' })) };
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify(index));
  age(root);
  const store = storeFiles(root);
  const pool = await freshPool();
  const first = pool.listStoredAgentWorkers();
  const { reads } = pool.storedAgentWorkerHeaderStats();
  const second = pool.listStoredAgentWorkers();
  const stats = pool.storedAgentWorkerHeaderStats();
  return { count: ids.length, aged: AGE_INPUT, store, first, firstReads: reads, second, statsAfterSecond: stats };
}));
await set.run('the awaited listing touches the store only through async I/O, and its caches serve the next one', () => withDataDir(async (root) => {
  const ids = Array.from({ length: 50 }, (_, index) => `async-${String(index).padStart(2, '0')}`);
  for (const id of ids) writeFileSync(join(root, 'sessions', `${id}.json`), JSON.stringify({ id, owner: 'agent', title: id, ownerSessionId: 'async-lead', messages: [] }));
  writeFileSync(join(root, 'sessions', 'async-lead.json'), JSON.stringify({ id: 'async-lead', owner: 'agent', agent: 'worker', messages: [] }));
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({ workers: ids.map((sessionId) => ({ sessionId, tag: sessionId, agent: 'worker', status: 'idle' })) }));
  age(root);
  const store = storeFiles(root);
  const pool = await freshPool();
  const originals = { readFileSync: fs.readFileSync, statSync: fs.statSync };
  let syncCalls = 0;
  for (const name of Object.keys(originals)) fs[name] = () => { syncCalls += 1; throw new Error(`synchronous ${name} during an awaited listing`); };
  syncBuiltinESMExports();
  let listed;
  let failure;
  try { listed = await pool.listStoredAgentWorkersAsync(); } catch (e) { failure = e; } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
  const sync = pool.listStoredAgentWorkers();
  const { reads } = pool.storedAgentWorkerHeaderStats();
  await pool.listStoredAgentWorkersAsync();
  return { count: ids.length, ownerRecord: { id: 'async-lead', owner: 'agent', agent: 'worker', messages: [] }, aged: AGE_INPUT, store, failure, synchronousFsCallsDuringAwaitedListing: syncCalls, listed, sync, readsAfterFirst: reads, readsAfterSecondAwaited: pool.storedAgentWorkerHeaderStats().reads };
}));
await set.run('a worker index rewrite that keeps its size and mtime is still read', () => withDataDir(async (root) => {
  const indexPath = join(root, 'agent-workers.json');
  writeFileSync(join(root, 'sessions', 'same-size.json'), JSON.stringify({ id: 'same-size', owner: 'agent', messages: [] }));
  const write = (title) => writeFileSync(indexPath, JSON.stringify({ workers: [{ sessionId: 'same-size', tag: 'same', agent: 'worker', status: 'idle', title, updatedAt: NOW }] }));
  write('AAAA');
  const { mtime } = statSync(indexPath);
  const pool = await freshPool();
  const stores = [storeFiles(root)];
  const a = structuredClone(pool.listStoredAgentWorkers());
  write('BBBB');
  utimesSync(indexPath, mtime, mtime);
  stores.push(storeFiles(root));
  return { storeAtEachList: stores, first: a, afterRewrite: pool.listStoredAgentWorkers(), links: pool.listStoredAgentWorkerLinks() };
}));

// ---- persisted header cache --------------------------------------------------------------------------------------------
const PLEAD = 'persist-lead';
const PRUNNING = new Set(['persist-00', 'persist-01', PLEAD]);
const OPTIONS = { runningSessionIds: PRUNNING };
const sessionPath = (root, id) => join(root, 'sessions', `${id}.json`);
const cachePath = (root) => join(root, 'agent-worker-header-cache.json');
function persistRecord(id, index, title) {
  const header = { id, owner: 'agent', agent: 'worker', ownerSessionId: PLEAD, parentSessionId: PLEAD, title, provider: 'test-provider', model: `model-${index % 3}`, createdAt: NOW - 90 * MINUTE, updatedAt: NOW - (index % 4) * MINUTE, totalInputTokens: 100 + index, totalOutputTokens: 7 * index, totalToolCalls: index, nested: { kept: 'out of the header' } };
  if (index % 7 === 3) Object.assign(header, { cancelStatus: 'cancel-unconfirmed', cancelledAt: NOW - 5 * MINUTE });
  if (index % 7 === 5) Object.assign(header, { status: 'cancelled', cancelledAt: NOW - 3 * MINUTE });
  const messages = Array.from({ length: 30 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: `message ${n} "quoted" \\ {brace} 한글 ${'z'.repeat(300)}` }));
  return JSON.stringify({ ...header, messages });
}
function persistIndexRow(id, index) {
  const status = PRUNNING.has(id) ? 'running' : ['idle', 'failed', 'done', 'idle'][index % 4];
  return { tag: `tag-${index}`, sessionId: id, agent: 'worker', ownerSessionId: PLEAD, parentSessionId: PLEAD, status, stage: status, updatedAt: NOW - (index % 3 === 0 ? 120 * MINUTE : 10 * MINUTE), createdAt: NOW - 90 * MINUTE, ...(status === 'failed' ? { failureReason: 'timeout' } : {}) };
}
const IDS = Array.from({ length: 30 }, (_, index) => `persist-${String(index).padStart(2, '0')}`);
function writeStoreFiles(root) {
  for (const [index, id] of IDS.entries()) writeFileSync(sessionPath(root, id), persistRecord(id, index, `T${index}`));
  writeFileSync(sessionPath(root, PLEAD), JSON.stringify({ id: PLEAD, owner: 'user', agent: 'lead', messages: [] }));
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({ workers: Object.fromEntries(IDS.map((id, index) => [id, persistIndexRow(id, index)])) }));
  writeFileSync(join(root, 'lead-workers.json'), JSON.stringify({ workers: [{ sessionId: PLEAD, status: 'idle', updatedAt: NOW, createdAt: NOW - 100 * MINUTE }] }));
}
const fullScan = async () => (await freshPool()).listStoredAgentWorkers(OPTIONS);
async function runDaemon() {
  const pool = await freshPool();
  const rows = await pool.listStoredAgentWorkersAsync(OPTIONS);
  await pool.flushStoredAgentWorkerHeaderCache();
  return { pool, rows, reads: pool.storedAgentWorkerHeaderStats().reads };
}
async function corruptCacheCases(root, reference) {
  const valid = JSON.parse(readFileSync(cachePath(root), 'utf8'));
  const tampered = structuredClone(valid);
  tampered.sessions[IDS[2]].stamp[3] = '1';
  tampered.sessions[IDS[3]].stamp = 'garbage';
  tampered.sessions[IDS[5]].header = ['not', 'a', 'header'];
  tampered.sessions[IDS[7]].header = { ...tampered.sessions[IDS[7]].header, unknownField: 1 };
  tampered.sessions['../escape'] = valid.sessions[IDS[9]];
  const damaged = [['missing', null, IDS.length + 1], ['empty', '', IDS.length + 1], ['truncated', JSON.stringify(valid).slice(0, 200), IDS.length + 1], ['not json', '{not json', IDS.length + 1], ['null', 'null', IDS.length + 1], ['other version', JSON.stringify({ ...valid, version: 999 }), IDS.length + 1], ['other fields', JSON.stringify({ ...valid, fields: 'title' }), IDS.length + 1], ['bad sessions', JSON.stringify({ ...valid, sessions: [] }), IDS.length + 1], ['tampered entries', JSON.stringify(tampered), 4]];
  const results = [];
  for (const [label, text, expectedReads] of damaged) {
    if (text === null) rmSync(cachePath(root));
    else writeFileSync(cachePath(root), text);
    const restarted = await runDaemon();
    const recovered = await runDaemon();
    results.push({ label, damage: text === null ? { removed: true } : { text: maskedText(text) }, rows: restarted.rows, reads: restarted.reads, expectedReads, recoveredRows: recovered.rows, recoveredReads: recovered.reads });
  }
  return { cache: maskFsStamps(valid), tamperedEntries: { [IDS[2]]: 'stamp[3] replaced by "1"', [IDS[3]]: 'stamp "garbage"', [IDS[5]]: 'header an array', [IDS[7]]: 'header plus unknownField', '../escape': 'a copy of another entry under a path-like id' }, results };
}
/** A cache stamp is, per file of the record (log, then json), ino, size, mtimeNs, ctimeNs (store-agent-worker-header-cache.mjs STAMP_FIELDS), so slots 4, 6 and 7 are the json file's inode, modification time (ns) and change time (ns) as the recording machine's file system gave them: written "<fs>"; the other slots are set by the recording (explicit sizes and aged mtimes). */
function maskFsStamps(cache) {
  const copy = structuredClone(cache);
  for (const entry of Object.values(copy.sessions ?? {})) if (Array.isArray(entry?.stamp)) for (const slot of [4, 6, 7]) if (slot in entry.stamp) entry.stamp[slot] = '<fs>';
  return copy;
}
const maskedText = (text) => { try { const parsed = JSON.parse(text); return parsed && typeof parsed === 'object' ? JSON.stringify(maskFsStamps(parsed)) : text; } catch { return text; } };
await set.run('the persisted header cache across daemon restarts', () => withDataDir(async (root) => {
  writeStoreFiles(root);
  age(root);
  const store = storeFiles(root);
  const out = { ids: IDS, running: [...PRUNNING], store, phases: {} };
  const first = await runDaemon();
  const cacheExists = existsSync(cachePath(root));
  const reference = await fullScan();
  const restarted = await runDaemon();
  out.phases.restart = { aged: AGE_INPUT, firstReads: first.reads, firstRows: first.rows, cachePersisted: cacheExists, reference, restartedRows: restarted.rows, restartedReads: restarted.reads, restartedAsyncRows: await restarted.pool.listStoredAgentWorkersAsync(OPTIONS) };
  out.phases.corrupt = await corruptCacheCases(root, reference);
  // Replaced by rename (new inode), rewritten in place keeping size and mtime, and deleted.
  const renamed = sessionPath(root, IDS[4]);
  writeFileSync(`${renamed}.tmp`, persistRecord(IDS[4], 4, 'RENAMED'));
  renameSync(`${renamed}.tmp`, renamed);
  const inPlace = sessionPath(root, IDS[5]);
  const { mtime } = statSync(inPlace);
  writeFileSync(inPlace, persistRecord(IDS[5], 5, 'XX'));
  utimesSync(inPlace, mtime, mtime);
  rmSync(sessionPath(root, IDS[8]));
  age(root);
  const storeChanged = storeChanges(store, storeFiles(root));
  const changed = await fullScan();
  const afterChange = await runDaemon();
  const persisted = JSON.parse(readFileSync(cachePath(root), 'utf8')).sessions;
  const again = await runDaemon();
  out.phases.changedWhileDown = { changes: ['rename-replace IDS[4] title RENAMED', 'in-place IDS[5] title XX keeping size and mtime', 'delete IDS[8]'], storeChanged, aged: AGE_INPUT, changed, restartedRows: afterChange.rows, restartedReads: afterChange.reads, persistedSessionIds: Object.keys(persisted), nextRestartRows: again.rows, nextRestartReads: again.reads };
  rmSync(cachePath(root));
  const lingering = await freshPool();
  await lingering.listStoredAgentWorkersAsync(OPTIONS);
  out.lingering = { pool: lingering, root };
  const holder = out.lingering;
  delete out.lingering;
  holder.removedRoot = root;
  // The store is removed when withDataDir returns; the flush is checked after.
  out.afterRemoval = holder;
  return out;
}).then(async (out) => {
  await out.afterRemoval.pool.flushStoredAgentWorkerHeaderCache();
  const recreated = existsSync(out.afterRemoval.removedRoot);
  delete out.afterRemoval;
  out.aPersistScheduledForARemovedStoreNeverRecreatesIt = { storeRecreated: recreated };
  return out;
}));
await set.run('switching data directories before a scheduled persist still persists the new directory', async () => {
  const previous = process.env.MIXDOG_DATA_DIR;
  const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), 'mixdog-worker-header-switch-')));
  roots.push(...dirs);
  try {
    for (const root of dirs) { mkdirSync(join(root, 'sessions')); writeStoreFiles(root); }
    for (const root of dirs) age(root);
    const pool = await freshPool();
    const [first, second] = dirs;
    const stores = dirs.map(storeFiles);
    process.env.MIXDOG_DATA_DIR = first;
    const listings = [await pool.listStoredAgentWorkersAsync(OPTIONS)];
    process.env.MIXDOG_DATA_DIR = second;
    listings.push(await pool.listStoredAgentWorkersAsync(OPTIONS));
    await pool.flushStoredAgentWorkerHeaderCache();
    listings.push(await pool.listStoredAgentWorkersAsync(OPTIONS));
    await pool.flushStoredAgentWorkerHeaderCache();
    return { ids: IDS, running: [...PRUNNING], storeOfEachDirectory: stores, sequence: ['list first dir', 'switch to second before the first persist fires', 'list second', 'flush', 'list second', 'flush'], listings, secondDirectoryCacheWritten: existsSync(cachePath(second)) };
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    for (const root of dirs) rmSync(root, { recursive: true, force: true });
  }
});

// ---- bounded fs calls --------------------------------------------------------------------------------------------------
const COUNTED = [[fs, ['statSync', 'lstatSync', 'readFileSync', 'existsSync', 'readdirSync', 'openSync', 'accessSync']], [fsp, ['stat', 'lstat', 'readFile', 'readdir', 'open', 'access']]];
async function countingFsCalls(run) {
  let calls = 0;
  const originals = [];
  for (const [target, names] of COUNTED) for (const name of names) { const original = target[name]; originals.push([target, name, original]); target[name] = function counted(...args) { calls += 1; return original.apply(this, args); }; }
  syncBuiltinESMExports();
  try { return { result: await run(), calls }; } finally { for (const [target, name, original] of originals) target[name] = original; syncBuiltinESMExports(); }
}
await set.run('listing a large index costs a bounded number of fs calls, whatever its row count', () => withDataDir(async (root) => {
  const OL = 'sess_ops_lead';
  const ROWS = 1800;
  const LIVE = 350;
  const workers = {};
  for (let i = 0; i < ROWS; i += 1) {
    const sessionId = `sess_ops_${String(i).padStart(4, '0')}`;
    const live = i < LIVE;
    workers[`tag-${i}`] = { tag: `tag-${i}`, sessionId, agent: 'worker', ownerSessionId: OL, parentSessionId: OL, status: live && i % 7 === 0 ? 'running' : 'idle', stage: live && i % 7 === 0 ? 'streaming' : 'idle', createdAt: new Date(NOW - 90 * MINUTE).toISOString(), startedAt: new Date(NOW - 90 * MINUTE + i * 1000).toISOString(), updatedAt: new Date(NOW - (live ? 5 : 20 * 24 * 60) * MINUTE).toISOString() };
    if (live) writeFileSync(join(root, 'sessions', `${sessionId}.json`), JSON.stringify({ id: sessionId, owner: 'agent', agent: 'worker', ownerSessionId: OL, title: `Agent ${i}`, messages: [] }));
  }
  writeFileSync(join(root, 'sessions', `${OL}.json`), JSON.stringify({ id: OL, owner: 'user', agent: 'lead', messages: [] }));
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({ version: 2, workers, tombstones: {} }));
  writeFileSync(join(root, 'lead-workers.json'), JSON.stringify({ workers: [{ sessionId: OL, status: 'idle', updatedAt: NOW, createdAt: NOW - 100 * MINUTE }] }));
  const past = new Date(NOW - 60_000);
  for (const name of readdirSync(join(root, 'sessions'))) utimesSync(join(root, 'sessions', name), past, past);
  const running = new Set(['sess_ops_0000', 'sess_ops_0007']);
  const store = storeFiles(root);
  const reference = (await freshPool()).listStoredAgentWorkers({ runningSessionIds: running });
  const pool = await freshPool();
  const cold = await countingFsCalls(() => pool.listStoredAgentWorkersAsync({ runningSessionIds: running }));
  const warm = await countingFsCalls(() => pool.listStoredAgentWorkersAsync({ runningSessionIds: running }));
  return { rows: ROWS, live: LIVE, running: [...running], store, reference, cold: cold.result, warm: warm.result, coldFsCalls: cold.calls, warmFsCalls: warm.calls, bound: 40 };
}));

await set.finish({
  entry: {
    maskedFsStamps: 'the cache record (and each damaged cache text written back, in the `corrupt` phase) holds sessions.*.stamp[4], [6], [7] (the inode, mtimeNs and ctimeNs of the json file on the recording machine) as "<fs>"; the rest of the cache is whole', runs: 'store-agent-worker-rows.mjs (listStoredAgentWorkers, listStoredAgentWorkersAsync, listStoredAgentWorkerLinks, storedAgentWorkerHeaderStats, flushStoredAgentWorkerHeaderCache) in a fresh module instance per cold reader / restarted daemon, over stores in a temp data dir', notRun: 'raw cache stamps are machine values and are not recorded' },
  replay: {
    entry: 'native/core/crates/mixdog-core/src/run_host/pool_list_replay.rs: each recorded store (the per-case files named in the case) is written as Node\'s data dir, migrated as the core does at its first start and opened through the real store; every listing is AgentPool::list over run_host/pool_inputs.rs RegistryPoolStore (what agent/pool/list answers with, composed as compose_flip.rs) and is compared whole',
    missingOnO1: ['the persisted header cache, the link list and the stat / read / fs-call counters: the format of Node\'s listing, no counterpart in the core'],
    notReplayed: [{ cases: '0 (round 5), 5 (phases.changedWhileDown)', reason: 'the store holds an agent-workers.json row whose session record was deleted (churn-22; persist-08) and Node lists it with a null title and usage. The core keeps a worker row in its session\'s header and the migration drops a row no session owns (native/core/crates/mixdog-migrate/src/session/mod.rs:240), so the core lists none of them: a design decision for the Lead' }],
    normalised: { dataDir: 'temp, not in the recording' },
  },
  replaceInText: roots.map((r) => [r, '<data>']),
});
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(0);
