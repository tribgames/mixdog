// Where the policy gets the setting: held in memory, replaced by the config
// file's watch event, and kept when the file cannot be read.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { eventually, settle, spySyncFs } from '../watched-file-cache.test-helpers.mjs';
import { routeForUrl } from './http-agent.mjs';
import { _resetProxySettingForTest, currentProxySetting, ProxyConfigError } from './proxy-policy.mjs';

const PROXY = 'http://proxy.corp:8080';
const file = (dir) => join(dir, 'mixdog-config.json');
const store = (dir, networkProxy) => {
  writeFileSync(`${file(dir)}.next`, JSON.stringify({ agent: networkProxy ? { networkProxy } : {} }));
  renameSync(`${file(dir)}.next`, file(dir));
};

/** A fresh data dir for one test, released (watches closed) when it ends. */
function dataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-proxy-source-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  t.mock.method(process.stderr, 'write', () => true);
  t.after(() => {
    _resetProxySettingForTest();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('a config that cannot be read keeps the last valid setting; only a config without the key means system', async (t) => {
  const dir = dataDir(t);
  store(dir, { mode: 'manual', url: PROXY });
  assert.equal(currentProxySetting().mode, 'manual');

  writeFileSync(file(dir), '{ "agent": { "networkProxy": '); // torn / corrupt
  await settle(400);
  assert.equal(currentProxySetting().mode, 'manual', 'a failed parse keeps manual');
  assert.equal(routeForUrl('https://api.example.com').proxy, PROXY, 'so traffic still uses the proxy');

  unlinkSync(file(dir)); // gone after a value was read: a failed read, not "no key"
  await settle(400);
  assert.equal(currentProxySetting().mode, 'manual');

  store(dir, null); // parses, and has no networkProxy key
  await eventually(() => currentProxySetting().mode === 'system');
});

test('a config that was never readable decides nothing: no setting is known, so nothing goes out', (t) => {
  const dir = dataDir(t);
  writeFileSync(file(dir), 'not json');
  assert.throws(() => routeForUrl('https://api.example.com'), ProxyConfigError);
});

test('a routing decision touches no file once warm, and another process’s write arrives with its watch event', async (t) => {
  const dir = dataDir(t);
  store(dir, { mode: 'manual', url: PROXY, exceptions: 'localhost, 10.0.0.0/8' });
  currentProxySetting(); // the one cold read
  const calls = spySyncFs(t);
  for (let i = 0; i < 1000; i += 1) {
    routeForUrl(i % 2 ? 'https://api.example.com' : 'wss://10.1.2.3/ws');
    currentProxySetting();
  }
  assert.deepEqual(calls, [], 'no synchronous fs call across 2000 decisions');

  // A different process rewrites the config.
  const writer = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(`${file(dir)}.x`)},JSON.stringify({agent:{networkProxy:{mode:'off'}}}));fs.renameSync(${JSON.stringify(`${file(dir)}.x`)},${JSON.stringify(file(dir))});`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', writer], { stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
  });
  await eventually(() => currentProxySetting().mode === 'off');
  assert.equal(routeForUrl('https://api.example.com').via, 'off');
});
