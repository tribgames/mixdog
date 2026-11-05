import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { jsonEqual } from './session-log-format.mjs';
import { readSessionLog, sessionFromLog } from './session-log-reader.mjs';
import { convertLegacySession } from './session-log-writer.mjs';
import { MIGRATION_SKIP, migrateLegacySessions, readMigrationProgress } from './session-log-migration.mjs';
import { loadLegacy } from './session-log-legacy-loader.fixture.mjs';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-log-migration-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

const loader = { url: new URL('./session-log-legacy-loader.fixture.mjs', import.meta.url).href, exportName: 'loadLegacy' };
const heldClaim = { assertHeld() {} };

function store(name, docs) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const doc of docs) writeFileSync(join(dir, `${doc.id}.json`), JSON.stringify(doc));
  return { dir, progressPath: join(root, `${name}-progress.json`) };
}

const docs = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `sess_${String(i).padStart(3, '0')}`,
    title: `t${i}`,
    messages: [{ role: 'user', content: `m${i}` }],
  }));

function snapshot(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => [name, { bytes: readFileSync(join(dir, name)), mtimeMs: statSync(join(dir, name)).mtimeMs }])
  );
}

test('migrates every legacy json into a proven log, never touching a json, and resumes after an exit', async () => {
  const { dir, progressPath } = store('all', docs(6));
  const before = snapshot(dir);
  const controller = new AbortController();
  let published = 0;
  const first = await migrateLegacySessions({
    storeDir: dir,
    progressPath,
    loader,
    claimFor: () => ({
      held: true,
      claim: heldClaim,
      release() {
        published += 1;
        if (published === 2) controller.abort();
      },
    }),
    signal: controller.signal,
  });
  assert.equal(first.aborted, true);
  assert.equal(first.migrated, 2);
  assert.equal(first.complete, false);
  assert.equal((await readMigrationProgress(progressPath)).cursor, 'sess_001');

  const second = await migrateLegacySessions({
    storeDir: dir,
    progressPath,
    loader,
    claimFor: () => ({ held: true, claim: heldClaim }),
  });
  assert.equal(second.total, 4, 'only the files without a log are candidates');
  assert.equal(second.migrated, 4);
  assert.equal(second.complete, true);
  assert.ok(second.bytes > 0);
  assert.deepEqual(snapshot(dir), before);
  for (const name of Object.keys(before)) {
    const log = await readSessionLog(join(dir, name.replace(/\.json$/, '.log.jsonl')));
    assert.ok(jsonEqual(sessionFromLog(log), loadLegacy(before[name].bytes.toString('utf8'), name.slice(0, -5))));
  }
  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
  assert.equal((await readMigrationProgress(progressPath)).complete, true);
});

test('a busy session is skipped and retried at the next start', async () => {
  const { dir, progressPath } = store('busy', docs(2));
  const busy = new Set(['sess_001']);
  const claimFor = (id) => ({ held: !busy.has(id), claim: heldClaim });
  const first = await migrateLegacySessions({ storeDir: dir, progressPath, loader, claimFor });
  assert.deepEqual(first.skipped, { [MIGRATION_SKIP.BUSY]: 1 });
  assert.equal(first.complete, false);
  assert.equal((await readMigrationProgress(progressPath)).skipped.sess_001.reason, MIGRATION_SKIP.BUSY);
  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
  busy.clear();
  const second = await migrateLegacySessions({ storeDir: dir, progressPath, loader, claimFor });
  assert.equal(second.migrated, 1);
  assert.equal(second.complete, true);
  assert.deepEqual((await readMigrationProgress(progressPath)).skipped, {});
});

test('a file that fails verification is skipped permanently until it changes', async () => {
  const { dir, progressPath } = store('verify', [
    { id: 'sess_bad', unstableLoad: true, messages: [] },
    { id: 'sess_good', messages: [] },
  ]);
  const claimFor = () => ({ held: true, claim: heldClaim });
  const first = await migrateLegacySessions({ storeDir: dir, progressPath, loader, claimFor });
  assert.equal(first.migrated, 1);
  assert.deepEqual(first.skipped, { [MIGRATION_SKIP.VERIFY_MISMATCH]: 1 });
  assert.equal(first.complete, true, 'every file is migrated or explicitly skipped');
  const skip = (await readMigrationProgress(progressPath)).skipped.sess_bad;
  assert.equal(skip.reason, MIGRATION_SKIP.VERIFY_MISMATCH);
  assert.match(skip.message, /does not read back/);

  const again = await migrateLegacySessions({ storeDir: dir, progressPath, loader, claimFor });
  assert.equal(again.migrated, 0);
  assert.deepEqual(again.skipped, { [MIGRATION_SKIP.VERIFY_MISMATCH]: 1 });

  // Fixed (rewritten) → a new fingerprint → tried again.
  writeFileSync(join(dir, 'sess_bad.json'), JSON.stringify({ id: 'sess_bad', messages: [], fixed: true }));
  const fixed = await migrateLegacySessions({ storeDir: dir, progressPath, loader, claimFor });
  assert.equal(fixed.migrated, 1);
  assert.deepEqual((await readMigrationProgress(progressPath)).skipped, {});
});

test('a file that failed for lack of disk space is tried again at the next start', async () => {
  const { dir, progressPath } = store('enospc', docs(1));
  const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  const fullClaim = {
    assertHeld() {
      throw full;
    },
  };
  const first = await migrateLegacySessions({
    storeDir: dir,
    progressPath,
    loader,
    claimFor: () => ({ held: true, claim: fullClaim }),
  });
  assert.deepEqual(first.skipped, { [MIGRATION_SKIP.FAILED]: 1 });
  assert.equal(first.complete, false, 'a resource failure is no verdict on the file');
  // Space freed; the json itself never changed.
  const second = await migrateLegacySessions({
    storeDir: dir,
    progressPath,
    loader,
    claimFor: () => ({ held: true, claim: heldClaim }),
  });
  assert.equal(second.migrated, 1);
  assert.equal(second.complete, true);
  assert.deepEqual((await readMigrationProgress(progressPath)).skipped, {});
});

test('a session converted by its first write is left as it is', async () => {
  const { dir, progressPath } = store('touched', docs(2));
  await convertLegacySession({
    jsonPath: join(dir, 'sess_000.json'),
    logPath: join(dir, 'sess_000.log.jsonl'),
    loadLegacy,
    claim: heldClaim,
  });
  const logBytes = readFileSync(join(dir, 'sess_000.log.jsonl'));
  const report = await migrateLegacySessions({
    storeDir: dir,
    progressPath,
    loader,
    claimFor: () => ({ held: true, claim: heldClaim }),
  });
  assert.equal(report.total, 1);
  assert.equal(report.migrated, 1);
  assert.deepEqual(readFileSync(join(dir, 'sess_000.log.jsonl')), logBytes);
});
