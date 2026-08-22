// apply_patch byte fidelity: a rewrite may only change the lines a hunk
// replaces. Encoding (BOM/codec) and every untouched line terminator survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    cloneTextLinesForPatch,
    decodePatchTargetBuffer,
    encodePatchTargetContent,
    detectPatchTargetCodec,
    joinTextLinesForPatch,
    patchTargetUsesUtf16,
    localTerminatorForWindow,
    setFinalNewlineForPatch,
    spliceTextLinesForPatch,
    splitTextLinesForPatch,
    terminatorsForUnifiedOps,
} from './matcher.mjs';
import { plusWindowCoversMatch } from './v4a-convert.mjs';
import { executePatchTool } from '../patch.mjs';
import { closeNativePatchServerForTests } from './native-server.mjs';

function makeDir() {
    return mkdtempSync(join(tmpdir(), 'mixdog-patch-codec-'));
}

test('a replaced line keeps its own terminator and untouched lines keep theirs', () => {
    const lines = splitTextLinesForPatch('a\r\nb\nc\r\n');
    const next = cloneTextLinesForPatch(lines);
    spliceTextLinesForPatch(next, 1, 1, ['B']);
    assert.equal(joinTextLinesForPatch(next), 'a\r\nB\nc\r\n');
});

test('extra inserted lines adopt the local convention only', () => {
    const lines = splitTextLinesForPatch('a\r\nb\nc\r\n');
    const next = cloneTextLinesForPatch(lines);
    spliceTextLinesForPatch(next, 1, 1, ['B', 'B2']);
    assert.equal(joinTextLinesForPatch(next), 'a\r\nB\nB2\nc\r\n');
});

test('a multi-run hunk keeps every untouched terminator', () => {
    // Two change runs with interior context: op-wise mapping is the only thing
    // that can place `MID`'s CRLF and `T`'s LF correctly.
    const lines = cloneTextLinesForPatch(splitTextLinesForPatch('H\r\nA\nMID\r\nC\nT\n'));
    const ops = ['context', 'delete', 'add', 'context', 'delete', 'add', 'context'];
    const newTerms = terminatorsForUnifiedOps(
        ops,
        lines.terminators.slice(0, 5),
        localTerminatorForWindow(lines, 0, 5),
    );
    spliceTextLinesForPatch(lines, 0, 5, ['H', 'A2', 'MID', 'C2', 'T'], newTerms);
    assert.equal(joinTextLinesForPatch(lines), 'H\r\nA2\nMID\r\nC2\nT\n');
});

test('a moved line does not drag a neighbouring terminator', () => {
    // `-A`, ` MID`, `+A`: MID is untouched and must keep its CRLF.
    const lines = cloneTextLinesForPatch(splitTextLinesForPatch('H\r\nA\nMID\r\nT\n'));
    const ops = ['context', 'delete', 'context', 'add', 'context'];
    const newTerms = terminatorsForUnifiedOps(
        ops,
        lines.terminators.slice(0, 4),
        localTerminatorForWindow(lines, 0, 4),
    );
    spliceTextLinesForPatch(lines, 0, 4, ['H', 'MID', 'A', 'T'], newTerms);
    assert.equal(joinTextLinesForPatch(lines), 'H\r\nMID\r\nA\nT\n');
});

test('a short NUL-containing file is undecidable, never UTF-16', () => {
    // UTF-8 `61 00` was classified UTF-16LE and rewritten as 78000a006100.
    assert.equal(detectPatchTargetCodec(Buffer.from([0x61, 0x00])).certain, false);
    assert.equal(detectPatchTargetCodec(Buffer.from([0x61, 0x00, 0x62, 0x00])).certain, false);
    // A real BOM-less UTF-16 file (enough evidence) is still detected.
    const real = Buffer.from('hello world, this is utf-16 text\n', 'utf16le');
    assert.equal(detectPatchTargetCodec(real).encoding, 'utf16le');
});

test('a parity flip past the old sample window is refused', () => {
    const buf = Buffer.alloc(9000);
    for (let i = 0; i < buf.length; i += 2) { buf[i] = 0x61; buf[i + 1] = 0x00; }
    buf[8200] = 0x00; // even offset → conflicting parity, beyond byte 8192
    assert.equal(detectPatchTargetCodec(buf).certain, false);
});

