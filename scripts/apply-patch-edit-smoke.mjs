#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  process.stdout.write('apply_patch edit smoke passed\n');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
