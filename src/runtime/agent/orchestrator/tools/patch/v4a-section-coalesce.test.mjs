// A whole-file rewrite written as "Delete File + Add File" for ONE path has a
// single possible outcome, so it applies instead of being rejected as a
// conflicting target. Genuinely ambiguous pairs keep rejecting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executePatchTool } from '../patch.mjs';
import { closeNativePatchServerForTests } from './native-server.mjs';

function makeDir() {
    return mkdtempSync(join(tmpdir(), 'mixdog-v4a-coalesce-'));
}

test('Delete + Add on one existing path rewrites the file', async (t) => {
    const dir = makeDir();
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const file = join(dir, 'algo.py');
    writeFileSync(file, 'def map(grid):\n    return grid\n');

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Delete File: algo.py
*** Add File: algo.py
+def map(grid):
+    return [row[::-1] for row in grid]
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /conflicting operations target/);
    assert.doesNotMatch(result, /^Error/);
    assert.equal(
        readFileSync(file, 'utf8'),
        'def map(grid):\n    return [row[::-1] for row in grid]\n',
    );
});

test('Delete + Add for a path that does not exist still creates the file', async (t) => {
    const dir = makeDir();
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const file = join(dir, 'fresh.txt');

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Delete File: fresh.txt
*** Add File: fresh.txt
+created
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /^Error/);
    assert.equal(readFileSync(file, 'utf8'), 'created\n');
});

test('Update + Delete on one path is still refused without touching the file', async (t) => {
    const dir = makeDir();
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const file = join(dir, 'target.txt');
    writeFileSync(file, 'aleph\nbravo\ndelta\n');

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: target.txt
@@
-bravo
+temporary
*** Delete File: target.txt
*** End Patch
`,
    }, dir, {}));

    assert.match(result, /conflicting operations target/);
    assert.equal(readFileSync(file, 'utf8'), 'aleph\nbravo\ndelta\n');
});
