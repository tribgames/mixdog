import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bridgeDiscoveryChanged, readBridgeDiscovery, readBridgeDiscoveryDetail } from './bridge-discovery.mjs';
import { _resetWatchedFileCachesForTest } from './shared/watched-file-cache.mjs';
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
  return { dir, publish };
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

test('fresh recovery reads bypass the cache and retain discovery validation', { timeout: 5_000 }, async (t) => {
  const { dir, publish } = discoveryFixture(t);
  publish(4000);
  assert.equal(port(), 4000);
  publish(4001);
  assert.equal(readBridgeDiscovery(FILE, { fresh: true }).port, 4001);
  const calls = spySyncFs(t);
  assert.equal(port(), 4001);
  assert.deepEqual([...calls], [], 'the fresh value is cached for later warm reads');
  calls.paused = true;

  const exited = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await once(exited, 'exit');
  const valid = { version: 1, port: 4002, token: 'replacement', pid: process.pid };
  for (const [record, reason] of [
    [{ ...valid, version: 2 }, 'invalid'],
    [{ ...valid, port: 0 }, 'invalid'],
    [{ ...valid, token: '' }, 'invalid'],
    [{ ...valid, pid: exited.pid }, `stale (writer pid ${exited.pid} has exited)`],
  ]) {
    writeFileSync(join(dir, FILE), JSON.stringify(record));
    assert.deepEqual(readBridgeDiscoveryDetail(FILE, { fresh: true }), { discovery: null, reason });
  }
  writeFileSync(join(dir, FILE), JSON.stringify(valid));
  const stale = new Date(Date.now() - 6 * 60_000);
  utimesSync(join(dir, FILE), stale, stale);
  assert.deepEqual(readBridgeDiscoveryDetail(FILE, { fresh: true }), { discovery: null, reason: 'expired' });
  writeFileSync(join(dir, FILE), '{');
  assert.deepEqual(readBridgeDiscoveryDetail(FILE, { fresh: true }), { discovery: null, reason: 'invalid' });
  rmSync(join(dir, FILE));
  assert.deepEqual(readBridgeDiscoveryDetail(FILE, { fresh: true }), { discovery: null, reason: 'missing' });
});

test('a re-read that cannot read the advertisement keeps the last one', async (t) => {
  const { publish } = discoveryFixture(t);
  publish(4000);
  assert.equal(port(), 4000);
  const readFile = fsp.readFile;
  let refused = 0;
  t.mock.method(fsp, 'readFile', async (target, ...rest) => {
    if (!String(target).endsWith(FILE)) return readFile(target, ...rest);
    refused += 1;
    throw Object.assign(new Error('sharing violation'), { code: 'EBUSY' });
  });
  syncBuiltinESMExports();
  t.after(() => syncBuiltinESMExports());
  publish(4001);
  await eventually(() => refused > 0);
  await settle(100);
  assert.equal(port(), 4000, 'a failed read is no missing advertisement');
});

test('a replacement advertisement is a different endpoint, never a missing file', () => {
  const current = { port: 1000, token: 'a' };
  assert.equal(bridgeDiscoveryChanged(current, { port: 1000, token: 'a' }), false);
  assert.equal(bridgeDiscoveryChanged(current, { port: 1001, token: 'a' }), true);
  assert.equal(bridgeDiscoveryChanged(current, { port: 1000, token: 'b' }), true);
  assert.equal(bridgeDiscoveryChanged(current, null), false);
  assert.equal(bridgeDiscoveryChanged(null, { port: 1000, token: 'a' }), true);
});
