import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';

import { check, entryPoints, specifiersOf } from './check-import-closure.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'import-closure-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const TREE = {
  'apps/desktop/src/main/index.ts':
    "import { a } from '../../../../src/runtime/a.mjs';\nconst b = await import('../../../../src/runtime/b.mjs');\n",
  'packages/client/src/index.ts': "import x from 'strip-ansi';\nexport * from '../../../src/runtime/c.cjs';\n",
  'src/skill-script-entry.mjs': "await import('./runtime/skill.mjs');\n",
  'src/runtime/a.mjs': "import './a-helper.mjs';\n",
  'src/runtime/a-helper.mjs': 'export {};\n',
  'src/runtime/b.mjs': "const here = new URL('./b-data.mjs', import.meta.url);\n",
  'src/runtime/b-data.mjs': 'export {};\n',
  'src/runtime/c.cjs': "const d = require('./d.cjs');\n",
  'src/runtime/d.cjs': '',
  'src/runtime/skill.mjs': '',
  'src/runtime/only-tests.mjs': '',
  'src/runtime/only-tests.test.mjs': "import './only-tests.mjs';\n",
  'src/runtime/nothing.mjs': "import './gone.mjs';\n",
  'src/tui/old.mjs': "import '../runtime/a.mjs';\n",
};

test('specifiersOf finds static, dynamic, require and new URL targets and skips comments and non-relative schemes', () => {
  const text = [
    "import a from './a.mjs';",
    "export { b } from '../b.mjs';",
    "const c = await import('./c.mjs');",
    "const d = require('./d.cjs');",
    "const e = new URL('./e.json', import.meta.url);",
    "const f = new URL('https://example.com/x');",
    "import fs from 'node:fs';",
    "import z from 'zod';",
    "// import './commented.mjs';",
    "/* import './block.mjs'; */",
  ].join('\n');
  assert.deepEqual(specifiersOf(text, 'x.mjs'), [
    { spec: './a.mjs', kind: 'relative' },
    { spec: '../b.mjs', kind: 'relative' },
    { spec: './c.mjs', kind: 'relative' },
    { spec: './d.cjs', kind: 'relative' },
    { spec: './e.json', kind: 'relative' },
    { spec: 'zod', kind: 'package' },
  ]);
});

test('entry points are computed from the tree and a file only a test imports is not production', () => {
  const root = fixture(TREE);
  try {
    const { production, tests } = entryPoints(root);
    assert.ok([...production].map((f) => f.split(sep).join('/')).some((f) => f.endsWith('main/index.ts')));
    assert.ok([...production].map((f) => f.split(sep).join('/')).some((f) => f.endsWith('skill-script-entry.mjs')));
    assert.ok([...tests].map((f) => f.split(sep).join('/')).some((f) => f.endsWith('only-tests.test.mjs')));
    const report = check(root);
    assert.deepEqual(report.srcReached, [
      'src/runtime/a-helper.mjs',
      'src/runtime/a.mjs',
      'src/runtime/b-data.mjs',
      'src/runtime/b.mjs',
      'src/runtime/c.cjs',
      'src/runtime/d.cjs',
      'src/runtime/skill.mjs',
      'src/skill-script-entry.mjs',
    ]);
    assert.deepEqual(report.srcTestsOnly, ['src/runtime/only-tests.mjs']);
    assert.deepEqual(report.srcNoImporter, ['src/runtime/nothing.mjs', 'src/tui/old.mjs']);
    assert.deepEqual(report.productionPackages, ['strip-ansi']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a remaining non-test file importing a file of src that is gone fails; a test fixture string does not', () => {
  const root = fixture({
    ...TREE,
    'src/runtime/skill.mjs': "import './removed.mjs';\n",
    'scripts/x.test.mjs': "writeFile('t.mjs', \"import './fixture-only.mjs'\")\nimport './fixture-only.mjs';\n",
  });
  try {
    const report = check(root);
    assert.deepEqual(report.missing, [
      { from: 'src/runtime/skill.mjs', spec: './removed.mjs', resolved: 'src/runtime/removed.mjs' },
    ]);
    assert.ok(report.unresolved.some((m) => m.from === 'scripts/x.test.mjs'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a delete entry that a remaining entry reaches is reported with its importers; one nothing reaches passes', () => {
  const root = fixture(TREE);
  try {
    const reached = check(root, ['src/runtime/a-helper.mjs']);
    assert.deepEqual(reached.reachedDeletes, [{ file: 'src/runtime/a-helper.mjs', importers: ['src/runtime/a.mjs'] }]);
    const folder = check(root, ['src/runtime/']);
    assert.deepEqual(
      folder.reachedDeletes.map((h) => h.file),
      ['src/runtime/a.mjs', 'src/runtime/b.mjs', 'src/runtime/c.cjs', 'src/runtime/skill.mjs']
    );
    const clean = check(root, ['src/tui/', 'src/runtime/nothing.mjs']);
    assert.deepEqual(clean.reachedDeletes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
