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

test('pingCore: a core answering reports its stall; a refusal and silence are no answer', async () => {
  const live = await controlListener(() => ({ stalledMs: 0 }));
  const stalled = await controlListener(() => ({ stalledMs: 30_000 }));
  const silent = await controlListener(() => null);
  try {
    assert.deepEqual(await pingCore({ state: 'serving', rpcPort: 1, controlPort: live.port, token: 't0k' }, { timeoutMs: 500 }), { answered: true, stalledMs: 0 });
    assert.deepEqual(await pingCore({ state: 'serving', rpcPort: 1, controlPort: live.port, token: 'wrong' }, { timeoutMs: 500 }), { answered: false, stalledMs: 0 });
    assert.deepEqual(await pingCore({ state: 'serving', rpcPort: 1, controlPort: stalled.port, token: 't0k' }, { timeoutMs: 500 }), { answered: true, stalledMs: 30_000 });
    assert.deepEqual(await pingCore({ state: 'serving', rpcPort: 1, controlPort: silent.port, token: 't0k' }, { timeoutMs: 150 }), { answered: false, stalledMs: 0 });
  } finally {
    live.close();
    stalled.close();
    silent.close();
  }
});

type Found = { state: string; rpcPort: number | null; pid: number; controlPort: number; token: string };
const serving = (pid = 100): Found => ({ state: 'serving', rpcPort: 4000, pid, controlPort: 4001, token: 't0k' });

