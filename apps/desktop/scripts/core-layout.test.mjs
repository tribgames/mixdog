import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import {
  CLOSURE_RECORD,
  CORE_READS,
  desktopJsRuntimeManifest,
  mirrorCoreRuntime,
  ortBinaryDir,
  remoteJsRuntimeManifest,
  trimOrtBinaries,
  verifyCoreInstall,
  verifyCoreTree,
} from './core-layout.mjs';

const put = (file, text = 'x') => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const LIBRARY = { win32: 'onnxruntime.dll', linux: 'libonnxruntime.so.1', darwin: 'libonnxruntime.1.dylib' };
const SIBLINGS = {
  win32: ['onnxruntime_binding.node', 'DirectML.dll','msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'],
  linux: ['onnxruntime_binding.node'],
  darwin: ['onnxruntime_binding.node'],
};

/** A `node_modules` holding the package (the files the core reads, an ext host reaching `alpha`, which
 *  depends on `beta`) and, where the platform has one, the ONNX Runtime directory. */
function modulesTree(modules, platform, arch) {
  const mixdog = join(modules, 'mixdog');
  for (const file of CORE_READS.files) put(join(mixdog, file), file.endsWith('.json') ? '{}' : '');
  put(join(mixdog, 'src/ext-host/worker.mjs'), "import 'alpha';\n");
  put(join(mixdog, 'src/skill-script-entry.mjs'), '');
  for (const dir of CORE_READS.dirs) put(join(mixdog, dir, 'file.md'));
  put(join(modules, 'alpha/package.json'), JSON.stringify({ name: 'alpha', dependencies: { beta: '1' } }));
  put(join(modules, 'beta/package.json'), JSON.stringify({ name: 'beta' }));
  put(join(modules, CLOSURE_RECORD), JSON.stringify({ skippedOptional: [] }));
  if (platform === 'darwin' && arch === 'x64') return;
  const binary = join(modules, 'onnxruntime-node', ortBinaryDir(platform, arch));
  put(join(binary, LIBRARY[platform]));
  for (const sibling of SIBLINGS[platform]) put(join(binary, sibling));
}

/** `resources/` of a desktop package or `payload/` of a server bundle, complete for `platform`/`arch`. */
function install(kind, platform, arch) {
  // The desktop's resources sit one level inside its app directory: the interpreter is `../../<app>` of core/.
  const top = makeTempDirSync(`core-layout-${kind}`);
  const root = kind === 'desktop' ? join(top, 'resources') : top;
  const manifest = (kind === 'desktop' ? desktopJsRuntimeManifest : remoteJsRuntimeManifest)(platform, arch);
  const dir = kind === 'desktop' ? join(root, 'core') : root;
  put(join(dir, 'js-runtime.json'), JSON.stringify(manifest));
  put(join(dir, manifest.program));
  modulesTree(kind === 'desktop' ? join(root, 'runtime.asar.unpacked/node_modules') : join(root, 'js/pkg/node_modules'), platform, arch);
  return { root, dir, modules: kind === 'desktop' ? join(root, 'runtime.asar.unpacked/node_modules') : join(root, 'js/pkg/node_modules') };
}

const verify = (kind, { dir }, platform, arch, extra = {}) => verifyCoreInstall({ manifestDir: dir, kind, platform, arch, ...extra });

