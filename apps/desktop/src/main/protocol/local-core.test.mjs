import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { beginDaemonSpawnCapture } from '../../../../../packages/protocol-client/src/launch/crash-capture/spawn-capture.mjs';
import { launchCore } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import { ensureCore } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import { coreBinaryPath, coreEnvironment, DESKTOP_CORE_READY_TIMEOUT_MS, packagedMixdogRoot, resolveLocalCore } from './local-core.ts';

test('a packaged app tells the core where its unpacked resources are; a development run leaves the environment alone', () => {
  const base = { PATH: 'p' };
  const resources = join('r', 'resources');
  assert.deepEqual(coreEnvironment(true, resources, base), {
    PATH: 'p',
    MIXDOG_ROOT: join(resources, 'runtime.asar.unpacked', 'node_modules', 'mixdog', 'src'),
  });
  assert.equal(packagedMixdogRoot(resources), coreEnvironment(true, resources, {}).MIXDOG_ROOT);
  assert.equal(coreEnvironment(false, resources, base), base);
});

test('the packaged core binary sits beside the resources', () => {
  assert.equal(coreBinaryPath(true, 'res', 'win32'), join('res', 'core', 'mixdogd.exe'));
  assert.equal(coreBinaryPath(true, 'res', 'linux'), join('res', 'core', 'mixdogd'));
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