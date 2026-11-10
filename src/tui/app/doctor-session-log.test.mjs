import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { SESSION_LOG_MIGRATION_ID } from '../../runtime/agent/orchestrator/session/store/session-log-format.mjs';
import { runDoctorChecks } from './doctor.mjs';

function dataDirWith({ jsons = [], logs = [], progress = null, rawProgress = null }) {
  const dataDir = makeTempDirSync('doctor-session-log');
  mkdirSync(join(dataDir, 'sessions'));
  for (const id of jsons) writeFileSync(join(dataDir, 'sessions', `${id}.json`), '{}');
  for (const id of logs) writeFileSync(join(dataDir, 'sessions', `${id}.log.jsonl`), '');
  const file = join(dataDir, 'session-log-migration.json');
  if (progress) {
    writeFileSync(file, JSON.stringify({ v: 1, migrationId: SESSION_LOG_MIGRATION_ID, cursor: null, complete: false, updatedAt: 1, skipped: {}, ...progress }));
  }
  if (rawProgress !== null) writeFileSync(file, rawProgress);
  return dataDir;
}

async function rowFor(dataDir) {
  return (await runDoctorChecks({}, () => ({}), { dataDir })).checks.find((check) => check.id === 'sessionLog');
}

test('no progress file and nothing to migrate is fine; legacy sessions without progress are pending', async () => {
  assert.equal((await rowFor(dataDirWith({}))).detail, 'nothing to migrate');
  const row = await rowFor(dataDirWith({ jsons: ['a', 'b'] }));
  assert.equal(row.level, 'warn');
  assert.equal(row.detail, 'not started · 2 pending');
});

test('a complete migration reports its logs; a partial one reports the pending count', async () => {
  const done = await rowFor(dataDirWith({ logs: ['a', 'b'], jsons: ['a', 'b'], progress: { complete: true } }));
  assert.equal(done.level, 'ok');
  assert.equal(done.detail, 'complete · 2 session logs');
  const partial = await rowFor(dataDirWith({ logs: ['a'], jsons: ['a', 'b', 'c'], progress: { cursor: 'a' } }));
  assert.equal(partial.level, 'warn');
  assert.equal(partial.detail, 'in progress · 2 pending');
});

test('a legacy session added after the recorded completion is reported pending, not complete', async () => {
  const row = await rowFor(dataDirWith({ logs: ['a'], jsons: ['a', 'b', 'c'], progress: { complete: true } }));
  assert.equal(row.level, 'warn');
  assert.equal(row.detail, 'in progress · 2 pending');
});

test('skipped sessions are listed with their reason and are not pending; messages stay hidden', async () => {
  const row = await rowFor(
    dataDirWith({
      jsons: ['a', 'bad'],
      logs: ['a'],
      progress: { complete: true, skipped: { bad: { reason: 'unreadable', size: 2, mtimeMs: 1, at: 1, message: 'C:\\secret\\path' } } },
    })
  );
  assert.equal(row.level, 'warn');
  assert.equal(row.detail, 'complete · 1 session log · 1 skipped: bad (unreadable)');
  assert.ok(row.fix.hint);
  assert.doesNotMatch(JSON.stringify(row), /secret/);
});

test('an unreadable progress file is a warning that says how to restart', async () => {
  const row = await rowFor(dataDirWith({ rawProgress: '{not json' }));
  assert.equal(row.level, 'warn');
  assert.equal(row.detail, 'progress file unreadable');
});