test('the desktop manifest names real files outside the archive; the ONNX library is the one the binding loads', () => {
  for (const [platform, arch] of [['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['darwin', 'arm64']]) {
    const manifest = desktopJsRuntimeManifest(platform, arch);
    assert.doesNotMatch(manifest.packageRoot, /\.asar(\/|$)/);
    assert.equal(manifest.packageRoot, '../runtime.asar.unpacked/node_modules/mixdog');
    assert.equal(manifest.ortLibrary, `../runtime.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/${platform}/${arch}/${LIBRARY[platform]}`);
  }
  // macOS Intel has no onnxruntime-node binding: both layouts name no library.
  assert.equal('ortLibrary' in desktopJsRuntimeManifest('darwin', 'x64'), false);
  assert.equal('ortLibrary' in remoteJsRuntimeManifest('darwin', 'x64'), false);
  assert.equal(remoteJsRuntimeManifest('linux', 'arm64').ortLibrary, 'js/pkg/node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/libonnxruntime.so.1');
  assert.throws(() => desktopJsRuntimeManifest('freebsd', 'x64'), /no app executable/);
});

test('a complete install of each layout and platform passes', () => {
  for (const [kind, platform, arch] of [
    ['desktop', 'win32', 'x64'],
    ['desktop', 'linux', 'x64'],
    ['desktop', 'darwin', 'arm64'],
    ['desktop', 'darwin', 'x64'],
    ['remote', 'linux', 'arm64'],
    ['remote', 'darwin', 'x64'],
  ]) {
    assert.doesNotThrow(() => verify(kind, install(kind, platform, arch), platform, arch), `${kind} ${platform}-${arch}`);
  }
});

test('an incomplete install names what is missing', () => {
  const broken = (kind, platform, arch, damage, pattern, extra) => {
    const tree = install(kind, platform, arch);
    damage(tree);
    assert.throws(() => verify(kind, tree, platform, arch, extra), pattern);
  };
  // What the core reads with plain fs.
  broken('desktop', 'linux', 'x64', ({ modules }) => rmSync(join(modules, 'mixdog/src/rules'), { recursive: true }), /missing or empty src\/rules/);
  broken('desktop', 'linux', 'x64', ({ modules }) => rmSync(join(modules, 'mixdog/package.json')), /missing file package\.json/);
  // The interpreter of the desktop is its app; a staged resources dir has none yet.
  broken('desktop', 'linux', 'x64', ({ root }) => rmSync(join(root, '..', 'mixdog-desktop')), /interpreter .* does not exist/);
  assert.doesNotThrow(() => verify('desktop', install('desktop', 'linux', 'x64'), 'linux', 'x64', { checkProgram: false }));
  // The extension host's dependency closure, transitively.
  broken('remote', 'linux', 'x64', ({ modules }) => rmSync(join(modules, 'beta'), { recursive: true }), /beta \(dependency of alpha\) is not installed/);
  broken('remote', 'linux', 'x64', ({ modules }) => rmSync(join(modules, 'alpha'), { recursive: true }), /alpha \(reached from the remote entry points\) is not installed/);
  // The ONNX Runtime library, its siblings, and nothing of another platform.
  broken('desktop', 'win32', 'x64', ({ modules }) => rmSync(join(modules, 'onnxruntime-node', ortBinaryDir('win32', 'x64'), 'DirectML.dll')), /DirectML\.dll is missing beside/);
  broken('desktop', 'win32', 'x64', ({ modules }) => rmSync(join(modules, 'onnxruntime-node', ortBinaryDir('win32', 'x64'), 'vcruntime140.dll')), /vcruntime140\.dll is missing beside/);
  broken('remote', 'linux', 'x64', ({ modules }) => rmSync(join(modules, 'onnxruntime-node', ortBinaryDir('linux', 'x64'), 'libonnxruntime.so.1')), /ONNX Runtime library .* does not exist/);
  broken('remote', 'linux', 'x64', ({ modules }) => put(join(modules, 'onnxruntime-node', ortBinaryDir('darwin', 'arm64'), 'libonnxruntime.1.dylib')), /foreign ONNX Runtime binaries/);
  broken('remote', 'linux', 'x64', ({ modules }) => put(join(modules, 'onnxruntime-node', ortBinaryDir('linux', 'arm64'), 'libonnxruntime.so.1')), /foreign ONNX Runtime binaries/);
  broken('desktop', 'darwin', 'x64', ({ modules }) => put(join(modules, 'onnxruntime-node/bin/napi-v6/darwin/x64/x')), /no ONNX Runtime binding/);
  // A manifest that is not the layout's (the package root back inside the archive) is refused.
  const tree = install('desktop', 'linux', 'x64');
  writeFileSync(join(tree.dir, 'js-runtime.json'), JSON.stringify({ ...desktopJsRuntimeManifest('linux', 'x64'), packageRoot: '../runtime.asar/node_modules/mixdog' }));
  assert.throws(() => verify('desktop', tree, 'linux', 'x64'), /js-runtime\.json is .*runtime\.asar\/node_modules\/mixdog/);
});

test('an optional package absent from the tree is a miss unless the staging recorded it as skipped', () => {
  const tree = install('remote', 'linux', 'x64');
  put(join(tree.modules, 'alpha/package.json'), JSON.stringify({ name: 'alpha', optionalDependencies: { 'alpha-linux-x64': '1', 'alpha-win32-x64': '1' } }));
  assert.throws(() => verify('remote', tree, 'linux', 'x64'), /alpha-linux-x64 \(optional dependency of alpha\) is not installed/);
  put(join(tree.modules, 'alpha-linux-x64/package.json'), '{}');
  assert.throws(() => verifyCoreTree({ modulesDir: tree.modules, platform: 'linux', arch: 'x64' }), /alpha-win32-x64/);
  put(join(tree.modules, CLOSURE_RECORD), JSON.stringify({ skippedOptional: ['alpha-win32-x64'] }));
  assert.doesNotThrow(() => verifyCoreTree({ modulesDir: tree.modules, platform: 'linux', arch: 'x64' }));
  rmSync(join(tree.modules, CLOSURE_RECORD));
  assert.throws(() => verifyCoreTree({ modulesDir: tree.modules, platform: 'linux', arch: 'x64' }), /was not recorded by the staging/);
});

test('mirroring copies the package, the closure and the ONNX directory, and records what the install skipped', async () => {
  const source = join(makeTempDirSync('core-mirror'), 'node_modules');
  modulesTree(source, 'linux', 'x64');
  rmSync(join(source, CLOSURE_RECORD));
  rmSync(join(source, 'onnxruntime-node'), { recursive: true });
  put(join(source, 'alpha/package.json'), JSON.stringify({ name: 'alpha', dependencies: { beta: '1' }, optionalDependencies: { 'alpha-musl': '1' } }));
  put(join(source, 'beta/node_modules/gamma/package.json'), '{"name":"gamma"}');
  put(join(source, 'beta/package.json'), JSON.stringify({ name: 'beta', dependencies: { gamma: '1', 'onnxruntime-node': '1' } }));
  // Something in the closure depends on onnxruntime-node, whose tarball carries every platform's binaries.
  put(join(source, 'onnxruntime-node/package.json'), '{"name":"onnxruntime-node"}');
  put(join(source, 'onnxruntime-node', ortBinaryDir('darwin', 'arm64'), 'libonnxruntime.1.dylib'));
  put(join(source, 'onnxruntime-node', ortBinaryDir('linux', 'x64'), 'libonnxruntime.so.1'));
  put(join(source, 'unrelated/package.json'), '{"name":"unrelated"}');
  const ortSource = join(makeTempDirSync('core-mirror-ort'), 'x64');
  put(join(ortSource, 'libonnxruntime.so.1'), 'from-source');
  put(join(ortSource, 'onnxruntime_binding.node'));
  const destination = join(makeTempDirSync('core-mirror-out'), 'node_modules');
  await mirrorCoreRuntime({ modulesDir: source, destination, platform: 'linux', arch: 'x64', ortBinarySource: ortSource });
  for (const copied of ['mixdog/package.json', 'alpha/package.json', 'beta/node_modules/gamma/package.json', 'onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1']) {
    assert.ok(existsSync(join(destination, copied)), copied);
  }
  assert.equal(existsSync(join(destination, 'unrelated')), false, 'what the entry points do not reach stays out');
  assert.ok(existsSync(join(destination, 'onnxruntime-node/package.json')));
  assert.equal(existsSync(join(destination, 'onnxruntime-node/bin/napi-v6/darwin')), false, 'only the target directory is mirrored');
  assert.equal(readFileSync(join(destination, 'onnxruntime-node', ortBinaryDir('linux', 'x64'), 'libonnxruntime.so.1'), 'utf8'), 'from-source', 'from ortBinarySource');
  assert.deepEqual(JSON.parse(readFileSync(join(destination, CLOSURE_RECORD), 'utf8')), { skippedOptional: ['alpha-musl'] });
  // A required package missing from the installed tree stops the mirror.
  rmSync(join(source, 'beta/node_modules'), { recursive: true });
  await assert.rejects(mirrorCoreRuntime({ modulesDir: source, destination: join(makeTempDirSync('core-mirror-again'), 'node_modules'), platform: 'linux', arch: 'x64', ortBinarySource: ortSource }), /gamma \(dependency of beta\) is not installed/);
  // darwin-x64 has no ONNX Runtime: nothing to copy.
  await mirrorCoreRuntime({ modulesDir: join(makeTreeWithoutOrt()), destination: join(makeTempDirSync('core-mirror-mac-out'), 'node_modules'), platform: 'darwin', arch: 'x64', ortBinarySource: null });
});

function makeTreeWithoutOrt() {
  const modules = join(makeTempDirSync('core-mirror-mac'), 'node_modules');
  modulesTree(modules, 'darwin', 'x64');
  rmSync(join(modules, CLOSURE_RECORD));
  return modules;
}

test('the remote trim keeps only the target platform binary directory', () => {
  const modules = makeTempDirSync('core-layout-trim');
  const pkg = join(modules, 'onnxruntime-node');
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['darwin', 'arm64']]) put(join(pkg, ortBinaryDir(platform, arch), LIBRARY[platform]));
  put(join(pkg, ortBinaryDir('linux', 'x64'), 'onnxruntime_binding.node'));
  trimOrtBinaries(pkg, 'linux', 'x64');
  assert.ok(existsSync(join(pkg, ortBinaryDir('linux', 'x64'), 'libonnxruntime.so.1')));
  assert.ok(existsSync(join(pkg, ortBinaryDir('linux', 'x64'), 'onnxruntime_binding.node')));
  assert.equal(existsSync(join(pkg, ortBinaryDir('linux', 'arm64'))), false);
  assert.equal(existsSync(join(pkg, 'bin/napi-v6/win32')), false);
  assert.equal(existsSync(join(pkg, 'bin/napi-v6/darwin')), false);
  assert.throws(() => trimOrtBinaries(pkg, 'darwin', 'x64'), /holds no darwin-x64 library/);
});
