#!/usr/bin/env node
// Public-runtime regressions for the V4A apply_patch semantics
// (compute_replacements / apply_replacements):
// pure additions land at end-of-file, several end-of-file additions keep their
// source order, the trailing-newline sentinel retry works for every chunk
// (including a single blank old line, which becomes a cursor insertion),
// replacement plans that would truncate or reorder content are rejected before
// any write, and an Add File section never clobbers an existing target — in
// base (native engine) and out of base (JS dispatch) alike.
//
// Everything below drives the public tool entry point on temp paths: no prior
// read, revision or snapshot is required for apply_patch to run.
process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { executePatchTool } from '../src/runtime/agent/orchestrator/tools/patch.mjs';
import { assertSafeReplacementPlan } from '../src/runtime/agent/orchestrator/tools/patch/matcher.mjs';
import { nativePatchBinPath } from '../src/runtime/agent/orchestrator/tools/patch/native-server.mjs';

// The in-base engine is the native binary. Its end-of-file newline and
// same-position guards ship in the Rust source, so a machine still resolving an
// older PREBUILT binary cannot assert them; those cases skip with this note
// instead of failing. Out-of-base (JS dispatch) coverage always runs.
const NATIVE_IS_LOCAL_BUILD = !!process.env.MIXDOG_PATCH_NATIVE_BIN
  || /native[\\/]mixdog-patch[\\/]target[\\/]/.test(nativePatchBinPath());
const NATIVE_SKIP_NOTE = 'in-base case needs a rebuilt native engine (cargo build --release in native/mixdog-patch) or a newer prebuilt release';

// Returns true when the native-dependent half can run.
function requireNativeEngine(t) {
  if (NATIVE_IS_LOCAL_BUILD) return true;
  t.skip(NATIVE_SKIP_NOTE);
  return false;
}

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-v4a-parity-'));
  const base = join(root, 'base');
  const outside = join(root, 'outside');
  mkdirSync(base, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { root, base, outside };
}

async function applyPatch(base, patch, args = {}) {
  // Out-of-base coverage names the workspace parent as the write root — the
  // same explicit opt-in a real caller makes. Pass `root: null` to exercise
  // the refusal path.
  const root = 'root' in args ? args.root : resolve(base, '..');
  const extra = root ? { root } : {};
  const { root: _ignored, ...rest } = args;
  return String(await executePatchTool('apply_patch', { base_path: base, patch, ...rest, ...extra }, base, {}));
}

function assertApplied(result) {
  assert.ok(!/^Error/.test(result), `apply_patch unexpectedly failed:\n${result}`);
  return result;
}

function assertRejected(result) {
  assert.ok(/^Error/.test(result), `apply_patch unexpectedly succeeded:\n${result}`);
  return result;
}

function read(path) {
  return readFileSync(path, 'utf8');
}

async function withWorkspace(fn) {
  const ws = makeWorkspace();
  try {
    await fn(ws);
  } finally {
    rmSync(ws.root, { recursive: true, force: true });
  }
}

test('a pure addition without *** End of File lands at end of file, not at the cursor', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'root\nmiddle\n', 'utf8');
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '+A',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'root\nmiddle\nA\n');
  });
});

test('a pure addition on a file ending in a blank line lands before that blank line', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'root\n\n', 'utf8');
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '+A',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'root\nA\n\n');
  });
});

test('a mid-file hunk marked *** End of File still applies, with a notice', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
    const result = assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '*** End of File',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'one\nTWO\nthree\nfour\nfive\n');
    assert.match(result, /End of File[\s\S]*marker was ignored/);
  });
});

test('a target outside the write root is refused until a root is named', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const target = join(outside, 'f.txt');
    writeFileSync(target, 'one\n', 'utf8');
    const patch = [
      '*** Begin Patch',
      '*** Update File: ../outside/f.txt',
      '@@',
      '-one',
      '+ONE',
      '*** End Patch',
      '',
    ].join('\n');
    const refused = assertRejected(await applyPatch(base, patch, { root: null }));
    assert.match(refused, /outside the write root/i);
    assert.equal(read(target), 'one\n', 'a refused patch must not write');
    assertApplied(await applyPatch(base, patch, { root: resolve(base, '..') }));
    assert.equal(read(target), 'ONE\n');
  });
});

