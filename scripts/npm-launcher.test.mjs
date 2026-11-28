// The `mixdog` command of the npm package (bin/mixdog.mjs, bin/native-layout.mjs): it starts the program of the runtime in
// the user's cache (bin/runtime.mjs), fetching it at first use, and an install made by 1.4.5 reaches it through src/cli.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exitCodeOf, launchPlan, nativeEnv, provisionedPlan, readyPlan, startPlan, unsupportedMessage } from '../bin/mixdog.mjs';
import { SUPPORTED_KEYS, ensureNativeLayout, jsRuntimeManifest, nativeCandidates, ortLibrary } from '../bin/native-layout.mjs';
import { programFile, runtimeCacheRoot, runtimeFolder } from '../bin/runtime.mjs';
import { PLATFORMS } from './npm-platforms.mjs';
import { LEGACY_ENTRY, runtimeManifest, writeRuntimeArchive } from './npm-runtime-assets.mjs';
import { programContents, runtimeEntry, writePackage, writeReadyRuntime } from './npm-test-fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scratch = () => mkdtempSync(join(tmpdir(), 'mixdog-npm-test-'));
const sep = (path) => path.split('\\').join('/');

test('a machine runs the program of its own platform; Windows on Arm also the x64 one, nothing else falls back', () => {
  assert.deepEqual(nativeCandidates('linux', 'x64'), ['linux-x64']);
  assert.deepEqual(nativeCandidates('linux', 'arm64'), ['linux-arm64']);
  assert.deepEqual(nativeCandidates('darwin', 'arm64'), ['darwin-arm64']);
  assert.deepEqual(nativeCandidates('win32', 'arm64'), ['win32-arm64', 'win32-x64']);
});

test('the keys the launcher selects are the platforms the release builds a runtime for', () => {
  assert.deepEqual([...SUPPORTED_KEYS].sort(), PLATFORMS.map(({ key }) => key).sort());
});

test('every machine the package allows has a runtime: each os/cpu pair selects a platform of its os', () => {
  for (const os of rootManifest.os) {
    for (const cpu of rootManifest.cpu) {
      const entry = PLATFORMS.find(({ key }) => nativeCandidates(os, cpu).includes(key));
      assert.ok(entry, `${os}-${cpu} has no runtime`);
      assert.equal(entry.platform, os, `${entry.key} is not a runtime of ${os}`);
    }
  }
});

test('a machine there is no runtime for is told which ones there are', () => {
  const said = unsupportedMessage('freebsd', 'x64', ['linux-x64', 'win32-x64']);
  assert.match(said, /no program to start on freebsd-x64: freebsd-x64 is not a platform mixdog supports \(it supports linux-x64, win32-x64\)/);
});

test('the Node that runs the command is first on the search path of the program, whatever the variable is called', () => {
  const exec = join('/opt', 'node', 'bin', 'node');
  assert.equal(nativeEnv({ PATH: '/usr/bin' }, exec).PATH, `${dirname(exec)}${delimiter}/usr/bin`);
  assert.equal(nativeEnv({ Path: 'C:\\Windows' }, exec).Path, `${dirname(exec)}${delimiter}C:\\Windows`);
  assert.equal(nativeEnv({}, exec).PATH, dirname(exec));
  assert.equal(nativeEnv({ PATH: '/usr/bin', HOME: '/h' }, exec).HOME, '/h');
});

test('a child ended by a signal reports 128 plus its number', () => {
  assert.equal(exitCodeOf(0, null), 0);
  assert.equal(exitCodeOf(3, null), 3);
  assert.equal(exitCodeOf(null, 'SIGINT'), 130);
  assert.equal(exitCodeOf(null, 'SIGTERM'), 143);
  assert.equal(exitCodeOf(null, 'SIGUNKNOWN'), 128);
});

