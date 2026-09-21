import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGlobTool } from './search-glob-tool.mjs';

test('the path cap does not hide errors from later groups or partial-result warnings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-glob-cap-diagnostics-'));
  try {
    await mkdir(join(root, 'a'));
    await mkdir(join(root, 'b'));
    const result = await executeGlobTool(
      { path: root, pattern: ['a/*.mjs', 'b/*.mjs'], sort: 'natural', limit: 50000 },
      root,
      {
        __runRgWindowedLines: async (_args, { cwd }) => {
          if (cwd === join(root, 'b')) throw new Error('permission denied in second group');
          return {
            lines: Array.from({ length: 50000 }, (_, i) => `file-${i}.mjs`),
            complete: false,
            partial: true,
            cacheSafe: false,
          };
        },
      }
    );
    assert.match(result, /accumulation cap \(50000\)/);
    assert.match(result, /rg exit 2 \(partial results\)/);
    assert.match(result, /permission denied in second group/);
    assert.match(result, /file-0\.mjs/);
    assert.match(result, /file-49999\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('empty partial glob results keep the incomplete warning and are not cached', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-glob-empty-partial-'));
  let calls = 0;
  try {
    const options = {
      __runRgWindowedLines: async () => {
        calls++;
        return { lines: [], complete: false, partial: true, timeout: true, cacheSafe: false };
      },
    };
    for (let i = 0; i < 2; i++) {
      const result = await executeGlobTool(
        { path: root, pattern: '**/*.mjs', sort: 'natural', limit: 25 },
        root,
        options
      );
      assert.match(result, /no files found yet/);
      assert.match(result, /partial results|incomplete/);
    }
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
