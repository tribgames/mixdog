import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { modelCatalogWorkerDefine } from '../../../scripts/model-catalog-worker-source.mjs';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootDir = join(desktopDir, '..', '..');

// The release gate's own "Build desktop" step is skipped on a cached bundle
// key that does not cover every runtime module the service reaches, so this
// lane builds it on every change: a module that pulls a native binding (.node)
// into the plain-Node service bundle fails the build, and with it this test.
test('the desktop service bundle builds and loads under plain Node', (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'mixdog-build-daemon-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [join(desktopDir, 'scripts', 'build-daemon.mjs'), `--outfile=${join(outDir, 'main', 'daemon.cjs')}`],
    { cwd: desktopDir, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Built plain-Node desktop service/);
});

// A CJS bundle has no import.meta.url, so the catalog's worker file cannot be
// found beside it: the bundle carries the worker's source instead. The catalog
// swallows a worker that fails to start (it stays cold), so the warm must be
// seen to fill the table, not merely to settle.
test('a CJS bundle of the model catalog loads and warms it through its embedded worker', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'mixdog-catalog-bundle-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const bundle = join(outDir, 'catalog.cjs');
  await build({
    entryPoints: [join(rootDir, 'apps', 'desktop', 'src', 'shared', 'core-src', 'runtime', 'shared', 'llm', 'model-catalog.mjs')],
    outfile: bundle,
    define: await modelCatalogWorkerDefine(),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
  });
  writeFileSync(
    join(outDir, 'litellm-catalog.json'),
    JSON.stringify({
      fetchedAt: 1,
      data: { 'gemini/gemini-bundle-test': { litellm_provider: 'gemini', input_cost_per_token: 1e-6 } },
    })
  );
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const catalog = require(${JSON.stringify(bundle)});
       catalog.warmCatalogFromDisk().then(() =>
         console.log(JSON.stringify(catalog.getModelMetadataSync('gemini-bundle-test', 'gemini')?.inputCostPerM)));`,
    ],
    { encoding: 'utf8', env: { ...process.env, MIXDOG_DATA_DIR: outDir }, timeout: 30_000 }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1');
});
