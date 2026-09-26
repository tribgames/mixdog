import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

mock.module('../../../vendor/statusline/src/gateway/session-routes.mjs', {
  namedExports: {
    clearGatewaySessionRoute: () => true,
    writeGatewaySessionRoutes: () => true,
  },
});

// Count reads of the worker index file; row-store's named fs import is a live
// binding refreshed by syncBuiltinESMExports.
let indexFileReads = 0;
const realReadFileSync = fs.readFileSync;
fs.readFileSync = function countingReadFileSync(...args) {
  if (String(args[0]).endsWith('agent-workers.json')) indexFileReads += 1;
  return realReadFileSync.apply(this, args);
};
syncBuiltinESMExports();

const { createWorkerIndex } = await import('../worker-index.mjs');
const { createTagTombstones } = await import('./tombstones.mjs');
const { clean } = await import('../helpers.mjs');
const { TAG_TOMBSTONE_TTL_MS, findTagTombstone, tagTombstoneKey, tombstoneBlocksWork } = await import(
  '../../../runtime/shared/agent-reap-state.mjs'
);

const PID = 4242;
const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// Pre-change implementation, kept verbatim as the decision oracle.
function oracleFindTagTombstone(row, tombstones) {
  const tag = clean(row.tag || row.agentTag);
  return (
    tombstones.get(tagTombstoneKey({ ...row, tag })) ||
    tombstones.get(tagTombstoneKey({ tag, clientHostPid: row.clientHostPid }))
  );
}

function oracleBlocksScan(index, session, tag) {
  const tombstones = new Map();
  for (const row of index.readAllTagTombstones()) tombstones.set(tagTombstoneKey(row), row);
  const value = clean(tag);
  const sessionId = clean(session?.id);
  if (!value || !sessionId) return false;
  if (!tombstoneBlocksWork(session, oracleFindTagTombstone({ ...session, tag: value }, tombstones))) return false;
  const rows = index.readAllWorkerRows();
  const admitted = rows.filter((row) => !tombstoneBlocksWork(row, oracleFindTagTombstone(row, tombstones)));
  return !admitted.some((row) => row.sessionId === sessionId && row.tag === value);
}

function session(id, tag, createdAt, extra = {}) {
  return {
    id,
    agentTag: tag,
    parentSessionId: 'lead-a',
    ownerSessionId: 'lead-a',
    agent: 'worker',
    clientHostPid: PID,
    status: 'idle',
    createdAt,
    ...extra,
  };
}

function tombstone(tag, sessionId, reapedAt, extra = {}) {
  return {
    tag,
    agent: 'worker',
    clientHostPid: PID,
    sessionId,
    parentSessionId: 'lead-a',
    ownerSessionId: 'lead-a',
    reapedAt,
    ...extra,
  };
}

function workerRow(sessionId, tag, extra = {}) {
  return {
    tag,
    sessionId,
    parentSessionId: 'lead-a',
    ownerSessionId: 'lead-a',
    agent: 'worker',
    clientHostPid: PID,
    status: 'idle',
    ...extra,
  };
}

let mtimeTick = 0;
// A foreign process rewriting the index: bypasses this process's store.
function foreignWrite(file, doc) {
  writeFileSync(file, JSON.stringify({ version: 2, ...doc }));
  mtimeTick += 10;
  const stamp = new Date(Date.UTC(2030, 0, 1) + mtimeTick * 1000);
  utimesSync(file, stamp, stamp);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tombstones-'));
  const file = join(root, 'agent-workers.json');
  const now = Date.now();
  const sessions = [
    session('s-blocked', 'r1', iso(now - 3 * HOUR)),
    session('s-admitted', 'r2', iso(now - 3 * HOUR)),
    session('s-row-reaped', 'r3', iso(now - 3 * HOUR)),
    session('s-live', 'live', iso(now - 3 * HOUR)),
    session('s-legacy', 'legacy', iso(now - 3 * HOUR)),
    session('s-top', 'top', iso(now - 3 * HOUR), { parentSessionId: '', ownerSessionId: '' }),
    session('s-expired', 'expired', iso(now - 9 * 24 * HOUR)),
    session('s-new-turn', 'turn', iso(now - 3 * HOUR), { turnStartedAt: iso(now) }),
    session('s-other-lead', 'other', iso(now - 3 * HOUR)),
  ];
  const reapedAt = iso(now - HOUR);
  const doc = {
    workers: {
      's-admitted': workerRow('s-admitted', 'r2', { turnStartedAt: iso(now - 1000) }),
      's-row-reaped': workerRow('s-row-reaped', 'r3', { createdAt: iso(now - 3 * HOUR) }),
      's-live': workerRow('s-live', 'live', { createdAt: iso(now - 3 * HOUR) }),
    },
    tombstones: {
      a: tombstone('r1', 's-blocked', reapedAt),
      b: tombstone('r2', 's-admitted', reapedAt),
      c: tombstone('r3', 's-row-reaped', reapedAt),
      // Legacy: no owner, recovered from the unique matching session.
      d: tombstone('legacy', 's-legacy', reapedAt, { parentSessionId: undefined, ownerSessionId: undefined }),
      // Legacy that cannot be recovered (the session has no owner): pid key.
      e: tombstone('top', 's-top', reapedAt, { parentSessionId: undefined, ownerSessionId: undefined }),
      f: tombstone('expired', 's-expired', iso(now - TAG_TOMBSTONE_TTL_MS - HOUR)),
      g: tombstone('turn', 's-new-turn', reapedAt),
      h: tombstone('other', 's-other-x', reapedAt, { parentSessionId: 'lead-b', ownerSessionId: 'lead-b' }),
    },
  };
  foreignWrite(file, doc);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const mgr = {
    getSession: (id) => byId.get(id) || null,
    listSessions: () => sessions,
    getSessionRuntime: () => null,
  };
  const index = createWorkerIndex({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr,
    tags: new Map(),
    tagAgents: new Map(),
    tagCwds: new Map(),
  });
  let readWorkerRowsCalls = 0;
  const countedIndex = {
    ...index,
    readWorkerRows: (...args) => {
      readWorkerRowsCalls += 1;
      return index.readWorkerRows(...args);
    },
  };
  const tombs = createTagTombstones({ tagMaps: { unbindIfOwned() {} }, index: countedIndex });
  // Session/tag pairs checked: own tags, a foreign tag, and degenerate inputs.
  const checks = [
    ...sessions.map((s) => [s, s.agentTag]),
    [sessions[3], 'r1'],
    [sessions[0], '  r1  '],
    [sessions[0], ''],
    [null, 'r1'],
    [{ ...sessions[0], id: '' }, 'r1'],
  ];
  return {
    root,
    file,
    doc,
    now,
    index,
    tombs,
    checks,
    readWorkerRowsCalls: () => readWorkerRowsCalls,
    decisions: () => {
      const map = tombs.tagTombstoneIndex();
      return checks.map(([s, tag]) => tombs.tombstoneBlocksScan(s, tag, map));
    },
    oracle: () => checks.map(([s, tag]) => oracleBlocksScan(index, s, tag)),
  };
}

