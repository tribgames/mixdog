import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ensureCore, pingCore, watchCore } from '../src/launch/ensure-core.mjs';

const absent = () => Object.assign(new Error('absent'), { name: 'CoreDiscoveryError', code: 'absent' });

/** A control listener answering `/mgmt/status` as the core does; `answer` null leaves the request unanswered. */
async function controlListener(answer: (() => { stalledMs: number } | null) | null) {
  const server = createServer((request, response) => {
    const body = answer?.();
    if (!body || request.headers.authorization !== 'Bearer t0k') {
      if (body) response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { port: (server.address() as AddressInfo).port, close: () => { server.closeAllConnections(); server.close(); } };
}

test('pingCore: a core answering with no stall answers; a wedged runtime, a refusal and silence do not', async () => {
  const live = await controlListener(() => ({ stalledMs: 0 }));
  const stalled = await controlListener(() => ({ stalledMs: 30_000 }));
  const silent = await controlListener(() => null);
  try {
    assert.equal(await pingCore({ state: 'serving', rpcPort: 1, controlPort: live.port, token: 't0k' }, { timeoutMs: 500 }), true);
    assert.equal(await pingCore({ state: 'serving', rpcPort: 1, controlPort: live.port, token: 'wrong' }, { timeoutMs: 500 }), false);
    assert.equal(await pingCore({ state: 'serving', rpcPort: 1, controlPort: stalled.port, token: 't0k' }, { timeoutMs: 500 }), false);
    assert.equal(await pingCore({ state: 'serving', rpcPort: 1, controlPort: silent.port, token: 't0k' }, { timeoutMs: 150 }), false);
  } finally {
    live.close();
    stalled.close();
    silent.close();
  }
});

test('a wedged core is killed after the bounded number of unanswered asks and a replacement is started', async () => {
  let clock = 0;
  let alive = new Set([100]);
  let discovery: { state: string; rpcPort: number | null; pid: number; controlPort: number; token: string } | null = {
    state: 'serving', rpcPort: 4000, pid: 100, controlPort: 4001, token: 't0k',
  };
  const killed: number[] = [];
  const asked: number[] = [];
  let watcher!: ReturnType<typeof watchCore>;
  const replaced = new Promise<void>((resolve) => {
    watcher = watchCore({
      readDiscovery: async () => {
        if (!discovery) throw absent();
        return discovery;
      },
      ownedPid: () => 100,
      ping: async (found) => (asked.push(clock), found.pid !== 100),
      kill: (pid) => void (killed.push(pid), alive.delete(pid)),
      onKilled: () => resolve(),
      sleep: async (ms) => void (clock += ms),
      intervalMs: 5_000,
      missedLimit: 3,
      runs: (pid) => alive.has(pid),
    });
  });
  await replaced;
  watcher.stop();
  await watcher.done;
  assert.deepEqual(killed, [100]);
  assert.equal(asked.length, 3, 'killed on the third unanswered ask, not before');
  assert.ok(clock <= 3 * 5_000 + 5_000, `ended within the bound (${clock} ms)`);

  // The dead pid names no core: the next attach-or-start launches a replacement.
  let launches = 0;
  const served = await ensureCore({
    readDiscovery: async () => (launches ? { state: 'serving', rpcPort: 5000, pid: 200 } : discovery!),
    launch: async () => void (launches += 1, alive = new Set([200])),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    readyTimeoutMs: 60_000,
    runs: (pid) => alive.has(pid),
  });
  assert.equal(launches, 1);
  assert.equal(served.pid, 200);
});

test('a core that answers again before the bound is not killed, and a core this launcher did not start is never touched', async () => {
  let clock = 0;
  const answers = [false, false, true, false, false, true];
  const killed: number[] = [];
  let owned: number | null = 100;
  let step = 0;
  const watcher = watchCore({
    readDiscovery: async () => ({ state: 'serving', rpcPort: 1, pid: 100, controlPort: 1, token: 't' }),
    ownedPid: () => owned,
    ping: async () => {
      const ok = answers[step++];
      if (step === answers.length) watcher.stop();
      return ok;
    },
    kill: (pid) => void killed.push(pid),
    sleep: async (ms) => void (clock += ms),
    missedLimit: 3,
    runs: () => true,
  });
  await watcher.done;
  assert.deepEqual(killed, []);

  owned = 999;
  let asked = 0;
  let rounds = 0;
  const other = watchCore({
    readDiscovery: async () => ({ state: 'serving', rpcPort: 1, pid: 100, controlPort: 1, token: 't' }),
    ownedPid: () => owned,
    ping: async () => (asked++, false),
    kill: (pid) => void killed.push(pid),
    sleep: async () => void (++rounds >= 5 && other.stop()),
    missedLimit: 1,
    runs: () => true,
  });
  await other.done;
  assert.equal(asked, 0);
  assert.deepEqual(killed, []);
});

test('a live owner that never publishes is named when no candidate was spawned', async () => {
  let clock = 0;
  let launches = 0;
  await assert.rejects(
    ensureCore({
      readDiscovery: async () => ({ state: 'booting', rpcPort: null, pid: 4321 }),
      launch: async () => void (launches += 1),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      readyTimeoutMs: 1_000,
      runs: () => true,
    }),
    /core is not ready: the core is booting; its owner \(pid 4321\) is alive and holds the data directory but has not published an endpoint/
  );
  assert.equal(launches, 0);

  // A core this call started that never publishes is not blamed on an owner.
  clock = 0;
  await assert.rejects(
    ensureCore({
      readDiscovery: async () => { throw absent(); },
      launch: async () => ({}),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      readyTimeoutMs: 500,
    }),
    (error: Error) => error.message === 'core is not ready: no core published its endpoint'
  );
});
