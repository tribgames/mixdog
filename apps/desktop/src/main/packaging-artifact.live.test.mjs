// Built-artifact checks: these read electron-vite output (out/), the staged
// platform runtime (.runtime/) and the packaged installer payload (dist/), so
// they run after a build — `verify:packaging-artifact` in desktop-package.yml —
// never in the default discovery lane. Source-shape packaging invariants stay
// in packaging.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, open, readdir } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listPackage, statFile } from '@electron/asar';

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
      archives.push(...await findRuntimeArchives(path, depth + 1));
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

test('electron-vite emitted the preload entry the main process loads', async () => {
  await access(new URL('../../out/preload/index.js', import.meta.url));
});

test('built runtime archive metadata and emitted native sidecar agree', async () => {
  const runtimeArchive = fileURLToPath(new URL('../../.runtime/runtime.asar', import.meta.url));
  const stagedSidecar = fileURLToPath(new URL('../../.runtime/runtime.asar.unpacked', import.meta.url));
  await access(runtimeArchive);

  const targetBinding = `/bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`;
  const candidates = await findRuntimeArchives(
    fileURLToPath(new URL('../../dist', import.meta.url)),
  );
  const built = candidates
    .map((archive) => ({
      archive,
      entries: listPackage(archive, { isPack: false })
        .map((entry) => entry.replaceAll('\\', '/')),
    }))
    .find(({ entries }) => entries.some((entry) => entry.endsWith(targetBinding)));
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
    'runtime archive contains an Office authoring copy',
  );
  const ortPackage = entries.find((entry) => /\/onnxruntime-node\/package\.json$/.test(entry));
  assert.ok(ortPackage, 'runtime archive is missing onnxruntime-node');
  const ortRoot = ortPackage.slice(0, -'/package.json'.length);
  const embeddingNapiRoot = `${ortRoot}/bin/napi-v6`;
  const embeddingPlatformRoot = `${embeddingNapiRoot}/${process.platform}`;
  const embeddingBinaryRoot = `${embeddingPlatformRoot}/${process.arch}`;
  assert.ok(
    entries.includes(`${embeddingBinaryRoot}/onnxruntime_binding.node`),
    `runtime archive is missing ${process.platform}-${process.arch} ONNX binding`,
  );
  assert.equal(
    entries.some((entry) => entry.startsWith(`${embeddingNapiRoot}/`)
      && entry !== embeddingPlatformRoot
      && entry !== embeddingBinaryRoot
      && !entry.startsWith(`${embeddingBinaryRoot}/`)),
    false,
    'runtime archive contains foreign ONNX platform binaries',
  );
  assert.equal(
    entries.some((entry) => /\/onnxruntime-web\/(?:dist|lib)\//.test(entry)),
    false,
    'runtime archive contains unused ONNX web payloads',
  );

  const nativeBinaryEntries = entries.filter(
    (entry) => /\.(?:node|dll|dylib|so(?:\.\d+)*)$/i.test(entry),
  );
  const unpackedRuntimeEntries = [...new Set([
    ...nativeBinaryEntries,
    '/node_modules/mixdog/src/runtime/office/com/office-com-host.ps1',
    '/node_modules/mixdog/src/runtime/office/com/office-com-session-host.ps1',
    '/node_modules/mixdog/src/runtime/office/design/library/templates/mixdog-executive.pptx',
    '/node_modules/mixdog/src/runtime/office/design/library/templates/mixdog-executive.pptx.mixdog.json',
  ])];
  assert.ok(nativeBinaryEntries.some((entry) => entry.endsWith('.node')), 'runtime archive contains no native addon');
  for (const entry of unpackedRuntimeEntries) {
    const archivePath = entry.replace(/^\/+/, '');
    assert.equal(
      statFile(builtArchive, archivePath.replaceAll('/', sep)).unpacked,
      true,
      `${entry} is not unpacked`,
    );
    const parts = archivePath.split('/');
    const stagedNative = join(stagedSidecar, ...parts);
    const builtNative = join(builtResources, 'runtime.asar.unpacked', ...parts);
    assert.deepEqual(
      await streamingFileIdentity(builtNative),
      await streamingFileIdentity(stagedNative),
      `${entry} was not emitted unchanged beside the built runtime.asar`,
    );
  }
});
