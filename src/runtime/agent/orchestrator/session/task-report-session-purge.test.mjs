// A bounded report's full copy is kept in its owning session's artifact
// directory, so deleting the session removes it with no cleanup of its own.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-report-purge-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const sessionsDir = join(dataDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });
const { deleteSession } = await import('./store.mjs');
await import('./tool-result-offload.mjs'); // registers the session purge hook
const { boundReportForModel } = await import('../../../shared/task-report-spill.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const report = ['Status: done', ...Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`), 'Open: none'].join(
  '\n'
);

test('deleting the owning session removes its spilled reports and leaves other sessions and the global folder', () => {
  const doomed = `sess_purge_${process.pid}_a`;
  const kept = `sess_purge_${process.pid}_b`;
  for (const id of [doomed, kept]) writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify({ id }));

  const mine = boundReportForModel('task_agent_1', report, doomed).outputFile;
  const other = boundReportForModel('task_agent_2', report, kept).outputFile;
  const unowned = boundReportForModel('task_agent_3', report).outputFile;
  assert.equal(mine, join(dataDir, 'tool-results', doomed, mine.split(/[\\/]/).pop()));
  for (const path of [mine, other, unowned]) assert.equal(readFileSync(path, 'utf8'), report);

  assert.equal(deleteSession(doomed), true);
  assert.equal(existsSync(mine), false, 'the spilled report is gone');
  assert.equal(existsSync(join(dataDir, 'tool-results', doomed)), false, 'so is its directory');
  assert.equal(existsSync(other), true);
  assert.equal(existsSync(unowned), true);
});
