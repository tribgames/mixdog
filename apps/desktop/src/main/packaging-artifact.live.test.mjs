// Built-artifact checks: these read electron-vite output (out/), the staged
// platform runtime (.runtime/) and the packaged installer payload (dist/), so
// they run after a build — `verify:packaging-artifact` in desktop-package.yml —
// never in the default discovery lane. Source-shape packaging invariants stay
// in packaging.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, open, readdir, readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listPackage, statFile } from '@electron/asar';
import { onnxRuntimeSupported } from '../../../../src/runtime/shared/onnx-runtime-support.mjs';

async function findRuntimeArchives(directory, depth = 0) {
  if (depth > 8) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const archives = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === 'runtime.asar') {
      archives.push(path);
    } else if (entry.isDirectory()) {
      archives.push(...(await findRuntimeArchives(path, depth + 1)));
    }
  }
  return archives;
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

test('plain Node can import the standalone daemon service artifact', async () => {
  const serviceUrl = new URL('../../out/main/daemon.cjs', import.meta.url);
  const source = await readFile(serviceUrl, 'utf8');
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()\s*["']electron["']/);
  const service = await import(`${serviceUrl.href}?packaging-test=${Date.now()}`);
  assert.equal(typeof service.createDesktopService, 'function');
});

test('built runtime archive metadata and emitted native sidecar agree', async () => {
  const runtimeArchive = fileURLToPath(new URL('../../.runtime/runtime.asar', import.meta.url));
  const stagedSidecar = fileURLToPath(new URL('../../.runtime/runtime.asar.unpacked', import.meta.url));
  await access(runtimeArchive);

  // Targets without an onnxruntime-node binding (darwin-x64) ship none at all.
  const onnx = onnxRuntimeSupported();
  const targetBinding = `/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`;
  const candidates = await findRuntimeArchives(fileURLToPath(new URL('../../dist', import.meta.url)));
  const built = candidates
    .map((archive) => ({
      archive,
      entries: listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll('\\', '/')),
    }))
    .find(({ entries }) =>
      onnx ? entries.some((entry) => entry.endsWith(targetBinding)) : entries.includes('/node_modules/mixdog/package.json')
    );
  assert.ok(built, `dist is missing a packaged ${process.platform}-${process.arch} runtime.asar`);
  const builtArchive = built.archive;
  const builtResources = dirname(builtArchive);
  const entries = built.entries;
  for (const required of [
    '/package.json',
    '/node_modules/mixdog/package.json',
    '/node_modules/mixdog/src/tui/session.mjs',
    '/node_modules/mixdog/src/runtime/office/core/journal.mjs',
    '/node_modules/mixdog/src/runtime/office/quality/visual-diff.mjs',
    '/node_modules/mixdog/src/runtime/office/com/office-com-host.ps1',
    '/node_modules/mixdog/src/runtime/office/com/office-com-session-host.ps1',
    '/node_modules/mixdog/src/runtime/office/com/office-com-cleanup.ps1',
    '/node_modules/mixdog/src/runtime/office/com/office-word-formatting.ps1',
    '/node_modules/mixdog/src/runtime/office/design/library/templates/mixdog-executive.pptx',
    '/node_modules/mixdog/src/runtime/office/design/library/templates/mixdog-executive.pptx.mixdog.json',
    '/node_modules/@huggingface/transformers/package.json',
    '/node_modules/@huggingface/transformers/dist/transformers.node.cjs',
    '/node_modules/@huggingface/transformers/dist/transformers.node.mjs',
  ]) {
    assert.ok(entries.includes(required), `runtime archive is missing ${required}`);
  }
  assert.equal(
    entries.some((entry) => /\.mixdog-edit\.[^/]+$/i.test(entry)),
    false,
    'runtime archive contains an Office authoring copy'
  );
  const ortPackage = entries.find((entry) => /\/onnxruntime-node\/package\.json$/.test(entry));
  assert.ok(ortPackage, 'runtime archive is missing onnxruntime-node');
  const ortRoot = ortPackage.slice(0, -'/package.json'.length);
  const embeddingNapiRoot = `${ortRoot}/bin/napi-v6`;
  const embeddingPlatformRoot = `${embeddingNapiRoot}/${process.platform}`;
  const embeddingBinaryRoot = `${embeddingPlatformRoot}/${process.arch}`;
  if (onnx) {
    assert.ok(
      entries.includes(`${embeddingBinaryRoot}/onnxruntime_binding.node`),
      `runtime archive is missing ${process.platform}-${process.arch} ONNX binding`
    );
  }
  assert.equal(
    entries.some(
      (entry) =>
        entry.startsWith(`${embeddingNapiRoot}/`) &&
        (!onnx ||
          (entry !== embeddingPlatformRoot &&
            entry !== embeddingBinaryRoot &&
            !entry.startsWith(`${embeddingBinaryRoot}/`)))
    ),
    false,
    'runtime archive contains foreign ONNX platform binaries'
  );
  assert.equal(
    entries.some((entry) => /\/onnxruntime-web\/(?:dist|lib)\//.test(entry)),
    false,
    'runtime archive contains unused ONNX web payloads'
  );

  const nativeBinaryEntries = entries.filter((entry) => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/i.test(entry));
  const unpackedRuntimeEntries = [
    ...new Set([
      ...nativeBinaryEntries,
      '/node_modules/mixdog/src/runtime/office/com/office-com-host.ps1',
      '/node_modules/mixdog/src/runtime/office/com/office-com-session-host.ps1',
      '/node_modules/mixdog/src/runtime/office/com/office-com-cleanup.ps1',
      '/node_modules/mixdog/src/runtime/office/com/office-word-formatting.ps1',
      '/node_modules/mixdog/src/runtime/office/design/library/templates/mixdog-executive.pptx',
      '/node_modules/mixdog/src/runtime/office/design/library/templates/mixdog-executive.pptx.mixdog.json',
    ]),
  ];
  assert.ok(
    nativeBinaryEntries.some((entry) => entry.endsWith('.node')),
    'runtime archive contains no native addon'
  );
  for (const entry of unpackedRuntimeEntries) {
    const archivePath = entry.replace(/^\/+/, '');
    assert.equal(statFile(builtArchive, archivePath.replaceAll('/', sep)).unpacked, true, `${entry} is not unpacked`);
    const parts = archivePath.split('/');
    const stagedNative = join(stagedSidecar, ...parts);
    const builtNative = join(builtResources, 'runtime.asar.unpacked', ...parts);
    assert.deepEqual(
      await emittedFileIdentity(builtNative),
      await emittedFileIdentity(stagedNative),
      `${entry} was not emitted unchanged beside the built runtime.asar`
    );
  }
});
