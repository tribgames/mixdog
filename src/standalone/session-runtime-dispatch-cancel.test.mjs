// Cold-start cancellation contract, exercised against the REAL runtime worker
// child (no stub): a cancel that arrives before or during the dispatch's
// module/provider cold start must never be answered "not running" and then let
// the dispatch run anyway.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const WORKER_ENTRY = fileURLToPath(new URL('./session-runtime-worker.mjs', import.meta.url));
const REPO_ROOT = join(dirname(WORKER_ENTRY), '..', '..');

function startWorker(runtimeRoot) {
  const child = fork(WORKER_ENTRY, [], {
    cwd: REPO_ROOT,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      MIXDOG_RUNTIME_ROOT: runtimeRoot,
      MIXDOG_DATA_DIR: runtimeRoot,
      MIXDOG_SESSION_RUNTIME_SHARD: '0',
      MIXDOG_SESSION_RUNTIME_SHARD_COUNT: '2',
    },
  });
  const responses = new Map();
  const waiters = new Map();
  child.on('message', (message) => {
    if (message?.type !== 'response') return;
    const id = String(message.requestId || '');
    const waiter = waiters.get(id);
    if (waiter) {
      waiters.delete(id);
      waiter(message);
      return;
    }
    responses.set(id, message);
  });
  const send = (payload) => child.send(payload);
  const wait = (requestId, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const settled = responses.get(requestId);
    if (settled) {
      responses.delete(requestId);
      resolve(settled);
      return;
    }
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${requestId}`)),
      timeoutMs,
    );
    waiters.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
  });
  return { child, send, wait };
}

async function stopWorker(worker) {
  try {
    worker.send({ type: 'shutdown', requestId: 'shutdown-1', reason: 'test complete' });
    await worker.wait('shutdown-1', 8_000).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    try { worker.child.kill(); } catch {}
  }
}

test('a cancel that arrives before the dispatch is retained and aborts it', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'mixdog-dispatch-cancel-'));
  const worker = startWorker(runtimeRoot);
  try {
    worker.send({
      type: 'agent-dispatch-cancel',
      requestId: 'cancel-early',
      dispatchId: 'dispatch-cold',
      reason: 'user aborted during cold start',
    });
    const cancel = await worker.wait('cancel-early', 15_000);
    assert.equal(cancel.ok, true);
    // Never "cancelled: false": an unknown id means not-registered-YET.
    assert.equal(cancel.value.cancelled, true);
    assert.equal(cancel.value.retained, true);

    const startedAt = Date.now();
    worker.send({
      type: 'agent-dispatch',
      requestId: 'dispatch-cold-1',
      dispatchId: 'dispatch-cold',
      agent: 'memory',
      params: { prompt: 'must never run' },
    });
    const dispatch = await worker.wait('dispatch-cold-1', 20_000);
    assert.equal(dispatch.ok, false);
    assert.match(String(dispatch.error?.message || ''), /user aborted during cold start/);
    // The abort is adopted at registration — before the orchestrator/provider
    // cold start, which alone takes seconds in this worker.
    assert.ok(
      Date.now() - startedAt < 3_000,
      'aborted dispatch never entered module/provider setup',
    );
  } finally {
    await stopWorker(worker);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test('a cancel racing a cold-start dispatch is never answered "not running"', async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'mixdog-dispatch-cancel-warm-'));
  const worker = startWorker(runtimeRoot);
  try {
    worker.send({
      type: 'agent-dispatch',
      requestId: 'dispatch-warm-1',
      dispatchId: 'dispatch-warm',
      agent: 'memory',
      params: { prompt: 'cancelled while importing' },
    });
    // The cold start compiles the orchestrator graph and blocks this loop, so
    // the cancel frame can only be handled once that window closes. Whichever
    // side wins, the abort must be honoured or retained — never dropped with
    // `cancelled: false`, which is what let a canceled dispatch keep running.
    worker.send({
      type: 'agent-dispatch-cancel',
      requestId: 'cancel-warm',
      dispatchId: 'dispatch-warm',
      reason: 'aborted mid cold start',
    });
    const cancel = await worker.wait('cancel-warm', 60_000);
    assert.equal(cancel.ok, true);
    assert.equal(cancel.value.cancelled, true);

    const dispatch = await worker.wait('dispatch-warm-1', 60_000);
    assert.equal(dispatch.ok, false);
  } finally {
    await stopWorker(worker);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