test('a bounded prefix can never decide a codec', () => {
    const real = Buffer.from('hello world, this is utf-16 text\n', 'utf16le');
    assert.equal(detectPatchTargetCodec(real, { partial: true }).certain, false);
});

test('a backward move across two contexts keeps its own terminator', () => {
    // `+A` precedes its `-A`: the identity pool must span the whole hunk.
    const lines = cloneTextLinesForPatch(splitTextLinesForPatch('C1\nC2\nA\r\n'));
    const ops = [
        { op: 'add', line: 'A' },
        { op: 'context', line: 'C1' },
        { op: 'context', line: 'C2' },
        { op: 'delete', line: 'A' },
    ];
    const newTerms = terminatorsForUnifiedOps(
        ops,
        lines.terminators.slice(0, 3),
        localTerminatorForWindow(lines, 0, 3),
    );
    spliceTextLinesForPatch(lines, 0, 3, ['A', 'C1', 'C2'], newTerms);
    assert.equal(joinTextLinesForPatch(lines), 'A\r\nC1\nC2\n');
});

test('a move across context keeps the moved line own terminator', () => {
    // `-A`, ` MID`, `+A`: context must not clear the identity pool.
    const lines = cloneTextLinesForPatch(splitTextLinesForPatch('A\r\nMID\nT\n'));
    const ops = [
        { op: 'delete', line: 'A' },
        { op: 'context', line: 'MID' },
        { op: 'add', line: 'A' },
        { op: 'context', line: 'T' },
    ];
    const newTerms = terminatorsForUnifiedOps(
        ops,
        lines.terminators.slice(0, 3),
        localTerminatorForWindow(lines, 0, 3),
    );
    spliceTextLinesForPatch(lines, 0, 3, ['MID', 'A', 'T'], newTerms);
    assert.equal(joinTextLinesForPatch(lines), 'MID\nA\r\nT\n');
});

test('duplicate deletes are claimed in order, not first-fit', () => {
    // D/X/D → X/D must take the FINAL D's LF, not the first D's CRLF.
    const lines = cloneTextLinesForPatch(splitTextLinesForPatch('D\r\nX\nD\nT\n'));
    const ops = [
        { op: 'delete', line: 'D' },
        { op: 'delete', line: 'X' },
        { op: 'delete', line: 'D' },
        { op: 'add', line: 'X' },
        { op: 'add', line: 'D' },
        { op: 'context', line: 'T' },
    ];
    const newTerms = terminatorsForUnifiedOps(
        ops,
        lines.terminators.slice(0, 4),
        localTerminatorForWindow(lines, 0, 4),
    );
    spliceTextLinesForPatch(lines, 0, 4, ['X', 'D', 'T'], newTerms);
    assert.equal(joinTextLinesForPatch(lines), 'X\nD\nT\n');
});

test('a shrinking hunk keeps the following untouched line terminator', () => {
    // 2 old lines → 1 new line: positional mapping used to shift `keep` onto a
    // deleted line's CRLF.
    const lines = cloneTextLinesForPatch(splitTextLinesForPatch('ctx\r\nold1\nold2\r\nkeep\n'));
    spliceTextLinesForPatch(lines, 0, 4, ['ctx', 'NEW', 'keep']);
    assert.equal(joinTextLinesForPatch(lines), 'ctx\r\nNEW\nkeep\n');
});

test('a growing hunk gives only the surplus lines the local convention', () => {
    const lines = cloneTextLinesForPatch(splitTextLinesForPatch('ctx\r\nold\nkeep\n'));
    spliceTextLinesForPatch(lines, 0, 3, ['ctx', 'NEW1', 'NEW2', 'keep']);
    assert.equal(joinTextLinesForPatch(lines), 'ctx\r\nNEW1\nNEW2\nkeep\n');
});

test('a file without a final newline does not gain one', () => {
    const lines = splitTextLinesForPatch('a\nb');
    const next = cloneTextLinesForPatch(lines);
    spliceTextLinesForPatch(next, 0, 1, ['A']);
    assert.equal(joinTextLinesForPatch(next), 'A\nb');
});

