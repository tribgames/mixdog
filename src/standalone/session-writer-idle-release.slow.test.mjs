// The daemon lets go of the writer lock of a session it left idle and
// unwatched, so a second Mixdog process on the same data dir (the store a
// `--plain` REPL writes through) opens it; work or a view keeps the lock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Read when the service builds its clock: only ever shorter than the default.
process.env.MIXDOG_SESSION_WRITER_IDLE_RELEASE_MS = '300';
const IDLE_MS = 300;

const { drainSessionStore, saveSession } = await import('../runtime/agent/orchestrator/session/store.mjs');
const { onSessionWriterHeldChange, sessionWriterHeldHere } = await import(
  '../runtime/agent/orchestrator/session/store/session-writer-claim.mjs'
);
const { _clearSessionRuntime, _detachTurnController, _touchRuntime, markSessionDone, updateSessionStage } =
  await import('../runtime/agent/orchestrator/session/manager/runtime-liveness.mjs');
const { _dropPendingMessageState, drainPendingMessages, enqueuePendingMessage, settlePendingMessageWrites } =
  await import('../runtime/agent/orchestrator/session/manager/pending-messages.mjs');
const { createSessionService } = await import('./session-service.mjs');

const PEER = fileURLToPath(
  new URL('../runtime/agent/orchestrator/session/store/session-writer-claim.fixture.mjs', import.meta.url)
);

let sequence = 0;
/** `deferService`: the test starts the service itself (`f.startService()`);
 *  `external`: the session is an agent's, viewed through its projection. */
function fixture(t, { deferService = false, external = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-writer-idle-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'));
  const id = `sess_writer_idle_${process.pid}_${++sequence}`;
  let service = null;
  const f = {
    root,
    id,
    session: { id, generation: 0, closed: false, messages: [{ role: 'user', content: 'daemon-1' }] },
    onDisk: () => JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8')).messages.map((m) => m.content),
    startService() {
      service = createSessionService({
        createSessionRuntime: async () => {
          throw new Error('cold views never materialize');
        },
        sessionExists: async () => true,
        statStoredSession: async () => null,
        readStoredSession: async (sessionId) => ({ sessionId, projectionStamp: 'p', items: [], queued: [] }),
        ...(external
          ? { readExternalSessionState: async (sessionId) => ({ sessionId, items: [], queued: [], busy: false }) }
          : {}),
        idleEvictMs: 60_000,
      });
      f.service = service;
      return service;
    },
  };
  t.after(async () => {
    await service?.stop();
    _dropPendingMessageState(id);
    await settlePendingMessageWrites();
    _clearSessionRuntime(id);
    drainSessionStore();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  if (!deferService) f.startService();
  return f;
}

// Resolves once this process lets go of `id`'s writer lock, or after `withinMs`
// with false.
function released(id, withinMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, withinMs);
    const stop = onSessionWriterHeldChange((sessionId, held) => {
      if (sessionId !== id || held) return;
      clearTimeout(timer);
      stop();
      resolve(true);
    });
  });
}

