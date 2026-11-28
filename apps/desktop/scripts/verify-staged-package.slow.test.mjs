import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { manifestBuild, SERVER_PLATFORM_TARGETS, serverBundleAsset } from '../src/main/ssh/server-manifest.mjs';
import { CORE_READS, ortBinaryDir, remoteJsRuntimeManifest } from './core-layout.mjs';
import { install, put } from './core-layout-fixture.mjs';
import {
  DEFAULT_DELETION_LIST,
  parseDeletionList,
  verifyServerSet,
  verifyStagedResources,
} from './verify-staged-package.mjs';

const VERSION = '1.5.0';
const KEYS = Object.keys(SERVER_PLATFORM_TARGETS);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The header of a 64-bit little-endian ELF image for `machine` (0x3e x64, 0xb7 arm64): what the architecture check reads. */
function elfImage(machine) {
  const image = Buffer.alloc(64);
  image.writeUInt32BE(0x7f454c46, 0);
  image[4] = 2;
  image[5] = 1;
  image.writeUInt16LE(machine, 18);
  return image;
}

/** The manifest of a release's server set (`servers.json`): one entry per server platform, complete. */
function manifestOf(binaries) {
  return { version: VERSION, build: manifestBuild(binaries), binaries };
}

/** A complete linux-x64 desktop package: core/, the unpacked root, the main-process module, and the manifest of the
 *  server bundles alone in server-cores/. */
function resources() {
  const desktop = install('desktop', 'linux', 'x64');
  const { root } = desktop;
  put(join(root, 'core', 'mixdogd'));
  put(join(root, 'core', 'mixdog-askpass'));
  put(join(root, 'native-tools', 'mixdog_main_native.node'), elfImage(0x3e));
  const binaries = {};
  for (const key of KEYS)
    binaries[key] = {
      target: SERVER_PLATFORM_TARGETS[key],
      sha256: sha256(`mixdogd for ${key}`),
      size: 1,
      bundle: { asset: serverBundleAsset(key), sha256: sha256(`bundle ${key}`), size: 2, content: sha256(`content ${key}`) },
    };
  const tree = { ...desktop, manifest: manifestOf(binaries) };
  tree.writeManifest = () => put(join(root, 'server-cores', 'servers.json'), JSON.stringify(tree.manifest));
  tree.writeManifest();
  return tree;
}

/** A package for this test's own machine is linux-x64 only by name: its core is no program, so it is not run unless asked. */
const verify = (tree, extra = {}) =>
  verifyStagedResources({ resources: tree.root, platform: 'linux', arch: 'x64', hostRunnable: false, ...extra });

/** A release's server set: a real bundle per server platform (mixdogd and a payload of core-layout's remote layout) and
 *  the manifest of them, alone in their folder. */
function serverSet() {
  const dir = makeTempDirSync('verify-server-set');
  const sources = makeTempDirSync('verify-server-sources');
  const set = { dir, sources: {}, binaries: {} };
  set.writeManifest = () => put(join(dir, 'servers.json'), JSON.stringify(manifestOf(set.binaries)));
  set.pack = (key, entries = ['mixdogd', 'payload']) => {
    const asset = join(dir, serverBundleAsset(key));
    execFileSync('tar', ['-czf', asset, '-C', set.sources[key], ...entries]);
    const bytes = readFileSync(asset);
    set.binaries[key].bundle = {
      asset: serverBundleAsset(key),
      sha256: sha256(bytes),
      size: bytes.length,
      content: sha256(`content ${key}`),
    };
    set.writeManifest();
    return asset;
  };
  for (const key of KEYS) {
    const [platform, arch] = key.split('-');
    set.sources[key] = join(sources, key);
    put(join(set.sources[key], 'mixdogd'), `mixdogd for ${key}`);
    install('remote', platform, arch, join(set.sources[key], 'payload'));
    set.binaries[key] = { target: SERVER_PLATFORM_TARGETS[key], sha256: sha256(`mixdogd for ${key}`), size: 1 };
    set.pack(key);
  }
  return set;
}

