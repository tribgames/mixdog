import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { boundReviewPatch } from './review-diff.mjs';
import {
  _resetTurnSnapshotForTest,
  beginAgentTurnReview,
  beginTurnSnapshot,
  completeAgentTurnReview,
  completeTurnSnapshot,
  getTurnReviewDiff,
  getTurnReviewFilePatch,
  recordTurnDiffChanges,
} from './turn-snapshot.mjs';
import { executeBuiltinTool } from '../agent/orchestrator/tools/builtin.mjs';
import { executePatchTool, takeApplyPatchUiDiff } from '../agent/orchestrator/tools/patch.mjs';
import { parseUnifiedDiff } from '../../../apps/desktop/src/renderer/renderer-logic.mjs';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

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

test('tracked review over two million characters lists the large file without its patch and keeps the others', async () => {
  try {
    const patch = recordTurnDiffChanges('oversized-review', [
      { path: '/probe/a.txt', displayPath: 'a.txt', before: null, after: `${'x'.repeat(2100000)}\n` },
      { path: '/probe/z.txt', displayPath: 'z.txt', before: 'old\n', after: 'new\n' },
    ]);
    assert.deepEqual(
      parseUnifiedDiff(patch).map((file) => file.newFile.fileName),
      ['a.txt', 'z.txt']
    );
    const review = await getTurnReviewDiff('/probe', 'oversized-review');
    assert.deepEqual(
      review.files.map(({ path, additions, patchOmitted, reason }) => [path, additions, patchOmitted, reason]),
      [
        ['a.txt', 1, true, 'too_large'],
        ['z.txt', 1, undefined, undefined],
      ]
    );
    assert.deepEqual(
      parseUnifiedDiff(review.patch).map((file) => file.newFile.fileName),
      ['z.txt']
    );
    assert.match(review.patch, /-old\n\+new\n/);
    assert.equal(review.patchTruncated, false);
    // Read on its own, the file's whole patch is there.
    const whole = await getTurnReviewFilePatch('/probe', 'oversized-review', 'a.txt');
    assert.equal(whole.patch.length > 2_100_000, true);
    assert.equal(whole.patchOmitted, undefined);
  } finally {
    _resetTurnSnapshotForTest();
  }
});

test('an over-ceiling change is rejected without converting its content to a Buffer', (t) => {
  // Past both the tracked-content ceiling and the 64 MiB baseline limit.
  const big = 'x'.repeat(81 * 1024 * 1024);
  const realFrom = Buffer.from;
  let largest = 0;
  t.mock.method(Buffer, 'from', function (value, ...rest) {
    if (typeof value === 'string') largest = Math.max(largest, value.length);
    return realFrom.call(this, value, ...rest);
  });
  try {
    recordTurnDiffChanges('over-ceiling', [
      { path: '/probe/huge.txt', displayPath: 'huge.txt', before: big, after: `${big}y` },
    ]);
  } finally {
    t.mock.restoreAll();
    _resetTurnSnapshotForTest();
  }
  assert.ok(largest <= 8 * 1024 * 1024, `converted a ${largest}-character string`);
});

