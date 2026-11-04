import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { importInStages, staticRelativeImports } from './staged-import.mjs';

// The daemon warm-up imports the session-runtime graph through this: each
// stage loads in its own loop turn, and evaluation order matches one import.
test('a staged import evaluates in single-import order, one loop turn per stage', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-staged-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = (name) => `globalThis.__stagedLog.push(['${name}', globalThis.__stagedTurns]);\n`;
  writeFileSync(join(dir, 'shared.mjs'), `${log('shared')}export const shared = 1;\n`);
  writeFileSync(join(dir, 'a.mjs'), `import { shared } from './shared.mjs';\n${log('a')}export const a = shared;\n`);
  writeFileSync(join(dir, 'b.mjs'), `import './shared.mjs';\n${log('b')}export const b = 2;\n`);
  writeFileSync(
    join(dir, 'core.mjs'),
    `import {\n  a,\n} from './a.mjs';\nimport { b } from './b.mjs';\n${log('core')}export const value = a + b;\n`
  );
  writeFileSync(join(dir, 'root.mjs'), `export { value } from './core.mjs';\n${log('root')}`);
  const url = (name) => pathToFileURL(join(dir, name)).href;
  assert.deepEqual(staticRelativeImports(url('core.mjs')), [url('a.mjs'), url('b.mjs')]);

  globalThis.__stagedLog = [];
  globalThis.__stagedTurns = 0;
  let counting = true;
  const count = () => {
    if (!counting) return;
    globalThis.__stagedTurns += 1;
    setImmediate(count);
  };
  setImmediate(count);
  const module = await importInStages(url('root.mjs'), url('core.mjs'));
  counting = false;
  assert.equal(module.value, 3);
  const order = globalThis.__stagedLog.map(([name]) => name);
  assert.deepEqual(order, ['shared', 'a', 'b', 'core', 'root']);
  const turnOf = Object.fromEntries(globalThis.__stagedLog);
  assert.ok(turnOf.b > turnOf.a, 'b loads in a later loop turn than a');
  assert.ok(turnOf.core > turnOf.b, 'the rest loads in a later loop turn than b');
  delete globalThis.__stagedLog;
  delete globalThis.__stagedTurns;
});

// A single import of a graph whose second dependency throws never evaluates
// the third; staging must not either, and must reject with the same error.
test('a throwing stage stops staging: later stages do not evaluate and the import rejects', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-staged-import-fail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = (name) => `globalThis.__stagedFailLog.push('${name}');\n`;
  writeFileSync(join(dir, 'a.mjs'), `${log('a')}export const a = 1;\n`);
  writeFileSync(join(dir, 'b.mjs'), `${log('b')}throw new Error('stage b failed');\n`);
  writeFileSync(join(dir, 'c.mjs'), `${log('c')}export const c = 3;\n`);
  writeFileSync(
    join(dir, 'core.mjs'),
    `import './a.mjs';\nimport './b.mjs';\nimport './c.mjs';\n${log('core')}export const value = 1;\n`
  );
  writeFileSync(join(dir, 'root.mjs'), `export { value } from './core.mjs';\n${log('root')}`);
  const url = (name) => pathToFileURL(join(dir, name)).href;

  globalThis.__stagedFailLog = [];
  await assert.rejects(importInStages(url('root.mjs'), url('core.mjs')), /stage b failed/);
  assert.deepEqual(globalThis.__stagedFailLog, ['a', 'b'], 'c, core and root never evaluate');
  delete globalThis.__stagedFailLog;
});
