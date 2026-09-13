import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeBuiltinTool } from '../builtin.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-public-path-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.txt'), 'alpha1\nalpha2\nalpha3\nunrequested-gap\nalpha5\n');
  writeFileSync(join(root, 'b.txt'), 'beta1\nbeta2\nbeta3\n');
  mkdirSync(join(root, 'found'));
  writeFileSync(join(root, 'found', 'unique.txt'), 'explicit-target-marker\n');
  return root;
}

test('public read batches apply shared defaults and per-target windows without hiding absence', async (t) => {
  const root = fixture(t);
  const out = String(await executeBuiltinTool('read', {
    file_path: [
      'a.txt',
      { file_path: 'b.txt', offset: 3, limit: 1 },
      { file_path: 'a.txt', offset: 5, limit: 1 },
      'missing.txt',
    ],
    offset: 2,
    limit: 2,
  }, root));
  assert.match(out, /2→alpha2/);
  assert.match(out, /3→alpha3/);
  assert.match(out, /3→beta3/);
  assert.match(out, /5→alpha5/);
  assert.doesNotMatch(out, /unrequested-gap|1→alpha1|2→beta2/);
  assert.match(out, /missing\.txt \[absent\]/);
  assert.match(out, /\[path absent\]/);

  for (const args of [
    { file_path: [] },
    { file_path: ['a.txt', ''] },
    { file_path: [{ file_path: 'a.txt', offset: 0 }] },
    { file_path: 'a.txt', offset: -1 },
    { file_path: 'a.txt', offset: '2' },
    { file_path: { file_path: 'a.txt' } },
    { file_path: [{ path: 'a.txt' }] },
  ]) {
    assert.match(String(await executeBuiltinTool('read', args, root)), /^Error:/);
  }
});

test('literal read strings are not split or repaired into different operands', async (t) => {
  const root = fixture(t);
  for (const file_path of [
    'a.txt b.txt',
    '["a.txt", "b.txt"]',
    '["a.txt',
    '[""]a.txt[""]',
  ]) {
    const out = String(await executeBuiltinTool('read', { file_path, limit: 2 }, root));
    assert.match(out, /^(?:Error:|\[path absent\])/);
    assert.doesNotMatch(out, /1→alpha1|1→beta1/);
  }
});

