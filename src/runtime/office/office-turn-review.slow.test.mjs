// Office writes are the session's own file changes: an edited document and a
// created one join the turn review as binary files, land in the turn's change
// record as replayable binary patches, and Undo restores their exact bytes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-office-review-')));
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.env.MIXDOG_OOXML_VALIDATOR_DISABLED = '1';
process.on('exit', () => {
  rmSync(base, { recursive: true, force: true });
});

const { executeOfficeTool, resetOfficeSessionsForTest } = await import('./index.mjs');
const { value } = await import('./office-test-support.mjs');
const {
  _resetTurnSnapshotForTest,
  beginTurnSnapshot,
  completeTurnSnapshot,
  getTurnChanges,
  getTurnReviewDiff,
  revertTurnChanges,
} = await import('../shared/turn-snapshot.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

test('Office-written files are own turn changes, a sibling is not, and Undo restores exact bytes', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async (t) => {
  t.after(() => resetOfficeSessionsForTest());
  _resetTurnSnapshotForTest();
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'notes.txt'), 'notes\n');
  writeFileSync(join(repo, 'report-notes.txt'), 'notes beside the report\n');
  // Written before the turn, by no session: the committed original.
  const created = value(
    await executeOfficeTool(
      {
        action: 'create',
        path: 'report.docx',
        mode: 'portable',
        operations: [{ op: 'append_text', text: 'First paragraph.' }],
      },
      { cwd: repo }
    )
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');
  const original = readFileSync(join(repo, 'report.docx'));

  const sessionId = 'office-review';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });
  const context = { cwd: repo, sessionId };
  const edit = executeOfficeTool(
    {
      action: 'batch',
      session: created.session,
      save: true,
      operations: [{ op: 'append_text', text: 'Second paragraph.' }],
    },
    context
  );
  // A sibling named after the document changes while the edit runs: no
  // Office route wrote it, so it is not the session's.
  writeFileSync(join(repo, 'report-notes.txt'), 'concurrent edit\n');
  value(await edit);
  assert.notDeepEqual(readFileSync(join(repo, 'report.docx')), original);
  value(
    await executeOfficeTool(
      {
        action: 'create',
        path: 'budget.xlsx',
        mode: 'portable',
        operations: [{ op: 'set_range', sheet: 'Sheet1', range: 'A1:B1', values: [['Item', 'Cost']] }],
      },
      context
    )
  );
  // Read-only calls write nothing.
  value(await executeOfficeTool({ action: 'snapshot', session: created.session }, context));

  const shape = (files) => files.map((file) => [file.path, file.status, file.binary === true]);
  const expected = [
    ['budget.xlsx', 'A', true],
    ['report.docx', 'M', true],
  ];
  assert.deepEqual(shape((await getTurnReviewDiff(repo, sessionId)).files), expected);
  await completeTurnSnapshot(sessionId);
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.deepEqual(shape(reply.files), expected);
  assert.equal(reply.canUndo, true, reply.reason);

  // Bytes changed since the turn refuse the binary Undo and stay as they are.
  const edited = readFileSync(join(repo, 'report.docx'));
  const foreign = Buffer.concat([edited, Buffer.from('foreign')]);
  writeFileSync(join(repo, 'report.docx'), foreign);
  await assert.rejects(
    revertTurnChanges(sessionId, 'cp', null, reply.revision),
    /undo failed; the worktree was not changed/
  );
  assert.deepEqual(readFileSync(join(repo, 'report.docx')), foreign);
  assert.equal(existsSync(join(repo, 'budget.xlsx')), true);

  writeFileSync(join(repo, 'report.docx'), edited);
  await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.deepEqual(readFileSync(join(repo, 'report.docx')), original);
  assert.equal(existsSync(join(repo, 'budget.xlsx')), false);
  assert.equal(readFileSync(join(repo, 'notes.txt'), 'utf8'), 'notes\n');
  assert.equal(readFileSync(join(repo, 'report-notes.txt'), 'utf8'), 'concurrent edit\n');
});
