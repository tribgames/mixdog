// Build-time step shared by the bundles that contain model-catalog.mjs: the
// catalog's worker file does not exist beside a bundle, so the bundle embeds
// the worker's own bundled source (see model-catalog.mjs).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const WORKER_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'runtime',
  'shared',
  'llm',
  'model-catalog-worker.mjs'
);

/** esbuild `define` entry carrying the model catalog worker's source. */
export async function modelCatalogWorkerDefine() {
  const [worker] = (
    await build({
      entryPoints: [WORKER_ENTRY],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      write: false,
    })
  ).outputFiles;
  return { __MODEL_CATALOG_WORKER_SOURCE__: JSON.stringify(worker.text) };
}
