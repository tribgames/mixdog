// Pure parts of the upgrade check: the app lookup, the vector layout and the marker verdicts. Starts no app.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { GENERATION, backupProblems, checksFor, findApp, loadVector, markerProblems, missingIds, runChecks, subsetProblems, upgradeEnvironment, vectorDigest } from './upgrade-145.mjs';
import { coreConnectionHeaders, isolatedPaths } from '../rust-core/lib/core-session.mjs';

test('findApp: an executable is used as it is, a folder yields its Mixdog executable, otherwise an error', () => {
  assert.equal(findApp('a.exe', { exists: () => true, isDir: () => false }), resolve('a.exe'));
  const dir = resolve('app');
  assert.equal(findApp('app', { exists: (p) => p === dir || p === join(dir, 'Mixdog.exe'), isDir: () => true, platform: 'win32' }), join(dir, 'Mixdog.exe'));
  assert.throws(() => findApp('app', { exists: (p) => p === dir, isDir: () => true, platform: 'win32' }), /no Mixdog executable/);
  assert.throws(() => findApp('nope', { exists: () => false }), /does not exist/);
});

test('loadVector derives the expected SSH hosts and paired PCs from the profile files', () => {
  const files = { 'ssh-hosts.json': { hosts: [{ id: 's1' }] }, 'remote-hosts.json': { hosts: [{ id: 'stored-id-not-used', url: 'https://relay.example.test/d/pc/', name: 'PC', alias: 'desk', addedAt: 1, lastConnectedAt: 2 }] } };
  const root = resolve('v');
  const exists = (p) => p === join(root, 'profile') || Object.keys(files).some((f) => p === join(root, 'profile', f));
  const v = loadVector('v', { exists, read: (p) => files[p.split(/[\\/]/).pop()] });
  assert.deepEqual(v.expect.sshHosts, ['s1']);
  assert.equal(v.expect.remoteHostRecords[0].name, 'desk');
  assert.equal(v.expect.remoteHostRecords[0].url, 'https://relay.example.test/d/pc/');
  assert.match(v.expect.remoteHostRecords[0].id, /^[0-9a-f]{16}$/);
  assert.equal(v.home, null);
  assert.throws(() => loadVector('v', { exists: () => false }), /no profile/);
});

test('markerProblems names every missing or wrong marker', () => {
  const ok = (p) => (p.endsWith('complete.json') ? { kinds: { data: { quarantined_unexpected: 0 }, desktopProfile: { quarantined_unexpected: 0 } } } : { generation: GENERATION });
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
    'remoteHosts/list': [{ id: 'p1' }],
  };
  const core = { call: async (method) => answers[method] };
  const run = (expect) => runChecks(checksFor({ expect, dataDir: 'd' }).filter((c) => c.name !== 'migration markers'), { core }, () => {});
  const good = await run({ projects: ['C:\work\a'], sshHosts: ['s1'], remoteHosts: ['p1'], notifications: { sound: false }, owedRevokes: ['k1'] });
  assert.deepEqual(good.filter((r) => !r.ok), []);
  const bad = await run({ projects: ['C:\work\b'], sshHosts: ['s2'], remoteHosts: ['p2'], notifications: { sound: true }, owedRevokes: ['k2'] });
  assert.deepEqual(bad.filter((r) => !r.ok).map((r) => r.name), ['projects', 'SSH hosts', 'notification preferences', 'owed revokes', 'paired PCs']);
});

test('acceptance expects the candidate generation and refuses an older completed supplement', () => {
  assert.equal(GENERATION, 3, 'candidate generation includes user editor settings');
  const read = (p) => p.endsWith('complete.json') ? { kinds: {} } : { generation: GENERATION - 1 };
  assert.match(markerProblems('d', read).join(' '), /generation/);
});

test('only the explicit isolated main-window client receives window headers', () => {
  assert.deepEqual(coreConnectionHeaders('synthetic'), { Authorization: 'Bearer synthetic' });
  assert.deepEqual(coreConnectionHeaders('synthetic', 'upgrade-145-0'), {
    Authorization: 'Bearer synthetic', 'Mixdog-Window': 'upgrade-145-0', 'Mixdog-Window-Role': 'main',
  });
  assert.throws(() => coreConnectionHeaders('synthetic', 'bad\r\nheader'), /invalid/);
});

