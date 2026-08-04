import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('live layout verification clears stale emulation without applying a viewport', async () => {
  const [packageJson, probe] = await Promise.all([
    readFile(new URL('../../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../scripts/cdp-layout-probe.mjs', import.meta.url), 'utf8'),
  ]);
  assert.equal(
    packageJson.scripts['verify:live-layout'],
    'node scripts/cdp-layout-probe.mjs --port=9342 --repair --exercise-panel',
  );
  assert.match(probe, /Emulation\.clearDeviceMetricsOverride/);
  assert.match(probe, /window\.resizeBy\(-1,\s*0\)[\s\S]*?window\.resizeBy\(1,\s*0\)/);
  assert.match(probe, /const waitForLayout = async/);
  assert.doesNotMatch(probe, /requestAnimationFrame/);
  assert.match(probe, /Runtime\.evaluate/);
  assert.doesNotMatch(
    probe,
    /(?:from\s+|import\()['"]puppeteer|setDeviceMetricsOverride|setViewport|defaultViewport/i,
    'live layout verification must never apply a synthetic viewport',
  );
});
