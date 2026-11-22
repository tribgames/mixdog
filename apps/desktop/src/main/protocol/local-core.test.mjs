import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { beginDaemonSpawnCapture } from '../../../../../packages/protocol-client/src/launch/crash-capture/spawn-capture.mjs';
import { launchCore } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import { ensureCore } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import {
  coreBinaryPath,
  coreEnvironment,
  coreExit,
  coreLaunchPath,
  forceEndCore,
  requestCoreStop,
  DESKTOP_CORE_READY_TIMEOUT_MS,
  packagedMixdogRoot,
  readCoreState,
  resolveLocalCore,
} from './local-core.ts';
import { BootReports } from '../core-port/boot-progress.ts';

test('a packaged app tells the core where its unpacked resources and its profile are; a development run leaves the environment alone', () => {
  const base = { PATH: 'p' };
  const resources = join('r', 'resources');
  const userData = join('r', 'profile');
  assert.deepEqual(coreEnvironment(true, resources, userData, base), {
    PATH: 'p',
    MIXDOG_ROOT: join(resources, 'runtime.asar.unpacked', 'node_modules', 'mixdog', 'src'),
    MIXDOG_DESKTOP_USER_DATA: userData,
  });
  assert.equal(packagedMixdogRoot(resources), coreEnvironment(true, resources, userData, {}).MIXDOG_ROOT);
  assert.equal(coreEnvironment(false, resources, userData, base), base);
});

test('the packaged core binary sits beside the resources', () => {
  assert.equal(coreBinaryPath(true, 'res', 'win32'), join('res', 'core', 'mixdogd.exe'));
  assert.equal(coreBinaryPath(true, 'res', 'linux'), join('res', 'core', 'mixdogd'));
});

test('on Windows the core is started under the name of the app through a hard link the app keeps current', () => {
  const bin = join('res', 'core', 'mixdogd.exe');
  const named = join('res', 'core', 'Mixdog.exe');
  const world = (files) => {
    const calls = [];
    return {
      calls,
      fs: {
        identity: (path) => files[path] ?? null,
        link: (existing, path) => {
          calls.push(`link ${path}`);
          if (files.refuseLink) throw new Error('EPERM');
          files[path] = files[existing];
        },
        remove: (path) => {
          calls.push(`remove ${path}`);
          delete files[path];
        },
      },
    };
  };
  // No link yet: it is made.
  let w = world({ [bin]: 'a' });
  assert.equal(coreLaunchPath(true, 'res', 'win32', w.fs), named);
  assert.deepEqual(w.calls, [`remove ${named}`, `link ${named}`]);
  // The link is the core: nothing is touched.
  w = world({ [bin]: 'a', [named]: 'a' });
  assert.equal(coreLaunchPath(true, 'res', 'win32', w.fs), named);
  assert.deepEqual(w.calls, []);
  // The core was replaced: the name moves to the new file.
  w = world({ [bin]: 'b', [named]: 'a' });
  assert.equal(coreLaunchPath(true, 'res', 'win32', w.fs), named);
  assert.deepEqual(w.calls, [`remove ${named}`, `link ${named}`]);
  // A link that cannot be made, or no core: the plain binary.
  w = world({ [bin]: 'a', refuseLink: true });
  assert.equal(coreLaunchPath(true, 'res', 'win32', w.fs), bin);
  assert.equal(coreLaunchPath(true, 'res', 'win32', world({}).fs), bin);
  // Elsewhere there is no second name.
  assert.equal(coreLaunchPath(true, 'res', 'linux', world({}).fs), join('res', 'core', 'mixdogd'));
  assert.equal(coreLaunchPath(false, 'res', 'win32', world({}).fs), process.env.MIXDOGD_BIN || 'mixdogd');
});

test('a quit waits for the core this app started, and no longer than it is given', async () => {
  // None started, or one that has ended: nothing to wait for.
  assert.equal(await coreExit(null, 10), true);
  assert.equal(await coreExit({ exitCode: 0, signalCode: null, once() {} }, 10), true);
  // A running core is waited for until it ends.
  const running = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const ended = coreExit(running, 5_000);
  running.emit('exit');
  assert.equal(await ended, true);
  // One that does not end is given up on at the limit.
  const stuck = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  assert.equal(await coreExit(stuck, 20), false);
});