const payloadOf = (set, key) => join(set.sources[key], 'payload');

test('a complete package passes: the core, the unpacked root, the ONNX library and the manifest of the server bundles', () => {
  assert.deepEqual(verify(resources()), KEYS);
});

test('the core the package starts runs here and reports the version of the server manifest it carries', () => {
  const tree = resources();
  const started = [];
  const reportedVersion = (file) => {
    started.push(file);
    return VERSION;
  };
  assert.deepEqual(verify(tree, { hostRunnable: true, reportedVersion }), KEYS);
  assert.deepEqual(started, [join(tree.root, 'core', 'mixdogd')]);
  assert.throws(
    () => verify(tree, { hostRunnable: true, reportedVersion: () => '1.4.6' }),
    /mixdogd reports version 1\.4\.6, the server manifest is 1\.5\.0/
  );
  const broken = () => {
    throw new Error('mixdogd --version exited with 1');
  };
  assert.throws(() => verify(tree, { hostRunnable: true, reportedVersion: broken }), /mixdogd does not run: .*exited with 1/);
  // A host-only package has no manifest: its core has only to run.
  rmSync(join(tree.root, 'server-cores'), { recursive: true });
  assert.deepEqual(verify(tree, { hostOnly: true, hostRunnable: true, reportedVersion: () => '9.9.9' }), []);
});

test('a package that carries a server bundle, or anything beside the manifest, is refused', () => {
  const legacy = resources();
  put(join(legacy.root, 'server-cores', 'linux-x64', 'bundle.tgz'));
  assert.throws(() => verify(legacy), /bundle\.tgz is a server bundle: those are release assets/);
  assert.throws(() => verify(legacy), /server-cores[\\/]linux-x64 is packed beside servers\.json/);

  const asset = resources();
  put(join(asset.root, 'native-tools', 'mixdog-server-darwin-arm64.tgz'));
  assert.throws(() => verify(asset), /mixdog-server-darwin-arm64\.tgz is a server bundle/);
  assert.throws(() => verify(asset, { hostOnly: true }), /mixdog-server-darwin-arm64\.tgz is a server bundle/);
});

