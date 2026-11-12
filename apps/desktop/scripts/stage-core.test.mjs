import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { loadServerPayloads } from '../src/main/ssh/remote-install-payload.ts';
import { HOST_TARGETS, jsRuntimeManifest, stageCore, stageHostCore, workspaceVersion } from './stage-core.mjs';

function builtTargets(dir, targets) {
  for (const target of targets) {
    mkdirSync(join(dir, target, 'release'), { recursive: true });
    const name = target.includes('windows') ? 'mixdogd.exe' : 'mixdogd';
    writeFileSync(join(dir, target, 'release', name), `binary for ${target}`);
  }
}

/** A JS runtime payload stand-in: the layout of stage-js-bundle.mjs with placeholder contents. */
const fakePayload = (js = 'node') => async ({ key, payloadDir }) => {
  mkdirSync(join(payloadDir, 'js'), { recursive: true });
  writeFileSync(join(payloadDir, 'js', 'node'), `${js} for ${key}`);
  writeFileSync(join(payloadDir, 'js-runtime.json'), '{"program":"js/node","packageRoot":"js/pkg/node_modules/mixdog","electron":false}\n');
};

/** The payload check stand-in records what it was asked to verify; its real counterpart is core-layout.test.mjs. */
const verified = [];
const verifyPayload = async ({ key, payloadDir }) => {
  assert.ok(readFileSync(join(payloadDir, 'js-runtime.json'), 'utf8'));
  verified.push(key);
};

test('a local deploy stages the host core from a plain cargo release build, and refuses a core of another version', async () => {
  const dir = makeTempDirSync('stage-core-host');
  const runtimeDir = makeTempDirSync('stage-core-host-rt');
  const binary = join(dir, 'mixdogd.exe');
  writeFileSync(binary, 'cargo release build');
  const options = { binary, runtimeDir, host: { platform: 'win32', arch: 'x64' } };
  await assert.rejects(stageHostCore({ ...options, version: '1.4.6', reportedVersion: () => '1.4.5' }), /reports version 1\.4\.5/);
  assert.equal(existsSync(join(runtimeDir, 'core', 'mixdogd.exe')), false);

  await stageHostCore({ ...options, version: '1.4.6', reportedVersion: () => '1.4.6' });
  assert.equal(readFileSync(join(runtimeDir, 'core', 'mixdogd.exe'), 'utf8'), 'cargo release build');
  assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir, 'core', 'js-runtime.json'), 'utf8')), jsRuntimeManifest('win32', 'x64'));
  // The SSH install's bundles need every platform's build: a local deploy ships none.
  assert.equal(existsSync(join(runtimeDir, 'server-cores')), false);
});

test('a server payload that fails its integrity check is never archived', async () => {
  const targetDir = makeTempDirSync('stage-core-verify');
  const runtimeDir = makeTempDirSync('stage-core-verify-rt');
  builtTargets(targetDir, Object.values(HOST_TARGETS));
  await assert.rejects(
    stageCore({
      targetDir,
      runtimeDir,
      version: '1.4.6',
      host: { platform: 'win32', arch: 'x64' },
      reportedVersion: () => '1.4.6',
      buildPayload: fakePayload(),
      verifyPayload: async () => {
        throw new Error('ONNX Runtime library is missing');
      },
    }),
    /ONNX Runtime library is missing/
  );
  assert.equal(existsSync(join(runtimeDir, 'server-cores', 'servers.json')), false);
});