test('explicit missing paths never redirect by basename or broaden search scope', async (t) => {
  const root = fixture(t);
  for (const [name, args] of [
    ['read', { file_path: 'wrong/unique.txt', limit: 2 }],
    ['grep', { path: 'wrong/unique.txt', pattern: 'explicit-target-marker' }],
    ['grep', { path: 'missing', pattern: 'explicit-target-marker' }],
    ['grep', { path: 'fou"nd"', pattern: 'explicit-target-marker' }],
    ['glob', { path: 'fou"nd"', pattern: '*.txt' }],
    ['glob', { path: 'wrong/found', pattern: '*.txt' }],
    ['list', { path: 'wrong/found' }],
  ]) {
    const out = String(await executeBuiltinTool(name, args, root));
    assert.match(out, /(?:path absent|does not exist|ENOENT|not found)/i, `${name}: ${out}`);
    assert.doesNotMatch(out, /explicit-target-marker|\[redirected from|searched the project root instead/);
  }
});

test('public grep batches keep every explicit scope and reject empty scope lists', async (t) => {
  const root = fixture(t);
  const out = String(await executeBuiltinTool('grep', {
    pattern: 'alpha2|beta3',
    path: ['a.txt', 'b.txt', 'missing'],
    context: 0,
  }, root));
  assert.match(out, /alpha2/);
  assert.match(out, /beta3/);
  assert.match(out, /path does not exist:.*missing/);
  for (const path of [[], ['a.txt', ''], ['a.txt', ['b.txt']]]) {
    assert.match(String(await executeBuiltinTool('grep', { pattern: 'alpha2', path }, root)), /^Error:/);
  }
});

test('regex character classes retain their meaning in single and batched searches', async (t) => {
  const root = fixture(t);
  for (const path of ['a.txt', ['a.txt', 'b.txt']]) {
    const out = String(await executeBuiltinTool('grep', {
      pattern: '[12]',
      path,
      context: 0,
    }, root));
    assert.match(out, /alpha1/);
    assert.match(out, /alpha2/);
    assert.doesNotMatch(out, /alpha3|beta3/);
  }
});

test('search never erases trailing pattern text to manufacture a match', async (t) => {
  const root = fixture(t);
  const out = String(await executeBuiltinTool('grep', {
    pattern: 'alpha2">\\n',
    path: 'a.txt',
    context: 0,
  }, root));
  assert.doesNotMatch(out, /(?:^|\n)(?:.*a\.txt:)?2:alpha2/);
  assert.match(out, /no matches|Error:|unsupported|multiline/i);
});

test('public continuation coordinates resume after the last returned line across encodings and batch shapes', async (t) => {
  for (const encoding of ['utf8', 'utf16le']) {
    for (const shape of [
      (path) => path,
      (path) => [path],
      (path) => [{ file_path: path, offset: 1, limit: 2 }, { file_path: path, offset: 4, limit: 1 }],
    ]) {
      const root = fixture(t);
      const text = 'first\nsecond\nthird\nfourth\nfifth\n';
      const bytes = Buffer.from((encoding === 'utf16le' ? '\uFEFF' : '') + text, encoding);
      writeFileSync(join(root, 'sample.txt'), bytes);
      const first = String(await executeBuiltinTool('read', {
        file_path: shape('sample.txt'), limit: 2,
      }, root));
      const next = Number(first.match(/\boffset:\s*(\d+)/)?.[1]);
      assert.equal(next, 3, first);
      const following = String(await executeBuiltinTool('read', {
        file_path: 'sample.txt', offset: next, limit: 1,
      }, root));
      assert.match(following, /3→third/);
      assert.doesNotMatch(following, /2→second|4→fourth/);
    }
  }
});

test('byte-capped public reads continue without repeating or skipping the boundary line', async (t) => {
  const root = fixture(t);
  const lines = Array.from({ length: 200 }, (_, index) => `row-${index + 1} ${'x'.repeat(1000)}`);
  writeFileSync(join(root, 'large.txt'), lines.join('\n'));
  const first = String(await executeBuiltinTool('read', { file_path: 'large.txt', limit: 200 }, root));
  const returned = [...first.matchAll(/^(\d+)→/gm)].map((match) => Number(match[1]));
  const next = Number(first.match(/\boffset:\s*(\d+)/)?.[1]);
  assert.ok(returned.length > 0 && returned.length < lines.length);
  assert.equal(next, returned.at(-1) + 1);
  const following = String(await executeBuiltinTool('read', {
    file_path: 'large.txt', offset: next, limit: 1,
  }, root));
  assert.match(following, new RegExp(`^${next}→row-${next} `, 'm'));
});

test('escaped regex pipes remain literal in scalar and batch execution', async (t) => {
  for (const path of ['literal.txt', ['literal.txt', 'a.txt']]) {
    const root = fixture(t);
    writeFileSync(join(root, 'literal.txt'), 'alpha2|beta3\nalpha2\nbeta3\n');
    const out = String(await executeBuiltinTool('grep', {
      pattern: 'alpha2\\|beta3', path, context: 0,
    }, root));
    assert.match(out, /1:alpha2\|beta3/);
    assert.doesNotMatch(out, /\b2:alpha2\b|\b3:beta3\b/);
  }
});

test('glob filters retain spaces and commas without widening the matched set', async (t) => {
  for (const [file, glob] of [['space one.txt', 'space *.txt'], ['comma,one.txt', 'comma,*.txt']]) {
    const root = fixture(t);
    writeFileSync(join(root, file), 'selected-marker\n');
    writeFileSync(join(root, 'other.txt'), 'unrequested-marker\n');
    const out = String(await executeBuiltinTool('grep', {
      pattern: 'marker', path: '.', glob, context: 0,
    }, root));
    assert.match(out, /selected-marker/);
    assert.doesNotMatch(out, /unrequested-marker|explicit-target-marker/);
  }
});
