// Pure parts of the upgrade check: the app lookup, the vector layout and the marker verdicts. Starts no app.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { findApp, loadVector, markerProblems, missingIds } from './upgrade-145.mjs';

test('findApp: an executable is used as it is, a folder yields its Mixdog executable, otherwise an error', () => {
  assert.equal(findApp('a.exe', { exists: () => true, isDir: () => false }), resolve('a.exe'));
  const dir = resolve('app');
  assert.equal(findApp('app', { exists: (p) => p === dir || p === join(dir, 'Mixdog.exe'), isDir: () => true, platform: 'win32' }), join(dir, 'Mixdog.exe'));
  assert.throws(() => findApp('app', { exists: (p) => p === dir, isDir: () => true, platform: 'win32' }), /no Mixdog executable/);
  assert.throws(() => findApp('nope', { exists: () => false }), /does not exist/);
});

test('loadVector derives the expected SSH hosts and paired PCs from the profile files', () => {
  const files = { 'ssh-hosts.json': { hosts: [{ id: 's1' }] }, 'remote-hosts.json': { hosts: [{ id: 'p1' }] } };
  const root = resolve('v');
  const exists = (p) => p === join(root, 'profile') || Object.keys(files).some((f) => p === join(root, 'profile', f));
  const v = loadVector('v', { exists, read: (p) => files[p.split(/[\\/]/).pop()] });
  assert.deepEqual(v.expect.sshHosts, ['s1']);
  assert.deepEqual(v.expect.remoteHosts, ['p1']);
  assert.equal(v.data, null);
  assert.throws(() => loadVector('v', { exists: () => false }), /no profile/);
});

test('markerProblems names every missing or wrong marker', () => {
  const ok = (p) => (p.endsWith('complete.json') ? { kinds: { data: { quarantined_unexpected: 0 }, desktopProfile: { quarantined_unexpected: 0 } } } : { generation: 2 });
  assert.deepEqual(markerProblems('d', ok), []);
  const bad = (p) => (p.endsWith('complete.json') ? { kinds: { data: { quarantined_unexpected: 1 }, desktopProfile: {} } } : { generation: 1 });
  assert.equal(markerProblems('d', bad).length, 2);
  assert.equal(markerProblems('d', () => { throw new Error('gone'); }).length, 2);
});

test('missingIds lists the expected ids a list lacks', () => {
  assert.deepEqual(missingIds(['a', 'b'], [{ id: 'a' }]), ['b']);
  assert.deepEqual(missingIds(['a'], null), ['a']);
});