test('a quit asks only the core this app started to stop, and does not wait past its limit', async () => {
  const ours = { pid: 7, exitCode: null, signalCode: null, once() {} };
  const runs = [];
  const ctl = (code) => (bin, args, options) => {
    runs.push({ bin, args, env: options.env });
    const child = new EventEmitter();
    if (code !== undefined) setImmediate(() => child.emit('exit', code));
    return child;
  };
  const named = (pid) => async () => ({ pid });
  const ask = (overrides) =>
    requestCoreStop({
      child: ours,
      bin: 'mixdogd',
      runtimeRoot: 'rt',
      env: { A: '1' },
      timeoutMs: 50,
      spawnImpl: ctl(0),
      readDiscovery: named(7),
      ...overrides,
    });
  const kind = async (overrides) => (await ask(overrides)).request;
  // A quit's stop is forced: the app has detached, so nothing could confirm an abort, and a stop that waits for idle never ends a busy core.
  assert.equal(await kind(), 'sent');
  assert.deepEqual(runs.pop(), {
    bin: 'mixdogd',
    args: ['ctl', 'stop', '--force', '--reason', 'userStop', '--json'],
    env: { A: '1', MIXDOG_RUNTIME_ROOT: 'rt' },
  });
  // The discovery file names another core: it is not ours to stop.
  assert.equal(await kind({ readDiscovery: named(8) }), 'not-ours');
  assert.equal(
    (
      await ask({
        readDiscovery: async () => {
          throw new Error('absent');
        },
      })
    ).request,
    'refused'
  );
  // No core started, or one that has ended.
  assert.equal(await kind({ child: null }), 'none');
  assert.equal(await kind({ child: { ...ours, exitCode: 0 } }), 'none');
  assert.equal(runs.length, 0);
  // A refused request says why, and one that does not answer within the limit is told apart.
  const refused = await ask({ spawnImpl: ctl(1) });
  assert.equal(refused.request, 'refused');
  assert.match(refused.error, /exited 1/);
  assert.equal(await kind({ spawnImpl: ctl(undefined) }), 'unanswered');
});

test('the app is told the core process it starts', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1, unref() {} });
  const told = [];
  const resolve = resolveLocalCore({
    runtimeRoot: 'unused',
    bin: 'mixdogd',
    environmentReady: async () => {},
    onLaunched: (started) => told.push(started),
    spawnImpl: (_bin, _args, options) => {
      assert.equal(options.detached, false);
      return child;
    },
    // The routine starts a core and is done: discovery is not what this test reads.
    ensure: async ({ launch }) => {
      queueMicrotask(() => child.emit('spawn'));
      await launch({ log() {} });
      throw new Error('stop here');
    },
  });
  await assert.rejects(resolve(), /stop here/);
  assert.deepEqual(told, [child]);
});

test('the core is started on the runtime root the app selected', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1, unref() {} });
  let spawnedEnv;
  const resolve = resolveLocalCore({
    runtimeRoot: join('tmp', 'mixdog'),
    bin: 'mixdogd',
    env: () => ({ PATH: 'p' }),
    environmentReady: async () => {},
    spawnImpl: (_bin, _args, options) => {
      spawnedEnv = options.env;
      return child;
    },
    ensure: async ({ launch }) => {
      queueMicrotask(() => child.emit('spawn'));
      await launch({ log() {} });
      throw new Error('stop here');
    },
  });
  await assert.rejects(resolve(), /stop here/);
  assert.deepEqual(spawnedEnv, { PATH: 'p', MIXDOG_RUNTIME_ROOT: join('tmp', 'mixdog') });
});