test('a freeform Root directive deliberately permits an outside target', async () => {
  await withWorkspace(async ({ root, base, outside }) => {
    const target = join(outside, 'f.txt');
    writeFileSync(target, 'one\n', 'utf8');
    const patch = [
      '*** Begin Patch',
      `*** Root: ${root}`,
      '*** Update File: ../outside/f.txt',
      '@@',
      '-one',
      '+ONE',
      '*** End Patch',
      '',
    ].join('\n');
    assertApplied(await applyPatch(base, patch, { root: null }));
    assert.equal(read(target), 'ONE\n');
  });
});

test('compact patch headers expand through the public tool entry point', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'one\n', 'utf8');
    const patch = [
      'U f.txt',
      '@',
      '-one',
      '+ONE',
      '',
    ].join('\n');
    assertApplied(await applyPatch(base, patch));
    assert.equal(read(target), 'ONE\n');
  });
});

test('an explicit filesystem root is refused before any write', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'one\n', 'utf8');
    const patch = [
      '*** Begin Patch',
      `*** Root: ${parse(base).root}`,
      '*** Update File: f.txt',
      '@@',
      '-one',
      '+ONE',
      '*** End Patch',
      '',
    ].join('\n');
    const refused = assertRejected(await applyPatch(base, patch, { root: null }));
    assert.match(refused, /refusing filesystem root/i);
    assert.equal(read(target), 'one\n', 'a filesystem-root refusal must not write');
  });
});

test('an end-of-file marker mid-file keeps its notice under an explicit root', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
    const result = assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '*** End of File',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'one\nTWO\nthree\nfour\nfive\n');
    assert.match(result, /End of File[\s\S]*marker was ignored/);
  });
});

test('a context block that is a couple of characters off resolves to the file bytes', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'alpha\nconst total = count + 1;\nbeta\ngamma\n', 'utf8');
    // The deletion line is retyped with one character missing ("cout"), which
    // the context-tolerance tier refuses because the drift is on a '-' line.
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' alpha',
      '-const total = cout + 1;',
      '+const total = count + 2;',
      ' beta',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'alpha\nconst total = count + 2;\nbeta\ngamma\n');
  });
});

test('wholly wrong surrounding context still applies around a unique exact deletion', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'l1\nl2\nl3\nconst flag = true;\nl5\nl6\nl7\n', 'utf8');
    // Every ' ' line was retyped from memory and is wrong; the deletion line is
    // current and occurs exactly once, so the position is unambiguous.
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' remembered header',
      ' another stale line',
      '-const flag = true;',
      '+const flag = false;',
      ' stale trailer',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'l1\nl2\nl3\nconst flag = false;\nl5\nl6\nl7\n');
  });
});

test('a deletion core that occurs twice is refused even with trimmed context', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    const original = 'a\nconst flag = true;\nb\nc\nconst flag = true;\nd\n';
    writeFileSync(target, original, 'utf8');
    assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' stale one',
      '-const flag = true;',
      '+const flag = false;',
      ' stale two',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), original);
  });
});

test('stacked @@ headers narrow one hunk to the right occurrence', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.py');
    const source = [
      'class A:',
      '    def run():',
      '        value = 1',
      '        return value',
      '',
      'class B:',
      '    def run():',
      '        value = 1',
      '        return value',
      '',
    ].join('\n');
    writeFileSync(target, source, 'utf8');
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.py',
      '@@ class B:',
      '@@     def run():',
      '         value = 1',
      '-        return value',
      '+        return value * 2',
      '*** End Patch',
      '',
    ].join('\n')));
    // The edit must land in class B: a dropped anchor chain used to resolve
    // the hunk against class A instead.
    assert.equal(read(target), source.replace(
      'class B:\n    def run():\n        value = 1\n        return value',
      'class B:\n    def run():\n        value = 1\n        return value * 2',
    ));
  });
});

