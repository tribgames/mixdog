// read `tail`: the last N lines through the same window pipeline as offset/limit.
import '../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeBuiltinTool } from '../builtin.mjs';
import { readRowsForDisplay } from '../../../../shared/read-row-numbers.mjs';

const read = async (args, root) => readRowsForDisplay(String(await executeBuiltinTool('read', args, root)));
const rows = (count, prefix = 'row') => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join('\n') + '\n';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-read-tail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.log'), rows(10));
  writeFileSync(join(root, 'b.log'), rows(6, 'b'));
  return root;
}

test('tail returns the last N lines with their real line numbers', async (t) => {
  const root = fixture(t);
  const out = await read({ file_path: 'a.log', tail: 3 }, root);
  assert.match(out, /8→row8\n9→row9\n10→row10/);
  assert.doesNotMatch(out, /row7/);
  assert.match(out, /\[lines 8-10 of 10\]/);
  const whole = await read({ file_path: 'a.log', tail: 50 }, root);
  assert.match(whole, /1→row1\n/);
  assert.match(whole, /10→row10/);
});

test('tail counts lines of a CRLF file, a file without a final newline, an empty file, and N past the end', async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, 'crlf.txt'), 'a\r\nb\r\nc\r\n');
  writeFileSync(join(root, 'nonl.txt'), 'a\nb\nc');
  writeFileSync(join(root, 'empty.txt'), '');
  const crlf = await read({ file_path: 'crlf.txt', tail: 2 }, root);
  assert.match(crlf, /2→b\n3→c/);
  assert.doesNotMatch(crlf, /1→a|\r/);
  const nonl = await read({ file_path: 'nonl.txt', tail: 2 }, root);
  assert.match(nonl, /2→b\n3→c/);
  assert.doesNotMatch(nonl, /1→a/);
  for (const file of ['crlf.txt', 'nonl.txt']) {
    const whole = await read({ file_path: file, tail: 1000 }, root);
    assert.match(whole, /1→a\n2→b\n3→c/, file);
    assert.match(whole, /\[lines 1-3 of 3\]/, file);
  }
  const empty = String(await executeBuiltinTool('read', { file_path: 'empty.txt', tail: 3 }, root));
  assert.match(empty, /empty contents: empty\.txt/);
});

test('tail works per target and as a batch default', async (t) => {
  const root = fixture(t);
  const out = await read({ file_path: ['a.log', { file_path: 'b.log', tail: 2 }], tail: 1 }, root);
  assert.match(out, /10→row10/);
  assert.doesNotMatch(out, /9→row9/);
  assert.match(out, /5→b5\n6→b6/);
  assert.doesNotMatch(out, /4→b4/);
});

test('tail together with offset is an argument error, per call and per target', async (t) => {
  const root = fixture(t);
  for (const args of [
    { file_path: 'a.log', tail: 3, offset: 2 },
    { file_path: ['a.log', { file_path: 'b.log', tail: 2, offset: 1 }] },
    { file_path: ['a.log', 'b.log'], tail: 2, offset: 2 },
    { file_path: 'a.log', tail: 0 },
    { file_path: 'a.log', tail: 100001 },
  ]) {
    assert.match(String(await executeBuiltinTool('read', args, root)), /^Error: .*tail/, JSON.stringify(args));
  }
});

test('tail of a file past the in-memory cap reads from the end, not the whole file', async (t) => {
  const root = fixture(t);
  const lines = 1_800_000;
  const path = join(root, 'huge.log');
  writeFileSync(path, rows(lines, 'entry'));
  const started = Date.now();
  const out = await read({ file_path: 'huge.log', tail: 3 }, root);
  assert.ok(Date.now() - started < 2000, 'a from-the-end read stays fast');
  assert.match(out, new RegExp(`entry${lines - 2}\\n.*entry${lines - 1}\\n.*entry${lines}`));
  assert.doesNotMatch(out, /entry1\n/);
  const batch = await read({ file_path: ['huge.log', { file_path: 'a.log', tail: 1 }], tail: 2 }, root);
  assert.match(batch, new RegExp(`entry${lines - 1}\\n.*entry${lines}`));
  assert.match(batch, /10→row10/);
});
