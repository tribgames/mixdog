import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  _bridgeDiscoverySettledForTest,
  bridgeDiscoveryChanged,
  onBridgeDiscoveryChange,
  readBridgeDiscovery,
  readBridgeDiscoveryFresh,
} from './bridge-discovery.mjs';
import { holdNextRead } from './bridge-discovery.test-support.mjs';
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
  return { publish, path: join(dir, FILE) };
}

const port = () => readBridgeDiscovery(FILE)?.port ?? null;
const freshPort = async () => (await readBridgeDiscoveryFresh(FILE))?.port ?? null;

test('a fresh read that cannot parse the advertisement answers the last good one', async (t) => {
  const { publish, path } = discoveryFixture(t);
  publish(4000);
  assert.equal(await freshPort(), 4000);
  writeFileSync(path, '{"version":1,');
  assert.equal(await freshPort(), 4000, 'a half-written file is no missing advertisement');
});

test('a fresh read overtaken by a newer one answers the newer endpoint and keeps it cached', async (t) => {
  const { publish, path } = discoveryFixture(t);
  publish(4000);
  assert.equal(port(), 4000);
  const { reached, release } = holdNextRead(t, path);
  let changes = 0;
  t.after(onBridgeDiscoveryChange((changed) => changed === path && (changes += 1)));

  const old = freshPort();
  await reached;
  publish(4001);
  assert.equal(await freshPort(), 4001);
  release();
  assert.equal(await old, 4001, 'the overtaken read answers what is current');
  assert.equal(port(), 4001, 'the overtaken read stored nothing');
  // Every re-read the watch or the stores scheduled has applied its result.
  await _bridgeDiscoverySettledForTest(path);
  assert.equal(port(), 4001, 'the overtaken read did not roll the copy back');
  assert.equal(changes, 1, 'one replacement, one notification');
});

test('a fresh read overtaken by a cold availability read answers what that read cached', async (t) => {
  const { publish, path } = discoveryFixture(t);
  publish(4000);
  const { reached, release } = holdNextRead(t, path);

  // A request's first read is out when availability is first asked.
  const old = freshPort();
  await reached;
  publish(4001);
  assert.equal(port(), 4001, 'the cold availability read sees the republished bridge');
  release();
  assert.equal(await old, 4001, 'the request goes to the endpoint the cold read cached');
  assert.equal(port(), 4001, 'the overtaken read stored nothing');
});

test('a fresh read sees a republished bridge at once, without synchronous fs', async (t) => {
  const { publish } = discoveryFixture(t);
  publish(4000);
  assert.equal(port(), 4000);
  const calls = spySyncFs(t);
  publish(4001);
  calls.splice(0);
  assert.equal(await freshPort(), 4001);
  assert.deepEqual([...calls], []);
  assert.equal(port(), 4001, 'the watched copy learns the fresh read');
});

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
