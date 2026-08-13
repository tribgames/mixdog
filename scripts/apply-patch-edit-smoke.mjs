#!/usr/bin/env node
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  writeFileSync(join(tmp, 'partial-blocker.txt'), 'present\n', 'utf8');
  const partialResult = await executePatchTool('apply_patch', {
    base_path: tmp,
    patch: `*** Begin Patch
*** Update File: target.txt
@@
 alpha
-bravo
+temporary
 gamma
*** Add File: rollback-created.txt
+must survive
*** Update File: partial-blocker.txt
@@
-missing
+replacement
*** End Patch
`,
  }, tmp, {});
  assert(/^Error[\s:]/.test(String(partialResult)), `partial-apply precondition patch unexpectedly passed:\n${partialResult}`);
  assert(/stopped at section 3\/3/i.test(String(partialResult))
    && /committed/i.test(String(partialResult))
    && /Retry only the failed and skipped sections/i.test(String(partialResult)),
  `partial-apply result did not report the committed prefix and economical retry scope:\n${partialResult}`);
  assert(
    readFileSync(join(tmp, 'target.txt'), 'utf8') === 'alpha\ntemporary\ngamma\n',
    'apply_patch failure did not preserve the earlier committed update',
  );
  assert(
    readFileSync(join(tmp, 'rollback-created.txt'), 'utf8') === 'must survive\n',
    'apply_patch failure did not preserve the earlier committed add',
  );
  assert(
    readFileSync(join(tmp, 'partial-blocker.txt'), 'utf8') === 'present\n',
    'apply_patch failure changed the failing target',
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

  const uniqueTargetDir = join(tmp, 'actual', 'unique');
  mkdirSync(uniqueTargetDir, { recursive: true });
  const uniqueTarget = join(uniqueTargetDir, 'unique-target.txt');
  writeFileSync(uniqueTarget, 'before unique redirect\n', 'utf8');
  const uniqueRedirectPatch = await executePatchTool('apply_patch', {
    base_path: tmp,
    patch: `*** Begin Patch
*** Update File: guessed/unique-target.txt
@@
-before unique redirect
+after unique redirect
*** End Patch
`,
  }, tmp, {});
  assertOk('apply_patch unique missing-path redirect', uniqueRedirectPatch);
  assert(readFileSync(uniqueTarget, 'utf8') === 'after unique redirect\n',
    'apply_patch did not relocate a missing target with one unique basename');
  assert(!existsSync(join(tmp, 'guessed', 'unique-target.txt')),
    'apply_patch wrote the original missing guessed path');

  const overwriteTarget = join(tmp, 'add-overwrite.txt');
  writeFileSync(overwriteTarget, 'old add content\n', 'utf8');
  const overwriteAdd = await executePatchTool('apply_patch', {
    base_path: tmp,
    patch: `*** Begin Patch
*** Add File: add-overwrite.txt
+new add content
*** End Patch
`,
  }, tmp, {});
  assertOk('apply_patch Add File overwrite', overwriteAdd);
  assert(readFileSync(overwriteTarget, 'utf8') === 'new add content\n',
    'Add File did not atomically replace an existing regular file');

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

  const corpusPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'patch-replay-corpus.json');
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  for (const rec of corpus) {
    const caseDir = mkdtempSync(join(tmpdir(), `mixdog-patch-corpus-${rec.id}-`));
    try {
      for (const [rel, content] of Object.entries(rec.file_snapshots || {})) {
        if (content == null) continue;
        const abs = join(caseDir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      const result = await executePatchTool('apply_patch', { ...(rec.args || {}), base_path: caseDir }, caseDir, {});
      const failed = /^Error[\s:]/.test(String(result || '').trimStart());
      if (rec.expect === 'applied') {
        assert(!failed, `corpus ${rec.id} should apply:\n${result}`);
        for (const [rel, want] of Object.entries(rec.expect_content || {})) {
          assert(readFileSync(join(caseDir, rel), 'utf8') === want, `corpus ${rec.id} content mismatch ${rel}`);
        }
      } else {
        assert(failed, `corpus ${rec.id} should reject:\n${result}`);
        if (rec.expect_error) {
          assert(new RegExp(rec.expect_error, 'i').test(String(result)),
            `corpus ${rec.id} error mismatch:\n${result}`);
        }
      }
    } finally {
      rmSync(caseDir, { recursive: true, force: true });
    }
  }

  process.stdout.write('apply_patch edit smoke passed\n');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
