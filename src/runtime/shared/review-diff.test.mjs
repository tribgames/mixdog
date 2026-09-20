import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { boundReviewPatch } from './review-diff.mjs';
import { _resetTurnSnapshotForTest, getTurnReviewDiff, recordTurnDiffChanges } from './turn-snapshot.mjs';
import { executeBuiltinTool } from '../agent/orchestrator/tools/builtin.mjs';
import { executePatchTool, takeApplyPatchUiDiff } from '../agent/orchestrator/tools/patch.mjs';
import { parseUnifiedDiff } from '../../../apps/desktop/src/renderer/renderer-logic.mjs';

test('bounded diffs keep every file, its operation, and complete small hunks', () => {
  const patch = [
    `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+${'x'.repeat(70000)}\n`,
    'diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+new\n',
    'diff --git a/c.txt b/c.txt\ndeleted file mode 100644\n--- a/c.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n',
  ].join('');
  const result = boundReviewPatch(patch, 65536);
  assert.equal(result.truncated, true);
  assert(result.patch.length <= 65536);
  assert.deepEqual(
    parseUnifiedDiff(result.patch).map((file) => [file.newFile.fileName, file.status]),
    [
      ['a.txt', 'M'],
      ['b.txt', 'A'],
      ['c.txt', 'D'],
    ]
  );
  assert.match(result.patch, /\+new\n/);
  assert.match(result.patch, /-old\n/);
  assert.equal(parseUnifiedDiff(result.patch)[0].hunks.length, 0);
  const tiny = boundReviewPatch(patch, 1);
  assert.equal(parseUnifiedDiff(tiny.patch).length, 3);
  assert.equal(boundReviewPatch(result.patch, 65536).truncated, true);
});

test('tracked review over two million characters retains large and subsequent files with a truncation flag', async () => {
  try {
    const patch = recordTurnDiffChanges('oversized-review', [
      { path: '/probe/a.txt', displayPath: 'a.txt', before: null, after: `${'x'.repeat(2100000)}\n` },
      { path: '/probe/z.txt', displayPath: 'z.txt', before: 'old\n', after: 'new\n' },
    ]);
    const review = await getTurnReviewDiff('/probe', 'oversized-review');
    assert.equal(review.patch, patch);
    assert.equal(review.patchTruncated, true);
    assert.deepEqual(
      parseUnifiedDiff(patch).map((file) => file.newFile.fileName),
      ['a.txt', 'z.txt']
    );
    assert.match(patch, /-old\n\+new\n/);
  } finally {
    _resetTurnSnapshotForTest();
  }
});

test('apply_patch and edit publish additions, modifications and deletion semantics after a large edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-diff-tools-'));
  try {
    for (const tool of ['apply_patch', 'edit']) {
      const sessionId = `diff-tools-${tool}`;
      let sequence = 0;
      const run = async (args) => {
        const toolCallId = `${sessionId}-${++sequence}`;
        const execute = tool === 'edit' ? executeBuiltinTool : executePatchTool;
        const result = await execute(tool, args, root, { sessionId, toolCallId });
        assert.doesNotMatch(String(result), /^Error[\s:]/);
        return takeApplyPatchUiDiff(toolCallId);
      };
      const file = `${tool}-z.txt`;
      const large = `${tool}-a.txt`;
      await run(
        tool === 'edit'
          ? { file_path: large, old_string: '', new_string: `${'x'.repeat(70000)}\n` }
          : { patch: `*** Begin Patch\n*** Add File: ${large}\n+${'x'.repeat(70000)}\n*** End Patch\n` }
      );
      let patch = await run(
        tool === 'edit'
          ? { file_path: file, old_string: '', new_string: 'old\n' }
          : { patch: `*** Begin Patch\n*** Add File: ${file}\n+old\n*** End Patch\n` }
      );
      assert.deepEqual(
        parseUnifiedDiff(patch).map((part) => part.newFile.fileName),
        [large, file]
      );
      patch = await run(
        tool === 'edit'
          ? { file_path: file, old_string: 'old', new_string: 'new' }
          : { patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n-old\n+new\n*** End Patch\n` }
      );
      assert.match(patch, /\+new/);
      patch = await run(
        tool === 'edit'
          ? { file_path: file, old_string: 'new\n', new_string: '' }
          : { patch: `*** Begin Patch\n*** Delete File: ${file}\n*** End Patch\n` }
      );
      if (tool === 'edit') {
        assert.equal(await readFile(join(root, file), 'utf8'), '');
        assert(parseUnifiedDiff(patch).some((part) => part.newFile.fileName === file && part.status === 'A'));
      } else {
        assert(!parseUnifiedDiff(patch).some((part) => part.newFile.fileName === file));
      }
    }
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});