test('a near-miss context matching two places is rejected without writing', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    const original = 'alpha\nvalue = 1;\nbeta\nalpha\nvalue = 1;\nbeta\n';
    writeFileSync(target, original, 'utf8');
    assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' alpha',
      '-value = 7;',
      '+value = 2;',
      ' beta',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), original);
  });
});

test('decomposed Unicode context still matches its composed on-disk form', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'head\nconst label = "caf\u00e9";\ntail\n', 'utf8');
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' head',
      '-const label = "cafe\u0301";',
      '+const label = "tea";',
      ' tail',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'head\nconst label = "tea";\ntail\n');
  });
});

test('two end-of-file additions keep their source order (in base)', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'root\n', 'utf8');
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '+A',
      '@@',
      '+B',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'root\nA\nB\n');
  });
});

test('two end-of-file additions keep their source order (out of base, JS dispatch)', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const target = join(outside, 'f.txt');
    writeFileSync(target, 'root\n', 'utf8');
    const result = assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: ../outside/f.txt',
      '@@',
      '+A',
      '@@',
      '+B',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.match(result, /\(JS\)/);
    assert.equal(read(target), 'root\nA\nB\n');
  });
});

test('a hunk whose only old line is the trailing-newline sentinel becomes a cursor insertion', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'root\n', 'utf8');
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '+A',
      '',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'A\nroot\n');
  });
});

test('a trailing blank context line at end of file still resolves without an EOF marker', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'alpha\nbeta\n', 'utf8');
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      ' beta',
      '+gamma',
      '',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(target), 'alpha\nbeta\ngamma\n');
  });
});

test('hunks listed in descending file order still apply at their own positions', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const inBase = join(base, 'f.txt');
    const outOfBase = join(outside, 'f.txt');
    writeFileSync(inBase, 'l1\nl2\nl3\nl4\nl5\n', 'utf8');
    writeFileSync(outOfBase, 'l1\nl2\nl3\nl4\nl5\n', 'utf8');
    const body = (path) => [
      '*** Begin Patch',
      `*** Update File: ${path}`,
      '@@',
      '-l4',
      '+L4',
      '@@',
      '-l2',
      '+L2',
      '*** End Patch',
      '',
    ].join('\n');
    assertApplied(await applyPatch(base, body('f.txt')));
    assertApplied(await applyPatch(base, body('../outside/f.txt')));
    assert.equal(read(inBase), 'l1\nL2\nl3\nL4\nl5\n');
    assert.equal(read(outOfBase), 'l1\nL2\nl3\nL4\nl5\n');
  });
});

test('an insertion sharing a position with a replacement is rejected without writing', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const target = join(outside, 'f.txt');
    writeFileSync(target, 'one\ntwo\nthree\nfour\n', 'utf8');
    const result = assertRejected(await applyPatch(base, [
      '--- a/../outside/f.txt',
      '+++ b/../outside/f.txt',
      '@@ -2,0 +3,1 @@',
      '+inserted',
      '@@ -3,1 +4,1 @@',
      '-three',
      '+THREE',
      '',
    ].join('\n'), { format: 'unified' }));
    assert.match(result, /same position|overlap/i);
    assert.equal(read(target), 'one\ntwo\nthree\nfour\n');
  });
});

test('a hunk that would land inside an earlier replaced range is rejected without writing', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const target = join(outside, 'f.txt');
    writeFileSync(target, 'one\ntwo\nthree\nfour\n', 'utf8');
    assertRejected(await applyPatch(base, [
      '--- a/../outside/f.txt',
      '+++ b/../outside/f.txt',
      '@@ -1,2 +1,2 @@',
      '-one',
      '-two',
      '+ONE',
      '+TWO',
      '@@ -2,2 +2,2 @@',
      '-two',
      '-three',
      '+TWO2',
      '+THREE',
      '',
    ].join('\n'), { format: 'unified' }));
    assert.equal(read(target), 'one\ntwo\nthree\nfour\n');
  });
});

