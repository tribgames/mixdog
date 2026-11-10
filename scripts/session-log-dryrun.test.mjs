import './lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { makeTempDirSync } from './lib/scoped-temp.mjs';
import { formatDryRunReport, runSessionLogDryRun } from './session-log-dryrun.mjs';

function fixtureDataDir() {
  const dataDir = join(makeTempDirSync('session-log-dryrun-fixture'), 'data');
  const sessions = join(dataDir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const doc = (id, content) => ({
    id,
    title: id,
    messages: [
      { role: 'user', content },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ],
  });
  writeFileSync(join(sessions, 'sess_a.json'), JSON.stringify(doc('sess_a', 'my key is Zq81xLmP93vTrW')));
  writeFileSync(join(sessions, 'sess_b.json'), JSON.stringify(doc('sess_b', 'no secret here at all, just words')));
  writeFileSync(join(sessions, 'sess_bad.json'), '{"id": "sess_bad", ');
  writeFileSync(join(sessions, 'sess_b.compaction-archive.jsonl'), '{"archived":true}\n');
  writeFileSync(join(dataDir, 'session-summaries.json'), '{}');
  writeFileSync(join(dataDir, 'session-catalog.sqlite'), 'not really sqlite');
  return dataDir;
}

test('the dry run proves equality on a copy, reports skips with reasons and leaves the source untouched', async () => {
  const dataDir = fixtureDataDir();
  const jsonBefore = readFileSync(join(dataDir, 'sessions', 'sess_a.json'));
  const report = await runSessionLogDryRun({ dataDir });

  assert.equal(report.sourceUntouched, true);
  assert.deepEqual(readFileSync(join(dataDir, 'sessions', 'sess_a.json')), jsonBefore);
  assert.equal(report.sessions.equal, 2);
  assert.deepEqual(report.sessions.different, []);
  assert.deepEqual(report.sessions.skipped, { unreadable: 1 });
  assert.deepEqual(report.sessions.skippedIds, { unreadable: ['sess_bad'] });
  assert.equal(report.sessions.appended.equal, 2);
  assert.equal(report.load.oldMs.n, 2);
  assert.equal(report.migration.complete, true);
  assert.equal(report.migration.jsonUntouchedOnCopy, true);
  assert.equal(report.redaction.ran, true);
  assert.equal(report.redaction.id, 'sess_a');
  assert.equal(report.redaction.heldAfter.length, 0);
  assert.equal(report.redaction.kindAfter, 'log');
  assert.equal(report.ok, true);
  assert.match(formatDryRunReport(report), /RESULT: ok/);
});

test('a linked sessions folder is copied as its contents, so the run never writes into the link target', async () => {
  const dataDir = fixtureDataDir();
  const target = join(makeTempDirSync('session-log-dryrun-link-target'), 'sessions');
  renameSync(join(dataDir, 'sessions'), target);
  symlinkSync(target, join(dataDir, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = readdirSync(target).sort();
  const jsonBefore = readFileSync(join(target, 'sess_a.json'));
  const report = await runSessionLogDryRun({ dataDir });
  assert.equal(report.sessions.equal, 2);
  assert.deepEqual(readdirSync(target).sort(), before, 'no log or set-aside file appears in the target');
  assert.deepEqual(readFileSync(join(target, 'sess_a.json')), jsonBefore, 'the redaction never reached the target');
});

test('a source that changes while the dry run works is reported, not hidden', async () => {
  const dataDir = fixtureDataDir();
  const report = await runSessionLogDryRun({
    dataDir,
    log: (line) => {
      if (line.startsWith('migrate:')) writeFileSync(join(dataDir, 'session-summaries.json'), '{"late":true}');
    },
  });
  assert.equal(report.sourceUntouched, false);
  assert.deepEqual(report.sourceChanges.map((change) => change.file), ['session-summaries.json']);
  assert.equal(report.ok, false);
});
