import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bridgeDiscoveryChanged, readBridgeDiscovery } from './bridge-discovery.mjs';
import { SAFETY_RECHECK_MS, _resetWatchedFileCachesForTest } from './shared/watched-file-cache.mjs';
import { eventually, settle, spySyncFs } from './shared/watched-file-cache.test-helpers.mjs';

const FILE = 'test-bridge.json';

function discoveryFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-bridge-discovery-'));
  const previous = process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
  process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = dir;
  t.after(() => {
    _resetWatchedFileCachesForTest();
    if (previous === undefined) delete process.env.MIXDOG_BRIDGE_DISCOVERY_DIR;
    else process.env.MIXDOG_BRIDGE_DISCOVERY_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const publish = (port) =>
    writeFileSync(join(dir, FILE), JSON.stringify({ version: 1, port, token: 't', pid: process.pid }));
  return { publish };
}

const port = () => readBridgeDiscovery(FILE)?.port ?? null;

test('warm discovery reads touch no filesystem; a missing file appears through the watch', async (t) => {
  const { publish } = discoveryFixture(t);
  assert.equal(port(), null);
  const calls = spySyncFs(t);
  assert.equal(port(), null);
  assert.deepEqual(calls.splice(0), [], 'a missing file is remembered too');
  calls.paused = true;
  publish(4000);
  await eventually(() => port() === 4000);
  calls.paused = false;
  for (let i = 0; i < 5; i += 1) assert.equal(port(), 4000);
  assert.deepEqual([...calls], []);
});

test('an atomic replacement of the advertisement is seen through the watch', async (t) => {
  const { publish } = discoveryFixture(t);
  publish(4000);
  assert.equal(port(), 4000);
  publish(4001);
  await eventually(() => port() === 4001);
});

test('without watch events the safety re-check sees a new advertisement', async (t) => {
  t.mock.method(fs, 'watch', () => {
    throw Object.assign(new Error('no watch'), { code: 'ENOSYS' });
  });
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { publish } = discoveryFixture(t);
  publish(4000);
  assert.equal(port(), 4000);
  publish(4001);
  await settle();
  assert.equal(port(), 4000, 'no re-check before its interval');
  t.mock.timers.tick(SAFETY_RECHECK_MS);
  await eventually(() => port() === 4001);
});

test('a replacement advertisement is a different endpoint, never a missing file', () => {
  const current = { port: 1000, token: 'a' };
  assert.equal(bridgeDiscoveryChanged(current, { port: 1000, token: 'a' }), false);
  assert.equal(bridgeDiscoveryChanged(current, { port: 1001, token: 'a' }), true);
  assert.equal(bridgeDiscoveryChanged(current, { port: 1000, token: 'b' }), true);
  assert.equal(bridgeDiscoveryChanged(current, null), false);
  assert.equal(bridgeDiscoveryChanged(null, { port: 1000, token: 'a' }), true);
});