test('the replacement-plan guard names overlaps and same-position collisions', () => {
  // Several pure insertions at one index stay legal (source order is preserved
  // by the descending apply); anything else is refused.
  assert.doesNotThrow(() => assertSafeReplacementPlan([
    { start: 3, oldLen: 0 },
    { start: 3, oldLen: 0 },
  ]));
  assert.throws(
    () => assertSafeReplacementPlan([{ start: 3, oldLen: 0 }, { start: 3, oldLen: 2 }]),
    /same position \(line 4\)/,
  );
  assert.throws(
    () => assertSafeReplacementPlan([{ start: 1, oldLen: 3 }, { start: 2, oldLen: 1 }]),
    /hunks overlap — line 3 falls inside lines 2-4/,
  );
});

test('Add File onto an existing target is rejected without writing (in base)', async () => {
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'exists.txt');
    writeFileSync(target, 'original\n', 'utf8');
    const result = assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Add File: exists.txt',
      '+clobbered',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.match(result, /already exists/i);
    assert.equal(read(target), 'original\n');
  });
});

test('an insert-only unified hunk anchors after its declared line, in base and out of base', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const inBase = join(base, 'f.txt');
    const outOfBase = join(outside, 'f.txt');
    writeFileSync(inBase, 'one\ntwo\nthree\n', 'utf8');
    writeFileSync(outOfBase, 'one\ntwo\nthree\n', 'utf8');
    const body = (path) => [
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -2,0 +3,1 @@',
      '+inserted',
      '',
    ].join('\n');
    assertApplied(await applyPatch(base, body('f.txt'), { format: 'unified' }));
    assertApplied(await applyPatch(base, body('../outside/f.txt'), { format: 'unified' }));
    assert.equal(read(inBase), 'one\ntwo\ninserted\nthree\n');
    assert.equal(read(outOfBase), 'one\ntwo\ninserted\nthree\n');
  });
});

test('Add File onto an existing target is rejected without writing (out of base)', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const target = join(outside, 'exists.txt');
    writeFileSync(target, 'original\n', 'utf8');
    const result = assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Add File: ../outside/exists.txt',
      '+clobbered',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.match(result, /create target already exists/i);
    assert.equal(read(target), 'original\n');
  });
});

test('two hunks resolving to one position are rejected in base too (native)', async (t) => {
  if (!requireNativeEngine(t)) return;
  await withWorkspace(async ({ base }) => {
    const target = join(base, 'f.txt');
    writeFileSync(target, 'one\ntwo\nthree\nfour\n', 'utf8');
    const result = assertRejected(await applyPatch(base, [
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -2,0 +3,1 @@',
      '+inserted',
      '@@ -3,1 +4,1 @@',
      '-three',
      '+THREE',
      '',
    ].join('\n'), { format: 'unified' }));
    assert.match(result, /same position/i);
    assert.equal(read(target), 'one\ntwo\nthree\nfour\n');
  });
});

test('a file without a final newline keeps that state through an EOF addition', async (t) => {
  await withWorkspace(async ({ base, outside }) => {
    const inBase = join(base, 'f.txt');
    const outOfBase = join(outside, 'f.txt');
    writeFileSync(inBase, 'root', 'utf8');
    writeFileSync(outOfBase, 'root', 'utf8');
    const body = (path) => [
      '*** Begin Patch',
      `*** Update File: ${path}`,
      '@@',
      '+A',
      '*** End Patch',
      '',
    ].join('\n');
    assertApplied(await applyPatch(base, body('../outside/f.txt')));
    // A separator is inserted (never "rootA") and no final newline is invented.
    assert.equal(read(outOfBase), 'root\nA');
    if (!NATIVE_IS_LOCAL_BUILD) { t.diagnostic(NATIVE_SKIP_NOTE); return; }
    assertApplied(await applyPatch(base, body('f.txt')));
    assert.equal(read(inBase), 'root\nA');
  });
});