test('the manifest names node, the package root relative to the programs (inside the package or beside it) and the ONNX Runtime library only when it is installed', () => {
  const hoisted = {
    folder: join('/n', 'mixdog-linux-x64', 'bin'),
    packageRoot: join('/n', 'mixdog'),
    platform: 'linux',
    arch: 'x64',
  };
  const nested = {
    folder: join('/g', 'mixdog', 'node_modules', 'mixdog-linux-x64', 'bin'),
    packageRoot: join('/g', 'mixdog'),
    platform: 'linux',
    arch: 'x64',
  };
  const none = jsRuntimeManifest({ ...nested, exists: () => false });
  assert.deepEqual(none, { program: 'node', packageRoot: '../../..' });
  assert.deepEqual(jsRuntimeManifest({ ...hoisted, exists: () => false }), {
    program: 'node',
    packageRoot: '../../mixdog',
  });
  // onnxruntime-node hoisted beside mixdog, and nested in it.
  const library = join('/n', 'onnxruntime-node', 'bin', 'napi-v6', 'linux', 'x64', 'libonnxruntime.so.1');
  const present = new Set([join('/n', 'onnxruntime-node', 'package.json'), library]);
  assert.deepEqual(jsRuntimeManifest({ ...hoisted, exists: (path) => present.has(path) }), {
    program: 'node',
    packageRoot: '../../mixdog',
    ortLibrary: '../../onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1',
  });
});

test('the ONNX Runtime library is found nested in the package, and named only for an architecture it carries', () => {
  const inner = join(
    '/g',
    'mixdog',
    'node_modules',
    'onnxruntime-node',
    'bin',
    'napi-v6',
    'win32',
    'x64',
    'onnxruntime.dll'
  );
  const innerPresent = new Set([join('/g', 'mixdog', 'node_modules', 'onnxruntime-node', 'package.json'), inner]);
  assert.equal(sep(ortLibrary(join('/g', 'mixdog'), 'win32', 'x64', (path) => innerPresent.has(path))), sep(inner));
  // The package is there but pruned to another arch (an x64 program on Windows on Arm): no library is named.
  assert.equal(
    ortLibrary(join('/g', 'mixdog'), 'win32', 'arm64', (path) => innerPresent.has(path)),
    undefined
  );
  // The package is there with no binding at all (ONNXRUNTIME_NODE_INSTALL=skip), and macOS x64 has none.
  assert.equal(
    ortLibrary(join('/n', 'mixdog'), 'linux', 'x64', (path) => path === join('/n', 'onnxruntime-node', 'package.json')),
    undefined
  );
  assert.equal(
    ortLibrary(join('/n', 'mixdog'), 'freebsd', 'x64', () => true),
    undefined
  );
});