test('a CR-only file still round-trips', () => {
    const lines = splitTextLinesForPatch('a\rb\r');
    assert.deepEqual([...lines], ['a', 'b']);
    const next = cloneTextLinesForPatch(lines);
    spliceTextLinesForPatch(next, 0, 1, ['A']);
    assert.equal(joinTextLinesForPatch(next), 'A\rb\r');
});

test('a lone CR inside an LF file stays line content', () => {
    const lines = splitTextLinesForPatch('a\rb\nc\n');
    assert.deepEqual([...lines], ['a\rb', 'c']);
    assert.equal(joinTextLinesForPatch(cloneTextLinesForPatch(lines)), 'a\rb\nc\n');
});

test('deleting the tail line keeps the terminator of the line above it', () => {
    // The reviewer's repro: "a\r\nb" (no final newline). Deleting `b` must not
    // strip the CRLF that belongs to the untouched line `a`.
    const lines = splitTextLinesForPatch('a\r\nb');
    const next = cloneTextLinesForPatch(lines);
    spliceTextLinesForPatch(next, 1, 1, []);
    assert.equal(joinTextLinesForPatch(next), 'a\r\n');

    const lfLines = cloneTextLinesForPatch(splitTextLinesForPatch('a\nb'));
    spliceTextLinesForPatch(lfLines, 1, 1, []);
    assert.equal(joinTextLinesForPatch(lfLines), 'a\n');
});

test('an explicit no-newline-at-EOF intent still wins', () => {
    const lines = cloneTextLinesForPatch(splitTextLinesForPatch('a\r\nb\r\n'));
    spliceTextLinesForPatch(lines, 1, 1, ['B']);
    setFinalNewlineForPatch(lines, false);
    assert.equal(joinTextLinesForPatch(lines), 'a\r\nB');

    const restored = cloneTextLinesForPatch(splitTextLinesForPatch('a\r\nb'));
    spliceTextLinesForPatch(restored, 1, 1, ['B']);
    setFinalNewlineForPatch(restored, true);
    assert.equal(joinTextLinesForPatch(restored), 'a\r\nB\r\n');
});

test('the peel-plus window may refine a match but never relocate it', () => {
    // Half-open containment: `start + length` is the index one PAST the
    // window, i.e. a different location. `<=` there re-introduced the no-op.
    assert.equal(plusWindowCoversMatch(2, 2, 1), false);
    assert.equal(plusWindowCoversMatch(2, 2, 2), true);
    assert.equal(plusWindowCoversMatch(2, 2, 3), true);
    assert.equal(plusWindowCoversMatch(2, 2, 4), false);
    assert.equal(plusWindowCoversMatch(2, 2, -1), true);
});

test('UTF-16BE patch content round-trips byte for byte', () => {
    const buf = Buffer.concat([
        Buffer.from([0xFE, 0xFF]),
        Buffer.from('hi\r\n', 'utf16le').swap16(),
    ]);
    const { text, enc } = decodePatchTargetBuffer(buf, 'x.txt');
    assert.equal(text, 'hi\r\n');
    assert.deepEqual([...encodePatchTargetContent(text, enc)], [...buf]);
});

test('a UTF-8 BOM round-trips and a BOM-less buffer stays BOM-less', () => {
    const withBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('hi\n')]);
    const decodedBom = decodePatchTargetBuffer(withBom, 'x.txt');
    assert.equal(decodedBom.text, 'hi\n');
    assert.deepEqual([...encodePatchTargetContent(decodedBom.text, decodedBom.enc)], [...withBom]);

    const plain = decodePatchTargetBuffer(Buffer.from('hi\n'), 'x.txt');
    assert.equal(encodePatchTargetContent(plain.text, plain.enc), 'hi\n');
});

test('malformed UTF-16 (odd payload) is refused instead of losing the byte', () => {
    const buf = Buffer.concat([
        Buffer.from([0xFF, 0xFE]),
        Buffer.from('ab', 'utf16le'),
        Buffer.from([0x41]),
    ]);
    assert.throws(() => decodePatchTargetBuffer(buf, 'x.txt'), /malformed UTF-16/);
});

