import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { parsePatch } from 'diff';
import { withBuiltinPathLocks } from '../builtin/path-locks.mjs';
import { withAdvisoryLocks } from '../builtin/advisory-lock.mjs';
import { applyCodexBatchWithRollback, runCodexBatch } from './apply-patch/codex-batch.mjs';
import { dispatchJsPatchEntries } from './dispatch.mjs';
import { closeNativePatchServerForTests } from './native-server.mjs';
import { classifyEntry } from './paths.mjs';
import { applyParsedWave } from './wave.mjs';

after(closeNativePatchServerForTests);

function fixture(t, kind = 'create') {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-patch-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = join(root, 'target.txt');
  if (kind !== 'create') writeFileSync(target, 'before\n');
  const patches = {
    create: '--- /dev/null\n+++ b/target.txt\n@@ -0,0 +1 @@\n+after\n',
    update: '--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-before\n+after\n',
    delete: '--- a/target.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\n',
  };
  const parsed = parsePatch(patches[kind]);
  return {
    root,
    target,
    wave: {
      parsed,
      entries: [{ kind: classifyEntry(parsed[0]), fullPath: target, displayPath: 'target.txt' }],
      headerRewrites: [],
    },
  };
}

for (const [label, lock] of [
  ['in-process', withBuiltinPathLocks],
  ['advisory', withAdvisoryLocks],
]) {
  test(`cancellation while waiting for the ${label} lock never creates the file`, async (t) => {
    const { root, target, wave } = fixture(t);
    const acquired = Promise.withResolvers();
    const held = Promise.withResolvers();
    const taskA = lock([target], async () => {
      acquired.resolve();
      await held.promise;
    });
    let taskB;
    try {
      await acquired.promise;
      const controller = new AbortController();
      const batch = { lockPaths: [target], waveDispatch: [wave] };
      const abortSignal = controller.signal;
      let settled = false;
      taskB = applyCodexBatchWithRollback({
        batch,
        basePath: root,
        dryRun: false,
        abortSignal,
        options: { signal: abortSignal },
        runBatch: () =>
          runCodexBatch({
            batch,
            basePath: root,
            rejectedV4AHunks: [],
            waveOpts: { abortSignal },
          }),
      });
      taskB.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await nextTurn();
      assert.equal(settled, false);
      assert.equal(existsSync(target), false);
      const reason = new Error('cancelled while waiting for lock');
      controller.abort(reason);
      const rejected = assert.rejects(taskB, (error) => error === reason);
      held.resolve();
      await taskA;
      await rejected;
      assert.equal(existsSync(target), false);
    } finally {
      held.resolve();
      await Promise.allSettled([taskA, taskB]);
    }
  });
}

test('Add File stops when cancelled during wave preparation', async (t) => {
  const { root, target, wave } = fixture(t);
  const controller = new AbortController();
  const pending = applyParsedWave(wave, root, { abortSignal: controller.signal });
  controller.abort(new Error('cancelled during wave preparation'));
  await assert.rejects(pending, /cancelled during wave preparation/);
  assert.equal(existsSync(target), false);
});

for (const kind of ['create', 'update', 'delete']) {
  test(`cancelled JS ${kind} leaves the target unchanged`, async (t) => {
    const { root, target, wave } = fixture(t, kind);
    const controller = new AbortController();
    controller.abort(new Error('cancelled before mutation'));
    const result = await dispatchJsPatchEntries({
      rows: wave.entries,
      parsed: wave.parsed,
      basePath: root,
      signal: controller.signal,
    });
    assert.match(result, /^Error: cancelled before mutation/);
    assert.doesNotMatch(result, /OK /);
    if (kind === 'create') assert.equal(existsSync(target), false);
    else assert.equal(readFileSync(target, 'utf8'), 'before\n');
  });
}

for (const kind of ['create', 'update']) {
  test(`JS ${kind} forwards cancellation to the atomic writer`, async (t) => {
    const { root, target, wave } = fixture(t, kind);
    const controller = new AbortController();
    const pending = dispatchJsPatchEntries({
      rows: wave.entries,
      parsed: wave.parsed,
      basePath: root,
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled before atomic write'));
    const result = await pending;
    assert.match(result, /^Error: cancelled before atomic write/);
    assert.doesNotMatch(result, /OK /);
    if (kind === 'create') assert.equal(existsSync(target), false);
    else assert.equal(readFileSync(target, 'utf8'), 'before\n');
  });
}
