#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';

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
  }, tmp, {});
  assertOk('apply_patch edit', editResult);

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
  }, tmp, {});
  assertOk('apply_patch delete', deleteResult);

  let deleteMissing = false;
  try {
    readFileSync(join(tmp, 'created.txt'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') deleteMissing = true;
    else throw err;
  }
  assert(deleteMissing, 'apply_patch delete left created.txt on disk');

  writeFileSync(join(tmp, 'rollback-blocker.txt'), 'present\n', 'utf8');
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
  assert(/rolled back to their pre-patch state/i.test(String(rollbackResult)), `rollback result did not report atomic recovery:\n${rollbackResult}`);
  assert(
    readFileSync(join(tmp, 'target.txt'), 'utf8') === 'alpha\nbravo\ngamma\n',
    'apply_patch failure left an earlier update committed',
  );
  assert(!existsSync(join(tmp, 'rollback-created.txt')), 'apply_patch failure left an earlier added file committed');
  assert(
    readFileSync(join(tmp, 'rollback-blocker.txt'), 'utf8') === 'present\n',
    'apply_patch failure changed the failing target',
  );

  process.stdout.write('apply_patch edit smoke passed\n');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
