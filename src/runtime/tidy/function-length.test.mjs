import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { summarizeFunctionLengths } from './function-length.mjs';
import { buildTidyReport } from './report.mjs';
import { graphBinaryPath } from '../agent/orchestrator/tools/code-graph/graph-binary.mjs';

function sixtyLineSource() {
  const body = Array.from({ length: 58 }, (_, i) => `  total += ${i};`).join('\n');
  return `export function longOne() {\n  let total = 0;\n${body}\n  return total;\n}\n`;
}

test('summary counts thresholds, lists the longest and flags spanless languages', async () => {
  const records = [
    {
      rel: 'a.js',
      lang: 'javascript',
      symbols: [
        { name: 'big', kind: 'function', startLine: 1, endLine: 160 },
        { name: 'mid', kind: 'method', startLine: 1, endLine: 60 },
        { name: 'small', kind: 'function', startLine: 1, endLine: 5 },
        { name: 'K', kind: 'class', startLine: 1, endLine: 400 },
      ],
    },
    { rel: 'b.zzz', lang: 'zzz', symbols: [] },
  ];
  const summary = await summarizeFunctionLengths({
    cwd: '/x',
    files: ['a.js', 'b.zzz'],
    runFiles: async () => records,
  });
  assert.equal(summary.over50, 2);
  assert.equal(summary.over100, 1);
  assert.equal(summary.over150, 1);
  assert.deepEqual(summary.longest[0], { path: 'a.js', name: 'big', lines: 160 });
  assert.deepEqual(summary.notMeasured, ['zzz']);
});

test('check/fix reports carry the summary; other actions do not', () => {
  const functionLength = { measured: true, over50: 1, over100: 0, over150: 0, longest: [] };
  assert.deepEqual(buildTidyReport({ action: 'check', functionLength }).functionLength, functionLength);
  assert.deepEqual(buildTidyReport({ action: 'fix', functionLength }).functionLength, functionLength);
  assert.equal(buildTidyReport({ action: 'scan', functionLength }).functionLength, undefined);
});

test('live graph: a 60-line JS function shows up in a check report summary', async (t) => {
  if (!graphBinaryPath()) return t.skip('mixdog-graph binary not available');
  const root = mkdtempSync(join(tmpdir(), 'tidy-fnlen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'long.js'), sixtyLineSource());
  const functionLength = await summarizeFunctionLengths({ cwd: root, files: ['long.js'] });
  assert.equal(functionLength.measured, true);
  assert.equal(functionLength.over50, 1);
  assert.equal(functionLength.over100, 0);
  assert.deepEqual(functionLength.longest[0], { path: 'long.js', name: 'longOne', lines: 62 });
  const report = buildTidyReport({ action: 'check', functionLength });
  assert.equal(report.functionLength.over50, 1);
});
