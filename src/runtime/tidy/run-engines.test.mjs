import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngineSuite } from './run-engines.mjs';
import { runnerFor } from './runners/index.mjs';
import { buildTidyReport } from './report.mjs';

const engines = ['biome', 'prettier'].map((id) => ({ id, source: 'project', languages: ['javascript'] }));

for (const failure of ['error', 'truncated']) {
  test(`an incomplete engine check (${failure}) prevents fixes and subsequent engines`, async (t) => {
    const first = runnerFor('biome');
    const second = runnerFor('prettier');
    t.mock.method(first, 'check', async () => {
      if (failure === 'error') throw new Error('check failed');
      return { diagnostics: [], changedFiles: ['a.js'], truncated: true };
    });
    const fix = t.mock.method(first, 'fix', async () => assert.fail('must not apply an incomplete plan'));
    const later = t.mock.method(second, 'check', async () => assert.fail('must stop after the failed engine'));
    const results = await runEngineSuite({
      engines,
      files: ['a.js'],
      cwd: process.cwd(),
      mode: 'fix',
      apply: true,
    });
    assert.equal(results.length, 1);
    assert.ok(results[0][failure]);
    assert.notEqual(results[0].applied, true);
    assert.equal(fix.mock.callCount(), 0);
    assert.equal(later.mock.callCount(), 0);
    assert.equal(buildTidyReport({ action: 'fix', results }).ok, false);
  });
}

test('an engine that writes and then fails reports its partial changes and stops', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tidy-engine-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'a.js');
  writeFileSync(file, 'const n=1;\n');
  const first = runnerFor('biome');
  t.mock.method(first, 'check', async () => ({ diagnostics: [], changedFiles: ['a.js'] }));
  t.mock.method(first, 'fix', async () => {
    writeFileSync(file, 'const n = 1;\n');
    throw new Error('fix interrupted');
  });
  const later = t.mock.method(runnerFor('prettier'), 'check', async () => assert.fail('must stop'));
  const results = await runEngineSuite({ engines, files: ['a.js'], cwd: root, mode: 'fix', apply: true });
  assert.equal(results.length, 1);
  assert.match(results[0].error, /fix interrupted/);
  assert.deepEqual(results[0].filesChanged, ['a.js']);
  assert.equal(readFileSync(file, 'utf8'), 'const n = 1;\n');
  assert.equal(later.mock.callCount(), 0);
  const report = buildTidyReport({ action: 'fix', results });
  assert.equal(report.ok, false);
  assert.equal(report.status, 'partial');
});
