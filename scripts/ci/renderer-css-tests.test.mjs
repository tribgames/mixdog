import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { rendererCssTests } from './renderer-css-tests.mjs';

test('the approval prompt stylesheet selects the layout test that reads it', async () => {
  const desktop = fileURLToPath(new URL('../../apps/desktop/', import.meta.url));
  const selected = await rendererCssTests(['src/renderer/desktop/15-approval-prompt.css'], desktop);
  assert.ok(selected.includes('src/renderer/approval-prompt-layout.slow.test.mjs'));
});

test('a removed stylesheet selects fast, slow and directory readers, not unrelated or live checks', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'renderer-css-tests-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const renderer = join(cwd, 'src', 'renderer');
  const scripts = join(cwd, 'scripts');
  await mkdir(renderer, { recursive: true });
  await mkdir(scripts);
  const paths = {
    'connector.test.mjs': 'new URL("./connectors.css", import.meta.url);',
    'layout.slow.test.mjs': 'new URL("./connectors.css", import.meta.url);',
    'layout.live.test.mjs': 'new URL("./connectors.css", import.meta.url);',
    'other.test.mjs': 'new URL("./other.css", import.meta.url);',
    'other.css': '',
  };
  for (const [name, text] of Object.entries(paths)) await writeFile(join(renderer, name), text);
  await writeFile(join(scripts, 'specificity.test.mjs'), '// @test-input ../src/renderer/');
  assert.deepEqual(await rendererCssTests(['src/renderer/connectors.css'], cwd), [
    'scripts/specificity.test.mjs',
    'src/renderer/connector.test.mjs',
    'src/renderer/layout.slow.test.mjs',
  ]);
});
