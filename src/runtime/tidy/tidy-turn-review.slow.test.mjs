// Tidy writes are the session's own file changes: a structural fix and an
// engine's in-place rewrite both join the turn review with their own line
// counts, land in the turn's change record, and are undone by Undo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-tidy-review-')));
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.on('exit', () => {
  rmSync(base, { recursive: true, force: true });
});

const { applyStructuralFixes, captureWriteBaselines, recordEngineWrites } = await import('./apply.mjs');
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

const counts = (files) => files.map((file) => [file.path, file.status, file.additions, file.deletions]);

test('a tidy fix and an engine rewrite are own turn changes and Undo restores them', {
  skip: gitAvailable ? false : 'git is unavailable',
}, async () => {
  _resetTurnSnapshotForTest();
  const repo = join(base, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.js'), 'let x = 1;\n');
  writeFileSync(join(repo, 'b.js'), 'let y = 2;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'seed');
  const sessionId = 'tidy-review';
  await beginTurnSnapshot(repo, sessionId, { checkpointId: 'cp' });

  const outcome = await applyStructuralFixes({
    cwd: repo,
    sessionId,
    matchesByFile: { 'a.js': [{ file: 'a.js', ruleId: 'no-let', fix: { byteOffset: [0, 3], text: 'const' } }] },
  });
  assert.deepEqual(outcome.applied, [{ file: 'a.js', fixes: 1 }]);
  // An engine formats b.js in place; tidy records what it rewrote.
  const engineFile = join(repo, 'b.js');
  const baselines = captureWriteBaselines([engineFile]);
  writeFileSync(engineFile, 'const y = 2;\n');
  await recordEngineWrites({ cwd: repo, sessionId, baselines, fullPaths: [engineFile] });

  const expected = [
    ['a.js', 'M', 1, 1],
    ['b.js', 'M', 1, 1],
  ];
  assert.deepEqual(counts((await getTurnReviewDiff(repo, sessionId)).files), expected);
  await completeTurnSnapshot(sessionId);
  const reply = await getTurnChanges(sessionId, { checkpointId: 'cp' });
  assert.deepEqual(counts(reply.files), expected);
  assert.equal(reply.canUndo, true, reply.reason);
  await revertTurnChanges(sessionId, 'cp', null, reply.revision);
  assert.equal(readFileSync(join(repo, 'a.js'), 'utf8'), 'let x = 1;\n');
  assert.equal(readFileSync(engineFile, 'utf8'), 'let y = 2;\n');
});
