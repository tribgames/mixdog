// The `mixdog` command of the npm package (bin/mixdog.mjs, bin/native-layout.mjs) and the packages it starts
// (scripts/npm-platforms.mjs, scripts/stage-npm-native.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exitCodeOf, missingProgramMessage, nativeEnv } from '../bin/mixdog.mjs';
import {
  SUPPORTED_KEYS,
  ensureNativeLayout,
  jsRuntimeManifest,
  nativeCandidates,
  ortLibrary,
  platformPackageName,
  resolveNativeProgram,
} from '../bin/native-layout.mjs';
import { OFFICE_TEMPLATE_FILES, OFFICE_TEMPLATES_DIR, OFFICE_TEMPLATES_SOURCE } from '../apps/desktop/scripts/core-layout.mjs';
import { NATIVE_PROGRAMS, PLATFORMS, platformPackageName as stagedPackageName } from './npm-platforms.mjs';
import { lockOptionalDependencies, platformManifest, stageNpmNative } from './stage-npm-native.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scratch = () => mkdtempSync(join(tmpdir(), 'mixdog-npm-test-'));
const sep = (path) => path.split('\\').join('/');

// A package resolver over a set of installed platform packages: name -> folder of the package.
const installed = (folders) => (name) => {
  if (!(name in folders)) throw new Error(`Cannot find module ${name}`);
  return join(folders[name], 'package.json');
};

test('a machine runs the program of its own platform; Windows on Arm also the x64 one, nothing else falls back', () => {
  assert.deepEqual(nativeCandidates('linux', 'x64'), ['linux-x64']);
  assert.deepEqual(nativeCandidates('linux', 'arm64'), ['linux-arm64']);
  assert.deepEqual(nativeCandidates('darwin', 'arm64'), ['darwin-arm64']);
  assert.deepEqual(nativeCandidates('win32', 'arm64'), ['win32-arm64', 'win32-x64']);
});

test('win32-arm64 with only the x64 package resolves to it; an arm64 package is preferred; linux arm64 never takes x64', () => {
  const programs = new Set([join('/n', 'mixdog-win32-x64', 'bin', 'mixdog.exe'), join('/n', 'mixdog-win32-arm64', 'bin', 'mixdog.exe'), join('/n', 'mixdog-linux-x64', 'bin', 'mixdog')]);
  const exists = (path) => programs.has(path);
  const only64 = installed({ 'mixdog-win32-x64': join('/n', 'mixdog-win32-x64') });
  const found = resolveNativeProgram({ packageRoot: '/p', platform: 'win32', arch: 'arm64', resolvePackageJson: only64, exists });
  assert.equal(found.key, 'win32-x64');
  assert.equal(found.program, join('/n', 'mixdog-win32-x64', 'bin', 'mixdog.exe'));
  assert.equal(found.folder, join('/n', 'mixdog-win32-x64', 'bin'));
  const both = installed({ 'mixdog-win32-x64': join('/n', 'mixdog-win32-x64'), 'mixdog-win32-arm64': join('/n', 'mixdog-win32-arm64') });
  assert.equal(resolveNativeProgram({ packageRoot: '/p', platform: 'win32', arch: 'arm64', resolvePackageJson: both, exists }).key, 'win32-arm64');
  const x64Only = installed({ 'mixdog-linux-x64': join('/n', 'mixdog-linux-x64') });
  assert.equal(resolveNativeProgram({ packageRoot: '/p', platform: 'linux', arch: 'arm64', resolvePackageJson: x64Only, exists }), undefined);
  assert.equal(resolveNativeProgram({ packageRoot: '/p', platform: 'linux', arch: 'x64', resolvePackageJson: installed({}), exists }), undefined);
  // A package that is installed but carries no program does not count.
  assert.equal(resolveNativeProgram({ packageRoot: '/p', platform: 'linux', arch: 'x64', resolvePackageJson: x64Only, exists: () => false }), undefined);
});

test('the names the launcher resolves are the names the staging publishes, for exactly the platforms it stages', () => {
  assert.deepEqual([...SUPPORTED_KEYS].sort(), PLATFORMS.map(({ key }) => key).sort());
  for (const { key } of PLATFORMS) assert.equal(platformPackageName(key), stagedPackageName(key));
  assert.equal(platformPackageName('linux-x64'), 'mixdog-linux-x64');
});

