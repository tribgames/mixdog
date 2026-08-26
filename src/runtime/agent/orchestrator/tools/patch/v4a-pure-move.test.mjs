// `*** Update File: X` + `*** Move to: Y` with no hunks is a pure move — the
// V4A spelling of `git mv` — and its outcome is fully specified by the two
// paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executePatchTool } from '../patch.mjs';
import { closeNativePatchServerForTests } from './native-server.mjs';

function makeDir() {
    return mkdtempSync(join(tmpdir(), 'mixdog-v4a-move-'));
}

test('a hunkless rename moves the file byte-identically', async (t) => {
    const dir = makeDir();
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const before = 'CPU_ONLY := 1\r\nBLAS := atlas\n';
    writeFileSync(join(dir, 'Makefile.config'), before);
    mkdirSync(join(dir, 'caffe'), { recursive: true });

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: Makefile.config
*** Move to: caffe/Makefile.config
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /no update hunks/);
    assert.doesNotMatch(result, /^Error/);
    assert.equal(existsSync(join(dir, 'Makefile.config')), false);
    assert.equal(readFileSync(join(dir, 'caffe', 'Makefile.config'), 'utf8'), before);
});

test('a move onto an existing file is still refused', async (t) => {
    const dir = makeDir();
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    writeFileSync(join(dir, 'a.txt'), 'source\n');
    writeFileSync(join(dir, 'b.txt'), 'occupied\n');

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
*** End Patch
`,
    }, dir, {}));

    assert.match(result, /destination already exists/);
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'source\n');
    assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'occupied\n');
});
