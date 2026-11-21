import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createWorkerPool } from './worker-pool.ts';
import { RESPONSE_MARKER } from './program.ts';

process.env.MIXDOG_COMPUTER_BIN ||= 'mixdog-computer';

const fakeChild = (pid) =>
  Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      this.killed = true;
      return true;
    },
  });

async function fakePool(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-worker-pool-sessions-'));
  const workers = [];
  const retired = [];
  const pool = createWorkerPool({
    dataDirectory: () => directory,
    isBridgeEnabled: () => false,
    isDisposed: () => false,
    onSessionRetired: (...args) => retired.push(args),
    spawnProcess: () => {
      const child = fakeChild(100 + workers.length);
      workers.push(child);
      return child;
    },
  });
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(async () => {
    clearInterval(keepAlive);
    for (const child of workers) {
      child.exitCode = 0;
      child.emit('exit', 0);
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { pool, workers, retired };
}

const reply = (child, body) => child.stdout.write(`${RESPONSE_MARKER}${JSON.stringify(body)}\n`);
const nextRequest = async (child) => {
  while (!child.stdin.readableLength) await new Promise((resolve) => setImmediate(resolve));
  return JSON.parse(child.stdin.read().toString());
};

test('a read the helper abandoned is an error answer: the session keeps its worker and the next request reaches it', async (t) => {
  const { pool, workers } = await fakePool(t);
  const read = pool.callPowerShell({ action: 'snapshot', session_id: 's1', read_only: true, bounded: true });
  const first = await nextRequest(workers[0]);
  reply(workers[0], {
    id: first.id,
    ok: false,
    error:
      'computer_command_timeout: accessibility read exceeded 1000ms during the element search; the read was abandoned',
  });
  const abandoned = await read;
  assert.equal(abandoned.ok, false);
  assert.match(abandoned.error, /^computer_command_timeout: accessibility read exceeded 1000ms/);
  assert.equal(pool.powerShellBySession.get('s1'), workers[0], 'the session keeps its input host');
  assert.equal(workers[0].killed, false);

  const next = pool.callPowerShell({ action: 'wait', duration: 0, session_id: 's1', read_only: true });
  const second = await nextRequest(workers[0]);
  reply(workers[0], { id: second.id, ok: true, result: { text: 'waited' } });
  assert.equal((await next).ok, true);
  assert.equal(workers.length, 1, 'no second worker was started');
});

test('first use starts one worker for the session and never refills an unused spare', async (t) => {
  const { pool, workers } = await fakePool(t);
  assert.deepEqual(pool.residentWorkerPids(), []);
  const warmed = pool.ensurePowerShell('first-use');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pool.ensurePowerShell('first-use'), warmed);
  assert.equal(workers.length, 1);
  assert.deepEqual(pool.residentWorkerPids(), [warmed.pid]);
  assert.equal(warmed.killed, false);
});

test('retiring a worker still warming up releases its session and ends its process', async (t) => {
  const { pool, workers, retired } = await fakePool(t);
  const child = pool.ensurePowerShell('warm-up-race');
  pool.retirePowerShell(child, new Error('bridge disabled during warm-up'));
  assert.equal(pool.powerShellBySession.has('warm-up-race'), false);
  assert.equal(workers[0].killed, true);
  assert.deepEqual(
    retired.map(([sessionId]) => sessionId),
    ['warm-up-race']
  );
});