test('a core that answers nothing for the freeze limit is killed, not before, and a replacement is started', async () => {
  let clock = 0;
  let alive = new Set([100]);
  const discovery: Found | null = serving();
  const killed: number[] = [];
  const killedAt: number[] = [];
  let watcher!: ReturnType<typeof watchCore>;
  const replaced = new Promise<void>((resolve) => {
    watcher = watchCore({
      readDiscovery: async () => discovery ?? Promise.reject(absent()),
      ownedPid: () => 100,
      ping: async () => ({ answered: false, stalledMs: 0 }),
      kill: (pid) => void (killed.push(pid), killedAt.push(clock), alive.delete(pid)),
      onKilled: () => resolve(),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      intervalMs: 5_000,
      runs: (pid) => alive.has(pid),
    });
  });
  await replaced;
  watcher.stop();
  await watcher.done;
  assert.deepEqual(killed, [100]);
  assert.ok(killedAt[0]! >= 120_000 && killedAt[0]! <= 125_000, `killed at the limit (${killedAt[0]} ms)`);

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

/** A watch over a silent core with `onEnding`; resolves with what was killed and what the callback saw. */
async function endSilentCore(onEnding: (ending: any) => unknown) {
  let clock = 0;
  const killed: number[] = [];
  const watcher: ReturnType<typeof watchCore> = watchCore({
    readDiscovery: async () => serving(),
    ownedPid: () => 100,
    ping: async () => ({ answered: false, stalledMs: 0 }),
    kill: (pid) => void killed.push(pid),
    onEnding,
    onKilled: () => watcher.stop(),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    intervalMs: 5_000,
    runs: () => true,
  });
  await watcher.done;
  return killed;
}

test('a core the watch ends is reported with why', async () => {
  const endings: any[] = [];
  const killed = await endSilentCore((ending) => void endings.push(ending));
  await new Promise((resolve) => setImmediate(resolve)); // the report is deferred off the kill's path
  assert.deepEqual(killed, [100]);
  assert.deepEqual({ ...endings[0], unansweredMs: 0 }, { pid: 100, reason: 'statusUnanswered', unansweredMs: 0, stalledMs: 0, limitMs: 120_000 });
  assert.ok(endings[0].unansweredMs >= 120_000);
});

test('a report that throws, rejects or never returns does not stop or delay the kill', async () => {
  assert.deepEqual(await endSilentCore(() => { throw new Error('diagnostic sink failed'); }), [100], 'a throwing report');
  assert.deepEqual(await endSilentCore(() => Promise.reject(new Error('diagnostic sink failed'))), [100], 'a rejecting report');
  assert.deepEqual(await endSilentCore(() => new Promise(() => {})), [100], 'a report that never settles');
});

test('a runtime that reports a stall of the limit is ended at once, one reporting less is not', async () => {
  let clock = 0;
  const killed: number[] = [];
  const stalledMs = [60_000, 119_999, 120_000];
  let step = 0;
  const watcher = watchCore({
    readDiscovery: async () => serving(),
    ownedPid: () => 100,
    ping: async () => ({ answered: true, stalledMs: stalledMs[step++] ?? 0 }),
    kill: (pid) => void killed.push(pid),
    onKilled: () => watcher.stop(),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    runs: () => true,
  });
  await watcher.done;
  assert.equal(step, 3);
  assert.deepEqual(killed, [100]);
});

test('a core that answers again is not killed, a sleep does not count, and a core this launcher did not start is never touched', async () => {
  let clock = 0;
  const killed: number[] = [];
  let step = 0;
  // Unanswered for 100 s, answered, unanswered for 100 s again: never 120 s in a row.
  const answers = [...Array(20).fill(false), true, ...Array(20).fill(false), true];
  const watcher = watchCore({
    readDiscovery: async () => serving(),
    ownedPid: () => 100,
    ping: async () => {
      const answered = answers[step++] ?? true;
      if (step >= answers.length) watcher.stop();
      return { answered, stalledMs: 0 };
    },
    kill: (pid) => void killed.push(pid),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    runs: () => true,
  });
  await watcher.done;
  assert.deepEqual(killed, []);
  const killedLater: number[] = [];

  // 100 s unanswered, a system sleep of an hour, 100 s unanswered: the sleep starts the count again.
  clock = 0;
  step = 0;
  const looks = 41;
  const slept = watchCore({
    readDiscovery: async () => serving(),
    ownedPid: () => 100,
    ping: async () => {
      if (++step >= looks) slept.stop();
      return { answered: false, stalledMs: 0 };
    },
    kill: (pid) => void killedLater.push(pid),
    sleep: async (ms) => void (clock += step === 20 ? 3_600_000 : ms),
    now: () => clock,
    runs: () => true,
  });
  await slept.done;
  assert.deepEqual(killedLater, []);

  const killedOther: number[] = [];
  let asked = 0;
  let rounds = 0;
  const other = watchCore({
    readDiscovery: async () => serving(),
    ownedPid: () => 999,
    ping: async () => (asked++, { answered: false, stalledMs: 0 }),
    kill: (pid) => void killedOther.push(pid),
    sleep: async () => void (++rounds >= 5 && other.stop()),
    unansweredLimitMs: 0,
    runs: () => true,
  });
  await other.done;
  assert.equal(asked, 0);
  assert.deepEqual(killedOther, []);
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

test('a core that says it is starting and answers its control listener is waited for past the ready time', async () => {
  let clock = 0;
  const booting = { state: 'booting', rpcPort: null, pid: 4321, controlPort: 7, token: 't' };
  const run = (stalledMs: number, servesAt: number) =>
    ensureCore({
      readDiscovery: async () => (clock >= servesAt ? { ...booting, state: 'serving', rpcPort: 9 } : booting),
      launch: async () => ({}),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      readyTimeoutMs: 1_000,
      runs: () => true,
      ping: async () => ({ answered: true, stalledMs }),
    });
  // Three ready times of index building, then it serves.
  assert.equal((await run(0, 3_500)).state, 'serving');
  // A runtime that reports a stall is not at work: the wait ends at the ready time.
  clock = 0;
  await assert.rejects(run(40_000, 3_500), /core is not ready: the core is booting/);
  assert.ok(clock < 1_200);
});

test('a blocked core names its own reason and no owner is blamed beside it', async () => {
  let clock = 0;
  await assert.rejects(
    ensureCore({
      readDiscovery: async () => ({ state: 'blocked', rpcPort: null, pid: 4321, blocked: { kind: 'undecidable' } }),
      launch: async () => ({}),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      readyTimeoutMs: 1_000,
      runs: () => true,
    }),
    (error: Error) => error.message === 'core is not ready: the core is blocked ({"kind":"undecidable"})'
  );
});