test('launching the core spawns it detached with the given environment', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-core-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const spawned = [];
  const spawnImpl = (bin, args, options) => {
    spawned.push({ bin, args, options });
    return {
      once(event, listener) {
        if (event === 'spawn') queueMicrotask(listener);
      },
      unref() {},
    };
  };
  const env = { MIXDOG_ROOT: 'x' };
  await launchCore({
    bin: 'mixdogd',
    env,
    spawnImpl,
    beginCapture: (options) => beginDaemonSpawnCapture({ ...options, dataDir, prune: false }),
  });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['serve']);
  assert.equal(spawned[0].options.env, env);
  assert.equal(spawned[0].options.detached, true);
});
test('a launcher that owns its core starts it as an ordinary child', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-core-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const spawned = [];
  const spawnImpl = (_bin, _args, options) => {
    spawned.push(options);
    return {
      once(event, listener) {
        if (event === 'spawn') queueMicrotask(listener);
      },
      unref() {},
    };
  };
  await launchCore({
    bin: 'mixdogd',
    detached: false,
    spawnImpl,
    beginCapture: (options) => beginDaemonSpawnCapture({ ...options, dataDir, prune: false }),
  });
  assert.equal(spawned[0].detached, false);
});
test('the launched core writes fd 2 into its boot capture, which records its ready and its exit', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-core-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const spawned = [];
  const child = Object.assign(new EventEmitter(), { pid: 5150, unref: () => {} });
  const capture = await launchCore({
    bin: 'mixdogd',
    spawnImpl: (bin, args, options) => {
      spawned.push({ bin, args, options });
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    beginCapture: (options) => beginDaemonSpawnCapture({ ...options, dataDir, prune: false }),
  });
  assert.deepEqual(
    spawned.map(({ bin, args }) => [bin, ...args]),
    [['mixdogd', 'serve']]
  );
  assert.equal(spawned[0].options.detached, true);
  assert.equal(typeof spawned[0].options.stdio[2], 'number', 'fd 2 is the capture file');
  assert.ok(capture.capturePath.startsWith(join(dataDir, 'daemon-crash')));
  capture.noteReady();
  writeFileSync(capture.capturePath, 'thread main panicked: the core lost its store\n');
  child.emit('exit', 101, null);
  const record = JSON.parse(readFileSync(capture.recordPath, 'utf8'));
  assert.equal(record.launcher, 'core');
  assert.equal(record.pid, 5150);
  assert.equal(record.ready, true);
  assert.equal(record.exitCode, 101);
  assert.equal(record.exitReason, 'exited with code 101');
  assert.ok(record.stderrBytes > 0);
});
test('the desktop waits for a core that takes 20 s to serve, as a large profile makes it (the library default gives up at 15 s)', async () => {
  const serving = { state: 'serving', rpcPort: 4242, blocked: null };
  const run = async (readyTimeoutMs) => {
    let clock = 0;
    return ensureCore({
      readDiscovery: async () => {
        if (clock < 20_000) {
          if (clock === 0) throw Object.assign(new Error('absent'), { name: 'CoreDiscoveryError', code: 'absent' });
          return { state: 'booting', rpcPort: null, blocked: null };
        }
        return serving;
      },
      launch: async () => {},
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      readyTimeoutMs,
    });
  };
  await assert.rejects(run(undefined), /core is not ready/);
  assert.deepEqual(await run(DESKTOP_CORE_READY_TIMEOUT_MS), serving);

  let asked;
  const endpoint = resolveLocalCore({
    runtimeRoot: 'unused',
    bin: 'mixdogd',
    environmentReady: async () => {},
    ensure: async (options) => {
      asked = options;
    },
  });
  await endpoint().catch(() => {});
  assert.equal(asked.readyTimeoutMs, DESKTOP_CORE_READY_TIMEOUT_MS);
});

test('a discovery file left by a process that no longer runs names no core: one is started, whatever the file says', async () => {
  const leftBehind = [
    { state: 'unknown', rpcPort: null, blocked: null, pid: 4242 },
    { state: 'serving', rpcPort: 5151, blocked: null, pid: 4242 },
    { state: 'booting', rpcPort: null, blocked: null, pid: 4242 },
  ];
  const started = { state: 'serving', rpcPort: 6060, blocked: null, pid: 99 };
  for (const stale of leftBehind) {
    let clock = 0;
    let launches = 0;
    const served = await ensureCore({
      // The started core replaces the file once it is up.
      readDiscovery: async () => (launches && clock >= 300 ? started : stale),
      launch: async () => {
        launches += 1;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      readyTimeoutMs: DESKTOP_CORE_READY_TIMEOUT_MS,
      runs: (pid) => pid === 99,
    });
    assert.deepEqual(served, started, `left behind as ${stale.state}`);
    assert.equal(launches, 1, `left behind as ${stale.state}`);
  }
  // An unrecognized live discovery is not enough evidence to start a contender.
  let clock = 0;
  let launches = 0;
  await assert.rejects(
    ensureCore({
      readDiscovery: async () => leftBehind[0],
      launch: async () => {
        launches += 1;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      readyTimeoutMs: 1_000,
      runs: () => true,
    }),
    /core is not ready: the core is unknown/
  );
  assert.equal(launches, 0);
});

test('live legacy discovery starts one Rust contender and reports its prior-owner verdict', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'local-core-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'daemon.json');
  writeFileSync(file, JSON.stringify({ protocol: 1, revision: 6, pid: 41, endpoints: { session: { port: 4242 } } }));
  const blocked = { kind: 'waitExit', pid: 41 };
  let clock = 0;
  let launches = 0;
  await assert.rejects(
    ensureCore({
      readDiscovery: () => readCoreState(root),
      launch: async () => {
        launches++;
      },
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 100) writeFileSync(file, JSON.stringify({ pid: 42, core: { state: 'blocked', blocked } }));
      },
      now: () => clock,
      runs: () => true,
      readyTimeoutMs: 500,
    }),
    (error) => {
      assert.deepEqual(error.coreDiscovery?.blocked, blocked);
      return true;
    }
  );
  assert.equal(launches, 1);
});

