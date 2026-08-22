// Same-anchor batch occupation: N edit calls sharing one old_string consume
// document-order occurrences in call order (tool-batch passes the remaining
// count via options.editOccurrence). Count drift must fall through to the
// native engine's strict ambiguity reject.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryExecuteExternalToolAdapter } from './external-tool-adapters.mjs';
import { executeBuiltinTool } from '../builtin.mjs';
import { recordReadSnapshot } from './read-snapshot-runtime.mjs';
import { executePatchTool } from '../patch.mjs';
import { closeNativePatchServerForTests } from '../patch/native-server.mjs';
import { classifyToolFailure } from '../../agent-trace-format.mjs';

const ANCHOR = '#if 0\n"""\n#endif';

function makeTempFile(content) {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-edit-seq-'));
    const file = join(dir, 'poly.c');
    writeFileSync(file, content, 'utf8');
    return { dir, file };
}

test('occupation consumes the first occurrence, then the sibling resolves as unique', async (t) => {
    const { dir, file } = makeTempFile(`${ANCHOR}\nmiddle\n${ANCHOR}\n`);
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });

    const first = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: ANCHOR,
        new_string: '#if 0\n""" "\n#endif',
    }, dir, { editOccurrence: { expected: 2 } });
    assert.match(String(first), /^Updated /);

    const second = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: ANCHOR,
        new_string: '#if 0\n" """\n#endif',
    }, dir, {});
    assert.match(String(second), /^Updated /);

    assert.equal(
        readFileSync(file, 'utf8'),
        '#if 0\n""" "\n#endif\nmiddle\n#if 0\n" """\n#endif\n',
    );
});

test('count drift falls through to the strict ambiguity reject', async (t) => {
    const { dir, file } = makeTempFile(`${ANCHOR}\n${ANCHOR}\n${ANCHOR}\n`);
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: ANCHOR,
        new_string: 'changed',
    }, dir, { editOccurrence: { expected: 2 } });
    assert.match(String(result), /old_string found 3 times/);
    assert.match(String(result), /current file excerpt lines/);
});

test('an edit on a body the session already read makes a follow-up read return unchanged', async (t) => {
    const { dir, file } = makeTempFile('alpha\nkeep\n');
    const sessionId = `edit-known-current-${process.pid}`;
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });

    // The "unchanged" stub is sound only because the model already holds the
    // pre-edit body: deliver it first.
    const firstRead = await executeBuiltinTool('read', { path: file }, dir, { sessionId });
    assert.match(String(firstRead), /alpha/);

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'alpha',
        new_string: 'omega',
    }, dir, { sessionId });
    assert.match(String(result), /^Updated /);

    const reread = await executeBuiltinTool('read', { path: file }, dir, { sessionId });
    assert.equal(reread, `[file unchanged: ${file.replaceAll('\\', '/')}]`);
});

test('an edit on a never-read file still delivers the body on the next read', async (t) => {
    const { dir, file } = makeTempFile('alpha\nkeep\n');
    const sessionId = `edit-unseen-body-${process.pid}`;
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'alpha',
        new_string: 'omega',
    }, dir, { sessionId });
    assert.match(String(result), /^Updated /);

    const reread = String(await executeBuiltinTool('read', { path: file }, dir, { sessionId }));
    assert.doesNotMatch(reread, /file unchanged/);
    assert.match(reread, /omega/);
});

test('an apply_patch on a body the session already read makes a follow-up read return unchanged', async (t) => {
    const { dir, file } = makeTempFile('alpha\nkeep\n');
    const sessionId = `patch-known-current-${process.pid}`;
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });

    const firstRead = await executeBuiltinTool('read', { path: file }, dir, { sessionId });
    assert.match(String(firstRead), /alpha/);

    const result = await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: poly.c
@@
-alpha
+omega
 keep
*** End Patch
`,
    }, dir, { sessionId });
    // Executor (Native vs JS) depends on the engine-contract gate; the
    // snapshot contract is what this test pins.
    assert.match(String(result), /^Applied 1 File/);

    const reread = await executeBuiltinTool('read', { path: file }, dir, { sessionId });
    assert.equal(reread, `[file unchanged: ${file.replaceAll('\\', '/')}]`);
});

test('an external write between read and edit is never hidden by "file unchanged"', async (t) => {
    const { dir, file } = makeTempFile('alpha\nkeep\n');
    const sessionId = `edit-stale-prior-${process.pid}`;
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });

    const firstRead = await executeBuiltinTool('read', { path: file }, dir, { sessionId });
    assert.match(String(firstRead), /alpha/);

    // Someone else changes the file AFTER the session read it.
    writeFileSync(file, 'alpha\nEXTERNAL\nkeep\n', 'utf8');

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'alpha',
        new_string: 'omega',
    }, dir, { sessionId });
    assert.match(String(result), /^Updated /);

    const reread = String(await executeBuiltinTool('read', { path: file }, dir, { sessionId }));
    assert.doesNotMatch(reread, /file unchanged/);
    assert.match(reread, /EXTERNAL/);
});

test('stale read snapshot does not block a still-unique current old_string', async (t) => {
    const { dir, file } = makeTempFile('alpha\nkeep\n');
    const sessionId = `edit-stale-safe-${process.pid}`;
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    recordReadSnapshot(file, statSync(file), sessionId, {
        source: 'read',
        isPartialView: false,
        replaceExisting: true,
    });
    writeFileSync(file, 'external\nalpha\nkeep\n', 'utf8');

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'alpha',
        new_string: 'omega',
    }, dir, { sessionId });

    assert.match(String(result), /^Updated /);
    assert.equal(readFileSync(file, 'utf8'), 'external\nomega\nkeep\n');
});

test('edit failure excerpt centres on a distinctive token from any old_string line', async (t) => {
    const { dir, file } = makeTempFile('const alpha = 1;\nconst beta = 2;\nconst DISTINCTIVE_TOKEN = 3;\ntail\n');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });

    // The first old_string line carries no usable keyword. Scanning only that
    // line returned no excerpt at all, and a bare "not found" was the edit
    // failure that reliably produced identical retries.
    const result = String(await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: '}\nconst DISTINCTIVE_TOKEN = 3;\nmissing_tail();',
        new_string: 'irrelevant',
    }, dir, {}));
    assert.match(result, /old_string not found/);
    assert.match(result, /current file excerpt lines/);
    assert.match(result, /DISTINCTIVE_TOKEN/);
});

test('edit failure states plainly when nothing in the file resembles old_string', async (t) => {
    const { dir, file } = makeTempFile('\n\n\n');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });

    const result = String(await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'zzz',
        new_string: 'yyy',
    }, dir, {}));
    assert.match(result, /contains nothing resembling old_string/);
});

test('a swallowed V4A envelope marker reports patch structure, not a context miss', async (t) => {
    const { dir } = makeTempFile('alpha\nkeep\ntail\n');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: poly.c
@@
 alpha
 keep
 tail
 *** End Patch ***
-gone
+kept
*** End Patch
`,
    }, dir, {}));
    assert.match(result, /structure error \(malformed patch envelope\)/);
    assert.match(result, /appears as a content line at old\[4\]/);
    assert.doesNotMatch(result, /context not found/);
    // A patch-text defect must not be filed as stale edit evidence.
    assert.equal(classifyToolFailure(result, 'apply_patch'), 'patch/parse');
});