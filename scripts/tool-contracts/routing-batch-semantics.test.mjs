import './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBuiltinTool } from '../../src/runtime/agent/orchestrator/tools/builtin.mjs';

function fixture(files) {
  const cwd = mkdtempSync(join(tmpdir(), 'mixdog-routing-batch-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  return cwd;
}

test('one read array preserves separate windows of the same file and other files', async () => {
  const cwd = fixture({
    'alpha.txt': `${Array.from({ length: 10 }, (_, i) => `ALPHA_${i + 1}`).join('\n')}\n`,
    'beta.txt': 'BETA_1\nBETA_2\n',
  });
  const args = {
    file_path: [
      { file_path: 'alpha.txt', offset: 2, limit: 2 },
      { file_path: 'alpha.txt', offset: 7, limit: 2 },
      { file_path: 'beta.txt', offset: 2, limit: 1 },
    ],
  };
  const original = structuredClone(args);
  const result = String(await executeBuiltinTool('read', args, cwd));
  const lines = result.split('\n').filter((line) => /^\d+→/.test(line));
  assert.deepEqual(lines, ['2→ALPHA_2', '3→ALPHA_3', '7→ALPHA_7', '8→ALPHA_8', '2→BETA_2']);
  assert.deepEqual(args, original);
});

test('grep arrays search every pattern in every path, while separate calls preserve requested pairs', async () => {
  const cwd = fixture({ 'alpha.txt': 'X_A\nY_A\n', 'beta.txt': 'X_B\nY_B\n' });
  const combined = String(
    await executeBuiltinTool(
      'grep',
      {
        pattern: ['X_', 'Y_'],
        path: ['alpha.txt', 'beta.txt'],
        context: 0,
      },
      cwd
    )
  );
  const markers = (text) => [...new Set(String(text).match(/\b[XY]_[AB]\b/g) || [])].sort();
  assert.deepEqual(markers(combined), ['X_A', 'X_B', 'Y_A', 'Y_B']);

  const paired = await Promise.all([
    executeBuiltinTool('grep', { pattern: 'X_', path: 'alpha.txt', context: 0 }, cwd),
    executeBuiltinTool('grep', { pattern: 'Y_', path: 'beta.txt', context: 0 }, cwd),
  ]);
  assert.deepEqual(markers(paired[0]), ['X_A']);
  assert.deepEqual(markers(paired[1]), ['Y_B']);
});