test('a core that ends abnormally before serving fails the start at once with its exit, not after the whole wait', async () => {
  const absent = () => Object.assign(new Error('absent'), { name: 'CoreDiscoveryError', code: 'absent' });
  // The launched core (pid 77) is seen ended at `exitAt` on the test's clock; `discovery` is what the file says then.
  const run = async ({ exit, exitAt = 150, discovery }) => {
    let clock = 0;
    const capture = {
      snapshot: () => (clock >= exitAt ? { pid: 77, exitedAt: 'then', ...exit } : { pid: 77, exitedAt: null }),
      summary: () => ({
        exitReason: null,
        stderrErrorLine: 'Error: the store is locked',
        stderrLastLine: null,
        stderrPath: 'capture.err.log',
      }),
    };
    const outcome = await ensureCore({
      readDiscovery: async () => {
        const said = discovery(clock);
        if (!said) throw absent();
        return said;
      },
      launch: async () => capture,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      readyTimeoutMs: DESKTOP_CORE_READY_TIMEOUT_MS,
      // The other core (88) runs; the launched one (77) until its exit is seen.
      runs: (pid) => pid === 88 || (pid === 77 && clock < exitAt),
    }).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    return { ...outcome, clock };
  };
  const booting = (pid) => ({ state: 'booting', rpcPort: null, blocked: null, pid });
  const serving = (pid) => ({ state: 'serving', rpcPort: 4242, blocked: null, pid });

  // Nothing published: the failure comes when the exit is seen, with the exit and the core's own words.
  const crashed = await run({ exit: { exitCode: 101, exitSignal: null }, discovery: () => null });
  assert.equal(
    crashed.error?.message,
    'core is not ready: the core ended before serving (exited with code 101): Error: the store is locked'
  );
  assert.deepEqual(crashed.error.coreExit, { code: 101, signal: null, reason: null, stderrPath: 'capture.err.log' });
  assert.equal(crashed.clock, 150);
  // The file it left behind still names it: the same.
  const stale = await run({
    exit: { exitCode: null, exitSignal: 'SIGKILL' },
    discovery: (at) => (at >= 50 ? booting(77) : null),
  });
  assert.equal(
    stale.error?.message,
    'core is not ready: the core ended before serving (killed by SIGKILL): Error: the store is locked'
  );
  assert.equal(stale.clock, 150);
  // Another core holds the folder: a contender that ended cleanly, or one that ended while the file names the other core, is waited out.
  const lostClaim = await run({
    exit: { exitCode: 0, exitSignal: null },
    discovery: (at) => (at >= 20_000 ? serving(88) : null),
  });
  assert.deepEqual(lostClaim.value, serving(88));
  const otherCore = await run({
    exit: { exitCode: 1, exitSignal: null },
    discovery: (at) => (at >= 20_000 ? serving(88) : at >= 50 ? booting(88) : null),
  });
  assert.deepEqual(otherCore.value, serving(88));
});
test('a core left running at quit is ended with its process tree on Windows, and a gone core is left alone', () => {
  const calls = [];
  const spawnImpl = (bin, args) => {
    calls.push([bin, ...args]);
    const child = new EventEmitter();
    child.unref = () => {};
    return child;
  };
  const running = { pid: 4321, exitCode: null, signalCode: null, once() {} };
  assert.equal(forceEndCore(running, { platform: 'win32', spawnImpl }), true);
  assert.deepEqual(calls, [['taskkill', '/PID', '4321', '/T', '/F']]);
  assert.equal(forceEndCore({ ...running, exitCode: 0 }, { platform: 'win32', spawnImpl }), false);
  assert.equal(forceEndCore(null, { platform: 'win32', spawnImpl }), false);
  assert.equal(calls.length, 1);
});

