import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyReplacements, applyStructuralFixes, guardTidyWritePath, planReplacements } from './apply.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidy-apply-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const fix = (start, end, text, ruleId = 'rule') => ({ byteOffset: [start, end], text, ruleId });

test('replacements are ordered back-to-front so earlier offsets stay valid', () => {
  const plan = planReplacements([fix(10, 12, 'BB'), fix(0, 3, 'AAA'), fix(20, 21, 'C')]);
  assert.deepEqual(
    plan.replacements.map((entry) => entry.start),
    [20, 10, 0]
  );
  assert.deepEqual(plan.overlaps, []);
  assert.deepEqual(plan.invalid, []);
});

test('overlapping ranges are detected and never applied', () => {
  const plan = planReplacements([fix(0, 10, 'x', 'first'), fix(5, 12, 'y', 'second')]);
  assert.equal(plan.overlaps.length, 1);
  assert.equal(plan.overlaps[0].previous.ruleId, 'first');
  assert.equal(plan.overlaps[0].current.ruleId, 'second');
  // Abutting ranges (end === next start) are not overlaps.
  assert.deepEqual(planReplacements([fix(0, 5, 'x'), fix(5, 9, 'y')]).overlaps, []);
});

test('unusable ranges are separated from applicable ones', () => {
  const plan = planReplacements([fix(3, 1, 'backwards'), { byteOffset: [0, 2] }, fix(0, 2, 'ok')]);
  assert.equal(plan.invalid.length, 2);
  assert.equal(plan.replacements.length, 1);
});

test('applyReplacements rewrites exactly the requested byte ranges', () => {
  const source = Buffer.from('const a = 1; const b = 2;');
  const plan = planReplacements([fix(6, 7, 'alpha'), fix(19, 20, 'beta')]);
  assert.equal(applyReplacements(source, plan.replacements).toString('utf8'), 'const alpha = 1; const beta = 2;');
  assert.throws(() => applyReplacements(source, [{ start: 0, end: 999, text: '' }]), /outside the file/);
});

test('structural fixes are written through the pipeline, overlaps reject the file', async (t) => {
  const root = workspace(t);
  const good = join(root, 'good.js');
  const clash = join(root, 'clash.js');
  writeFileSync(good, 'let x = 1;\nlet y = 2;\n');
  writeFileSync(clash, 'let z = 3;\n');

  const outcome = await applyStructuralFixes({
    cwd: root,
    matchesByFile: {
      'good.js': [
        { file: 'good.js', ruleId: 'no-let', fix: { byteOffset: [0, 3], text: 'const' } },
        { file: 'good.js', ruleId: 'no-let', fix: { byteOffset: [11, 14], text: 'const' } },
      ],
      'clash.js': [
        { file: 'clash.js', ruleId: 'a', fix: { byteOffset: [0, 5], text: 'const' } },
        { file: 'clash.js', ruleId: 'b', fix: { byteOffset: [3, 9], text: 'X' } },
      ],
    },
  });

  assert.deepEqual(outcome.applied, [{ file: 'good.js', fixes: 2 }]);
  assert.equal(readFileSync(good, 'utf8'), 'const x = 1;\nconst y = 2;\n');
  assert.equal(outcome.rejected.length, 1);
  assert.equal(outcome.rejected[0].file, 'clash.js');
  assert.match(outcome.rejected[0].reason, /overlapping fixes from a, b/);
  assert.equal(readFileSync(clash, 'utf8'), 'let z = 3;\n', 'a rejected file must stay byte-identical');
});

test('matches without a fix payload never open a write', async (t) => {
  const root = workspace(t);
  const file = join(root, 'a.js');
  writeFileSync(file, 'untouched');
  const outcome = await applyStructuralFixes({
    cwd: root,
    matchesByFile: { 'a.js': [{ file: 'a.js', ruleId: 'lint-only', fix: null }] },
  });
  assert.deepEqual(outcome, { applied: [], rejected: [] });
  assert.equal(readFileSync(file, 'utf8'), 'untouched');
});

test('write guards reject UNC, device, and ADS targets', () => {
  assert.match(guardTidyWritePath('\\\\server\\share\\a.js'), /UNC/);
  assert.match(guardTidyWritePath('//server/share/a.js'), /UNC/);
  // The raw-device namespace is caught by the UNC check first; either guard is
  // a refusal, and that is what matters.
  assert.match(guardTidyWritePath('\\\\.\\PhysicalDrive0'), /cannot write/);
  assert.equal(guardTidyWritePath('/dev/stdin'), 'cannot write device path: /dev/stdin');
  assert.equal(guardTidyWritePath(join(tmpdir(), 'ordinary.js')), null);
});

test('a guarded path is rejected per file, not by throwing the whole run', async (t) => {
  const root = workspace(t);
  const outcome = await applyStructuralFixes({
    cwd: root,
    matchesByFile: {
      '//server/share/a.js': [{ file: '//server/share/a.js', ruleId: 'r', fix: { byteOffset: [0, 1], text: 'x' } }],
    },
  });
  assert.deepEqual(outcome.applied, []);
  assert.match(outcome.rejected[0].reason, /UNC/);
});
