import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { CLOSURE_RECORD, CORE_READS, desktopJsRuntimeManifest, ortBinaryDir, remoteJsRuntimeManifest } from './core-layout.mjs';
import { createPackage } from '@electron/asar';
import { DEFAULT_DELETION_LIST, parseDeletionList, verifyStagedResources } from './verify-staged-package.mjs';

const put = (file, text = 'x') => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** The package files the core reads, and the closure record, under `modules`. */
function packageTree(modules) {
  for (const file of CORE_READS.files) put(join(modules, 'mixdog', file), file.endsWith('.json') ? '{}' : '');
  for (const dir of CORE_READS.dirs) put(join(modules, 'mixdog', dir, 'file.md'));
  put(join(modules, CLOSURE_RECORD), '{"skippedOptional":[]}');
}

/** A linux-x64 desktop's resources: core/, the unpacked root, and one server bundle (linux-x64). */
function resources() {
  const top = makeTempDirSync('verify-staged');
  const root = join(top, 'resources');
  put(join(top, 'mixdog-desktop'));
  put(join(root, 'core', 'mixdogd'));
  put(join(root, 'core', 'js-runtime.json'), JSON.stringify(desktopJsRuntimeManifest('linux', 'x64')));
  const modules = join(root, 'runtime.asar.unpacked', 'node_modules');
  packageTree(modules);
  const binary = join(modules, 'onnxruntime-node', ortBinaryDir('linux', 'x64'));
  put(join(binary, 'libonnxruntime.so.1'));
  put(join(binary, 'onnxruntime_binding.node'));

  const bundleDir = join(top, 'bundle');
  const wanted = remoteJsRuntimeManifest('linux', 'x64');
  put(join(bundleDir, 'mixdogd'));
  put(join(bundleDir, 'payload', 'js-runtime.json'), JSON.stringify(wanted));
  put(join(bundleDir, 'payload', wanted.packageRoot, 'package.json'), '{}');
  put(join(bundleDir, 'payload', wanted.ortLibrary));
  const bundle = join(root, 'server-cores', 'linux-x64', 'bundle.tgz');
  mkdirSync(dirname(bundle), { recursive: true });
  execFileSync('tar', ['-czf', bundle, '-C', bundleDir, 'mixdogd', 'payload']);
  const sha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
  put(join(root, 'server-cores', 'servers.json'), JSON.stringify({ binaries: { 'linux-x64': { bundle: { file: 'bundle.tgz', sha256 } } } }));
  return { root, top, bundleDir, bundle };
}

test('complete resources pass: the core, the unpacked root, the ONNX library and each server bundle', () => {
  const { root } = resources();
  assert.deepEqual(verifyStagedResources({ resources: root, platform: 'linux', arch: 'x64' }), ['linux-x64']);
});

test('resources missing what the core needs are refused', () => {
  const noCore = resources();
  rmSync(join(noCore.root, 'core', 'mixdogd'));
  assert.throws(() => verifyStagedResources({ resources: noCore.root, platform: 'linux', arch: 'x64' }), /the Rust core .* is not in the package/);

  const noRules = resources();
  rmSync(join(noRules.root, 'runtime.asar.unpacked/node_modules/mixdog/src/rules'), { recursive: true });
  assert.throws(() => verifyStagedResources({ resources: noRules.root, platform: 'linux', arch: 'x64' }), /missing or empty src\/rules/);

  const noLibrary = resources();
  rmSync(join(noLibrary.root, 'runtime.asar.unpacked/node_modules/onnxruntime-node', ortBinaryDir('linux', 'x64'), 'libonnxruntime.so.1'));
  assert.throws(() => verifyStagedResources({ resources: noLibrary.root, platform: 'linux', arch: 'x64' }), /ONNX Runtime library .* does not exist/);
});

