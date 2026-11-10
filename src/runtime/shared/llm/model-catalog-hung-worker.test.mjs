// A catalog worker that never answers must not hold up importers: the import
// settles at once, the disk warm gives up at its deadline and settles cold,
// and the wedged worker does not keep the process alive.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';

const directory = makeTempDirSync('model-catalog-hung-worker');
process.env.MIXDOG_DATA_DIR = directory;
writeFileSync(join(directory, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: 1, data: {} }));

const real = await import('../worker-requests.mjs');
const hangingWorker = new URL(`data:text/javascript,${encodeURIComponent('setInterval(() => {}, 1000);')}`);
mock.module('../worker-requests.mjs', {
  namedExports: {
    ...real,
    createWorkerRequestClient: (_url, options) => {
      const request = real.createWorkerRequestClient(hangingWorker, options);
      return Object.assign((payload, requestOptions) => request(payload, { ...requestOptions, timeoutMs: 300 }), {
        hold: request.hold,
        running: request.running,
      });
    },
  },
});

test('import does not wait for the worker; a silent worker leaves the catalog cold', async () => {
  const imported = await Promise.race([
    import('./model-catalog.mjs'),
    new Promise((resolve) => setTimeout(() => resolve('stuck'), 150)),
  ]);
  assert.notEqual(imported, 'stuck', 'importing the module must not wait on the worker (its deadline is 300 ms)');
  const warmed = await Promise.race([
    imported.warmCatalogFromDisk().then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('stuck'), 5000)),
  ]);
  assert.equal(warmed, 'settled');
  assert.equal(imported.getModelMetadataSync('gemini-x', 'gemini')?.inputCostPerM ?? null, null);
});
