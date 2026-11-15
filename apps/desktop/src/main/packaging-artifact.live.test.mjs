// Built-artifact checks: these read electron-vite output (out/), the staged
// platform runtime (.runtime/) and the packaged installer payload (dist/), so
// they run after a build — `verify:packaging-artifact` in desktop-package.yml —
// never in the default discovery lane. Source-shape packaging invariants stay
// in packaging.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CORE_READS, onnxRuntimeSupported, ortBinaryDir, UNPACKED_NODE_MODULES } from '../../scripts/core-layout.mjs';
import { verifyStagedResources } from '../../scripts/verify-staged-package.mjs';

/** The `resources` directories under `directory` (win-unpacked/resources, linux-unpacked/resources,
 *  Mixdog.app/Contents/Resources): the directories holding the core and the unpacked runtime. */
async function findPackagedResources(directory, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const names = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  if (names.has('core') && names.has('runtime.asar.unpacked')) return [directory];
  const found = [];
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(...(await findPackagedResources(join(directory, entry.name), depth + 1)));
  }
  return found;
}

const distDir = () => fileURLToPath(new URL('../../dist', import.meta.url));

/** Every file under `directory`, as paths relative to it. */
async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'));
  }
  return files;
}

async function streamingFileIdentity(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const handle = await open(path, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest('hex') };
}

const MACHO_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_SEGMENT_64 = 0x19;

// Developer ID signing rewrites every Mach-O binary's __LINKEDIT segment (it
// holds the code signature) and the load commands that size it, so a signed
// macOS package can never match the staged file byte for byte. The code and
// data segments must still be identical, which is what "emitted unchanged"
// guards. Returns null for non-Mach-O files so callers fall back to bytes.
function machoSliceSegments(data, base, digest) {
  if (data.readUInt32LE(base) !== MACHO_64) return false;
  const commandCount = data.readUInt32LE(base + 16);
  let offset = base + 32;
  for (let index = 0; index < commandCount; index += 1) {
    const command = data.readUInt32LE(offset);
    const size = data.readUInt32LE(offset + 4);
    if (command === LC_SEGMENT_64) {
      const name = data.toString('latin1', offset + 8, offset + 24).replace(/\0+$/, '');
      const fileOffset = Number(data.readBigUInt64LE(offset + 40));
      const fileSize = Number(data.readBigUInt64LE(offset + 48));
      if (name !== '__LINKEDIT' && fileSize > 0) {
        // __TEXT starts with the header and load commands, then free padding.
        // Signing an unsigned (x86_64) binary adds LC_CODE_SIGNATURE into that
        // padding, so compare __TEXT only from its first section's file data.
        let textStart = fileOffset;
        if (name === '__TEXT') {
          const sectionCount = data.readUInt32LE(offset + 64);
          const sectionOffsets = [];
          for (let section = 0; section < sectionCount; section += 1) {
            const sectionOffset = data.readUInt32LE(offset + 72 + section * 80 + 48);
            if (sectionOffset > 0) sectionOffsets.push(sectionOffset);
          }
          textStart = sectionOffsets.length ? Math.min(...sectionOffsets) : fileOffset + fileSize;
        }
        const start = base + textStart;
        digest.update(name);
        digest.update(data.subarray(start, base + fileOffset + fileSize));
      }
    }
    offset += size;
  }
  return true;
}

async function machoContentIdentity(path) {
  const data = await readFile(path);
  if (data.length < 32) return null;
  const digest = createHash('sha256');
  if (data.readUInt32BE(0) === FAT_MAGIC) {
    const architectures = data.readUInt32BE(4);
    for (let index = 0; index < architectures; index += 1) {
      const sliceOffset = data.readUInt32BE(8 + index * 20 + 8);
      if (!machoSliceSegments(data, sliceOffset, digest)) return null;
    }
  } else if (!machoSliceSegments(data, 0, digest)) {
    return null;
  }
  return { segments: digest.digest('hex') };
}