test('a manifest that is not one of a release is refused', () => {
  const short = resources();
  delete short.manifest.binaries['darwin-arm64'];
  short.manifest.build = manifestBuild(short.manifest.binaries);
  short.writeManifest();
  assert.throws(
    () => verify(short),
    /servers\.json: it lists darwin-x64, linux-arm64, linux-x64, not darwin-arm64, darwin-x64, linux-arm64, linux-x64/
  );

  const extra = resources();
  extra.manifest.binaries['win32-x64'] = extra.manifest.binaries['linux-x64'];
  extra.manifest.build = manifestBuild(extra.manifest.binaries);
  extra.writeManifest();
  assert.throws(() => verify(extra), /servers\.json: it lists .*win32-x64, not/);

  const unnamed = resources();
  delete unnamed.manifest.binaries['linux-x64'].bundle.asset;
  unnamed.writeManifest();
  assert.throws(() => verify(unnamed), /linux-x64: the bundle asset is undefined, not mixdog-server-linux-x64\.tgz/);

  const unmeasured = resources();
  unmeasured.manifest.binaries['linux-arm64'].bundle.size = 0;
  unmeasured.writeManifest();
  assert.throws(() => verify(unmeasured), /linux-arm64: the bundle's sha256, size or content digest is missing/);

  const swapped = resources();
  swapped.manifest.binaries['darwin-x64'].target = 'aarch64-apple-darwin';
  swapped.writeManifest();
  assert.throws(() => verify(swapped), /darwin-x64: the target is aarch64-apple-darwin, not x86_64-apple-darwin/);

  const rebuilt = resources();
  rebuilt.manifest.binaries['linux-x64'].sha256 = sha256('rebuilt');
  rebuilt.writeManifest();
  assert.throws(() => verify(rebuilt), /the recorded build is not the build of the listed binaries/);
});

test('resources missing what the core needs are refused', () => {
  const noCore = resources();
  rmSync(join(noCore.root, 'core', 'mixdogd'));
  assert.throws(() => verify(noCore), /the Rust core .* is not in the package/);

  for (const dir of CORE_READS.dirs) {
    const missing = resources();
    rmSync(join(missing.modules, 'mixdog', dir), { recursive: true });
    assert.throws(() => verify(missing), new RegExp(`missing or empty ${dir}`));
  }

  const noAskpass = resources();
  rmSync(join(noAskpass.root, 'core', 'mixdog-askpass'));
  assert.throws(() => verify(noAskpass), /the ssh askpass helper .* is not in the package/);

  const noLibrary = resources();
  rmSync(join(noLibrary.modules, 'onnxruntime-node', ortBinaryDir('linux', 'x64'), 'libonnxruntime.so.1'));
  assert.throws(() => verify(noLibrary), /ONNX Runtime library .* does not exist/);

  for (const file of CORE_READS.files.filter((name) => name.startsWith('data/pptxgenjs/'))) {
    const missing = resources();
    rmSync(join(missing.modules, 'mixdog', file));
    assert.throws(() => verify(missing), new RegExp(`missing file ${file.replaceAll('.', '\\.')}`));
  }
});

test('a package without the main-process native module, or with one built for another architecture, is refused', () => {
  const absent = resources();
  rmSync(join(absent.root, 'native-tools', 'mixdog_main_native.node'));
  assert.throws(
    () => verify(absent),
    /the main-process native module .*mixdog_main_native\.node is not in the package/
  );

  const foreign = resources();
  writeFileSync(join(foreign.root, 'native-tools', 'mixdog_main_native.node'), elfImage(0xb7));
  assert.throws(() => verify(foreign), /the main-process native module .* does not run on linux-x64/);
});

const verifySet = (set, extra = {}) => verifyServerSet({ dir: set.dir, deleted: new Set(), ...extra });

test("the release's server set passes when each bundle is the bytes its manifest lists, and nothing else is in it", () => {
  assert.deepEqual(verifySet(serverSet()), KEYS);

  const stray = serverSet();
  put(join(stray.dir, 'mixdog-server-linux-riscv64.tgz'));
  assert.throws(() => verifySet(stray), /mixdog-server-linux-riscv64\.tgz is not part of a server set/);

  const missing = serverSet();
  rmSync(join(missing.dir, serverBundleAsset('darwin-x64')));
  assert.throws(() => verifySet(missing), /darwin-x64: .*mixdog-server-darwin-x64\.tgz is missing/);

  const unlisted = serverSet();
  delete unlisted.binaries['linux-arm64'];
  unlisted.writeManifest();
  assert.throws(() => verifySet(unlisted), /servers\.json: it lists darwin-arm64, darwin-x64, linux-x64, not/);
});

test('each server bundle is unpacked and checked as the staging checked the payload: manifest, interpreter, resources, closure, ONNX Runtime', () => {
  const damaged = (key, damage, pattern) => {
    const set = serverSet();
    damage(set, payloadOf(set, key));
    set.pack(key);
    assert.throws(() => verifySet(set), pattern, key);
  };
  damaged(
    'linux-arm64',
    (_tree, payload) => rmSync(join(payload, 'js/node')),
    /linux-arm64: [\s\S]*interpreter .* does not exist/
  );
  damaged(
    'linux-x64',
    (_tree, payload) => rmSync(join(payload, 'js/pkg/node_modules/mixdog/src/workflows'), { recursive: true }),
    /linux-x64: [\s\S]*missing or empty src\/workflows/
  );
  damaged(
    'darwin-arm64',
    (_tree, payload) => rmSync(join(payload, 'js/pkg/node_modules/beta'), { recursive: true }),
    /darwin-arm64: [\s\S]*beta \(dependency of alpha\) is not installed/
  );
  damaged(
    'linux-x64',
    (_tree, payload) => rmSync(join(payload, remoteJsRuntimeManifest('linux', 'x64').ortLibrary)),
    /linux-x64: [\s\S]*ONNX Runtime library .* does not exist/
  );
  damaged(
    'linux-x64',
    (_tree, payload) =>
      rmSync(
        join(payload, 'js/pkg/node_modules/onnxruntime-node', ortBinaryDir('linux', 'x64'), 'onnxruntime_binding.node')
      ),
    /onnxruntime_binding\.node is missing beside/
  );
  damaged(
    'darwin-x64',
    (_tree, payload) => put(join(payload, 'js-runtime.json'), '{"program":"js/node"}'),
    /darwin-x64: [\s\S]*js-runtime\.json is/
  );

  const noBinary = serverSet();
  noBinary.pack('linux-x64', ['payload']);
  assert.throws(() => verifySet(noBinary), /linux-x64: mixdog-server-linux-x64\.tgz holds no mixdogd/);

  const swapped = serverSet();
  put(join(swapped.sources['darwin-x64'], 'mixdogd'), 'another build');
  swapped.pack('darwin-x64');
  assert.throws(() => verifySet(swapped), /darwin-x64: the bundle's mixdogd does not match servers\.json/);

  const stale = serverSet();
  put(join(payloadOf(stale, 'linux-x64'), 'js/node'), 'changed after packing');
  execFileSync('tar', [
    '-czf',
    join(stale.dir, serverBundleAsset('linux-x64')),
    '-C',
    stale.sources['linux-x64'],
    'mixdogd',
    'payload',
  ]);
  assert.throws(() => verifySet(stale), /linux-x64: mixdog-server-linux-x64\.tgz does not match servers\.json/);
});

test('a file of the K1 deletion list in the unpacked package or a server bundle is refused', async () => {
  const deleted = parseDeletionList(
    '# header\nsrc/repl.mjs\n## KEEP: tests\nsrc/keep.test.mjs\n## DELETE: Node source\nsrc/app.mjs\n## MOVE (not deleted)\nsrc/moved.json\n'
  );
  assert.deepEqual([...deleted], ['src/repl.mjs', 'src/app.mjs']);
  assert.equal(verify(resources(), { deleted }).length, KEYS.length);

  const inUnpacked = resources();
  put(join(inUnpacked.modules, 'mixdog/src/app.mjs'));
  assert.throws(
    () => verify(inUnpacked, { deleted }),
    /runtime\.asar\.unpacked.*packs 1 file\(s\) the K1 cut deletes, e\.g\. src\/app\.mjs/
  );

  const inBundle = serverSet();
  assert.equal(verifySet(inBundle, { deleted }).length, KEYS.length);
  put(join(payloadOf(inBundle, 'linux-x64'), remoteJsRuntimeManifest('linux', 'x64').packageRoot, 'src/app.mjs'));
  inBundle.pack('linux-x64');
  assert.throws(() => verifySet(inBundle, { deleted }), /mixdog-server-linux-x64\.tgz packs 1 file\(s\).*src\/app\.mjs/);
});

test('a package that ships runtime.asar is refused: nothing opens it and the core reads real files', () => {
  const tree = resources();
  put(join(tree.root, 'runtime.asar'));
  assert.throws(() => verify(tree, { deleted: new Set() }), /runtime\.asar is shipped, but nothing opens it/);
});

test('the Linux package carries the WebAssembly sharp the Electron interpreter loads', () => {
  const tree = resources();
  rmSync(join(tree.modules, '@img/sharp-wasm32'), { recursive: true });
  assert.throws(
    () => verify(tree, { deleted: new Set() }),
    /@img\/sharp-wasm32 \(reached from the remote entry points\) is not installed/
  );
});

test('the committed deletion list holds package paths and none a K1 survivor needs', () => {
  const text = readFileSync(DEFAULT_DELETION_LIST, 'utf8');
  const deleted = parseDeletionList(text);
  assert.ok(deleted.size > 2000);
  assert.match(text, /single authority/);
  for (const kept of [...CORE_READS.files, 'src/skill-script-entry.mjs']) assert.equal(deleted.has(kept), false, kept);
});
