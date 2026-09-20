import assert from 'node:assert/strict';
import test from 'node:test';
import { _gitCommandInternals } from './git-command-tool.mjs';
import { createDiffSnapshot } from './git-partial-stage.mjs';

const plan = { operation: 'diff', cwd: process.cwd(), args: [], globalArgs: [] };
const result = (stdout, stderr = '', exitCode = 0) => ({ stdout, stderr, exitCode });
const patch = 'diff --git a/a.txt b/a.txt\nindex 123..456 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n-old\n+new\n context\n-before\n+after\n';

test('git single output preserves whitespace, JSON-looking blobs and stderr', () => {
  const { commandResult } = _gitCommandInternals;
  for (const text of ['', '  M a.txt\n', '{"ok":false}\n', 'x\r\n\n', 'x'.repeat(5000)]) {
    assert.deepEqual(commandResult(plan, result(text), 50), { text, failed: false });
  }
  assert.equal(commandResult(plan, result('out', 'warning\n'), 50).text, 'out\nwarning\n');
  assert.equal(commandResult(plan, result('out\n', 'fatal\n', 128), 50).text, 'exit 128\nout\nfatal\n');
  assert.equal(commandResult(plan, { ...result(''), timedOut: true }, 50).text, 'error: git command timed out');
});

test('git line caps include blank lines, retain headers, and count all omissions', () => {
  const { commandResult } = _gitCommandInternals;
  assert.equal(commandResult(plan, result('a\n\nb\nc\n'), 2).text,
    'a\n\n... [2 more lines omitted; raise output_limit or narrow the command]');
  assert.equal(commandResult(plan, result(patch), 4).text,
    `${patch.split('\n').slice(0, 4).join('\n')}\n... [6 more lines omitted; raise output_limit or narrow the command]`);
  assert.equal(commandResult(plan, result('a\nb\n'), 2).text, 'a\nb\n');
});

test('stage discovery annotates every edit group on its original hunk and retains raw body', () => {
  const snapshot = createDiffSnapshot({ repo: process.cwd(), scope: process.cwd(), plan, argv: ['diff'], raw: patch.trimEnd() });
  assert.equal(snapshot.changes.length, 2);
  const text = _gitCommandInternals.stageableDiffResult(plan, result(patch), snapshot, 50).text;
  assert.ok(text.includes(`@@ -1,3 +1,3 @@${snapshot.changes.map(({ id }) => ` # change:${id}`).join('')}\n`));
  assert.equal(text.replace(/ # change:chg_[0-9a-f]{16}/g, ''), `${patch}diff_id: ${snapshot.diffId}`);
  const capped = _gitCommandInternals.stageableDiffResult(plan, result(patch), snapshot, 4).text;
  assert.doesNotMatch(capped, / # change:/);
  assert.ok(capped.endsWith(`diff_id: ${snapshot.diffId}\n… [2 more changes omitted]`));
});
