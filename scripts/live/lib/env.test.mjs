// Pure parts of the live runner library: paths, overlay merge, core identity parsing, CPU parsers, start arguments.
// Starts no app and no core.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { linuxLoad, macLoad } from './cpu.mjs';
import { instanceConfig, mergeOverlay } from './env.mjs';
import { startFixtures } from './fixtures.mjs';
import { profileShares, topFunctions } from './inspector.mjs';
import { instanceController, parseCimProcess, samePath, starterEnv, startArgs, verifyCore } from './instance.mjs';
import { findOrtLibrary, parseLiveArgs, resolveLivePaths } from './paths.mjs';
import { providerControl, startProvider } from './provider.mjs';
import { CUSTOM } from './paths.mjs';

test('parseLiveArgs reads --a=b, --a b and bare flags', () => {
  assert.deepEqual(parseLiveArgs(['--core=x.exe', '--out', 'dir', '--keep']), {
    core: 'x.exe',
    out: 'dir',
    keep: true,
  });
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
  assert.throws(
    () => resolveLivePaths({ argv: ['--core=nope'], env: { MIXDOG_LIVE_ORT_LIBRARY: 'o' }, exists: () => false }),
    /does not exist/
  );
});

test('findOrtLibrary: first existing candidate, none on macOS x64, an error when none exists', () => {
  const seen = [];
  const found = findOrtLibrary({
    desktopDir: 'd',
    repoRoot: 'r',
    platform: 'win32',
    arch: 'x64',
    exists: (p) => {
      seen.push(p);
      return p.includes(join('d', 'node_modules'));
    },
  });
  assert.ok(found.endsWith(join('onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime.dll')));
  assert.equal(seen.length, 2);
  assert.equal(findOrtLibrary({ platform: 'darwin', arch: 'x64', exists: () => false }), null);
  assert.throws(
    () => findOrtLibrary({ desktopDir: 'd', repoRoot: 'r', platform: 'linux', arch: 'x64', exists: () => false }),
    /not found/
  );
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
  assert.deepEqual(
    parseCimProcess('{"ProcessId":7,"ExecutablePath":"C:\\\\x\\\\mixdogd.exe","CommandLine":"mixdogd serve"}\r\n'),
    {
      executablePath: 'C:\\x\\mixdogd.exe',
      commandLine: 'mixdogd serve',
    }
  );
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
  assert.equal(
    macLoad('CPU usage: 10.0% user, 5.0% sys, 85.0% idle\nCPU usage: 20.0% user, 10.0% sys, 70.0% idle\n'),
    30
  );
  assert.equal(macLoad('nothing'), null);
});

test('start arguments carry the overlay, inspector and env allowlist only when given', () => {
  assert.deepEqual(startArgs({ overlayFile: 'o.json' }).slice(-1), ['--config-overlay=o.json']);
  const full = startArgs({
    overlayFile: 'o.json',
    inspectorPort: 9229,
    passEnv: ['MIXDOG_DIAGNOSTICS', 'MIXDOG_AGENT_TRACE_TIMING'],
  });
  assert.deepEqual(full.slice(-3), [
    '--config-overlay=o.json',
    '--inspect-main=9229',
    '--pass-env=MIXDOG_DIAGNOSTICS,MIXDOG_AGENT_TRACE_TIMING',
  ]);
  assert.equal(
    startArgs({}).some((a) => a.startsWith('--inspect-main')),
    false
  );
});

test('starterEnv names the core and the root, drops ELECTRON_RUN_AS_NODE, sets the dist only when given', () => {
  const env = starterEnv({ coreExe: 'c', isoRoot: 'r', parent: { ELECTRON_RUN_AS_NODE: '1', PATH: 'p' } });
  assert.deepEqual(env, { PATH: 'p', MIXDOGD_BIN: 'c', MIXDOG_DEV_ISOLATED_ROOT: 'r' });
  assert.equal(
    starterEnv({ coreExe: 'c', isoRoot: 'r', electronDist: 'e', parent: {} }).ELECTRON_OVERRIDE_DIST_PATH,
    'e'
  );
});