const booting = (rebuild) => ({ state: 'booting', rpcPort: null, blocked: null, rebuild });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the launcher reports the core's index rebuild while it waits, each change once, and nothing for a start without one", async () => {
  const run = async (states) => {
    let step = 0;
    const told = [];
    await ensureCore({
      readDiscovery: async () => states[step++] ?? { state: 'serving', rpcPort: 4242, blocked: null, rebuild: null },
      launch: async () => {},
      sleep: async () => {},
      now: () => 0,
      readyTimeoutMs: DESKTOP_CORE_READY_TIMEOUT_MS,
      onProgress: (progress) => told.push(progress),
    });
    await tick();
    return told;
  };
  assert.deepEqual(
    await run([
      booting(null),
      booting({ done: 0, total: 3 }),
      booting({ done: 0, total: 3 }),
      booting({ done: 2, total: 3 }),
      booting({ done: 3, total: 3 }),
    ]),
    [{ done: 0, total: 3 }, { done: 2, total: 3 }, { done: 3, total: 3 }, null],
    'counts as they advance, then withdrawn when the core serves'
  );
  assert.deepEqual(await run([booting(null), booting(null)]), [], 'a normal start reports nothing');
  assert.deepEqual(
    await run([{ state: 'migrating', rpcPort: null, blocked: null, rebuild: null }]),
    [],
    'a conversion of older data (no counts) reports nothing'
  );
});

test('a report belongs to its call: it is withdrawn when the call throws on a read error or at its deadline', async () => {
  const told = [];
  const base = {
    launch: async () => {},
    sleep: async () => {},
    readyTimeoutMs: 1_000,
    ping: async () => ({ answered: false, stalledMs: 0 }),
    onProgress: (p) => told.push(p),
  };
  let step = 0;
  await assert.rejects(
    ensureCore({
      ...base,
      now: () => 0,
      readDiscovery: async () => {
        if (step++ === 0) return booting({ done: 1, total: 4 });
        throw new Error('EACCES');
      },
    }),
    /EACCES/
  );
  await tick();
  assert.deepEqual(told, [{ done: 1, total: 4 }, null], 'a failed read withdraws the report');
  told.length = 0;
  let clock = 0;
  await assert.rejects(
    ensureCore({
      ...base,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      readDiscovery: async () => booting({ done: 1, total: 4 }),
    }),
    /core is not ready/
  );
  await tick();
  assert.deepEqual(told, [{ done: 1, total: 4 }, null], 'the deadline withdraws it');
});

test("a launch attempt owns its reports: nothing it said outlives it, whichever way it ends, and one attempt's end leaves another's alone", () => {
  const reports = new BootReports();
  const a = reports.attempt();
  const b = reports.attempt();
  a.progress({ done: 1, total: 5 }, 7);
  b.progress({ done: 2, total: 5 }, 7);
  assert.deepEqual(reports.current().progress, { done: 2, total: 5, boot: 7 });
  b.failed(new Error('timed out'));
  assert.deepEqual(
    reports.current().progress,
    { done: 2, total: 5, boot: 7 },
    'the other attempt still stands, and what the boot reached is not taken back'
  );
  a.progress(null, null);
  assert.equal(reports.current().progress, null);
  const c = reports.attempt();
  c.progress({ done: 3, total: 5 }, 7);
  c.failed(new Error('read error'));
  assert.equal(reports.current().progress, null, 'a failed attempt leaves no count behind');
  c.progress({ done: 4, total: 5 }, 7);
  assert.equal(reports.current().progress, null, 'a late report of an ended attempt is ignored');
  const d = reports.attempt();
  d.progress({ done: 5, total: 5 }, 7);
  d.succeeded();
  assert.equal(reports.current().progress, null);
});

test("one core boot's counts never decrease on screen, whichever attempt read them; a new boot starts again", () => {
  const reports = new BootReports();
  const seen = [];
  reports.subscribe((report) => seen.push(report.progress && `${report.progress.boot}:${report.progress.done}`));
  const older = reports.attempt();
  const newer = reports.attempt();
  newer.progress({ done: 6, total: 10 }, 11);
  older.progress({ done: 4, total: 10 }, 11);
  assert.equal(reports.current().progress.done, 6, 'an older reading of the same boot is not shown');
  newer.failed(new Error('gone'));
  assert.equal(reports.current().progress.done, 6, 'ending the newer attempt exposes no older cached value');
  older.progress({ done: 7, total: 10 }, 11);
  assert.equal(reports.current().progress.done, 7);
  older.progress(null, null);
  assert.equal(reports.current().progress, null, 'withdrawn');
  const later = reports.attempt();
  later.progress({ done: 5, total: 10 }, 11);
  assert.equal(
    reports.current().progress.done,
    7,
    'a later reading of the same boot does not show less than was reached'
  );
  later.succeeded();
  assert.equal(reports.current().progress, null);
  const next = reports.attempt();
  next.progress({ done: 0, total: 10 }, 12);
  assert.deepEqual(reports.current().progress, { done: 0, total: 10, boot: 12 }, 'a new boot starts at zero');
  assert.ok(
    seen.every(
      (value, index) =>
        index === 0 ||
        value === null ||
        seen[index - 1] === null ||
        Number(value.split(':')[0]) !== Number(seen[index - 1].split(':')[0]) ||
        Number(value.split(':')[1]) >= Number(seen[index - 1].split(':')[1])
    ),
    `never decreasing within a boot: ${seen}`
  );
});