test('staging puts the host core and every server runtime where the build and the ssh install read them', async () => {
  const targetDir = makeTempDirSync('stage-core-target');
  const runtimeDir = makeTempDirSync('stage-core-runtime');
  builtTargets(targetDir, Object.values(HOST_TARGETS));
  const manifest = await stageCore({
    targetDir,
    runtimeDir,
    version: '1.4.6',
    host: { platform: 'win32', arch: 'x64' },
    reportedVersion: () => '1.4.6',
    buildPayload: fakePayload(),
    verifyPayload,
  });
  assert.equal(readFileSync(join(runtimeDir, 'core', 'mixdogd.exe'), 'utf8'), 'binary for x86_64-pc-windows-msvc');
  // The core finds the app binary (interpreter, node mode) and the package as real files beside the archive:
  // plain fs cannot read inside runtime.asar.
  assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir, 'core', 'js-runtime.json'), 'utf8')), {
    program: '../../Mixdog.exe',
    packageRoot: '../runtime.asar.unpacked/node_modules/mixdog',
    electron: true,
    // The file onnxruntime-node's binding loads, mirrored unpacked beside the archive.
    ortLibrary: '../runtime.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll',
  });
  // macOS x64 has no onnxruntime-node binding: its manifest names no library.
  assert.equal('ortLibrary' in jsRuntimeManifest('darwin', 'x64'), false);
  assert.deepEqual(Object.keys(manifest.binaries).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
  assert.deepEqual([...verified].sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'], 'every server payload is checked');
  // The ssh install reads exactly what was staged, and finds the same build.
  const payloads = await loadServerPayloads(join(runtimeDir, 'server-cores'));
  assert.equal(payloads.identity.build, manifest.build);
  assert.equal(payloads.identity.installId, `1.4.6-${manifest.build}`);
  const linux = await payloads.binary({ os: 'linux', arch: 'x64' });
  assert.equal(linux.sha256, manifest.binaries['linux-x64'].sha256);
  // One upload per platform: the binary and its JS runtime, in one archive.
  const listing = spawnSync('tar', ['-tzf', join(runtimeDir, 'server-cores', 'linux-x64', 'bundle.tgz')], { encoding: 'utf8' });
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.replace(/\/$/, ''));
  for (const entry of ['mixdogd', 'payload/js-runtime.json', 'payload/js/node']) assert.ok(entries.includes(entry), entry);
  // A rebuilt binary of any platform is a new build, and so is a changed JS runtime.
  const build = (js) => stageCore({
    targetDir,
    runtimeDir,
    version: '1.4.6',
    host: { platform: 'win32', arch: 'x64' },
    reportedVersion: () => '1.4.6',
    buildPayload: fakePayload(js),
    verifyPayload,
  });
  assert.equal((await build('node')).build, manifest.build, 'staging is reproducible');
  assert.notEqual((await build('node-next')).build, manifest.build);
  writeFileSync(join(targetDir, 'aarch64-apple-darwin', 'release', 'mixdogd'), 'rebuilt');
  assert.notEqual((await build('node')).build, manifest.build);
});

test('a missing target, or a host binary reporting another version, stops the staging', async () => {
  const targetDir = makeTempDirSync('stage-core-missing');
  const runtimeDir = makeTempDirSync('stage-core-missing-rt');
  builtTargets(targetDir, ['x86_64-pc-windows-msvc']);
  await assert.rejects(
    stageCore({
      targetDir,
      runtimeDir,
      version: '1.4.6',
      host: { platform: 'win32', arch: 'x64' },
      reportedVersion: () => '1.4.6',
      buildPayload: fakePayload(),
    verifyPayload,
    }),
    /x86_64-unknown-linux-gnu is not built/
  );
  builtTargets(targetDir, Object.values(HOST_TARGETS));
  // The host binary of the machine staging reports its own version.
  const host = { platform: 'win32', arch: 'x64' };
  await assert.rejects(
    stageCore({ targetDir, runtimeDir, version: '1.4.6', host, hostRunnable: true, reportedVersion: () => '1.4.5', buildPayload: fakePayload(), verifyPayload }),
    /reports version 1\.4\.5, but the release is 1\.4\.6/
  );
});

test('the release version is the workspace package version', async () => {
  const dir = makeTempDirSync('stage-core-cargo');
  const manifest = join(dir, 'Cargo.toml');
  writeFileSync(manifest, '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "1.4.6"\nedition = "2024"\n\n[dependencies]\nversion = "9"\n');
  assert.equal(await workspaceVersion(manifest), '1.4.6');
});
