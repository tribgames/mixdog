import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { createPackage } from '@electron/asar';

import { CORE_READS, ortBinaryDir, remoteJsRuntimeManifest } from './core-layout.mjs';
import { install, put } from './core-layout-fixture.mjs';
import { DEFAULT_DELETION_LIST, parseDeletionList, verifyStagedResources } from './verify-staged-package.mjs';

const SERVERS = [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64']];
const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The header of a 64-bit little-endian ELF image for `machine` (0x3e x64, 0xb7 arm64): what the architecture check reads. */
function elfImage(machine) {
  const image = Buffer.alloc(64);
  image.writeUInt32BE(0x7f454c46, 0);
  image[4] = 2;
  image[5] = 1;
  image.writeUInt16LE(machine, 18);
  return image;
}

/** A complete linux-x64 desktop package: core/, the unpacked root, and a complete bundle for each server
 *  platform (a real payload of core-layout's remote layout). */
function resources() {
  const desktop = install('desktop', 'linux', 'x64');
  const { root, top } = desktop;
  put(join(root, 'core', 'mixdogd'));
  put(join(root, 'core', 'mixdog-askpass'));
  put(join(root, 'native-tools', 'mixdog_main_native.node'), elfImage(0x3e));
  const tree = { ...desktop, bundleDirs: {}, binaries: {} };
  tree.pack = (key) => {
    const bundle = join(root, 'server-cores', key, 'bundle.tgz');
    mkdirSync(dirname(bundle), { recursive: true });
    execFileSync('tar', ['-czf', bundle, '-C', tree.bundleDirs[key], 'mixdogd', 'payload']);
    tree.binaries[key].bundle = { file: 'bundle.tgz', sha256: sha256Of(bundle) };
    tree.writeServers();
    return bundle;
  };
  tree.writeServers = () => put(join(root, 'server-cores', 'servers.json'), JSON.stringify({ binaries: tree.binaries }));
  for (const [platform, arch] of SERVERS) {
    const key = `${platform}-${arch}`;
    tree.bundleDirs[key] = join(top, 'bundles', key);
    put(join(tree.bundleDirs[key], 'mixdogd'), `mixdogd for ${key}`);
    install('remote', platform, arch, join(tree.bundleDirs[key], 'payload'));
    tree.binaries[key] = { sha256: sha256Of(join(tree.bundleDirs[key], 'mixdogd')) };
    tree.pack(key);
  }
  return tree;
}

const verify = (tree, extra = {}) => verifyStagedResources({ resources: tree.root, platform: 'linux', arch: 'x64', ...extra });
const payloadOf = (tree, key) => join(tree.bundleDirs[key], 'payload');

test('complete resources pass: the core, the unpacked root, the ONNX library and each server platform\'s bundle', () => {
  assert.deepEqual(verify(resources()), SERVERS.map(([platform, arch]) => `${platform}-${arch}`));
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

  const noLibrary = resources();
  rmSync(join(noLibrary.modules, 'onnxruntime-node', ortBinaryDir('linux', 'x64'), 'libonnxruntime.so.1'));
  assert.throws(() => verify(noLibrary), /ONNX Runtime library .* does not exist/);
});

test('a package without the main-process native module, or with one built for another architecture, is refused', () => {
  const absent = resources();
  rmSync(join(absent.root, 'native-tools', 'mixdog_main_native.node'));
  assert.throws(() => verify(absent), /the main-process native module .*mixdog_main_native\.node is not in the package/);

  const foreign = resources();
  writeFileSync(join(foreign.root, 'native-tools', 'mixdog_main_native.node'), elfImage(0xb7));
  assert.throws(() => verify(foreign), /the main-process native module .* does not run on linux-x64/);
});

test('a manifest that does not list exactly the server platforms is refused', () => {
  const empty = resources();
  empty.binaries = {};
  empty.writeServers();
  assert.throws(() => verify(empty), /servers\.json lists no linux-x64 bundle[\s\S]*no darwin-arm64 bundle/);

  const short = resources();
  delete short.binaries['darwin-arm64'];
  short.writeServers();
  assert.throws(() => verify(short), /servers\.json lists no darwin-arm64 bundle/);

  const extra = resources();
  extra.binaries['win32-x64'] = extra.binaries['linux-x64'];
  extra.writeServers();
  assert.throws(() => verify(extra), /win32-x64, which is not a server platform/);
});

test('each server bundle is unpacked and checked as the staging checked the payload: manifest, interpreter, resources, closure, ONNX Runtime', () => {
  const damaged = (key, damage, pattern) => {
    const tree = resources();
    damage(tree, payloadOf(tree, key));
    tree.pack(key);
    assert.throws(() => verify(tree), pattern, key);
  };
  damaged('linux-arm64', (_tree, payload) => rmSync(join(payload, 'js/node')), /linux-arm64: [\s\S]*interpreter .* does not exist/);
  damaged('linux-x64', (_tree, payload) => rmSync(join(payload, 'js/pkg/node_modules/mixdog/src/workflows'), { recursive: true }), /linux-x64: [\s\S]*missing or empty src\/workflows/);
  damaged('darwin-arm64', (_tree, payload) => rmSync(join(payload, 'js/pkg/node_modules/beta'), { recursive: true }), /darwin-arm64: [\s\S]*beta \(dependency of alpha\) is not installed/);
  damaged('linux-x64', (_tree, payload) => rmSync(join(payload, remoteJsRuntimeManifest('linux', 'x64').ortLibrary)), /linux-x64: [\s\S]*ONNX Runtime library .* does not exist/);
  damaged('linux-x64', (_tree, payload) => rmSync(join(payload, 'js/pkg/node_modules/onnxruntime-node', ortBinaryDir('linux', 'x64'), 'onnxruntime_binding.node')), /onnxruntime_binding\.node is missing beside/);
  damaged('darwin-x64', (_tree, payload) => put(join(payload, 'js-runtime.json'), '{"program":"js/node"}'), /darwin-x64: [\s\S]*js-runtime\.json is/);

  const noBinary = resources();
  const noBinaryBundle = join(noBinary.root, 'server-cores', 'linux-x64', 'bundle.tgz');
  execFileSync('tar', ['-czf', noBinaryBundle, '-C', noBinary.bundleDirs['linux-x64'], 'payload']);
  noBinary.binaries['linux-x64'].bundle.sha256 = sha256Of(noBinaryBundle);
  noBinary.writeServers();
  assert.throws(() => verify(noBinary), /linux-x64: bundle\.tgz holds no mixdogd/);

  const swapped = resources();
  put(join(swapped.bundleDirs['darwin-x64'], 'mixdogd'), 'another build');
  swapped.pack('darwin-x64');
  assert.throws(() => verify(swapped), /darwin-x64: the bundle's mixdogd does not match servers\.json/);

  const stale = resources();
  put(join(payloadOf(stale, 'linux-x64'), 'js/node'), 'changed after packing');
  execFileSync('tar', ['-czf', join(stale.root, 'server-cores', 'linux-x64', 'bundle.tgz'), '-C', stale.bundleDirs['linux-x64'], 'mixdogd', 'payload']);
  assert.throws(() => verify(stale), /linux-x64: bundle\.tgz does not match servers\.json/);
});

test('a file of the K1 deletion list in the unpacked package, runtime.asar or a server bundle is refused', async () => {
  const deleted = parseDeletionList('# header\nsrc/repl.mjs\n## KEEP: tests\nsrc/keep.test.mjs\n## DELETE: Node source\nsrc/app.mjs\n## MOVE (not deleted)\nsrc/moved.json\n');
  assert.deepEqual([...deleted], ['src/repl.mjs', 'src/app.mjs']);
  assert.equal(verify(resources(), { deleted }).length, SERVERS.length);

  const inUnpacked = resources();
  put(join(inUnpacked.modules, 'mixdog/src/app.mjs'));
  assert.throws(() => verify(inUnpacked, { deleted }), /runtime\.asar\.unpacked.*packs 1 file\(s\) the K1 cut deletes, e\.g\. src\/app\.mjs/);

  const inArchive = resources();
  const archiveSource = join(inArchive.top, 'archive-source');
  put(join(archiveSource, 'node_modules/mixdog/src/repl.mjs'));
  await createPackage(archiveSource, join(inArchive.root, 'runtime.asar'));
  assert.throws(() => verify(inArchive, { deleted }), /runtime\.asar packs 1 file\(s\).*src\/repl\.mjs/);

  const inBundle = resources();
  put(join(payloadOf(inBundle, 'linux-x64'), remoteJsRuntimeManifest('linux', 'x64').packageRoot, 'src/app.mjs'));
  inBundle.pack('linux-x64');
  assert.throws(() => verify(inBundle, { deleted }), /bundle\.tgz packs 1 file\(s\).*src\/app\.mjs/);
});

test('src/defaults/shipped-history.json only inside runtime.asar is refused', async () => {
  const tree = resources();
  rmSync(join(tree.modules, 'mixdog/src/defaults/shipped-history.json'));
  const source = join(tree.top, 'asar-history');
  put(join(source, 'node_modules/mixdog/src/defaults/shipped-history.json'));
  await createPackage(source, join(tree.root, 'runtime.asar'));
  assert.throws(() => verify(tree, { deleted: new Set() }), /src\/defaults\/shipped-history\.json are only inside runtime\.asar; MIXDOG_ROOT/);
});

test('core resources only inside runtime.asar are refused: MIXDOG_ROOT needs real files', async () => {
  const tree = resources();
  rmSync(join(tree.modules, 'mixdog/src/rules'), { recursive: true });
  const source = join(tree.top, 'asar-rules');
  put(join(source, 'node_modules/mixdog/src/rules/a.md'));
  await createPackage(source, join(tree.root, 'runtime.asar'));
  assert.throws(() => verify(tree, { deleted: new Set() }), /src\/rules are only inside runtime\.asar; MIXDOG_ROOT/);
});

test('the committed deletion list holds package paths and none a K1 survivor needs', () => {
  const text = readFileSync(DEFAULT_DELETION_LIST, 'utf8');
  const deleted = parseDeletionList(text);
  assert.ok(deleted.size > 2000);
  assert.match(text, /single authority/);
  for (const kept of [...CORE_READS.files, 'src/ext-host/worker.mjs', 'src/skill-script-entry.mjs']) assert.equal(deleted.has(kept), false, kept);
});