test('every machine the package allows has a program: each os/cpu pair resolves to a staged platform', () => {
  for (const os of rootManifest.os) {
    for (const cpu of rootManifest.cpu) {
      const keys = nativeCandidates(os, cpu);
      const entry = PLATFORMS.find(({ key }) => keys.includes(key));
      assert.ok(entry, `${os}-${cpu} has no program`);
      assert.ok(entry.platform === os && entry.cpu.includes(cpu), `${entry.key} does not install on ${os}-${cpu}`);
    }
  }
});

test('a machine with no program is told what to do: unsupported platform, or optional dependencies disabled', () => {
  const lacking = missingProgramMessage('linux', 'x64');
  assert.match(lacking, /no program to start on linux-x64/);
  assert.match(lacking, /mixdog-linux-x64/);
  assert.match(lacking, /optional dependencies/);
  assert.match(lacking, /npm install -g mixdog/);
  assert.match(missingProgramMessage('win32', 'arm64'), /mixdog-win32-arm64 or mixdog-win32-x64/);
  const unsupported = missingProgramMessage('freebsd', 'x64');
  assert.match(unsupported, /freebsd-x64 is not a platform mixdog supports/);
  assert.match(unsupported, /linux-x64/);
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
  const nested = { folder: join('/g', 'mixdog', 'node_modules', 'mixdog-linux-x64', 'bin'), packageRoot: join('/g', 'mixdog'), platform: 'linux', arch: 'x64' };
  const none = jsRuntimeManifest({ ...nested, exists: () => false });
  assert.deepEqual(none, { program: 'node', packageRoot: '../../..' });
  const hoisted = { folder: join('/n', 'mixdog-linux-x64', 'bin'), packageRoot: join('/n', 'mixdog'), platform: 'linux', arch: 'x64' };
  assert.deepEqual(jsRuntimeManifest({ ...hoisted, exists: () => false }), { program: 'node', packageRoot: '../../mixdog' });
  // onnxruntime-node hoisted beside mixdog, and nested in it.
  const library = join('/n', 'onnxruntime-node', 'bin', 'napi-v6', 'linux', 'x64', 'libonnxruntime.so.1');
  const present = new Set([join('/n', 'onnxruntime-node', 'package.json'), library]);
  assert.deepEqual(jsRuntimeManifest({ ...hoisted, exists: (path) => present.has(path) }), {
    program: 'node',
    packageRoot: '../../mixdog',
    ortLibrary: '../../onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1',
  });
  const inner = join('/g', 'mixdog', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime.dll');
  const innerPresent = new Set([join('/g', 'mixdog', 'node_modules', 'onnxruntime-node', 'package.json'), inner]);
  assert.equal(sep(ortLibrary(join('/g', 'mixdog'), 'win32', 'x64', (path) => innerPresent.has(path))), sep(inner));
  // The package is there but pruned to another arch (an x64 program on Windows on Arm): no library is named.
  assert.equal(ortLibrary(join('/g', 'mixdog'), 'win32', 'arm64', (path) => innerPresent.has(path)), undefined);
  // The package is there with no binding at all (ONNXRUNTIME_NODE_INSTALL=skip), and macOS x64 has none.
  assert.equal(ortLibrary(join('/n', 'mixdog'), 'linux', 'x64', (path) => path === join('/n', 'onnxruntime-node', 'package.json')), undefined);
  assert.equal(ortLibrary(join('/n', 'mixdog'), 'freebsd', 'x64', () => true), undefined);
});

test('the layout is written once, rewritten when it differs, and the programs are made executable', () => {
  const dir = scratch();
  try {
    const folder = join(dir, 'node_modules', 'mixdog-linux-x64', 'bin');
    const packageRoot = join(dir, 'node_modules', 'mixdog');
    mkdirSync(folder, { recursive: true });
    for (const name of NATIVE_PROGRAMS) writeFileSync(join(folder, name), name, { mode: 0o644 });
    assert.equal(ensureNativeLayout({ folder, packageRoot, platform: 'linux', arch: 'x64' }), true);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, 'js-runtime.json'), 'utf8')), { program: 'node', packageRoot: '../../mixdog' });
    assert.equal(ensureNativeLayout({ folder, packageRoot, platform: 'linux', arch: 'x64' }), false);
    writeFileSync(join(folder, 'js-runtime.json'), '{}');
    assert.equal(ensureNativeLayout({ folder, packageRoot, platform: 'linux', arch: 'x64' }), true);
    if (process.platform !== 'win32') for (const name of NATIVE_PROGRAMS) assert.ok(statSync(join(folder, name)).mode & 0o100, `${name} is not executable`);
    assert.throws(() => ensureNativeLayout({ folder: join(dir, 'absent'), packageRoot, platform: 'linux', arch: 'x64' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the programs of a package are the three the core looks for, and the committed package lists no platform package yet', () => {
  assert.deepEqual(NATIVE_PROGRAMS, ['mixdog', 'mixdogd', 'mixdog-askpass']);
  // `npm ci` would look for packages that do not exist until the release publishes them; the release pack job adds them.
  assert.equal(rootManifest.optionalDependencies, undefined);
});

test('staging copies the three programs from the folders that hold them, the templates, and a manifest for the platform; a program that is not built is an error', async () => {
  const dir = scratch();
  try {
    const core = join(dir, 'core');
    const entry = join(dir, 'entry');
    mkdirSync(core);
    mkdirSync(entry);
    writeFileSync(join(entry, 'mixdog'), 'entry');
    writeFileSync(join(core, 'mixdogd'), 'core');
    await assert.rejects(stageNpmNative({ from: [core, entry], out: join(dir, 'out'), platform: 'linux', arch: 'x64', version: '2.0.0' }), /mixdog-askpass is not built/);
    writeFileSync(join(core, 'mixdog-askpass'), 'askpass');
    const folder = await stageNpmNative({ from: [core, entry], out: join(dir, 'out'), platform: 'linux', arch: 'x64', version: '2.0.0' });
    assert.equal(folder, join(dir, 'out', 'mixdog-linux-x64'));
    assert.equal(readFileSync(join(folder, 'bin', 'mixdog'), 'utf8'), 'entry');
    assert.equal(readFileSync(join(folder, 'bin', 'mixdogd'), 'utf8'), 'core');
    assert.equal(readFileSync(join(folder, 'bin', 'mixdog-askpass'), 'utf8'), 'askpass');
    assert.equal(existsSync(join(folder, 'bin', 'js-runtime.json')), false);
    const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
    assert.equal(manifest.name, 'mixdog-linux-x64');
    assert.equal(manifest.version, '2.0.0');
    assert.deepEqual(manifest.os, ['linux']);
    assert.deepEqual(manifest.cpu, ['x64']);
    assert.deepEqual(manifest.files, ['bin/']);
    for (const file of OFFICE_TEMPLATE_FILES) {
      assert.deepEqual(readFileSync(join(folder, 'bin', OFFICE_TEMPLATES_DIR, file)), readFileSync(join(OFFICE_TEMPLATES_SOURCE, file)));
    }
    await assert.rejects(stageNpmNative({ from: [core], out: join(dir, 'out'), platform: 'win32', arch: 'arm64', version: '2.0.0' }), /no npm platform win32-arm64/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Windows package installs on x64 and on Arm, the others on their own cpu only', () => {
  const root2 = { license: 'x', repository: 'r', homepage: 'h' };
  assert.deepEqual(platformManifest({ key: 'win32-x64', version: '1.0.0', root: root2 }).cpu, ['x64', 'arm64']);
  assert.deepEqual(platformManifest({ key: 'darwin-arm64', version: '1.0.0', root: root2 }).cpu, ['arm64']);
  assert.deepEqual(platformManifest({ key: 'linux-x64', version: '1.0.0', root: root2 }).os, ['linux']);
});

test('the release lists every platform package at the release version in the package it packs, and only there', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'package.json');
    writeFileSync(path, JSON.stringify({ name: 'mixdog', version: '3.4.5', dependencies: { a: '1' } }));
    const locked = lockOptionalDependencies(path);
    assert.deepEqual(Object.keys(locked).sort(), ['mixdog-darwin-arm64', 'mixdog-darwin-x64', 'mixdog-linux-arm64', 'mixdog-linux-x64', 'mixdog-win32-x64']);
    assert.ok(Object.values(locked).every((version) => version === '3.4.5'));
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(written.dependencies, { a: '1' });
    assert.deepEqual(written.optionalDependencies, locked);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a package with no program for the platform says what to do and exits 1', () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, 'bin'));
    for (const file of ['mixdog.mjs', 'native-layout.mjs', 'staged-swap.mjs', 'invocation.mjs']) writeFileSync(join(dir, 'bin', file), readFileSync(join(root, 'bin', file)));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const run = spawnSync(process.execPath, [join(dir, 'bin', 'mixdog.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no program to start on/);
    assert.match(run.stderr, /npm install -g mixdog|not a platform mixdog supports/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the launcher starts the program of the installed platform package with its arguments and ends with its exit code', (t) => {
  const dir = scratch();
  try {
    const modules = join(dir, 'node_modules');
    const main = join(modules, 'mixdog');
    mkdirSync(join(main, 'bin'), { recursive: true });
    for (const file of ['mixdog.mjs', 'native-layout.mjs', 'staged-swap.mjs', 'invocation.mjs']) writeFileSync(join(main, 'bin', file), readFileSync(join(root, 'bin', file)));
    writeFileSync(join(main, 'package.json'), '{"type":"module","name":"mixdog"}');
    const candidate = PLATFORMS.find(({ key }) => nativeCandidates().includes(key));
    // A release target with no candidate is a defect (the launcher would never run here); only a host mixdog does not ship for is skipped.
    if (!candidate) {
      assert.ok(!nativeCandidates().some((key) => SUPPORTED_KEYS.includes(key)), `${process.platform}-${process.arch} is a supported release target and has no native candidate`);
      t.skip(`${process.platform}-${process.arch} is not a platform mixdog supports`);
      return;
    }
    const platform = join(modules, `mixdog-${candidate.key}`);
    mkdirSync(join(platform, 'bin'), { recursive: true });
    writeFileSync(join(platform, 'package.json'), JSON.stringify({ name: `mixdog-${candidate.key}`, version: '1.0.0' }));
    // The program is a copy of node: `mixdog -p <script>` runs the script.
    const program = join(platform, 'bin', process.platform === 'win32' ? 'mixdog.exe' : 'mixdog');
    copyFileSync(process.execPath, program);
    const run = spawnSync(process.execPath, [join(main, 'bin', 'mixdog.mjs'), '-p', 'process.exit(7)'], { encoding: 'utf8' });
    assert.equal(run.status, 7, run.stderr);
    const manifest = JSON.parse(readFileSync(join(platform, 'bin', 'js-runtime.json'), 'utf8'));
    assert.deepEqual(manifest, { program: 'node', packageRoot: '../../mixdog' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every supported release key has a platform entry the launcher test can run, so a missing candidate can only be an unsupported host', () => {
  for (const key of SUPPORTED_KEYS) assert.ok(PLATFORMS.some((platform) => platform.key === key), `${key} is supported and has no PLATFORMS entry`);
  assert.deepEqual(nativeCandidates('freebsd', 'x64').filter((key) => SUPPORTED_KEYS.includes(key)), []);
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']]) assert.ok(PLATFORMS.some(({ key }) => nativeCandidates(platform, arch).includes(key)), `${platform}-${arch}`);
});

test('the package declares the command and the launcher, ships no native program itself, and keeps its tools out of the tarball', () => {
  assert.deepEqual(rootManifest.bin, { mixdog: 'bin/mixdog.mjs' });
  assert.ok(rootManifest.files.includes('bin/'));
  assert.equal(rootManifest.files.includes('native-bin/'), false);
  for (const tool of ['npm-platforms.mjs', 'stage-npm-native.mjs', 'check-npm-packages.mjs']) assert.ok(rootManifest.files.includes(`!scripts/${tool}`), tool);
  assert.ok(existsSync(join(root, 'bin', 'native-layout.mjs')));
});
