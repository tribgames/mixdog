// Pure parts of the live runner library: paths, overlay merge, core identity parsing, CPU parsers, start arguments.
// Starts no app, no core and no process.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { linuxLoad, macLoad } from './cpu.mjs';
import { instanceConfig, mergeOverlay } from './env.mjs';
import { parseCimProcess, samePath, starterEnv, startArgs, verifyCore } from './instance.mjs';
import { findOrtLibrary, parseLiveArgs, resolveLivePaths } from './paths.mjs';
import { CUSTOM } from './paths.mjs';

test('parseLiveArgs reads --a=b, --a b and bare flags', () => {
  assert.deepEqual(parseLiveArgs(['--core=x.exe', '--out', 'dir', '--keep']), { core: 'x.exe', out: 'dir', keep: true });
});

test('resolveLivePaths: argument beats environment, environment beats the default', () => {
  const exists = () => true;
  const env = { MIXDOG_LIVE_CORE_EXE: 'env-core', MIXDOG_LIVE_ISO_ROOT: 'env-iso', MIXDOG_LIVE_ORT_LIBRARY: 'ort' };
  const a = resolveLivePaths({ argv: ['--core=arg-core'], env, exists });
  assert.equal(a.coreExe, resolve('arg-core'));
  assert.equal(a.isoRoot, resolve('env-iso'));
  assert.equal(a.ortLibrary, 'ort');
  const b = resolveLivePaths({ argv: ['--iso-root', 'arg-iso', '--out=o'], env, exists });
  assert.equal(b.coreExe, resolve('env-core'));
  assert.equal(b.isoRoot, resolve('arg-iso'));
  assert.equal(b.out, resolve('o'));
});

test('resolveLivePaths refuses a missing or nonexistent core', () => {
  assert.throws(() => resolveLivePaths({ argv: [], env: {}, exists: () => true }), /no core binary/);
  assert.throws(() => resolveLivePaths({ argv: ['--core=nope'], env: { MIXDOG_LIVE_ORT_LIBRARY: 'o' }, exists: () => false }), /does not exist/);
});

test('findOrtLibrary: first existing candidate, none on macOS x64, an error when none exists', () => {
  const seen = [];
  const found = findOrtLibrary({ desktopDir: 'd', repoRoot: 'r', platform: 'win32', arch: 'x64', exists: (p) => (seen.push(p), p.includes(join('d', 'node_modules'))) });
  assert.ok(found.endsWith(join('onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime.dll')));
  assert.equal(seen.length, 2);
  assert.equal(findOrtLibrary({ platform: 'darwin', arch: 'x64', exists: () => false }), null);
  assert.throws(() => findOrtLibrary({ desktopDir: 'd', repoRoot: 'r', platform: 'linux', arch: 'x64', exists: () => false }), /not found/);
});

test('mergeOverlay merges objects deeply, replaces arrays and scalars, and leaves its inputs alone', () => {
  const base = { a: { b: 1, c: [1, 2] }, keep: true };
  const overlay = { a: { c: [3], d: 4 }, x: { y: 1 } };
  const out = mergeOverlay(base, overlay);
  assert.deepEqual(out, { a: { b: 1, c: [3], d: 4 }, keep: true, x: { y: 1 } });
  assert.deepEqual(base, { a: { b: 1, c: [1, 2] }, keep: true });
  assert.deepEqual(overlay, { a: { c: [3], d: 4 }, x: { y: 1 } });
  assert.equal(mergeOverlay({ a: 1 }, { a: null }).a, null);
});

test('instanceConfig: scripted provider and Browser Use, with the caller overlay on top', () => {
  const cfg = instanceConfig('http://127.0.0.1:1', { desktop: { browserControl: false }, extra: 1 });
  assert.equal(cfg.agent.providers[CUSTOM].baseURL, 'http://127.0.0.1:1');
  assert.deepEqual(cfg.desktop, { browserControl: false, browserInstalled: true });
  assert.equal(cfg.extra, 1);
});

test('parseCimProcess reads ExecutablePath and tolerates no process', () => {
  assert.deepEqual(parseCimProcess('{"ProcessId":7,"ExecutablePath":"C:\\\\x\\\\mixdogd.exe","CommandLine":"mixdogd serve"}\r\n'), {
    executablePath: 'C:\\x\\mixdogd.exe',
    commandLine: 'mixdogd serve',
  });
  assert.deepEqual(parseCimProcess('  \r\n'), { executablePath: '', commandLine: '' });
  assert.deepEqual(parseCimProcess('{"ProcessId":7,"ExecutablePath":null}'), { executablePath: '', commandLine: '' });
});

test('samePath compares case-insensitively on Windows only', () => {
  assert.equal(samePath('C:\\X\\Core.EXE', 'c:/x/core.exe', 'win32'), true);
  assert.equal(samePath('/a/Core', '/a/core', 'linux'), false);
  assert.equal(samePath('', '/a', 'linux'), false);
});

test('verifyCore says whether daemon.json pid runs the expected executable (linux /proc of this process)', async (t) => {
  if (process.platform !== 'linux') return t.skip('reads /proc');
  const ok = await verifyCore({ pid: process.pid }, process.execPath, 'linux');
  assert.equal(ok.ours, true);
  const other = await verifyCore({ pid: process.pid }, '/definitely/not', 'linux');
  assert.equal(other.ours, false);
});

test('linuxLoad and macLoad parse their sources', () => {
  assert.equal(linuxLoad('cpu  100 0 100 700 100 0 0 0\n', 'cpu  200 0 200 800 100 0 0 0\n'), 66.7);
  assert.equal(linuxLoad('cpu 1 1 1 1 1', 'cpu 1 1 1 1 1'), null);
  assert.equal(linuxLoad('', ''), null);
  assert.equal(macLoad('CPU usage: 10.0% user, 5.0% sys, 85.0% idle\nCPU usage: 20.0% user, 10.0% sys, 70.0% idle\n'), 30);
  assert.equal(macLoad('nothing'), null);
});

test('start arguments carry the overlay, inspector and env allowlist only when given', () => {
  assert.deepEqual(startArgs({ overlayFile: 'o.json' }).slice(-1), ['--config-overlay=o.json']);
  const full = startArgs({ overlayFile: 'o.json', inspectorPort: 9229, passEnv: ['MIXDOG_DIAGNOSTICS', 'MIXDOG_AGENT_TRACE_TIMING'] });
  assert.deepEqual(full.slice(-3), ['--config-overlay=o.json', '--inspect-main=9229', '--pass-env=MIXDOG_DIAGNOSTICS,MIXDOG_AGENT_TRACE_TIMING']);
  assert.equal(startArgs({}).some((a) => a.startsWith('--inspect-main')), false);
});

test('starterEnv names the core and the root, drops ELECTRON_RUN_AS_NODE, sets the dist only when given', () => {
  const env = starterEnv({ coreExe: 'c', isoRoot: 'r', parent: { ELECTRON_RUN_AS_NODE: '1', PATH: 'p' } });
  assert.deepEqual(env, { PATH: 'p', MIXDOGD_BIN: 'c', MIXDOG_DEV_ISOLATED_ROOT: 'r' });
  assert.equal(starterEnv({ coreExe: 'c', isoRoot: 'r', electronDist: 'e', parent: {} }).ELECTRON_OVERRIDE_DIST_PATH, 'e');
});
