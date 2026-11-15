// The `mixdog` command of the npm package (bin/mixdog.mjs) and the layout it starts (scripts/stage-npm-native.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exitCodeOf, nativeEnv, nativeProgram } from '../bin/mixdog.mjs';
import { NATIVE_PROGRAMS, jsRuntimeManifest, stageNpmNative } from './stage-npm-native.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('the program of a platform is in its own folder of the package', () => {
  assert.deepEqual(nativeProgram('/pkg', 'linux', 'arm64'), {
    folder: join('/pkg', 'native-bin', 'linux-arm64'),
    program: join('/pkg', 'native-bin', 'linux-arm64', 'mixdog'),
  });
  assert.equal(nativeProgram('/pkg', 'win32', 'x64').program, join('/pkg', 'native-bin', 'win32-x64', 'mixdog.exe'));
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

test('the manifest names node and the package root two folders up', () => {
  assert.deepEqual(jsRuntimeManifest(), { program: 'node', packageRoot: '../..' });
  assert.deepEqual(NATIVE_PROGRAMS, ['mixdog', 'mixdogd']);
});

test('staging copies both programs and writes the manifest; a program that is not built is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-npm-stage-'));
  try {
    const from = join(dir, 'built');
    mkdirSync(from);
    writeFileSync(join(from, 'mixdog'), 'entry');
    assert.throws(() => stageNpmNative({ from, packageRoot: join(dir, 'pkg'), platform: 'linux', arch: 'x64' }), /mixdogd is not built/);
    writeFileSync(join(from, 'mixdogd'), 'core');
    const folder = stageNpmNative({ from, packageRoot: join(dir, 'pkg'), platform: 'linux', arch: 'x64' });
    assert.equal(folder, join(dir, 'pkg', 'native-bin', 'linux-x64'));
    assert.equal(readFileSync(join(folder, 'mixdog'), 'utf8'), 'entry');
    assert.equal(readFileSync(join(folder, 'mixdogd'), 'utf8'), 'core');
    assert.deepEqual(JSON.parse(readFileSync(join(folder, 'js-runtime.json'), 'utf8')), jsRuntimeManifest());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a package with no program for the platform says where it looked and exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-npm-bin-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'mixdog.mjs'), readFileSync(join(root, 'bin', 'mixdog.mjs')));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const run = spawnSync(process.execPath, [join(dir, 'bin', 'mixdog.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /this package has no program for/);
    assert.match(run.stderr, /native-bin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the package declares the command and ships the launcher and the programs', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.bin, { mixdog: 'bin/mixdog.mjs' });
  assert.ok(manifest.files.includes('bin/'));
  assert.ok(manifest.files.includes('native-bin/'));
});
