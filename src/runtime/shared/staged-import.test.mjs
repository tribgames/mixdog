import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { importInStages } from './staged-import.mjs';

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
  const stages = [url('a.mjs'), url('b.mjs')];

  globalThis.__stagedLog = [];
  globalThis.__stagedTurns = 0;
  let counting = true;
  const count = () => {
    if (!counting) return;
    globalThis.__stagedTurns += 1;
    setImmediate(count);
  };
  setImmediate(count);
  const module = await importInStages(url('root.mjs'), stages);
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
  await assert.rejects(importInStages(url('root.mjs'), [url('a.mjs'), url('b.mjs'), url('c.mjs')]), /stage b failed/);
  assert.deepEqual(globalThis.__stagedFailLog, ['a', 'b'], 'c, core and root never evaluate');
  delete globalThis.__stagedFailLog;
});

// A stage that fails to link must surface its own error, not the masked
// "request for 'node:perf_hooks' is not in cache" older Node gives on re-link.
test('a stage that fails to link rejects with its link error', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-staged-import-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(
    join(dir, 'b.mjs'),
    "import { performance } from 'node:perf_hooks';\nimport { missing } from './a.mjs';\nexport const b = [performance, missing];\n"
  );
  writeFileSync(join(dir, 'core.mjs'), "import './a.mjs';\nimport './b.mjs';\nexport const value = 1;\n");
  writeFileSync(join(dir, 'root.mjs'), "export { value } from './core.mjs';\n");
  const url = (name) => pathToFileURL(join(dir, name)).href;

  await assert.rejects(
    importInStages(url('root.mjs'), [url('a.mjs'), url('b.mjs')]),
    /does not provide an export named 'missing'/
  );
});

// Stages are the caller's declared modules, never read out of a source text:
// a core whose text only looks like it imports other.mjs (a template string)
// never evaluates other.mjs.
test('stages are not derived from source text', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-staged-import-text-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'other.mjs'), "globalThis.__stagedTextLog.push('other');\n");
  writeFileSync(
    join(dir, 'core.mjs'),
    "import { a } from './a.mjs';\nexport const text = `\nimport './other.mjs';\n`;\nexport const value = a;\n"
  );
  writeFileSync(join(dir, 'root.mjs'), "export { value } from './core.mjs';\n");
  const url = (name) => pathToFileURL(join(dir, name)).href;

  globalThis.__stagedTextLog = [];
  const module = await importInStages(url('root.mjs'), [url('a.mjs')]);
  assert.equal(module.value, 1);
  assert.deepEqual(globalThis.__stagedTextLog, [], 'other.mjs is not a stage');
  delete globalThis.__stagedTextLog;
});
