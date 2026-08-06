#!/usr/bin/env node
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePatchTool, takeApplyPatchUiDiff } from '../src/runtime/agent/orchestrator/tools/patch.mjs';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { beginTurnSnapshot, getTurnReviewDiff } from '../src/runtime/shared/turn-snapshot.mjs';
import { getNativePatchServer } from '../src/runtime/agent/orchestrator/tools/patch/native-server.mjs';

// Keep the smoke's intentional failure cases out of the real diagnostic sinks
// (tool-failure log + patch-replay captures). Both env vars are read lazily.
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(tmpdir(), `mixdog-apply-patch-smoke-failures-${process.pid}.jsonl`);
process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '0';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertOk(label, result) {
  const text = String(result || '');
  if (!text || /^Error[\s:]/.test(text)) {
    throw new Error(`${label} failed:\n${text}`);
  }
  return text;
}

const tmp = mkdtempSync(join(tmpdir(), 'mixdog-apply-patch-smoke-'));

try {
  writeFileSync(join(tmp, 'target.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
  const reviewSession = `apply-patch-review-${process.pid}`;
  await beginTurnSnapshot(tmp, reviewSession);

  const editResult = await executePatchTool('apply_patch', {
    base_path: tmp,
    patch: `*** Begin Patch
*** Update File: target.txt
@@
 alpha
-beta
+bravo
 gamma
*** Add File: created.txt
+created by apply_patch smoke
+second line
*** End Patch
`,
  }, tmp, { sessionId: reviewSession, toolCallId: 'review-edit' });
  assertOk('apply_patch edit', editResult);
  const editUiDiff = takeApplyPatchUiDiff('review-edit');
  assert(/target\.txt/.test(String(editUiDiff)) && /created\.txt/.test(String(editUiDiff)),
    `apply_patch did not publish the committed turn diff:\n${editUiDiff}`);

  assert(
    readFileSync(join(tmp, 'target.txt'), 'utf8') === 'alpha\nbravo\ngamma\n',
    'apply_patch update did not write the expected target.txt contents',
  );
  assert(
    readFileSync(join(tmp, 'created.txt'), 'utf8') === 'created by apply_patch smoke\nsecond line\n',
    'apply_patch add did not write the expected created.txt contents',
  );

  const deleteResult = await executePatchTool('apply_patch', {
    base_path: tmp,
    patch: `*** Begin Patch
*** Delete File: created.txt
*** End Patch
`,
  }, tmp, { sessionId: reviewSession, toolCallId: 'review-delete' });
  assertOk('apply_patch delete', deleteResult);
  const deleteUiDiff = takeApplyPatchUiDiff('review-delete');
  assert(/target\.txt/.test(String(deleteUiDiff)) && !/created\.txt/.test(String(deleteUiDiff)),
    `add-then-delete did not cancel from the turn diff:\n${deleteUiDiff}`);

  let deleteMissing = false;
  try {
    readFileSync(join(tmp, 'created.txt'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') deleteMissing = true;
    else throw err;
  }
  assert(deleteMissing, 'apply_patch delete left created.txt on disk');
  const review = await getTurnReviewDiff(tmp, reviewSession);
  assert(review.authoritative === true && /-beta/.test(review.patch) && /\+bravo/.test(review.patch),
    `turn review did not retain the first-before/latest-after diff:\n${review.patch}`);

  writeFileSync(join(tmp, 'rollback-blocker.txt'), 'present\n', 'utf8');
  const targetMtimeBeforeRejectedPatch = statSync(join(tmp, 'target.txt')).mtimeMs;
  const rollbackResult = await executePatchTool('apply_patch', {
    base_path: tmp,
    patch: `*** Begin Patch
*** Update File: target.txt
@@
 alpha
-bravo
+temporary
 gamma
*** Add File: rollback-created.txt
+must not survive
*** Update File: rollback-blocker.txt
@@
-missing
+replacement
*** End Patch
`,
  }, tmp, {});
  assert(/^Error[\s:]/.test(String(rollbackResult)), `rollback precondition patch unexpectedly passed:\n${rollbackResult}`);
  assert(/preflight rejected section 3\/3/i.test(String(rollbackResult))
    && /no files were written/i.test(String(rollbackResult)),
  `rollback result did not report no-write preflight rejection:\n${rollbackResult}`);
  assert(
    readFileSync(join(tmp, 'target.txt'), 'utf8') === 'alpha\nbravo\ngamma\n',
    'apply_patch failure left an earlier update committed',
  );
  assert(!existsSync(join(tmp, 'rollback-created.txt')), 'apply_patch failure left an earlier added file committed');
  assert(
    readFileSync(join(tmp, 'rollback-blocker.txt'), 'utf8') === 'present\n',
    'apply_patch failure changed the failing target',
  );
  assert(
    statSync(join(tmp, 'target.txt')).mtimeMs === targetMtimeBeforeRejectedPatch,
    'apply_patch stale preflight wrote and rolled back an earlier valid target',
  );

  const canonicalDir = join(tmp, 'actual', 'nested');
  mkdirSync(canonicalDir, { recursive: true });
  const canonicalTarget = join(canonicalDir, 'redirected.txt');
  writeFileSync(canonicalTarget, 'before redirect\n', 'utf8');
  const redirectSession = `apply-patch-redirect-${process.pid}`;
  const redirectedRead = await executeBuiltinTool('read', {
    path: 'wrong/nested/redirected.txt',
  }, tmp, { sessionId: redirectSession });
  assert(/^\[redirected from /i.test(String(redirectedRead)), `read did not establish a canonical redirect:\n${redirectedRead}`);
  const redirectedPatch = await executePatchTool('apply_patch', {
    base_path: tmp,
    patch: `*** Begin Patch
*** Update File: wrong/nested/redirected.txt
@@
-before redirect
+after redirect
*** End Patch
`,
  }, tmp, { sessionId: redirectSession });
  assertOk('apply_patch same-session canonical redirect', redirectedPatch);
  assert(readFileSync(canonicalTarget, 'utf8') === 'after redirect\n',
    'apply_patch did not reuse the read-confirmed canonical path');
  assert(!existsSync(join(tmp, 'wrong', 'nested', 'redirected.txt')),
    'apply_patch created or modified the original missing guessed path');

  // A native server that died between requests (idle watchdog, panic, external
  // kill) must never take THIS process down: an unhandled EPIPE on the child's
  // stdin crashed the release validate job. The dead instance has to reject,
  // and the next request has to respawn and succeed.
  const revivedPath = join(tmp, 'revived.txt');
  writeFileSync(revivedPath, 'before respawn\n', 'utf8');
  const doomed = getNativePatchServer();
  if (!doomed.exited) {
    // Subscribe BEFORE the kill, and cap the wait: a child that already died
    // never re-emits 'exit', and this smoke must not hang on it.
    // ref() the handles and keep the timer referenced, or the loop drains and
    // the await never settles (the server runs unref'd between requests).
    doomed.ref();
    const exited = once(doomed.child, 'exit');
    doomed.child.kill('SIGKILL');
    let capTimer = null;
    await Promise.race([exited, new Promise((resolve) => { capTimer = setTimeout(resolve, 2000); })]);
    if (capTimer) clearTimeout(capTimer);
  }
  let deadError = null;
  try {
    await doomed.apply(tmp, '*** Begin Patch\n*** End Patch\n', {});
  } catch (err) {
    deadError = err;
  }
  assert(deadError, 'a dead native patch server must reject instead of crashing the host');
  const revived = await executePatchTool('apply_patch', {
    base_path: tmp,
    patch: `*** Begin Patch
*** Update File: revived.txt
@@
-before respawn
+after respawn
*** End Patch
`,
  }, tmp);
  assertOk('apply_patch after the native server died', revived);
  assert(readFileSync(revivedPath, 'utf8') === 'after respawn\n',
    'apply_patch did not respawn the native server after its death');

  process.stdout.write('apply_patch edit smoke passed\n');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