test('a core that exits at boot with the same recorded outcome again is a start that cannot succeed, whatever its stderr said; a different outcome or one exit read twice is not', () => {
  const exited = (path, code = 2, said = 'no manifest', signal = null, reason = `exited with code ${code}`) =>
    Object.assign(new Error(`core is not ready: the core ended before serving (${reason}): ${said}`), {
      coreExit: { code, signal, reason, stderrPath: path },
    });
  const reports = new BootReports();
  const outcome = (error) => reports.attempt().failed(error);
  const permanent = (error) => Boolean(error.coreLaunchFailed);
  const first = exited('a', 2, '[2026-11-19T01:00:00Z] pid 4001: C:\\tmp\\a1\\x not found');
  assert.equal(permanent(outcome(first)), false, 'the first exit is an ordinary failure');
  assert.equal(reports.current().failure, null);
  assert.equal(
    permanent(outcome(exited('a', 2, 'other text'))),
    false,
    'the same capture seen again (an overlapping attempt) is not a second exit'
  );
  assert.equal(permanent(outcome(exited('b', 3, 'x'))), false, 'a different code is a new first');
  assert.equal(permanent(outcome(exited('c', 3, 'y', 'SIGSEGV'))), false, 'a different signal is a new first');
  assert.equal(
    permanent(
      outcome(exited('c2', 3, 'y', 'SIGSEGV', 'unrecorded-termination: the daemon ended without running any exit hook'))
    ),
    false,
    'the same code and signal with another recorded reason is a new first'
  );
  const again = outcome(
    exited(
      'd',
      3,
      '[2026-11-19T01:00:05Z] pid 4002: C:\\tmp\\b2\\y',
      'SIGSEGV',
      'unrecorded-termination: the daemon ended without running any exit hook'
    )
  );
  assert.ok(permanent(again), 'the same code and signal, other timestamps, pids and paths in the stderr line');
  assert.equal(reports.current().failure.exitCode, 3);
  assert.equal(reports.current().failure.stderrPath, 'd');
  assert.match(reports.current().failure.message, /pid 4002/, "the launcher's sentence is the detail shown");
  const unrelated = new Error('EACCES: daemon.json');
  assert.equal(outcome(unrelated), unrelated, "an error that is neither an exit nor the launcher's verdict is not confirmed");
  reports.attempt().succeeded();
  assert.equal(reports.current().failure, null, 'a core observed serving supersedes it');
  reports.attempt().failed(exited('e0'));
  reports.attempt().failed(exited('e1'));
  assert.ok(reports.current().failure);
  reports.retry();
  assert.equal(reports.current().failure, null);
  assert.equal(permanent(outcome(exited('e', 7))), false, 'a different outcome after Try again is a new first');
});

test('a core whose binary cannot be started is a confirmed failure at the first attempt, and is not started again until Try again', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-core-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const reports = new BootReports();
  const heard = [];
  reports.subscribe((report) => heard.push(report.failure));
  let spawns = 0;
  const resolve = resolveLocalCore({
    runtimeRoot: 'unused',
    bin: join('res', 'core', 'mixdogd.exe'),
    environmentReady: async () => {},
    reports,
    beginCapture: (options) => beginDaemonSpawnCapture({ ...options, dataDir, prune: false }),
    spawnImpl: () => {
      spawns += 1;
      const child = Object.assign(new EventEmitter(), { unref() {} });
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn mixdogd ENOENT'), { code: 'ENOENT' })));
      return child;
    },
    ensure: (options) =>
      ensureCore({
        ...options,
        sleep: async () => {},
        readDiscovery: async () => {
          throw Object.assign(new Error('no core is running'), { name: 'CoreDiscoveryError', code: 'absent' });
        },
      }),
  });
  const first = await resolve().catch((error) => error);
  assert.match(first.message, /cannot start .*mixdogd\.exe: spawn mixdogd ENOENT/);
  assert.ok(first.coreLaunchFailed, 'the window is answered launchFailed, not an error to redial on');
  assert.equal(first.coreLaunchFailed, reports.confirmed());
  assert.deepEqual(heard, [{ message: first.message, exitCode: null, stderrPath: null }]);
  const second = await resolve().catch((error) => error);
  assert.equal(second.coreLaunchFailed, reports.confirmed());
  assert.equal(spawns, 1, 'a redial does not start it again');
  reports.retry();
  await resolve().catch(() => {});
  assert.equal(spawns, 2, 'Try again does');
  assert.ok(reports.confirmed());
});

