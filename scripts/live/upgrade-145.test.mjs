// Pure parts of the upgrade check: the app lookup, the vector layout and the marker verdicts. Starts no app.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { checksFor, findApp, loadVector, markerProblems, missingIds, runChecks } from './upgrade-145.mjs';

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
  assert.equal(v.home, null);
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

test('the read-back checks fail on a missing host, owed key or differing notification preference', async () => {
  const answers = {
    'project/list': [{ path: 'C:\work\a' }],
    'connections/ssh/list': [{ id: 's1' }],
    'notify/state': { supported: true, notifications: { sound: false } },
    'pcAccess/readiness': { owed: { keys: ['k1'], unknown: 0 } },
    'remoteAccess/state': { hosts: [{ id: 'p1' }] },
  };
  const core = { call: async (method) => answers[method] };
  const run = (expect) => runChecks(checksFor({ expect, dataDir: 'd' }).filter((c) => c.name !== 'migration markers'), { core }, () => {});
  const good = await run({ projects: ['C:\work\a'], sshHosts: ['s1'], remoteHosts: ['p1'], notifications: { sound: false }, owedRevokes: ['k1'] });
  assert.deepEqual(good.filter((r) => !r.ok), []);
  const bad = await run({ projects: ['C:\work\b'], sshHosts: ['s2'], remoteHosts: ['p2'], notifications: { sound: true }, owedRevokes: ['k2'] });
  assert.deepEqual(bad.filter((r) => !r.ok).map((r) => r.name), ['projects', 'SSH hosts', 'notification preferences', 'owed revokes', 'paired PCs']);
});