test('a UTF-16 update routes to the BOM-preserving writer', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'poly.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    writeFileSync(file, Buffer.concat([
        Buffer.from([0xFF, 0xFE]),
        Buffer.from('alpha\r\nkeep\r\n', 'utf16le'),
    ]));
    assert.equal(patchTargetUsesUtf16(file), true);

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: poly.txt
@@
-alpha
+omega
 keep
*** End Patch
`,
    }, dir, {}));

    assert.match(result, /\(JS\)/);
    const raw = readFileSync(file);
    assert.deepEqual([raw[0], raw[1]], [0xFF, 0xFE]);
    assert.equal(raw.subarray(2).toString('utf16le'), 'omega\r\nkeep\r\n');
});

test('a UTF-16 tail deletion leaves every other byte identical', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'tail.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const before = Buffer.concat([
        Buffer.from([0xFF, 0xFE]),
        Buffer.from('a\r\nb', 'utf16le'),
    ]);
    writeFileSync(file, before);

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: tail.txt
@@
 a
-b
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /^Error/);
    const after = readFileSync(file);
    const expected = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('a\r\n', 'utf16le')]);
    assert.deepEqual([...after], [...expected]);
    // Byte-prefix equality: the untouched head (BOM + "a\r\n") is unchanged.
    assert.deepEqual([...after], [...before.subarray(0, expected.length)]);
});

// The UTF-8 in-base route runs inside the Rust engine when its artifact
// satisfies the engine contract, and inside the JS writer when it does not.
// Either way the byte contract must hold, so this runs unconditionally.
test('a UTF-8 tail deletion leaves every other byte identical', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'tail8.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const before = Buffer.from('a\r\nb');
    writeFileSync(file, before);

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: tail8.txt
@@
 a
-b
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /^Error/);
    const after = readFileSync(file);
    assert.deepEqual([...after], [...Buffer.from('a\r\n')]);
    assert.deepEqual([...after], [...before.subarray(0, after.length)]);
});

test('an invalid-UTF-8 target is refused on the native route too', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'latin1.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const before = Buffer.from([0x6F, 0x6C, 0x64, 0x0A, 0xFF, 0x0A]); // "old\n<FF>\n"
    writeFileSync(file, before);

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: latin1.txt
@@
-old
+new
*** End Patch
`,
    }, dir, {}));

    assert.match(result, /neither valid UTF-8/);
    assert.deepEqual([...readFileSync(file)], [...before]);
});

test('a UTF-16 shrinking hunk leaves the trailing context byte-identical', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'shrink.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const before = Buffer.concat([
        Buffer.from([0xFF, 0xFE]),
        Buffer.from('ctx\r\nold1\nold2\r\nkeep\n', 'utf16le'),
    ]);
    writeFileSync(file, before);

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: shrink.txt
@@
 ctx
-old1
-old2
+NEW
 keep
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /^Error/);
    const after = readFileSync(file);
    assert.deepEqual([after[0], after[1]], [0xFF, 0xFE]);
    assert.equal(after.subarray(2).toString('utf16le'), 'ctx\r\nNEW\nkeep\n');
    // The untouched head (BOM + "ctx\r\n") and tail ("keep\n") are byte-equal.
    const headBytes = 2 + Buffer.byteLength('ctx\r\n', 'utf16le');
    assert.deepEqual([...after.subarray(0, headBytes)], [...before.subarray(0, headBytes)]);
    const tailBytes = Buffer.byteLength('keep\n', 'utf16le');
    assert.deepEqual(
        [...after.subarray(after.length - tailBytes)],
        [...before.subarray(before.length - tailBytes)],
    );
});

test('a UTF-16 multi-run hunk keeps the interior context byte-identical', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'multi.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const before = Buffer.concat([
        Buffer.from([0xFF, 0xFE]),
        Buffer.from('H\r\nA\nMID\r\nC\nT\n', 'utf16le'),
    ]);
    writeFileSync(file, before);

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: multi.txt
@@
 H
-A
+A2
 MID
