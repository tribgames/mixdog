// A foreground `await warmCatalogFromDisk()` must keep the process alive until
// the worker answers. Run in an isolated process with nothing else pending and
// no test keepalive: an unref'd worker read let it exit with the await unsettled.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const catalogUrl = new URL('./model-catalog.mjs', import.meta.url).href;

test('a foreground catalog warm in a bare process settles before the process exits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-bare-warm-'));
  try {
    writeFileSync(join(dir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: 1, data: {} }));
    const script = `const c = await import(${JSON.stringify(catalogUrl)}); await c.warmCatalogFromDisk(); console.log('WARM-DONE');`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, MIXDOG_DATA_DIR: dir },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.match(result.stdout, /WARM-DONE/, `exit ${result.status}: ${result.stderr}`);
    assert.equal(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