test('findTagTombstone matches the spread-based lookup', () => {
  const tombstones = new Map(
    [
      { tag: 't', parentSessionId: 'p' },
      { tag: 't', clientHostPid: 7 },
      { tag: 'u', ownerSessionId: 'o' },
      { tag: 'v' },
    ].map((row) => [tagTombstoneKey(row), row])
  );
  const rows = [
    { tag: 't', parentSessionId: 'p' },
    { tag: ' t ', ownerSessionId: 'p', clientHostPid: 7 },
    { agentTag: 't', parentSessionId: 'q', clientHostPid: '7' },
    { tag: 't', clientHostPid: 8 },
    { tag: 'u', ownerSessionId: ' o ' },
    { tag: 'u', parentSessionId: '', ownerSessionId: 'o' },
    { tag: 'v' },
    { tag: 'v', clientHostPid: 0, parentSessionId: 'x' },
    { tag: '' },
    {},
  ];
  for (const row of rows) {
    assert.equal(findTagTombstone(row, tombstones), oracleFindTagTombstone(row, tombstones), JSON.stringify(row));
  }
});

test('scan decisions match the previous implementation across tombstone changes', () => {
  const ctx = setup();
  try {
    // prettier-ignore
    const initial = [true, false, true, false, true, true, false, false, false, true, true, false, false, false];
    assert.deepEqual(ctx.oracle(), initial);
    assert.deepEqual(ctx.decisions(), initial);

    // Foreign process: drops r1's tombstone, reaps `live`, removes r2's row.
    const { a: _dropped, ...rest } = ctx.doc.tombstones;
    const { 's-admitted': _row, ...workers } = ctx.doc.workers;
    foreignWrite(ctx.file, {
      workers,
      tombstones: { ...rest, z: tombstone('live', 's-live', iso(Date.now())) },
    });
    const changed = ctx.oracle();
    assert.deepEqual(changed.slice(0, 4), [false, true, true, true]);
    assert.deepEqual(ctx.decisions(), changed);

    // This process: a new reap tombstone and a consumed legacy tombstone.
    assert.equal(ctx.tombs.tombstoneTerminalSession('r1', 's-blocked', ctx.checks[0][0]), true);
    const legacy = ctx.tombs.tagTombstoneForTag('legacy');
    assert.ok(legacy);
    assert.equal(ctx.tombs.consumeTagTombstone(legacy), true);
    const local = ctx.oracle();
    assert.equal(local[0], true);
    assert.equal(local[4], false);
    assert.deepEqual(ctx.decisions(), local);

    // A turn stamped after the reap is new work again.
    ctx.checks[0][0].turnStartedAt = iso(Date.now() + 1000);
    assert.deepEqual(ctx.decisions(), ctx.oracle());
    assert.equal(ctx.decisions()[0], false);
    delete ctx.checks[0][0].turnStartedAt;

    // Index file removed: nothing blocks.
    rmSync(ctx.file);
    assert.deepEqual(ctx.decisions(), ctx.oracle());
    assert.ok(ctx.decisions().every((blocked) => blocked === false));
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test('repeated checks with unchanged tombstones do no file reads or row rebuilds', () => {
  const ctx = setup();
  try {
    const first = ctx.decisions();
    const reads = indexFileReads;
    const rebuilds = ctx.readWorkerRowsCalls();
    const map = ctx.tombs.tagTombstoneIndex();
    for (let i = 0; i < 50; i += 1) {
      assert.deepEqual(ctx.decisions(), first);
      assert.equal(ctx.tombs.tagTombstoneIndex(), map);
    }
    assert.equal(indexFileReads, reads);
    assert.equal(ctx.readWorkerRowsCalls(), rebuilds);

    // A foreign write is observed on the very next check.
    const { a: _dropped, ...rest } = ctx.doc.tombstones;
    foreignWrite(ctx.file, { workers: ctx.doc.workers, tombstones: rest });
    const next = ctx.decisions();
    assert.equal(next[0], false);
    assert.deepEqual(next, ctx.oracle());
    assert.equal(indexFileReads, reads + 1);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
