// Windows-first edit fidelity: the file's line endings and its encoding decide
// how old_string/new_string are matched and written back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryExecuteExternalToolAdapter } from './external-tool-adapters.mjs';
import { closeNativePatchServerForTests } from '../patch/native-server.mjs';
import { sliceReadBodyByLines } from './read-batch.mjs';

function makeDir() {
    return mkdtempSync(join(tmpdir(), 'mixdog-edit-enc-'));
}

test('a multiline LF old_string matches a CRLF file and keeps CRLF', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'crlf.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    writeFileSync(file, 'one\r\ntwo\r\nthree\r\n');

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'one\ntwo',
        new_string: 'one\nTWO',
    }, dir, {});

    assert.match(String(result), /^Updated /);
    assert.equal(readFileSync(file, 'utf8'), 'one\r\nTWO\r\nthree\r\n');
});

test('a replacement never injects LF endings into a CRLF file', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'crlf-insert.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    writeFileSync(file, 'one\r\ntwo\r\n');

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'two',
        new_string: 'two\nthree',
    }, dir, {});

    assert.match(String(result), /^Updated /);
    assert.equal(readFileSync(file, 'utf8'), 'one\r\ntwo\r\nthree\r\n');
});

test('a UTF-16LE file is edited in place instead of transcoded', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'utf16.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    writeFileSync(file, Buffer.concat([
        Buffer.from([0xFF, 0xFE]),
        Buffer.from('alpha\r\nkeep\r\n', 'utf16le'),
    ]));

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'alpha',
        new_string: 'omega',
    }, dir, {});

    assert.match(String(result), /^Updated /);
    const raw = readFileSync(file);
    assert.deepEqual([raw[0], raw[1]], [0xFF, 0xFE]);
    assert.equal(raw.subarray(2).toString('utf16le'), 'omega\r\nkeep\r\n');
});

test('a file that is neither UTF-8 nor UTF-16 is refused, not rewritten', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'latin1.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const bytes = Buffer.from([0x61, 0xE9, 0x62, 0x0A]); // latin-1 "aéb\n"
    writeFileSync(file, bytes);

    const result = String(await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'a',
        new_string: 'z',
    }, dir, {}));

    assert.match(result, /not decidable text/);
    assert.deepEqual([...readFileSync(file)], [...bytes]);
});

test('a UTF-16BE file keeps its byte order and BOM', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'utf16be.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    writeFileSync(file, Buffer.concat([
        Buffer.from([0xFE, 0xFF]),
        Buffer.from('alpha\r\nkeep\r\n', 'utf16le').swap16(),
    ]));

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'alpha',
        new_string: 'omega',
    }, dir, {});

    assert.match(String(result), /^Updated /);
    const raw = readFileSync(file);
    assert.deepEqual([raw[0], raw[1]], [0xFE, 0xFF]);
    assert.equal(Buffer.from(raw.subarray(2)).swap16().toString('utf16le'), 'omega\r\nkeep\r\n');
});

test('a UTF-8 BOM survives and a BOM-less file never gains one', async (t) => {
    const dir = makeDir();
    const withBom = join(dir, 'bom.txt');
    const noBom = join(dir, 'nobom.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    writeFileSync(withBom, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('alpha\nkeep\n')]));
    writeFileSync(noBom, 'alpha\nkeep\n');

    for (const file of [withBom, noBom]) {
        const result = await tryExecuteExternalToolAdapter('edit', {
            file_path: file,
            old_string: 'alpha',
            new_string: 'omega',
        }, dir, {});
        assert.match(String(result), /^Updated /);
    }

    assert.deepEqual([...readFileSync(withBom)], [
        0xEF, 0xBB, 0xBF, ...Buffer.from('omega\nkeep\n'),
    ]);
    assert.deepEqual([...readFileSync(noBom)], [...Buffer.from('omega\nkeep\n')]);
});

test('a missing final newline is not added back', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'nofinal.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    writeFileSync(file, 'alpha\nkeep');

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'keep',
        new_string: 'kept',
    }, dir, {});

    assert.match(String(result), /^Updated /);
    assert.equal(readFileSync(file, 'utf8'), 'alpha\nkept');
});

test('malformed UTF-16 (odd trailing byte) is refused, not silently truncated', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'odd-utf16.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const bytes = Buffer.concat([
        Buffer.from([0xFF, 0xFE]),
        Buffer.from('alpha', 'utf16le'),
        Buffer.from([0x41]), // dangling byte: undecodable, unrepresentable
    ]);
    writeFileSync(file, bytes);

    const result = String(await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'alpha',
        new_string: 'omega',
    }, dir, {}));

    assert.match(result, /malformed UTF-16 with an odd trailing byte/);
    assert.deepEqual([...readFileSync(file)], [...bytes]);
});

test('a mixed-EOL file keeps every terminator the edit did not replace', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'mixed.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const before = 'one\r\ntwo\nthree\r\nfour\n';
    writeFileSync(file, before);

    const result = await tryExecuteExternalToolAdapter('edit', {
        file_path: file,
        old_string: 'three',
        new_string: 'THREE',
    }, dir, {});

    assert.match(String(result), /^Updated /);
    const after = readFileSync(file, 'utf8');
    assert.equal(after, 'one\r\ntwo\nthree\r\nfour\n'.replace('three', 'THREE'));
    // Byte-level: everything outside the replaced span is untouched.
    const at = before.indexOf('three');
    assert.equal(after.slice(0, at), before.slice(0, at));
    assert.equal(after.slice(at + 'THREE'.length), before.slice(at + 'three'.length));
});

test('an inserted line adopts the convention of the line it replaces, not the file', async (t) => {
    const dir = makeDir();
    const crlfLine = join(dir, 'mixed-crlf-line.txt');
    const lfFile = join(dir, 'lf.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    // LF-dominant file, but the replaced line itself ends with CRLF.
    writeFileSync(crlfLine, 'a\nb\r\nc\nd\n');
    writeFileSync(lfFile, 'a\nb\n');

    assert.match(String(await tryExecuteExternalToolAdapter('edit', {
        file_path: crlfLine,
        old_string: 'b',
        new_string: 'b\nb2',
    }, dir, {})), /^Updated /);
    assert.equal(readFileSync(crlfLine, 'utf8'), 'a\nb\r\nb2\r\nc\nd\n');

    // CRLF replacement text in an LF file normalizes to the local LF.
    assert.match(String(await tryExecuteExternalToolAdapter('edit', {
        file_path: lfFile,
        old_string: 'b',
        new_string: 'b\r\nb2',
    }, dir, {})), /^Updated /);
    assert.equal(readFileSync(lfFile, 'utf8'), 'a\nb\nb2\n');
});

test('a coalesced slice past the returned window never fabricates a footer', () => {
    const body = ['1→a', '2→b', '3→c', '[lines 1-3 of 100; output truncated at 64 KB]'].join('\n');

    const past = sliceReadBodyByLines(body, 10, 5);
    assert.doesNotMatch(past, /\[lines \d+-\d+ of/);
    assert.match(past, /NOT returned/);

    const inside = sliceReadBodyByLines(body, 1, 5);
    assert.match(inside, /^\[lines 2-3 of 100/m);
    assert.match(inside, /2→b/);
});