function startPeer(t, root) {
  const child = spawn(process.execPath, [PEER], {
    env: { ...process.env, MIXDOG_DATA_DIR: root, MIXDOG_USER_DATA_BACKUP_ROOT: join(root, 'backups') },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const waiters = [];
  createInterface({ input: child.stdout }).on('line', (line) => waiters.shift()?.(JSON.parse(line)));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  return {
    send: (command) =>
      new Promise((resolve) => {
        waiters.push(resolve);
        child.stdin.write(`${JSON.stringify(command)}\n`);
      }),
    exit: async () => {
      child.stdin.end(`${JSON.stringify({ op: 'exit' })}\n`);
      assert.equal(await exited, 0, stderr);
    },
  };
}

test('a session the daemon left idle and unwatched opens in another process after the delay', async (t) => {
  const f = fixture(t);
  const startedAt = Date.now();
  const letGo = released(f.id, 20 * IDLE_MS);
  // A daemon-side save (a rename, a delivery) makes this process the writer.
  saveSession(f.session, { sync: true });
  assert.equal(sessionWriterHeldHere(f.id), true);
  assert.equal(await letGo, true, 'the idle unwatched session kept its writer lock');
  assert.ok(Date.now() - startedAt >= IDLE_MS - 20, 'let go before the idle delay');

  const peer = startPeer(t, f.root);
  await peer.send({ op: 'load', id: f.id });
  assert.deepEqual(await peer.send({ op: 'append', id: f.id, text: 'repl-1' }), { saved: true });
  await peer.exit();
  assert.deepEqual(f.onDisk(), ['daemon-1', 'repl-1']);
});

test('a view or a running turn keeps the writer lock; the delay counts from when both end', async (t) => {
  const f = fixture(t);
  const viewer = { clientToken: 'desktop' };
  await f.service.subscribeSession({ sessionId: f.id }, viewer);
  saveSession(f.session, { sync: true });
  await delay(3 * IDLE_MS);
  assert.equal(sessionWriterHeldHere(f.id), true, 'let go while a view was open');
  const peer = startPeer(t, f.root);
  await peer.send({ op: 'load', id: f.id });
  assert.equal((await peer.send({ op: 'append', id: f.id, text: 'repl-early' })).code, 'ESESSIONCLAIMED');
  await peer.exit();

  // The view leaves while a turn runs: the turn keeps it.
  updateSessionStage(f.id, 'streaming');
  await f.service.unsubscribeSession({ sessionId: f.id }, viewer);
  await delay(3 * IDLE_MS);
  assert.equal(sessionWriterHeldHere(f.id), true, 'let go while a turn was running');

  const turnEndedAt = Date.now();
  const letGo = released(f.id, 20 * IDLE_MS);
  updateSessionStage(f.id, 'done');
  assert.equal(await letGo, true, 'the session kept its writer lock after it went idle and unwatched');
  assert.ok(Date.now() - turnEndedAt >= IDLE_MS - 20, 'let go before the delay after the turn ended');
  const repl = startPeer(t, f.root);
  await repl.send({ op: 'load', id: f.id });
  assert.deepEqual(await repl.send({ op: 'append', id: f.id, text: 'repl-1' }), { saved: true });
  await repl.exit();
  assert.deepEqual(f.onDisk(), ['daemon-1', 'repl-1']);
});

test('the delay starts when a finished turn lets its controller go', async (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  // An unhosted worker's turn, as askSession runs it: the terminal stage is
  // announced while the turn's controller is still live.
  const runtime = _touchRuntime(f.id);
  runtime.generation = 7;
  runtime.controller = new AbortController();
  updateSessionStage(f.id, 'streaming');
  markSessionDone(f.id);
  await delay(3 * IDLE_MS);
  assert.equal(sessionWriterHeldHere(f.id), true, 'let go while the turn still held its controller');

  const letGo = released(f.id, 20 * IDLE_MS);
  assert.equal(_detachTurnController(f.id, 7), true);
  assert.equal(await letGo, true, 'the worker went idle and kept its writer lock');
});

test('queued input keeps the writer lock until it is taken', async (t) => {
  const f = fixture(t);
  saveSession(f.session, { sync: true });
  assert.ok(enqueuePendingMessage(f.id, { message: 'queued prompt' }) > 0);
  await delay(3 * IDLE_MS);
  assert.equal(sessionWriterHeldHere(f.id), true, 'let go while a prompt was queued');

  const letGo = released(f.id, 20 * IDLE_MS);
  assert.equal(drainPendingMessages(f.id).length, 1);
  assert.equal(await letGo, true, 'the queue emptied and the lock was kept');
});

test("an open view of an agent's projection keeps the writer lock", async (t) => {
  const f = fixture(t, { external: true });
  const viewer = { clientToken: 'agents-pane' };
  const subscribed = await f.service.subscribeSession({ sessionId: f.id }, viewer);
  assert.equal(subscribed.subscribed, true);
  saveSession(f.session, { sync: true });
  await delay(3 * IDLE_MS);
  assert.equal(sessionWriterHeldHere(f.id), true, 'let go while the agent view was open');

  const letGo = released(f.id, 20 * IDLE_MS);
  await f.service.unsubscribeSession({ sessionId: f.id }, viewer);
  assert.equal(await letGo, true, 'the agent view left and the lock was kept');
});

test('a writer lock taken before the service started is on its clock', async (t) => {
  const f = fixture(t, { deferService: true });
  saveSession(f.session, { sync: true });
  const letGo = released(f.id, 20 * IDLE_MS);
  f.startService();
  assert.equal(await letGo, true, 'the earlier claim was never let go');
});