test('a file of the K1 deletion list in the unpacked package, runtime.asar or a server bundle is refused', async () => {
  const deleted = parseDeletionList('# header\nsrc/repl.mjs\n## KEEP: tests\nsrc/keep.test.mjs\n## DELETE: Node source\nsrc/app.mjs\n## MOVE (not deleted)\nsrc/moved.json\n');
  assert.deepEqual([...deleted], ['src/repl.mjs', 'src/app.mjs']);
  assert.deepEqual(verifyStagedResources({ resources: resources().root, platform: 'linux', arch: 'x64', deleted }), ['linux-x64']);

  const inUnpacked = resources();
  put(join(inUnpacked.root, 'runtime.asar.unpacked/node_modules/mixdog/src/app.mjs'));
  assert.throws(() => verifyStagedResources({ resources: inUnpacked.root, platform: 'linux', arch: 'x64', deleted }), /runtime\.asar\.unpacked.*packs 1 file\(s\) the K1 cut deletes, e\.g\. src\/app\.mjs/);

  const inArchive = resources();
  const archiveSource = join(inArchive.top, 'archive-source');
  put(join(archiveSource, 'node_modules/mixdog/src/repl.mjs'));
  await createPackage(archiveSource, join(inArchive.root, 'runtime.asar'));
  assert.throws(() => verifyStagedResources({ resources: inArchive.root, platform: 'linux', arch: 'x64', deleted }), /runtime\.asar packs 1 file\(s\).*src\/repl\.mjs/);

  const inBundle = resources();
  put(join(inBundle.bundleDir, 'payload', remoteJsRuntimeManifest('linux', 'x64').packageRoot, 'src/app.mjs'));
  execFileSync('tar', ['-czf', inBundle.bundle, '-C', inBundle.bundleDir, 'mixdogd', 'payload']);
  const sha256 = createHash('sha256').update(readFileSync(inBundle.bundle)).digest('hex');
  put(join(inBundle.root, 'server-cores', 'servers.json'), JSON.stringify({ binaries: { 'linux-x64': { bundle: { file: 'bundle.tgz', sha256 } } } }));
  assert.throws(() => verifyStagedResources({ resources: inBundle.root, platform: 'linux', arch: 'x64', deleted }), /bundle\.tgz packs 1 file\(s\).*src\/app\.mjs/);
});

test('core resources only inside runtime.asar are refused: MIXDOG_ROOT needs real files', async () => {
  const tree = resources();
  rmSync(join(tree.root, 'runtime.asar.unpacked/node_modules/mixdog/src/rules'), { recursive: true });
  const source = join(tree.top, 'asar-rules');
  put(join(source, 'node_modules/mixdog/src/rules/a.md'));
  await createPackage(source, join(tree.root, 'runtime.asar'));
  assert.throws(() => verifyStagedResources({ resources: tree.root, platform: 'linux', arch: 'x64', deleted: new Set() }), /src\/rules are only inside runtime\.asar; MIXDOG_ROOT/);
});

test('the committed deletion list holds package paths and none a K1 survivor needs', () => {
  const deleted = parseDeletionList(readFileSync(DEFAULT_DELETION_LIST, 'utf8'));
  assert.ok(deleted.size > 2000);
  for (const kept of [...CORE_READS.files, 'src/ext-host/worker.mjs', 'src/skill-script-entry.mjs']) assert.equal(deleted.has(kept), false, kept);
});

test('a server bundle that lost its ONNX library, or no longer matches servers.json, is refused', () => {
  const lost = resources();
  rmSync(join(lost.bundleDir, 'payload', remoteJsRuntimeManifest('linux', 'x64').ortLibrary));
  execFileSync('tar', ['-czf', lost.bundle, '-C', lost.bundleDir, 'mixdogd', 'payload']);
  assert.throws(
    () => verifyStagedResources({ resources: lost.root, platform: 'linux', arch: 'x64' }),
    /linux-x64: bundle\.tgz does not match servers\.json[\s\S]*bundle\.tgz holds no payload\/js\/pkg\/node_modules\/onnxruntime-node\/bin\/napi-v6\/linux\/x64\/libonnxruntime\.so\.1/
  );
});
