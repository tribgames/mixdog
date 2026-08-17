import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSessionRuntimePool } from './session-runtime-pool.mjs';

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const WORKER_STUB = `
const revisions = new Map();
function send(message) { if (process.connected) process.send(message); }
function respond(requestId, value) { send({ type: 'response', requestId, ok: true, value }); }
process.on('message', (message) => {
  const requestId = String(message.requestId || '');
  if (message.type === 'create') {
    revisions.set(message.runtimeId, 1);
    send({ type: 'state', runtimeId: message.runtimeId, revision: 1, full: { sessionId: message.options?.sessionId || '' } });
    respond(requestId, { created: true });
    return;
  }
  if (message.type === 'snapshot') {
    const revision = (revisions.get(message.runtimeId) || 1) + 1;
    revisions.set(message.runtimeId, revision);
    send({ type: 'state', runtimeId: message.runtimeId, revision, full: { sessionId: 'session-health' } });
    respond(requestId, { published: true });
    return;
  }
  if (message.type === 'call') {
    if (message.method === 'resume') {
      respond(requestId, true);
      return;
    }
    respond(requestId, { pid: process.pid, args: message.args });
    if (message.method === 'submitAsync' && message.args?.[0] === 'trigger') {
      setImmediate(() => send({ type: 'unhealthy', detail: { reason: 'test directory reads failed' } }));
    }
    return;
  }
  if (message.type === 'shutdown') {
    respond(requestId, { stopped: true });
    setImmediate(() => process.exit(0));
    return;
  }
  respond(requestId, { ready: true });
});
`;

test('an unhealthy shard is replaced and its runtime is recovered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-shard-health-'));
  const workerEntry = join(dir, 'worker.mjs');
  const logs = [];
  await writeFile(workerEntry, WORKER_STUB, 'utf8');

  const pool = createSessionRuntimePool({
    shardCount: 1,
    workerEntry,
    cwd: dir,
    env: { ...process.env },
    log: (line) => logs.push(line),
    coldDownMs: 0,
  });
  try {
    const runtime = await pool.create({ sessionId: 'session-health' });
    const originalPid = pool.status.shards[0].pid;
    assert.equal((await runtime.submitAsync('trigger')).pid, originalPid);
    await waitFor(
      () => pool.status.shards[0].pid && pool.status.shards[0].pid !== originalPid,
      'replacement shard',
    );
    const healthy = await runtime.submitAsync('healthy');
    assert.notEqual(healthy.pid, originalPid);
    assert.ok(logs.some((line) => /unhealthy; recycling/.test(line)));
    assert.ok(logs.some((line) => /recovered 1 runtime/.test(line)));
  } finally {
    await pool.close('test complete');
    await rm(dir, { recursive: true, force: true });
  }
});

// Wire contract regression: fork IPC serializes call frames as JSON, which
// cannot represent `undefined` and would fabricate `null` in its place. An
// omitted optional argument (e.g. `resume(id)`) must stay omitted on the wire
// so shard-side default parameters apply — it must never arrive as `null`
// (the daemon-boot remote-restore crash: `resume(id, null)` threw on
// `options.quiet`).
test('omitted trailing arguments stay omitted across the shard wire', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-shard-wire-args-'));
  const workerEntry = join(dir, 'worker.mjs');
  await writeFile(workerEntry, WORKER_STUB, 'utf8');

  const pool = createSessionRuntimePool({
    shardCount: 1,
    workerEntry,
    cwd: dir,
    env: { ...process.env },
    log: () => {},
    coldDownMs: 0,
  });
  try {
    const runtime = await pool.create({ sessionId: 'session-wire-args' });
    const echoed = await runtime.submitAsync('echo', undefined, undefined);
    assert.deepEqual(echoed.args, ['echo']);
    // Interior holes cannot be omitted positionally; only the tail is trimmed.
    const interior = await runtime.submitAsync('echo', undefined, 'keep');
    assert.deepEqual(interior.args, ['echo', null, 'keep']);
  } finally {
    await pool.close('test complete');
    await rm(dir, { recursive: true, force: true });
  }
});
