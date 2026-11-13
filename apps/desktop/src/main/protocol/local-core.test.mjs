import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { beginDaemonSpawnCapture } from '../../../../../packages/protocol-client/src/launch/crash-capture/spawn-capture.mjs';
import { launchCore } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import { ensureCore } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import { coreBinaryPath, coreEnvironment, coreExit, coreLaunchPath, DESKTOP_CORE_READY_TIMEOUT_MS, packagedMixdogRoot, resolveLocalCore } from './local-core.ts';

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

test('the app is told the core process it starts', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1, unref() {} });
  const told = [];
  const resolve = resolveLocalCore({
    runtimeRoot: 'unused',
    bin: 'mixdogd',
    environmentReady: async () => {},
    onLaunched: (started) => told.push(started),
    spawnImpl: (bin, args, options) => {
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
  await launchCore({ bin: 'mixdogd', env, spawnImpl, beginCapture: (options) => beginDaemonSpawnCapture({ ...options, dataDir, prune: false }) });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['serve']);
  assert.equal(spawned[0].options.env, env);
  assert.equal(spawned[0].options.detached, true);
});
test('a launcher that owns its core starts it as an ordinary child', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-core-'));
  context.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const spawned = [];
  const spawnImpl = (bin, args, options) => {
    spawned.push(options);
    return {
      once(event, listener) {
        if (event === 'spawn') queueMicrotask(listener);
      },
      unref() {},
    };
  };
  await launchCore({ bin: 'mixdogd', detached: false, spawnImpl, beginCapture: (options) => beginDaemonSpawnCapture({ ...options, dataDir, prune: false }) });
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
  assert.deepEqual(spawned.map(({ bin, args }) => [bin, ...args]), [['mixdogd', 'serve']]);
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
      sleep: async (ms) => void (clock += ms),
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
    ensure: async (options) => void (asked = options),
  });
  await endpoint().catch(() => {});
  assert.equal(asked.readyTimeoutMs, DESKTOP_CORE_READY_TIMEOUT_MS);
});

test('a discovery file left by a process that no longer runs names no core: one is started, whatever the file says', async () => {
  // What a killed 1.4.5 daemon leaves (no `core` section, so its state reads `unknown`), and what a killed core leaves.
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
      launch: async () => void (launches += 1),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      readyTimeoutMs: DESKTOP_CORE_READY_TIMEOUT_MS,
      runs: (pid) => pid === 99,
    });
    assert.deepEqual(served, started, `left behind as ${stale.state}`);
    assert.equal(launches, 1, `left behind as ${stale.state}`);
  }
  // The same file while its process runs is that core's: none is started beside it.
  let clock = 0;
  let launches = 0;
  await assert.rejects(
    ensureCore({
      readDiscovery: async () => leftBehind[0],
      launch: async () => void (launches += 1),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      readyTimeoutMs: 1_000,
      runs: () => true,
    }),
    /core is not ready: the core is unknown/
  );
  assert.equal(launches, 0);
});

test('a core that ends abnormally before serving fails the start at once with its exit, not after the whole wait', async () => {
  const absent = () => Object.assign(new Error('absent'), { name: 'CoreDiscoveryError', code: 'absent' });
  // The launched core (pid 77) is seen ended at `exitAt` on the test's clock; `discovery` is what the file says then.
  const run = async ({ exit, exitAt = 150, discovery }) => {
    let clock = 0;
    const capture = {
      snapshot: () => (clock >= exitAt ? { pid: 77, exitedAt: 'then', ...exit } : { pid: 77, exitedAt: null }),
      summary: () => ({ exitReason: null, stderrErrorLine: 'Error: the store is locked', stderrLastLine: null, stderrPath: 'capture.err.log' }),
    };
    const outcome = await ensureCore({
      readDiscovery: async () => {
        const said = discovery(clock);
        if (!said) throw absent();
        return said;
      },
      launch: async () => capture,
      sleep: async (ms) => void (clock += ms),
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
  assert.equal(crashed.error?.message, 'core is not ready: the core ended before serving (exited with code 101): Error: the store is locked');
  assert.deepEqual(crashed.error.coreExit, { code: 101, signal: null, stderrPath: 'capture.err.log' });
  assert.equal(crashed.clock, 150);
  // The file it left behind still names it: the same.
  const stale = await run({ exit: { exitCode: null, exitSignal: 'SIGKILL' }, discovery: (at) => (at >= 50 ? booting(77) : null) });
  assert.equal(stale.error?.message, 'core is not ready: the core ended before serving (killed by SIGKILL): Error: the store is locked');
  assert.equal(stale.clock, 150);
  // Another core holds the folder: a contender that ended cleanly, or one that ended while the file names the other core, is waited out.
  const lostClaim = await run({ exit: { exitCode: 0, exitSignal: null }, discovery: (at) => (at >= 20_000 ? serving(88) : null) });
  assert.deepEqual(lostClaim.value, serving(88));
  const otherCore = await run({ exit: { exitCode: 1, exitSignal: null }, discovery: (at) => (at >= 20_000 ? serving(88) : at >= 50 ? booting(88) : null) });
  assert.deepEqual(otherCore.value, serving(88));
});