test('profileShares and topFunctions split a CPU profile by self time', () => {
  const frame = (functionName, url = '', lineNumber = 0) => ({ functionName, url, lineNumber });
  const profile = {
    nodes: [
      { id: 1, callFrame: frame('(root)') },
      { id: 2, callFrame: frame('(idle)') },
      { id: 3, callFrame: frame('(garbage collector)') },
      { id: 4, callFrame: frame('work', 'file:///a/b/main.js', 9) },
    ],
    samples: [2, 4, 4, 3],
    timeDeltas: [0, 1000, 1000, 1000],
  };
  const shares = profileShares(profile);
  assert.deepEqual(shares, { totalMs: 4, idlePct: 25, programPct: 0, gcPct: 25, jsPct: 50, busyPct: 75 });
  assert.deepEqual(topFunctions(profile), [{ fn: 'work main.js:10', selfMs: 2, pct: 50 }]);
});

test('startProvider answers queued, routed and decided chat requests and exposes the control API', async () => {
  const provider = await startProvider();
  const chat = async (content) => {
    const res = await fetch(`${provider.baseURL}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    });
    return { status: res.status, text: await res.text() };
  };
  try {
    const control = providerControl(provider.baseURL);
    assert.deepEqual(await control.push([{ text: 'queued' }, { status: 500 }]), { queued: 2 });
    assert.deepEqual(await control.route('thread-b', [{ text: 'routed' }]), { routes: 1 });
    assert.match((await chat('thread-b')).text, /"content":"routed"/);
    assert.match((await chat('x')).text, /"content":"queued"/);
    assert.equal((await chat('x')).status, 500);
    assert.match((await chat('x')).text, /"content":"done"/);
    provider.state.decide = (_body, n) => ({ calls: [{ name: 'tool', args: { n } }] });
    assert.match((await chat('x')).text, /"name":"tool","arguments":"{\\"n\\":5}"/);
    assert.equal((await chat('{')).status, 200);
    const models = await fetch(`${provider.baseURL}/v1/models`).then((r) => r.json());
    assert.equal(models.data[0].id, 'smoke');
    const view = await control.requests(4);
    assert.equal(view.total, provider.requests.length);
    assert.equal(view.requests[0].i, 4);
    assert.equal(view.requests[0].answer.kind, 'calls');
  } finally {
    await provider.close();
  }
});

test('startFixtures serves the form, frames, submitted, root and blank pages and closes', async () => {
  const fixtures = await startFixtures();
  try {
    const text = async (url) => (await fetch(url)).text();
    assert.match(await text(fixtures.url('/form')), /<form id="f" action="\/submitted"/);
    const frames = await text(fixtures.url('/frames'));
    assert.match(frames, /id="plain"/);
    assert.ok(frames.includes(`src="${fixtures.frameOrigin}/inner"`));
    assert.match(await text(`${fixtures.frameOrigin}/inner`), /id="inner"/);
    assert.match(await text(fixtures.url('/submitted?q=a%20b')), /<p id="q">a%20b<\/p>/);
    assert.deepEqual(JSON.parse(await text(fixtures.url('/root?q=7'))), { q: '7' });
    assert.match(await text(fixtures.url('/anything')), /<p>blank<\/p>/);
  } finally {
    await fixtures.close();
  }
  await assert.rejects(fetch(fixtures.url('/form')));
});

test('instanceController runs dev-isolated start, stop and sweep and logs each run', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'live-instance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktopDir = join(root, 'desktop');
  mkdirSync(join(desktopDir, 'scripts'), { recursive: true });
  writeFileSync(
    join(desktopDir, 'scripts', 'dev-isolated.mjs'),
    "console.log('noise'); console.log(JSON.stringify({ verb: process.argv[2], dataDir: 'd', args: process.argv.slice(3) }));"
  );
  const lines = [];
  const controller = instanceController({
    desktopDir,
    coreExe: 'core',
    isoRoot: join(root, 'iso'),
    name: 'probe',
    log: (line) => lines.push(line),
  });
  const info = await controller.start({ inspectorPort: 9229, config: { a: 1 } });
  assert.equal(info.verb, 'start');
  assert.equal(info.dataDir, 'd');
  assert.equal(info.inspectorPort, 9229);
  assert.ok(info.args.includes('--inspect-main=9229'));
  assert.equal(await controller.stop(), 0);
  assert.equal(await controller.sweep(), 0);
  assert.ok(lines.some((line) => line.startsWith('instance: stop exit 0 ')));
  assert.ok(lines.some((line) => line.startsWith('instance: sweep exit 0 ')));
  const logNames = readdirSync(controller.logs);
  for (const prefix of ['start-', 'stop-', 'sweep-'])
    assert.ok(
      logNames.some((name) => name.startsWith(prefix)),
      prefix
    );
});