test('a completion wake continues the user turn review with its Lead edits and worker diffs', async () => {
  const root = makeTempDirSync('turn-wake');
  const lead = 'wake-lead';
  try {
    await beginTurnSnapshot(root, lead, { checkpointId: 'prompt-1' });
    const worker = beginAgentTurnReview(lead, 'wake-worker', { tag: 'split' });
    recordTurnDiffChanges(lead, [
      { path: join(root, 'lead.txt'), displayPath: 'lead.txt', before: 'a\n', after: 'b\n' },
    ]);
    await completeTurnSnapshot(lead);
    recordTurnDiffChanges('wake-worker', [
      { path: join(root, 'worker.txt'), displayPath: 'worker.txt', before: null, after: 'w\n' },
    ]);
    completeAgentTurnReview(worker);

    await beginTurnSnapshot(root, lead, { continueTurn: true });
    recordTurnDiffChanges(lead, [{ path: join(root, 'fix.txt'), displayPath: 'fix.txt', before: 'x\n', after: 'y\n' }]);
    const review = await getTurnReviewDiff(root, lead);
    assert.equal(review.checkpointId, 'prompt-1');
    // The completed worker's own edits joined the Lead's.
    assert.deepEqual(
      parseUnifiedDiff(review.patch).map((file) => file.newFile.fileName),
      ['fix.txt', 'lead.txt', 'worker.txt']
    );
    assert.deepEqual(
      review.agents.map((agent) => [agent.tag, parseUnifiedDiff(agent.patch).map((file) => file.newFile.fileName)]),
      [['split', ['worker.txt']]]
    );

    await beginTurnSnapshot(root, lead, { checkpointId: 'prompt-2' });
    assert.deepEqual((await getTurnReviewDiff(root, lead)).agents, []);
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('a worker running its own session turn still reports its edits to the Lead turn', async () => {
  const root = makeTempDirSync('turn-own-worker');
  const lead = 'own-turn-lead';
  try {
    await beginTurnSnapshot(root, lead, { checkpointId: 'prompt-1' });
    const worker = beginAgentTurnReview(lead, 'own-turn-worker', { tag: 'impl' });
    // The worker's session turn opens its own tracker, replacing the bound one.
    await beginTurnSnapshot(root, 'own-turn-worker', { checkpointId: 'worker-prompt' });
    recordTurnDiffChanges('own-turn-worker', [
      { path: join(root, 'worker.txt'), displayPath: 'worker.txt', before: 'a\n', after: 'b\n' },
    ]);
    completeAgentTurnReview(worker);
    const review = await getTurnReviewDiff(root, lead);
    assert.deepEqual(
      review.agents.map((agent) => [agent.tag, parseUnifiedDiff(agent.patch).map((file) => file.newFile.fileName)]),
      [['impl', ['worker.txt']]]
    );
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});

// Exact per-call patches: each card shows the change ITS call made, from that
// call's own before and after, never the turn's running total.
const added = (name, lines) =>
  `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join('')}`;
const changed = (name, from, to) =>
  `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,1 @@\n-${from}\n+${to}\n`;
const deleted = (name, lines) =>
  `diff --git a/${name} b/${name}\ndeleted file mode 100644\n--- a/${name}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}\n`).join('')}`;

async function callRunner(root, sessionId) {
  let sequence = 0;
  return async (tool, args) => {
    const toolCallId = `${sessionId}-${++sequence}`;
    const execute = tool === 'apply_patch' ? executePatchTool : executeBuiltinTool;
    const result = await execute(tool, args, root, { sessionId, toolCallId });
    assert.doesNotMatch(String(result), /^Error[\s:]/);
    return takeApplyPatchUiDiff(toolCallId);
  };
}

test('successive edits of one file each show their own step, in both edit dialects', async () => {
  const root = makeTempDirSync('call-diff');
  try {
    const edit = await callRunner(root, 'call-diff-edit');
    assert.equal(
      await edit('edit', { file_path: 'e.txt', old_string: '', new_string: 'old\n' }),
      added('e.txt', ['old'])
    );
    assert.equal(
      await edit('edit', { file_path: 'e.txt', old_string: 'old', new_string: 'middle' }),
      changed('e.txt', 'old', 'middle')
    );
    assert.equal(
      await edit('edit', { file_path: 'e.txt', old_string: 'middle', new_string: 'new' }),
      changed('e.txt', 'middle', 'new')
    );

    const patch = await callRunner(root, 'call-diff-patch');
    const update = (from, to) => ({
      patch: `*** Begin Patch\n*** Update File: p.txt\n@@\n-${from}\n+${to}\n*** End Patch\n`,
    });
    assert.equal(
      await patch('apply_patch', { patch: '*** Begin Patch\n*** Add File: p.txt\n+old\n*** End Patch\n' }),
      added('p.txt', ['old'])
    );
    assert.equal(await patch('apply_patch', update('old', 'middle')), changed('p.txt', 'old', 'middle'));
    assert.equal(await patch('apply_patch', update('middle', 'new')), changed('p.txt', 'middle', 'new'));
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('create then delete, rename then edit, several files, and a/ b/ named paths', async () => {
  const root = makeTempDirSync('call-diff');
  try {
    const run = await callRunner(root, 'call-diff-shapes');
    assert.equal(
      await run('apply_patch', { patch: '*** Begin Patch\n*** Add File: gone.txt\n+bye\n*** End Patch\n' }),
      added('gone.txt', ['bye'])
    );
    assert.equal(
      await run('apply_patch', { patch: '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch\n' }),
      deleted('gone.txt', ['bye'])
    );

    await run('apply_patch', { patch: '*** Begin Patch\n*** Add File: from.txt\n+one\n*** End Patch\n' });
    assert.equal(
      await run('apply_patch', {
        patch: '*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n@@\n-one\n+two\n*** End Patch\n',
      }),
      'diff --git a/from.txt b/to.txt\nrename from from.txt\nrename to to.txt\n--- a/from.txt\n+++ b/to.txt\n@@ -1,1 +1,1 @@\n-one\n+two\n'
    );
    assert.equal(
      await run('edit', { file_path: 'to.txt', old_string: 'two', new_string: 'three' }),
      changed('to.txt', 'two', 'three')
    );

    assert.equal(
      await run('apply_patch', {
        patch: '*** Begin Patch\n*** Add File: m1.txt\n+1\n*** Add File: m2.txt\n+2\n*** End Patch\n',
      }),
      added('m1.txt', ['1']) + added('m2.txt', ['2'])
    );

    // A directory literally named "a" keeps its name in the header.
    assert.equal(
      await run('edit', { file_path: 'a/file.txt', old_string: '', new_string: 'x\n' }),
      added('a/file.txt', ['x'])
    );
    assert.equal(
      await run('edit', { file_path: 'b/file.txt', old_string: '', new_string: 'y\n' }),
      added('b/file.txt', ['y'])
    );
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty file created or deleted is still a change', async () => {
  const { callUiDiff } = await import('../agent/orchestrator/tools/patch/ui-diff.mjs');
  assert.equal(
    callUiDiff([{ displayPath: 'empty.txt', before: null, after: '' }]),
    'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n'
  );
  assert.equal(
    callUiDiff([{ displayPath: 'empty.txt', before: Buffer.from(''), after: null }]),
    'diff --git a/empty.txt b/empty.txt\ndeleted file mode 100644\n'
  );
  // Same bytes, same place: nothing to show.
  assert.equal(callUiDiff([{ displayPath: 'same.txt', before: 'x\n', after: 'x\n' }]), '');
});

test('a large earlier change in the turn never rides on a later call', async () => {
  const root = makeTempDirSync('call-diff');
  try {
    for (const tool of ['apply_patch', 'edit']) {
      const run = await callRunner(root, `call-diff-large-${tool}`);
      const large = `${tool}-a.txt`;
      const file = `${tool}-z.txt`;
      await run(
        tool,
        tool === 'edit'
          ? { file_path: large, old_string: '', new_string: `${'x'.repeat(70000)}\n` }
          : { patch: `*** Begin Patch\n*** Add File: ${large}\n+${'x'.repeat(70000)}\n*** End Patch\n` }
      );
      const patch = await run(
        tool,
        tool === 'edit'
          ? { file_path: file, old_string: '', new_string: 'old\n' }
          : { patch: `*** Begin Patch\n*** Add File: ${file}\n+old\n*** End Patch\n` }
      );
      assert.equal(patch, added(file, ['old']));
    }
  } finally {
    _resetTurnSnapshotForTest();
    await rm(root, { recursive: true, force: true });
  }
});