test("a wait for the core that ends with none serving (never published, stalled, blocked) is confirmed when the launcher's limit runs out", async () => {
  const LIMIT_MS = 2_000;
  const waitedOut = async (discovery) => {
    const reports = new BootReports();
    let clock = 0;
    const resolve = resolveLocalCore({
      runtimeRoot: 'unused',
      bin: 'mixdogd',
      environmentReady: async () => {},
      reports,
      ensure: (options) =>
        ensureCore({
          ...options,
          readyTimeoutMs: LIMIT_MS,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          readDiscovery: async () => discovery,
          ping: async () => ({ answered: false, stalledMs: 0 }),
        }),
    });
    const error = await resolve().catch((thrown) => thrown);
    assert.equal(error.coreLaunchFailed, reports.confirmed());
    return { error, clock, failure: reports.current().failure };
  };
  const held = { rpcPort: null, pid: process.pid, controlPort: null, token: null, rebuild: null };
  const booting = await waitedOut({ ...held, state: 'booting', blocked: null });
  assert.match(booting.failure.message, /core is not ready: the core is booting/);
  assert.equal(booting.clock, LIMIT_MS, 'after the whole wait, once');
  const blocked = await waitedOut({ ...held, state: 'blocked', blocked: { reason: 'dataVersion' } });
  assert.match(blocked.failure.message, /the core is blocked \(\{"reason":"dataVersion"\}\)/);
  assert.equal(blocked.clock, 0, 'a blocked core is not waited for');
});

test('a confirmed failure stays until the user chooses Try again: other attempts do not clear it, and no launch is made meanwhile', async () => {
  const reports = new BootReports();
  const heard = [];
  const exited = (path) =>
    Object.assign(new Error('ended'), {
      coreExit: { code: 2, signal: null, reason: 'exited with code 2', stderrPath: path },
    });
  reports.attempt().failed(exited('a'));
  reports.attempt().failed(exited('b'));
  const confirmed = reports.confirmed();
  assert.ok(confirmed);
  reports.subscribe((report) => heard.push(report));
  let launched = 0;
  let retried = false;
  const resolve = resolveLocalCore({
    runtimeRoot: 'unused',
    bin: 'mixdogd',
    environmentReady: async () => {},
    reports,
    ensure: async (options) => {
      if (!retried) return options.launch(); // the latch refuses a launch
      launched += 1;
      throw exited('c');
    },
  });
  for (let i = 0; i < 3; i += 1) {
    const error = await resolve().catch((e) => e);
    assert.equal(error.coreLaunchFailed, confirmed, 'background resolutions get the confirmed failure');
  }
  assert.equal(launched, 0, 'nothing launches the core');
  assert.equal(reports.confirmed(), confirmed);
  assert.deepEqual(heard, [], 'nothing was told: the card does not alternate with the mark');
  reports.retry();
  retried = true;
  assert.equal(reports.confirmed(), null, "the user's action clears it");
  const after = await resolve().catch((e) => e);
  assert.equal(launched, 1, 'and the next resolution launches');
  assert.ok(
    after.coreLaunchFailed && reports.confirmed(),
    'the same exit recorded again after Try again is confirmed at once'
  );
});
test('the latch governs attempts already in flight: one that waited on the core does not launch it, and its end, whichever way, does not clear the failure', async () => {
  const reports = new BootReports();
  const exited = (path, code) =>
    Object.assign(new Error(`ended ${code}`), {
      coreExit: { code, signal: null, reason: `exited with code ${code}`, stderrPath: path },
    });
  let release;
  const waiting = new Promise((resolve) => (release = resolve));
  let launched = 0;
  let paths = 0;
  const inFlight = resolveLocalCore({
    runtimeRoot: 'unused',
    bin: 'mixdogd',
    environmentReady: async () => {},
    reports,
    ensure: async (options) => {
      await waiting;
      await options.launch();
      launched += 1;
    },
  })().catch((error) => error);
  const other = resolveLocalCore({
    runtimeRoot: 'unused',
    bin: 'mixdogd',
    environmentReady: async () => {},
    reports,
    ensure: async () => {
      throw exited(`p${paths++}`, 2);
    },
  });
  await other().catch(() => {});
  await other().catch(() => {});
  const confirmed = reports.confirmed();
  assert.ok(confirmed, 'confirmed while the first attempt still waits');
  release();
  const result = await inFlight;
  assert.equal(launched, 0, 'it did not launch');
  assert.equal(result.coreLaunchFailed, confirmed);
  // an in-flight attempt that ends for another reason leaves the latch alone
  reports.attempt().failed(exited('z', 9));
  assert.equal(reports.confirmed(), confirmed);
  reports.retry();
  assert.equal(reports.confirmed(), null);
});