async function emittedFileIdentity(path) {
  if (process.platform === 'darwin') {
    const macho = await machoContentIdentity(path);
    if (macho) return macho;
  }
  return streamingFileIdentity(path);
}

test('electron-vite emitted the preload entry the main process loads', async () => {
  await access(new URL('../../out/preload/index.js', import.meta.url));
});

test('the build staged the core the app starts, with its js-runtime manifest beside it', async () => {
  const core = fileURLToPath(new URL('../../.runtime/core/', import.meta.url));
  await access(join(core, process.platform === 'win32' ? 'mixdogd.exe' : 'mixdogd'));
  await access(join(core, 'js-runtime.json'));
});

test('the built runtime is the staged real-file tree: no archive, the closure, the ONNX library of this target, nothing foreign', async () => {
  const stagedModules = fileURLToPath(new URL('../../.runtime/native-modules/', import.meta.url));
  await access(stagedModules);
  // Targets without an onnxruntime-node binding (darwin-x64) ship none at all.
  const onnx = onnxRuntimeSupported(process.platform, process.arch);
  const [resources] = await findPackagedResources(distDir());
  assert.ok(resources, `dist is missing a packaged ${process.platform}-${process.arch} resources directory with core/ and runtime.asar.unpacked/`);
  assert.equal(await stat(join(resources, 'runtime.asar')).then(() => true, () => false), false, 'the package ships a runtime.asar nothing opens');
  const builtModules = join(resources, UNPACKED_NODE_MODULES);
  const files = await filesUnder(builtModules);
  for (const required of ['mixdog/package.json', ...CORE_READS.files.map((file) => `mixdog/${file}`)]) {
    assert.ok(files.includes(required), `the built runtime is missing ${required}`);
  }
  assert.equal(
    files.some((entry) => /\.mixdog-edit\.[^/]+$/i.test(entry)),
    false,
    'the built runtime contains an Office authoring copy'
  );
  const binaries = files.filter((entry) => entry.startsWith('onnxruntime-node/bin/napi-v6/'));
  const ownBinaryDir = `onnxruntime-node/${ortBinaryDir(process.platform, process.arch)}/`;
  if (onnx) assert.ok(files.includes(`${ownBinaryDir}onnxruntime_binding.node`), `the built runtime is missing the ${process.platform}-${process.arch} ONNX binding`);
  assert.deepEqual(
    binaries.filter((entry) => !onnx || !entry.startsWith(ownBinaryDir)),
    [],
    'the built runtime contains foreign ONNX platform binaries'
  );
  assert.equal(
    files.some((entry) => /\/onnxruntime-web\/(?:dist|lib)\//.test(entry)),
    false,
    'the built runtime contains unused ONNX web payloads'
  );
  const nativeBinaries = files.filter((entry) => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/i.test(entry));
  assert.ok(nativeBinaries.some((entry) => entry.endsWith('.node')), 'the built runtime contains no native addon');
  // Every staged file reached the package unchanged (a signed macOS binary: same code and data segments).
  const staged = await filesUnder(stagedModules);
  const builtSet = new Set(files);
  for (const entry of staged.filter((file) => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/i.test(file) || file.startsWith('mixdog/src/defaults/skills/'))) {
    assert.ok(builtSet.has(entry), `${entry} is not in the built runtime`);
    assert.deepEqual(
      await emittedFileIdentity(join(builtModules, ...entry.split('/'))),
      await emittedFileIdentity(join(stagedModules, ...entry.split('/'))),
      `${entry} was not emitted unchanged`
    );
  }
});

test('the packaged resources hold the Rust core, its unpacked resource root, the ONNX library and the extension host closure', async () => {
  const resources = (await findPackagedResources(distDir()))[0];
  assert.ok(resources, 'dist holds no packaged resources with a core/ directory');
  assert.deepEqual(verifyStagedResources({ resources, platform: process.platform, arch: process.arch }).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
  ]);
});
