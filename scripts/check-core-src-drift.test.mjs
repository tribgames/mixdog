import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeCoreSrc } from './check-core-src-drift.mjs';

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-src-drift-'));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return {
    root,
    analyze: () => analyzeCoreSrc({ desktopRoot: path.join(root, 'apps/desktop'), runtimeRoot: path.join(root, 'src') }),
  };
}

const CORE = 'apps/desktop/src/shared/core-src/runtime/shared';

test('a copy imported by a desktop source is kept, one nobody imports is listed', () => {
  const { root, analyze } = fixture({
    'apps/desktop/src/renderer/a.ts': `import { x } from '../shared/core-src/runtime/shared/used.mjs';`,
    [`${CORE}/used.mjs`]: 'export const x = 1;\n',
    [`${CORE}/used.d.mts`]: 'export const x: number;\n',
    [`${CORE}/unused.mjs`]: 'export const y = 1;\n',
    [`${CORE}/unused.d.mts`]: 'export const y: number;\n',
  });
  try {
    const result = analyze();
    assert.deepEqual(result.unreferenced, [
      'src/shared/core-src/runtime/shared/unused.d.mts',
      'src/shared/core-src/runtime/shared/unused.mjs',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a copy reached only through another kept copy is kept; dynamic imports in tests count', () => {
  const { root, analyze } = fixture({
    'apps/desktop/src/renderer/a.test.mjs': `const m = await import('../shared/core-src/runtime/shared/top.mjs');`,
    [`${CORE}/top.mjs`]: `import { z } from './inner.mjs';\nexport { z };\n`,
    [`${CORE}/inner.mjs`]: 'export const z = 1;\n',
  });
  try {
    assert.deepEqual(analyze().unreferenced, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('drift is a kept copy that differs from src/, line endings aside; a missing counterpart is separate', () => {
  const { root, analyze } = fixture({
    'apps/desktop/src/renderer/a.ts': [
      `import './../shared/core-src/runtime/shared/same.mjs';`,
      `import './../shared/core-src/runtime/shared/changed.mjs';`,
      `import './../shared/core-src/runtime/shared/lonely.mjs';`,
    ].join('\n'),
    [`${CORE}/same.mjs`]: 'export const a = 1;\r\n',
    'src/runtime/shared/same.mjs': 'export const a = 1;\n',
    [`${CORE}/changed.mjs`]: 'export const b = 1;\n',
    'src/runtime/shared/changed.mjs': 'export const b = 2;\n',
    [`${CORE}/lonely.mjs`]: 'export const c = 1;\n',
  });
  try {
    const result = analyze();
    assert.deepEqual(result.drift, ['src/shared/core-src/runtime/shared/changed.mjs']);
    assert.deepEqual(result.noCounterpart, ['src/shared/core-src/runtime/shared/lonely.mjs']);
    assert.deepEqual(result.unreferenced, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