test('backup-enabled validation stays inside its owned root and ordinary helper behavior stays disabled', () => {
  const paths = isolatedPaths(resolve('owned-upgrade'));
  const yes = upgradeEnvironment(paths, true), no = upgradeEnvironment(paths);
  assert.equal(yes.MIXDOG_SKIP_USER_DATA_BACKUP, '0');
  assert.equal(no.MIXDOG_SKIP_USER_DATA_BACKUP, '1');
  assert.equal(yes.MIXDOG_USER_DATA_BACKUP_ROOT, join(paths.root, 'user-data-backups'));
  assert.equal(yes.MIXDOG_DESKTOP_USER_DATA, join(paths.appData, 'Mixdog'));
  assert.equal(yes.MIXDOG_RELAY_URL, 'off');
});

test('paired-PC check reads the saved-host consumer and cannot pass on a phone-state substring', async () => {
  const calls = [];
  const core = { call: async (method) => { calls.push(method); return method === 'remoteAccess/state' ? { text: 'p1' } : []; } };
  const check = checksFor({ expect: { remoteHosts: ['p1'] }, dataDir: 'd' }).find((check) => check.name === 'paired PCs');
  await assert.rejects(check.run({ core }), /remoteHosts\/list lacks p1/);
  assert.deepEqual(calls, ['remoteHosts/list']);
});

test('project equality cannot be satisfied by an unrelated row field or longer path', async () => {
  const check = checksFor({ expect: { projects: ['/wanted'] }, dataDir: 'd' }).find((check) => check.name === 'projects');
  await assert.rejects(check.run({ core: { call: async () => [{ path: '/wanted-other', note: '/wanted' }] } }), /lacks/);
});

test('effective settings, real store records and retained unknown keys are distinct assertions', async () => {
  const expect = {
    sshHostRecords: [{ id: 's', settings: { autoReconnect: false, remoteCwd: '/work' } }],
    remoteHostRecords: [{ id: 'p', url: 'https://example.test/d/p/', name: 'alias' }],
    restore: { enabled: false }, config: { 'desktop.testSetting': false }, editorSettings: { tabSize: 2 },
    storedConfig: { future: { sentinel: 'retained' } }, configWrite: { path: 'desktop.testSetting', value: false },
  };
  const answers = {
    'connections/ssh/list': [{ id: 's', settings: { autoReconnect: false, remoteCwd: '/work' } }],
    'remoteHosts/list': [{ id: 'p', url: 'https://example.test/d/p/', name: 'alias' }],
    'connections/restore/get': { enabled: false }, 'config/read': { config: { 'desktop.testSetting': false } },
    'projectFs/readEditorSettings': { tabSize: 2 },
  };
  const calls = [];
  const core = { call: async (method, params) => { calls.push({ method, params }); return answers[method] ?? []; } };
  const checks = checksFor({ expect, dataDir: 'd', performWrite: true }).filter((check) => check.name !== 'migration markers');
  const results = await runChecks(checks, { core, workspace: '/owned/ws', read: () => ({ future: { sentinel: 'retained' } }) }, () => {});
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.deepEqual(calls.find((call) => call.method === 'projectFs/readEditorSettings').params, { root: '/owned/ws', rel: 'synthetic.ts' });
  assert.equal(calls.filter((call) => call.method === 'config/value/write').length, 1);
  assert.ok(!checksFor({ expect, dataDir: 'd' }).some((check) => check.name === 'unrelated configuration write'), 'restart does not repeat a mutation');
  assert.deepEqual(subsetProblems({ future: { sentinel: 'changed' } }, expect.storedConfig), ['future.sentinel']);
});

test('a backup must be complete, of this incarnation and carry the expected config', () => {
  const dataDir = resolve('owned/data');
  const good = { manifest: { dataDir, instanceId: 'fixture', createdAt: 'now', reason: 'write' }, config: { future: { flag: false } }, dataDir, instanceId: 'fixture', expected: { future: { flag: false } } };
  assert.deepEqual(backupProblems(good), []);
  assert.deepEqual(backupProblems({ ...good, manifest: { ...good.manifest, instanceId: 'another' } }), ['backup incarnation']);
  assert.deepEqual(backupProblems({ ...good, config: {} }), ['backup config future.flag']);
  assert.ok(backupProblems({ ...good, manifest: {} }).includes('backup completion metadata'));
});

test('source preservation records hashes and detects changed vector bytes without returning their contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-vector-'));
  try {
    const profile = join(root, 'profile'); mkdirSync(profile);
    writeFileSync(join(profile, 'settings.json'), '{"synthetic":true}');
    const before = vectorDigest({ profile });
    assert.deepEqual(Object.keys(before), ['profile/settings.json']);
    assert.match(before['profile/settings.json'], /^[0-9a-f]{64}$/);
    assert.deepEqual(vectorDigest({ profile }), before);
    writeFileSync(join(profile, 'settings.json'), '{"synthetic":false}');
    assert.notDeepEqual(vectorDigest({ profile }), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