test('a confirmed failure does not keep a working core behind the card: an attempt attaches to a serving core without launching and the failure is superseded', async () => {
  const reports = new BootReports();
  const exited = (path) =>
    Object.assign(new Error('ended'), {
      coreExit: { code: 2, signal: null, reason: 'exited with code 2', stderrPath: path },
    });
  reports.attempt().failed(exited('a'));
  reports.attempt().failed(exited('b'));
  assert.ok(reports.confirmed());
  const heard = [];
  reports.subscribe((report) => heard.push(report.failure));
  const launches = 0;
  const serving = { state: 'serving', rpcPort: 4242, blocked: null };
  const resolve = resolveLocalCore({
    runtimeRoot: 'unused',
    bin: 'mixdogd',
    environmentReady: async () => {},
    reports,
    ensure: async () => serving,
  });
  await resolve().catch((error) =>
    assert.match(String(error), /daemon\.json|ENOENT/, 'only the discovery read after ensure may fail here')
  );
  assert.equal(reports.confirmed(), null, 'observing a serving core supersedes the failure');
  assert.deepEqual(heard, [null], 'the windows are told once');
  assert.equal(launches, 0);
});
test("a superseded boot's late readings never become current again: A:9, B:1, then A:8 leaves B's bar", () => {
  const reports = new BootReports();
  const a = reports.attempt();
  const b = reports.attempt();
  a.progress({ done: 9, total: 10 }, 1);
  b.progress({ done: 1, total: 10 }, 2);
  assert.deepEqual(reports.current().progress, { done: 1, total: 10, boot: 2 });
  a.progress({ done: 8, total: 10 }, 1);
  assert.deepEqual(
    reports.current().progress,
    { done: 1, total: 10, boot: 2 },
    "A's late reading does not replace B's"
  );
  b.progress({ done: 4, total: 10 }, 2);
  b.progress({ done: 3, total: 10 }, 2);
  assert.equal(reports.current().progress.done, 4, 'each boot keeps its own highest');
});
test('resolveLocalCore reports each call as one attempt and rethrows what the launcher threw, marked once the same exit repeats', async () => {
  const reports = new BootReports();
  const ended = (path) =>
    Object.assign(new Error('core is not ready: the core ended before serving (exited with code 2): no manifest'), {
      coreExit: { code: 2, signal: null, reason: 'exited with code 2', stderrPath: path },
    });
  let step = 0;
  const resolve = resolveLocalCore({
    runtimeRoot: 'unused',
    bin: 'mixdogd',
    environmentReady: async () => {},
    reports,
    ensure: async (options) => {
      options.onProgress({ done: 1, total: 2 }, 9);
      throw ended(`p${step++}`);
    },
  });
  const first = await resolve().catch((error) => error);
  assert.match(first.message, /no manifest/);
  assert.equal(first.coreLaunchFailed, undefined);
  assert.equal(reports.current().progress, null, 'its progress ended with it');
  const second = await resolve().catch((error) => error);
  assert.match(second.message, /no manifest/);
  assert.equal(second.coreLaunchFailed.exitCode, 2);
});
test("the discovery file's rebuild counts are read only when they count something", async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-core-state-'));
  try {
    const read = async (core) => {
      writeFileSync(
        join(root, 'daemon.json'),
        JSON.stringify({ pid: 1, endpoints: { session: { token: 't' } }, core })
      );
      return (await readCoreState(root)).rebuild;
    };
    assert.deepEqual(await read({ state: 'booting', rebuild: { done: 5, total: 20 } }), { done: 5, total: 20 });
    assert.equal(await read({ state: 'booting' }), null, 'absent without a rebuild');
    assert.equal(await read({ state: 'migrating', rebuild: { done: 0, total: 0 } }), null, 'no counts, no bar');
    assert.equal(await read({ state: 'serving', rpc: { port: 1 } }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
