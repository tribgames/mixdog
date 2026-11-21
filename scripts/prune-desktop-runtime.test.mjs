import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneDesktopRuntime } from './prune-desktop-runtime.mjs';

async function put(path, contents = 'fixture') {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

async function missing(path) {
  await assert.rejects(access(path));
}

test('desktop runtime prune removes production sources and native Sharp WASM fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-runtime-prune-'));
  try {
    await put(join(root, 'node_modules', 'pkg', 'index.js'));
    await put(join(root, 'node_modules', 'pkg', 'index.js.map'));
    await put(join(root, 'node_modules', 'pkg', 'src', 'index.ts'));
    await put(join(root, 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp.node'));
    await put(join(root, 'node_modules', '@img', 'sharp-wasm32', 'lib', 'sharp.wasm'));

    const result = await pruneDesktopRuntime(root, { platform: 'win32', arch: 'x64' });

    await access(join(root, 'node_modules', 'pkg', 'index.js'));
    await missing(join(root, 'node_modules', 'pkg', 'index.js.map'));
    await missing(join(root, 'node_modules', 'pkg', 'src', 'index.ts'));
    await missing(join(root, 'node_modules', '@img', 'sharp-wasm32'));
    assert.equal(result.removedSharpWasm, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop runtime prune keeps the Sharp WASM build on Linux, where Electron needs it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-desktop-runtime-prune-linux-'));
  try {
    await put(join(root, 'node_modules', '@img', 'sharp-linux-x64', 'lib', 'sharp.node'));
    await put(join(root, 'node_modules', '@img', 'sharp-wasm32', 'lib', 'sharp.wasm'));

    const result = await pruneDesktopRuntime(root, { platform: 'linux', arch: 'x64' });

    await access(join(root, 'node_modules', '@img', 'sharp-wasm32', 'lib', 'sharp.wasm'));
    assert.equal(result.removedSharpWasm, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function pruned(prefix, populate, check) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await populate(root);
    const result = await pruneDesktopRuntime(root, { platform: 'win32', arch: 'x64' });
    await check(root, result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('desktop runtime prune keeps the relaxed-SIMD LSTM tesseract core only', () =>
  pruned(
    'mixdog-desktop-runtime-tesseract-',
    async (root) => {
      const tesseractRoot = join(root, 'node_modules', 'tesseract.js-core');
      for (const name of [
        'tesseract-core-lstm.js',
        'tesseract-core-lstm.wasm',
        'tesseract-core-simd-lstm.js',
        'tesseract-core-simd-lstm.wasm',
        'tesseract-core-relaxedsimd-lstm.js',
        'tesseract-core-relaxedsimd-lstm.wasm',
      ]) {
        await put(join(tesseractRoot, name), Buffer.alloc(64));
      }
      await put(join(tesseractRoot, 'package.json'), '{"name":"tesseract.js-core"}');
      await put(join(tesseractRoot, 'LICENSE'));
      await put(join(tesseractRoot, 'tesseract-core.js'), Buffer.alloc(128));
      await put(join(tesseractRoot, 'tesseract-core.wasm'), Buffer.alloc(128));
      await put(join(tesseractRoot, 'tesseract-core-relaxedsimd-lstm.wasm.js'), Buffer.alloc(128));
    },
    async (root, result) => {
      const tesseractRoot = join(root, 'node_modules', 'tesseract.js-core');
      await access(join(tesseractRoot, 'tesseract-core-relaxedsimd-lstm.js'));
      await access(join(tesseractRoot, 'tesseract-core-relaxedsimd-lstm.wasm'));
      await missing(join(tesseractRoot, 'tesseract-core.js'));
      await missing(join(tesseractRoot, 'tesseract-core-relaxedsimd-lstm.wasm.js'));
      assert.ok(result.removedTesseractBytes > 0);
    }
  ));

test('desktop runtime prune keeps the legacy pdfjs build and its data only', () =>
  pruned(
    'mixdog-desktop-runtime-pdfjs-',
    async (root) => {
      const pdfJsRoot = join(root, 'node_modules', 'pdfjs-dist');
      await put(join(pdfJsRoot, 'package.json'), '{"name":"pdfjs-dist"}');
      await put(join(pdfJsRoot, 'LICENSE'));
      await put(join(pdfJsRoot, 'legacy', 'build', 'pdf.mjs'));
      await put(join(pdfJsRoot, 'legacy', 'build', 'pdf.worker.mjs'));
      await put(join(pdfJsRoot, 'legacy', 'build', 'pdf.min.mjs'), Buffer.alloc(128));
      await put(join(pdfJsRoot, 'legacy', 'web', 'pdf_viewer.mjs'), Buffer.alloc(128));
      await put(join(pdfJsRoot, 'build', 'pdf.mjs'), Buffer.alloc(128));
      await put(join(pdfJsRoot, 'web', 'pdf_viewer.mjs'), Buffer.alloc(128));
      await put(join(pdfJsRoot, 'image_decoders', 'pdf.image_decoders.mjs'), Buffer.alloc(128));
      await put(join(pdfJsRoot, 'cmaps', 'Identity-H.bcmap'));
      await put(join(pdfJsRoot, 'standard_fonts', 'FoxitSans.pfb'));
      await put(join(pdfJsRoot, 'wasm', 'openjpeg.wasm'));
      await put(join(pdfJsRoot, 'iccs', 'CGATS001Compat-v2-micro.icc'));
    },
    async (root, result) => {
      const pdfJsRoot = join(root, 'node_modules', 'pdfjs-dist');
      await access(join(pdfJsRoot, 'legacy', 'build', 'pdf.mjs'));
      await access(join(pdfJsRoot, 'legacy', 'build', 'pdf.worker.mjs'));
      await access(join(pdfJsRoot, 'cmaps', 'Identity-H.bcmap'));
      await access(join(pdfJsRoot, 'standard_fonts', 'FoxitSans.pfb'));
      await access(join(pdfJsRoot, 'wasm', 'openjpeg.wasm'));
      await missing(join(pdfJsRoot, 'build'));
      await missing(join(pdfJsRoot, 'legacy', 'web'));
      await missing(join(pdfJsRoot, 'legacy', 'build', 'pdf.min.mjs'));
      assert.ok(result.removedPdfBytes > 0);
    }
  ));

test('desktop runtime prune keeps the CommonJS builds of pdf-lib and fontkit only', () =>
  pruned(
    'mixdog-desktop-runtime-pdflib-',
    async (root) => {
      const pdfLibRoot = join(root, 'node_modules', 'pdf-lib');
      await put(join(pdfLibRoot, 'package.json'), '{"name":"pdf-lib","main":"cjs/index.js"}');
      await put(join(pdfLibRoot, 'LICENSE.md'));
      await put(join(pdfLibRoot, 'cjs', 'index.js'));
      await put(join(pdfLibRoot, 'es', 'index.js'), Buffer.alloc(128));
      await put(join(pdfLibRoot, 'dist', 'pdf-lib.js'), Buffer.alloc(128));
      const fontkitRoot = join(root, 'node_modules', '@pdf-lib', 'fontkit');
      await put(join(fontkitRoot, 'package.json'), '{"name":"@pdf-lib/fontkit","main":"dist/fontkit.umd.js"}');
      await put(join(fontkitRoot, 'dist', 'fontkit.umd.js'));
      await put(join(fontkitRoot, 'dist', 'fontkit.es.js'), Buffer.alloc(128));
    },
    async (root) => {
      const pdfLibRoot = join(root, 'node_modules', 'pdf-lib');
      const fontkitRoot = join(root, 'node_modules', '@pdf-lib', 'fontkit');
      await access(join(pdfLibRoot, 'cjs', 'index.js'));
      await missing(join(pdfLibRoot, 'es'));
      await missing(join(pdfLibRoot, 'dist'));
      await access(join(fontkitRoot, 'dist', 'fontkit.umd.js'));
      await missing(join(fontkitRoot, 'dist', 'fontkit.es.js'));
    }
  ));

test('desktop runtime prune keeps the ESM entry of unpdf only', () =>
  pruned(
    'mixdog-desktop-runtime-unpdf-',
    async (root) => {
      const unpdfRoot = join(root, 'node_modules', 'unpdf');
      await put(join(unpdfRoot, 'package.json'), '{"name":"unpdf","type":"module"}');
      await put(join(unpdfRoot, 'LICENSE'));
      await put(join(unpdfRoot, 'dist', 'index.mjs'));
      await put(join(unpdfRoot, 'dist', 'index.cjs'), Buffer.alloc(128));
      await put(join(unpdfRoot, 'dist', 'pdfjs.mjs'), Buffer.alloc(128));
    },
    async (root) => {
      const unpdfRoot = join(root, 'node_modules', 'unpdf');
      await access(join(unpdfRoot, 'dist', 'index.mjs'));
      await missing(join(unpdfRoot, 'dist', 'index.cjs'));
      await missing(join(unpdfRoot, 'dist', 'pdfjs.mjs'));
    }
  ));