test('a file without a final newline keeps that state through an EOF replacement', async (t) => {
  await withWorkspace(async ({ base, outside }) => {
    const inBase = join(base, 'f.txt');
    const outOfBase = join(outside, 'f.txt');
    writeFileSync(inBase, 'one\ntwo', 'utf8');
    writeFileSync(outOfBase, 'one\ntwo', 'utf8');
    const body = (path) => [
      '*** Begin Patch',
      `*** Update File: ${path}`,
      '@@',
      '-two',
      '+TWO',
      '*** End Patch',
      '',
    ].join('\n');
    assertApplied(await applyPatch(base, body('../outside/f.txt')));
    assert.equal(read(outOfBase), 'one\nTWO');
    if (!NATIVE_IS_LOCAL_BUILD) { t.diagnostic(NATIVE_SKIP_NOTE); return; }
    assertApplied(await applyPatch(base, body('f.txt')));
    assert.equal(read(inBase), 'one\nTWO');
  });
});

test('a dry-run Add File onto an existing target is rejected and writes nothing', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const inBase = join(base, 'exists.txt');
    const outOfBase = join(outside, 'exists.txt');
    writeFileSync(inBase, 'original\n', 'utf8');
    writeFileSync(outOfBase, 'original\n', 'utf8');
    assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Add File: exists.txt',
      '+clobbered',
      '*** End Patch',
      '',
    ].join('\n'), { dry_run: true }));
    const outResult = assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Add File: ../outside/exists.txt',
      '+clobbered',
      '*** End Patch',
      '',
    ].join('\n'), { dry_run: true }));
    assert.match(outResult, /create target already exists/i);
    assert.equal(read(inBase), 'original\n');
    assert.equal(read(outOfBase), 'original\n');
  });
});

test('default ordered mode keeps a Codex-style committed prefix and skips the tail', async () => {
  await withWorkspace(async ({ base }) => {
    const created = join(base, 'created.txt');
    const blocker = join(base, 'blocker.txt');
    const skipped = join(base, 'skipped.txt');
    writeFileSync(blocker, 'present\n', 'utf8');
    const result = assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Add File: created.txt',
      '+hello',
      '*** Update File: blocker.txt',
      '@@',
      '-missing',
      '+replacement',
      '*** Add File: skipped.txt',
      '+not attempted',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.match(result, /stopped at section 2\/3/i);
    assert.match(result, /applied \(committed to disk\)/i);
    assert.match(result, /Retry only the failed and skipped sections; do not resend committed sections/i);
    assert.match(result, /skipped \(not attempted\): skipped\.txt/i);
    assert.equal(read(created), 'hello\n');
    assert.equal(read(blocker), 'present\n');
    assert.ok(!existsSync(skipped));
  });
});

test('legacy mode:"atomic" rolls back native writes when an out-of-base entry fails', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const nativeTarget = join(base, 'f.txt');
    const jsTarget = join(outside, 'exists.txt');
    writeFileSync(nativeTarget, 'alpha\n', 'utf8');
    writeFileSync(jsTarget, 'original\n', 'utf8');
    const result = assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '-alpha',
      '+ALPHA',
      '*** Add File: ../outside/exists.txt',
      '+clobbered',
      '*** End Patch',
      '',
    ].join('\n'), { mode: 'atomic' }));
    assert.match(result, /create target already exists/i);
    assert.match(result, /rolled back/i);
    // The native half of the batch is committed before the JS entry runs, so
    // this is the proof that mode:"atomic" leaves no partial write behind.
    assert.equal(read(nativeTarget), 'alpha\n');
    assert.equal(read(jsTarget), 'original\n');
  });
});

// A V4A rename failure THROWS rather than returning Error text; it must take
// the same snapshot-restore path out as a returned failure.
test('legacy mode:"atomic" rolls back and reports when a V4A rename throws', async () => {
  await withWorkspace(async ({ base }) => {
    const src = join(base, 'src.txt');
    const dest = join(base, 'dst.txt');
    writeFileSync(src, 'one\ntwo\n', 'utf8');
    const result = assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: src.txt',
      '*** Move to: dst.txt',
      '@@',
      '-this line is not in the file',
      '+X',
      '*** End Patch',
      '',
    ].join('\n'), { mode: 'atomic' }));
    assert.match(result, /rolled back|rollback incomplete/i);
    assert.equal(read(src), 'one\ntwo\n');
    assert.ok(!existsSync(dest), 'a thrown rename must leave no destination behind');
  });
});

