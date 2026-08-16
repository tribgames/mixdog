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
import { recordReadSnapshot } from './read-snapshot-runtime.mjs';
import { closeNativePatchServerForTests } from '../patch/native-server.mjs';

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