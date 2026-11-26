import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { bundledMermaidSource } from './export-offscreen.ts';
import { bundledEchartsSource } from './inline-page.ts';
import { readVisualizeVendorAsset } from './vendor-asset.ts';

test('mermaid and echarts are shipped as asset files read on demand, not virtual JS string modules', async () => {
  const config = await readFile(join(import.meta.dirname, '../../../electron.vite.config.ts'), 'utf8');
  const inlinePage = await readFile(join(import.meta.dirname, 'inline-page.ts'), 'utf8');
  const exportOffscreen = await readFile(join(import.meta.dirname, 'export-offscreen.ts'), 'utf8');

  assert.equal(config.includes('virtual:mixdog-echarts-source'), false);
  assert.equal(config.includes('virtual:mixdog-mermaid-source'), false);
  assert.equal(inlinePage.includes('virtual:mixdog-echarts-source'), false);
  assert.equal(exportOffscreen.includes('virtual:mixdog-mermaid-source'), false);
  assert.match(config, /assets\/echarts\.min\.js/);
  assert.match(config, /assets\/mermaid\.min\.js/);

  // Real bundles load from disk on demand.
  const [echarts, mermaid] = await Promise.all([bundledEchartsSource(), bundledMermaidSource()]);
  assert.ok(echarts.length > 100_000, 'echarts asset read from disk');
  assert.ok(mermaid.length > 100_000, 'mermaid asset read from disk');
});

test('readVisualizeVendorAsset reads from bundled assets directory without caching in V8', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-vendor-asset-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'assets'), { recursive: true });
  const assetFile = join(dir, 'assets', 'sample.min.js');

  await writeFile(assetFile, 'window.V = 1;', 'utf8');
  assert.equal(await readVisualizeVendorAsset('sample.min.js', 'nonexistent', dir), 'window.V = 1;');

  // Rewriting the file yields the new content, proving no V8 module/string cache holds it.
  await writeFile(assetFile, 'window.V = 2;', 'utf8');
  assert.equal(await readVisualizeVendorAsset('sample.min.js', 'nonexistent', dir), 'window.V = 2;');
});