-C
+C2
 T
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /^Error/);
    const after = readFileSync(file);
    assert.deepEqual([after[0], after[1]], [0xFF, 0xFE]);
    assert.equal(after.subarray(2).toString('utf16le'), 'H\r\nA2\nMID\r\nC2\nT\n');
    // `MID\r\n` and the trailing `T\n` are untouched bytes.
    assert.ok(after.includes(Buffer.from('MID\r\n', 'utf16le')));
    assert.ok(after.includes(Buffer.from('T\n', 'utf16le')));
});

test('a UTF-16 moved line leaves the line it crossed byte-identical', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'moved.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    writeFileSync(file, Buffer.concat([
        Buffer.from([0xFF, 0xFE]),
        Buffer.from('H\r\nA\nMID\r\nT\n', 'utf16le'),
    ]));

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: moved.txt
@@
 H
-A
 MID
+A
 T
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /^Error/);
    const after = readFileSync(file);
    assert.equal(after.subarray(2).toString('utf16le'), 'H\r\nMID\r\nA\nT\n');
});

test('a BOM-less UTF-16 target is detected and stays in its own codec', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'nobom.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    // UTF-16LE with NO BOM (long enough to be decidable — a short NUL-bearing
    // file is refused instead, see the tiny-file test). Routing by BOM presence
    // sent this to the UTF-8 engine, which produced mixed bytes
    // (72006f006f0074000a616c706861).
    const before = Buffer.from('root\nsecond line of plain text\n', 'utf16le');
    writeFileSync(file, before);
    assert.equal(patchTargetUsesUtf16(file), true);
    assert.equal(detectPatchTargetCodec(before).encoding, 'utf16le');

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: nobom.txt
@@
+alpha
 root
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /^Error/);
    const after = readFileSync(file);
    assert.equal(after.toString('utf16le'), 'alpha\nroot\nsecond line of plain text\n');
    assert.notDeepEqual([after[0], after[1]], [0xFF, 0xFE]); // no BOM invented
    assert.deepEqual([...after.subarray(after.length - before.length)], [...before]);
});

test('a two-byte UTF-8 file with a stray NUL is refused, not rewritten as UTF-16', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'tiny.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    const before = Buffer.from([0x61, 0x00]); // "a" + NUL — was destroyed as 78000a006100
    writeFileSync(file, before);

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: tiny.txt
@@
-a
+x
*** End Patch
`,
    }, dir, {}));

    assert.match(result, /decidable text encoding|NUL bytes/);
    assert.deepEqual([...readFileSync(file)], [...before]);
});

test('a file whose codec cannot be decided is refused without a write', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'undecidable.txt');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    // NULs on BOTH parities: neither UTF-8 text nor a UTF-16 pattern.
    const before = Buffer.from([0x61, 0x00, 0x00, 0x62, 0x0a, 0x6f, 0x6c, 0x64, 0x0a]);
    writeFileSync(file, before);
    assert.equal(detectPatchTargetCodec(before).certain, false);

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: undecidable.txt
@@
-old
+new
*** End Patch
`,
    }, dir, {}));

    assert.match(result, /decidable text encoding|NUL bytes/);
    assert.deepEqual([...readFileSync(file)], [...before]);
});

test('a genuine addition is not relocated onto a lookalike "+" line', async (t) => {
    const dir = makeDir();
    const file = join(dir, 'a.md');
    t.after(() => { rmSync(dir, { recursive: true, force: true }); void closeNativePatchServerForTests?.(); });
    // `+ marker` exists further down, and ['alpha', '+ marker'] is a unique
    // window there — the peel-plus recovery tier must not drag the hunk to it.
    writeFileSync(file, 'alpha\nbeta\nalpha\n+ marker\n');

    const result = String(await executePatchTool('apply_patch', {
        base_path: dir,
        patch: `*** Begin Patch
*** Update File: a.md
@@
 alpha
+ marker
*** End Patch
`,
    }, dir, {}));

    assert.doesNotMatch(result, /^Error/);
    assert.equal(readFileSync(file, 'utf8'), 'alpha\n marker\nbeta\nalpha\n+ marker\n');
});