test('the layout is written once and rewritten when it differs: the cache is shared by every install of a version', () => {
  const dir = scratch();
  try {
    const folder = join(dir, 'data', 'runtime', '1.0.0', 'linux-x64-abc');
    const first = join(dir, 'a', 'node_modules', 'mixdog');
    mkdirSync(folder, { recursive: true });
    assert.equal(ensureNativeLayout({ folder, packageRoot: first, platform: 'linux', arch: 'x64', exists: () => false }), true);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, 'js-runtime.json'), 'utf8')), {
      program: 'node',
      packageRoot: '../../../../a/node_modules/mixdog',
    });
    assert.equal(ensureNativeLayout({ folder, packageRoot: first, platform: 'linux', arch: 'x64', exists: () => false }), false);
    // Another install of the version names its own package root at its start.
    const second = join(dir, 'b', 'node_modules', 'mixdog');
    assert.equal(ensureNativeLayout({ folder, packageRoot: second, platform: 'linux', arch: 'x64', exists: () => false }), true);
    assert.equal(JSON.parse(readFileSync(join(folder, 'js-runtime.json'), 'utf8')).packageRoot, '../../../../b/node_modules/mixdog');
    assert.throws(() => ensureNativeLayout({ folder: join(dir, 'absent'), packageRoot: first, platform: 'linux', arch: 'x64' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest write that fails partway leaves the manifest a core of another install reads whole', () => {
  const dir = scratch();
  try {
    const folder = join(dir, 'runtime');
    mkdirSync(folder);
    const layout = (install, write) =>
      ensureNativeLayout({ folder, packageRoot: join(dir, install, 'node_modules', 'mixdog'), platform: 'linux', arch: 'x64', exists: () => false, write });
    layout('a');
    const before = readFileSync(join(folder, 'js-runtime.json'), 'utf8');
    const full = (path, text) => {
      writeFileSync(path, text.slice(0, 5));
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    assert.throws(() => layout('b', full), /ENOSPC/);
    assert.equal(readFileSync(join(folder, 'js-runtime.json'), 'utf8'), before);
    assert.deepEqual(readdirSync(folder), ['js-runtime.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a package without a runtime manifest (a source checkout) says so and exits 1', () => {
  const dir = scratch();
  try {
    writePackage(join(dir, 'pkg'), { version: '1.0.0', targets: {} });
    rmSync(join(dir, 'pkg', 'bin', 'runtime-manifest.json'));
    const run = spawnSync(process.execPath, [join(dir, 'pkg', 'bin', 'mixdog.mjs'), '--help'], {
      encoding: 'utf8',
      env: { ...process.env, MIXDOG_DATA_DIR: join(dir, 'data') },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /has no bin\/runtime-manifest\.json: it is not a released mixdog package/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** This host's runtime key, or a skip when mixdog has none for it (a host of a supported platform always has one). */
function hostKey(t) {
  const candidate = PLATFORMS.find(({ key }) => nativeCandidates().includes(key));
  if (!candidate) {
    assert.ok(!nativeCandidates().some((key) => SUPPORTED_KEYS.includes(key)), `${process.platform}-${process.arch} is supported and has no candidate`);
    t.skip(`${process.platform}-${process.arch} is not a platform mixdog supports`);
  }
  return candidate;
}

/** An installed package of 1.0.0 whose runtime for this host is in the cache of `data`, its `mixdog` a copy of node. */
function installWithRuntime(dir, candidate) {
  // `mixdog -p <script>` runs the script.
  const contents = { ...programContents(candidate.platform), [programFile('mixdog', candidate.platform)]: readFileSync(process.execPath) };
  const entry = runtimeEntry({ key: candidate.key, version: '1.0.0', contents });
  const packageRoot = writePackage(join(dir, 'node_modules', 'mixdog'), { version: '1.0.0', targets: { [candidate.key]: entry } });
  const data = join(dir, 'data');
  return { packageRoot, data, folder: writeReadyRuntime({ data, key: candidate.key, entry, contents }) };
}

test('the launcher, and the command an install made by 1.4.5 links to, start the program of the runtime in the cache', (t) => {
  const candidate = hostKey(t);
  if (!candidate) return;
  const dir = scratch();
  try {
    const { packageRoot, data, folder } = installWithRuntime(dir, candidate);
    const env = { ...process.env, MIXDOG_DATA_DIR: data };
    const run = spawnSync(process.execPath, [join(packageRoot, 'bin', 'mixdog.mjs'), '-p', 'process.exit(7)'], { encoding: 'utf8', env });
    assert.equal(run.status, 7, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, 'js-runtime.json'), 'utf8')), {
      program: 'node',
      packageRoot: sep(join('..', '..', '..', '..', 'node_modules', 'mixdog')),
    });
    // 1.4.5's npm linked `mixdog` to src/cli.mjs, and its updater starts that file again after a swap.
    const legacy = spawnSync(process.execPath, [join(packageRoot, LEGACY_ENTRY), '-p', 'process.exit(9)'], {
      encoding: 'utf8',
      env: { ...env, MIXDOG_SWAP_REEXEC: '1' },
    });
    assert.equal(legacy.status, 9, legacy.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('at first use the launcher fetches the runtime the install\'s scripts did not, and offline names the asset and the import command', async (t) => {
  const candidate = hostKey(t);
  if (!candidate) return;
  const dir = scratch();
  try {
    const built = join(dir, 'built');
    mkdirSync(built);
    for (const name of ['mixdog', 'mixdogd', 'mixdog-askpass']) writeFileSync(join(built, programFile(name, candidate.platform)), name);
    const archive = await writeRuntimeArchive({ key: candidate.key, from: [built], out: join(dir, 'assets') });
    const manifest = runtimeManifest({ archives: [archive], version: '1.0.0', buildId: 'b', repository: 'o/r', tag: 'v1.0.0' });
    const packageRoot = writePackage(join(dir, 'node_modules', 'mixdog'), { version: '1.0.0', manifest });
    const env = { MIXDOG_DATA_DIR: join(dir, 'data') };
    const replan = () => launchPlan({ packageRoot, swapped: false, argv: ['--plain'], env });
    const plan = replan();
    assert.equal(plan.provision.key, candidate.key);
    const stderr = { write: () => {} };
    const offline = await provisionedPlan(plan.provision, replan, {
      packageRoot,
      env,
      stderr,
      fetchArchive: async () => {
        throw new Error('connect ETIMEDOUT');
      },
    });
    assert.match(offline.error, new RegExp(`mixdog 1\\.0\\.0 for ${candidate.key} is not installed, and fetching it failed: connect ETIMEDOUT`));
    assert.match(offline.error, new RegExp(`https://github\\.com/o/r/releases/download/v1\\.0\\.0/mixdog-runtime-${candidate.key}\\.tar\\.gz`));
    assert.match(offline.error, new RegExp(`mixdog-runtime import <path to mixdog-runtime-${candidate.key}\\.tar\\.gz>`));
    // A download that is not the archive the manifest names installs nothing.
    const wrong = await provisionedPlan(plan.provision, replan, {
      packageRoot,
      env,
      stderr,
      fetchArchive: async ({ file, length }) => writeFileSync(file, Buffer.alloc(length)),
    });
    assert.match(wrong.error, /fetching it failed: .+ is not mixdog-runtime-.+ of mixdog 1\.0\.0: its SHA-256 is [0-9a-f]{64}, the release's is [0-9a-f]{64}/);
    assert.ok(replan().provision, 'still not installed');
    const asked = [];
    const fetched = await provisionedPlan(plan.provision, replan, {
      packageRoot,
      env,
      stderr,
      fetchArchive: async ({ url, file }) => {
        asked.push(url);
        copyFileSync(archive.file, file);
      },
    });
    assert.deepEqual(asked, [`https://github.com/o/r/releases/download/v1.0.0/mixdog-runtime-${candidate.key}.tar.gz`]);
    assert.equal(fetched.program, join(runtimeFolder(runtimeCacheRoot(env.MIXDOG_DATA_DIR), candidate.key, manifest.targets[candidate.key]), programFile('mixdog', candidate.platform)));
    assert.deepEqual(fetched.args, ['--plain']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Children that are never run, and the exit codes of the run: `next(event)` waits for the next 'start' or 'exit'. */
function fakeProcesses(stderr) {
  const events = new EventEmitter();
  const started = [];
  const exits = [];
  const common = {
    spawnProcess: (program, args) => {
      const child = new EventEmitter();
      started.push({ program, args, child });
      events.emit('start');
      return child;
    },
    exit: (code) => {
      exits.push(code);
      events.emit('exit');
    },
    stderr,
  };
  return { started, exits, common, next: (event) => once(events, event) };
}

test('a failed re-run falls back to the program in place, fetching its runtime first; one still missing then is an error, never a start of nothing', async (t) => {
  const candidate = hostKey(t);
  if (!candidate) return;
  const dir = scratch();
  try {
    const built = join(dir, 'built');
    mkdirSync(built);
    for (const name of ['mixdog', 'mixdogd', 'mixdog-askpass']) writeFileSync(join(built, programFile(name, candidate.platform)), name);
    const archive = await writeRuntimeArchive({ key: candidate.key, from: [built], out: join(dir, 'assets') });
    const manifest = runtimeManifest({ archives: [archive], version: '1.0.0', buildId: 'b', repository: 'o/r', tag: 'v1.0.0' });
    const packageRoot = writePackage(join(dir, 'node_modules', 'mixdog'), { version: '1.0.0', manifest });
    const env = { MIXDOG_DATA_DIR: join(dir, 'data') };
    const replan = () => launchPlan({ packageRoot, swapped: false, argv: ['--plain'], env });
    const said = { text: '', write: (text) => (said.text += text) };
    const options = { packageRoot, env, stderr: said, fetchArchive: async ({ file }) => copyFileSync(archive.file, file) };
    const reexec = { program: process.execPath, args: [], env: {}, reexec: true };
    const lost = replan();
    assert.ok(lost.provision, 'the cache lacks the runtime');

    const fresh = fakeProcesses(said);
    startPlan({ plan: reexec, fallback: () => readyPlan(replan(), replan, options), ...fresh.common });
    const starting = fresh.next('start');
    fresh.started[0].child.emit('error', new Error('spawn ENOENT'));
    await starting;
    assert.equal(fresh.started[1].program, join(runtimeFolder(runtimeCacheRoot(env.MIXDOG_DATA_DIR), candidate.key, manifest.targets[candidate.key]), programFile('mixdog', candidate.platform)));
    assert.deepEqual(fresh.started[1].args, ['--plain']);

    // A fetch after which the cache still lacks it.
    const stuck = fakeProcesses(said);
    startPlan({ plan: reexec, fallback: () => readyPlan(lost, () => lost, options), ...stuck.common });
    const ending = stuck.next('exit');
    stuck.started[0].child.emit('error', new Error('spawn ENOENT'));
    await ending;
    assert.equal(stuck.started.length, 1, 'nothing else was started');
    assert.deepEqual(stuck.exits, [1]);
    assert.match(said.text, /is not installed, and fetching it failed: it is not complete in the cache once fetched/);
    assert.match(said.text, new RegExp(`mixdog-runtime import <path to mixdog-runtime-${candidate.key}\\.tar\\.gz>`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every supported release key has a platform entry the launcher test can run, so a missing candidate can only be an unsupported host', () => {
  for (const key of SUPPORTED_KEYS)
    assert.ok(
      PLATFORMS.some((platform) => platform.key === key),
      `${key} is supported and has no PLATFORMS entry`
    );
  assert.deepEqual(
    nativeCandidates('freebsd', 'x64').filter((key) => SUPPORTED_KEYS.includes(key)),
    []
  );
  for (const [platform, arch] of [
    ['linux', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ])
    assert.ok(
      PLATFORMS.some(({ key }) => nativeCandidates(platform, arch).includes(key)),
      `${platform}-${arch}`
    );
});

test('the package declares the command and the runtime command, provisions at install, lists no platform package and keeps its tools out', () => {
  assert.deepEqual(rootManifest.bin, { mixdog: 'bin/mixdog.mjs', 'mixdog-runtime': 'bin/mixdog-runtime.mjs' });
  assert.equal(rootManifest.optionalDependencies, undefined);
  assert.match(rootManifest.scripts.postinstall, /node bin\/mixdog-runtime\.mjs postinstall$/);
  assert.ok(rootManifest.files.includes('bin/'));
  for (const tool of ['!scripts/npm-*.mjs', '!scripts/check-npm-packages.mjs']) assert.ok(rootManifest.files.includes(tool), tool);
});
