import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { loadServerPayloads } from '../src/main/ssh/remote-install-payload.ts';
import { HOST_TARGETS, stageCore, workspaceVersion } from './stage-core.mjs';

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
  });
  assert.equal(readFileSync(join(runtimeDir, 'core', 'mixdogd.exe'), 'utf8'), 'binary for x86_64-pc-windows-msvc');
  // The core finds the app binary (interpreter, node mode) and the package inside runtime.asar from here.
  assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir, 'core', 'js-runtime.json'), 'utf8')), {
    program: '../../Mixdog.exe',
    packageRoot: '../runtime.asar/node_modules/mixdog',
    electron: true,
  });
  assert.deepEqual(Object.keys(manifest.binaries).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
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
    }),
    /x86_64-unknown-linux-gnu is not built/
  );
  builtTargets(targetDir, Object.values(HOST_TARGETS));
  // The host binary of the machine staging reports its own version.
  const host = { platform: 'win32', arch: 'x64' };
  await assert.rejects(
    stageCore({ targetDir, runtimeDir, version: '1.4.6', host, hostRunnable: true, reportedVersion: () => '1.4.5', buildPayload: fakePayload() }),
    /reports version 1\.4\.5, but the release is 1\.4\.6/
  );
});

test('the release version is the workspace package version', async () => {
  const dir = makeTempDirSync('stage-core-cargo');
  const manifest = join(dir, 'Cargo.toml');
  writeFileSync(manifest, '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "1.4.6"\nedition = "2024"\n\n[dependencies]\nversion = "9"\n');
  assert.equal(await workspaceVersion(manifest), '1.4.6');
});