// A later unsupported rename stops the sequence without undoing the two
// same-target sections that already committed.
test('a rename that throws after earlier sections committed keeps the committed prefix', async () => {
  await withWorkspace(async ({ base }) => {
    const committed = join(base, 'f.txt');
    const renameSrc = join(base, 'a.txt');
    const renameDest = join(base, 'b.txt');
    writeFileSync(committed, 'one\ntwo\n', 'utf8');
    writeFileSync(renameSrc, 'source\n', 'utf8');
    const result = assertRejected(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@',
      '-one',
      '+ONE',
      '*** Update File: f.txt',
      '@@',
      '-two',
      '+TWO',
      '*** Update File: a.txt',
      '*** Move to: b.txt',
      '@@',
      '-source',
      '+SOURCE',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.match(result, /stopped at section 3\/3/);
    assert.match(result, /committed/i);
    assert.match(result, /Retry only the failed and skipped sections/i);
    assert.match(result, /rename/i);
    assert.equal(read(committed), 'ONE\nTWO\n', 'the committed sections must remain applied');
    assert.equal(read(renameSrc), 'source\n');
    assert.ok(!existsSync(renameDest), 'the rename destination must not exist');
  });
});

test('CRLF files keep CRLF through an EOF addition and an EOF replacement', async (t) => {
  await withWorkspace(async ({ base, outside }) => {
    const outAdd = join(outside, 'add.txt');
    const outRep = join(outside, 'rep.txt');
    writeFileSync(outAdd, 'one\r\ntwo\r\n', 'utf8');
    writeFileSync(outRep, 'one\r\ntwo\r\n', 'utf8');
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: ../outside/add.txt',
      '@@',
      '+three',
      '*** End Patch',
      '',
    ].join('\n')));
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: ../outside/rep.txt',
      '@@',
      '-two',
      '+TWO',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(outAdd), 'one\r\ntwo\r\nthree\r\n');
    assert.equal(read(outRep), 'one\r\nTWO\r\n');
    if (!NATIVE_IS_LOCAL_BUILD) { t.diagnostic(NATIVE_SKIP_NOTE); return; }
    const inBase = join(base, 'add.txt');
    writeFileSync(inBase, 'one\r\ntwo\r\n', 'utf8');
    assertApplied(await applyPatch(base, [
      '*** Begin Patch',
      '*** Update File: add.txt',
      '@@',
      '+three',
      '*** End Patch',
      '',
    ].join('\n')));
    assert.equal(read(inBase), 'one\r\ntwo\r\nthree\r\n');
  });
});

test('explicit no-newline markers are honoured in both directions (out of base)', async () => {
  await withWorkspace(async ({ base, outside }) => {
    const drop = join(outside, 'drop.txt');
    const restore = join(outside, 'restore.txt');
    writeFileSync(drop, 'one\ntwo\n', 'utf8');
    writeFileSync(restore, 'one\ntwo', 'utf8');
    // New side marked: the terminator is removed.
    assertApplied(await applyPatch(base, [
      '--- a/../outside/drop.txt',
      '+++ b/../outside/drop.txt',
      '@@ -2,1 +2,1 @@',
      '-two',
      '+TWO',
      '\\ No newline at end of file',
      '',
    ].join('\n'), { format: 'unified' }));
    // Old side marked only: the patch re-adds the terminator.
    assertApplied(await applyPatch(base, [
      '--- a/../outside/restore.txt',
      '+++ b/../outside/restore.txt',
      '@@ -2,1 +2,1 @@',
      '-two',
      '\\ No newline at end of file',
      '+TWO',
      '',
    ].join('\n'), { format: 'unified' }));
    assert.equal(read(drop), 'one\nTWO');
    assert.equal(read(restore), 'one\nTWO\n');
  });
});
