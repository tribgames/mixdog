import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hashText } from './hash-utils.mjs';
import { executeHeadTool, executeSummaryTool, executeTailTool, executeWcTool } from './read-mode-tool.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'read-mode-tool-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snapshots = [];
  const largeFileOnly = () => {
    throw new Error('small files never take the large-file path');
  };
  const helpers = {
    recordReadSnapshot: (fullPath, _st, _scope, meta) => snapshots.push({ fullPath, meta }),
    countLogicalLinesBytesSync: largeFileOnly,
    streamHeadWindow: largeFileOnly,
    renderTailWindowSync: largeFileOnly,
  };
  return { dir, snapshots, helpers };
}

const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

test('head renders the first n lines and records a partial range', async (t) => {
  const { dir, snapshots, helpers } = fixture(t);
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'a\nb\nc\n');
  assert.equal(await executeHeadTool({ path: file, n: 2 }, dir, null, helpers), '1→a\n2→b');
  assert.deepEqual(snapshots[0].meta, {
    source: 'read_head',
    fileLineCount: 3,
    ranges: [{ startLine: 1, endLine: 2 }],
    rangeHash: hashText('a\nb'),
  });
});

test('head covering the whole file records a full-file content hash', async (t) => {
  const { dir, snapshots, helpers } = fixture(t);
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'a\r\nb\r\n');
  assert.equal(await executeHeadTool({ path: file, n: 5 }, dir, null, helpers), '1→a\n2→b');
  assert.deepEqual(snapshots[0].meta, {
    source: 'read_head',
    fileLineCount: 2,
    ranges: [{ startLine: 1, endLine: Infinity }],
    contentHash: hashText('a\r\nb\r\n'),
  });
});

test('head decodes UTF-16 before splitting lines', async (t) => {
  const { dir, snapshots, helpers } = fixture(t);
  const file = join(dir, 'u16.txt');
  writeFileSync(file, utf16le('x\ny\nz\n'));
  assert.equal(await executeHeadTool({ path: file, n: 2 }, dir, null, helpers), '1→x\n2→y');
  assert.deepEqual(snapshots[0].meta, {
    source: 'read_head',
    fileLineCount: 3,
    ranges: [{ startLine: 1, endLine: 2 }],
    rangeHash: hashText('x\ny'),
  });
});

test('head of a file that outgrew the in-memory cap goes through the bounded head streamer', async (t) => {
  const { dir, helpers } = fixture(t);
  const file = join(dir, 'grows.txt');
  writeFileSync(file, 'a\nb\n');
  // The file is small at the first stat and past the in-memory cap at the
  // second (the one openForRead takes): the ETOOBIG race branch.
  const realStat = fsPromises.stat;
  let statsOfFile = 0;
  fsPromises.stat = async (path, ...rest) => {
    const st = await realStat(path, ...rest);
    if (path === file && ++statsOfFile === 2) st.size = 64 * 1024 * 1024;
    return st;
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises.stat = realStat;
    syncBuiltinESMExports();
  });
  const calls = [];
  helpers.streamHeadWindow = async (fullPath, st, n, scope, source) => {
    calls.push({ fullPath, size: st.size, n, scope, source });
    return 'streamed head';
  };
  assert.equal(await executeHeadTool({ path: file, n: 3 }, dir, 'scope-1', helpers), 'streamed head');
  assert.deepEqual(calls, [
    { fullPath: file, size: 64 * 1024 * 1024, n: 3, scope: 'scope-1', source: 'read_head_large' },
  ]);
});

test('tail renders the last n lines with their file line numbers', async (t) => {
  const { dir, snapshots, helpers } = fixture(t);
  const file = join(dir, 'a.txt');
  writeFileSync(file, 'a\nb\nc\n');
  assert.equal(await executeTailTool({ path: file, n: 2 }, dir, null, helpers), '2→b\n3→c');
  assert.deepEqual(snapshots[0].meta, {
    source: 'read_tail',
    fileLineCount: 3,
    ranges: [{ startLine: 2, endLine: 3 }],
    rangeHash: hashText('b\nc'),
  });
});

test('tail over a UTF-16 file covering every line records the decoded content hash', async (t) => {
  const { dir, snapshots, helpers } = fixture(t);
  const file = join(dir, 'u16.txt');
  writeFileSync(file, utf16le('x\ny\n'));
  assert.equal(await executeTailTool({ path: file, n: 9 }, dir, null, helpers), '1→x\n2→y');
  assert.deepEqual(snapshots[0].meta, {
    source: 'read_tail',
    fileLineCount: 2,
    ranges: [{ startLine: 1, endLine: Infinity }],
    contentHash: hashText('x\ny\n'),
  });
});

test('wc counts lines, words and bytes for UTF-8 and UTF-16 files', async (t) => {
  const { dir, helpers } = fixture(t);
  const utf8 = join(dir, 'a.txt');
  writeFileSync(utf8, 'a b\nc\n');
  assert.equal(await executeWcTool({ path: utf8 }, dir, helpers), 'lines\t2\twords\t3\tbytes\t6');
  const u16 = join(dir, 'u16.txt');
  const buf = utf16le('one two\nthree');
  writeFileSync(u16, buf);
  assert.equal(await executeWcTool({ path: u16 }, dir, helpers), `lines\t2\twords\t3\tbytes\t${buf.length}`);
});

test('summary lists stats and symbol lines for UTF-8 and UTF-16 files', async (t) => {
  const { dir, snapshots, helpers } = fixture(t);
  const text = 'export function foo() {}\nlet y;\n# Title\n';
  const utf8 = join(dir, 'a.mjs');
  writeFileSync(utf8, text);
  const expected = (path, bytes) =>
    [
      `summary ${path}`,
      `lines\t3\twords\t8\tbytes\t${bytes}`,
      'symbols\t2',
      '',
      '1→export function foo() {}',
      '3→# Title',
    ].join('\n');
  const utf8Out = await executeSummaryTool({ path: utf8 }, dir, null, helpers);
  assert.equal(utf8Out.replace(/^summary .*$/m, 'summary P'), expected('P', Buffer.byteLength(text)));
  const u16 = join(dir, 'u16.mjs');
  const buf = utf16le(text);
  writeFileSync(u16, buf);
  const u16Out = await executeSummaryTool({ path: u16 }, dir, null, helpers);
  assert.equal(u16Out.replace(/^summary .*$/m, 'summary P'), expected('P', buf.length));
  assert.deepEqual(
    snapshots.map((row) => row.meta),
    [
      { source: 'read_summary', ranges: [] },
      { source: 'read_summary', ranges: [] },
    ]
  );
});

test('summary reports when no symbols are found', async (t) => {
  const { dir, helpers } = fixture(t);
  const file = join(dir, 'plain.txt');
  writeFileSync(file, 'just words\n');
  const out = await executeSummaryTool({ path: file }, dir, null, helpers);
  assert.equal(
    out.replace(/^summary .*$/m, 'summary P'),
    ['summary P', 'lines\t1\twords\t2\tbytes\t11', 'symbols\t0', '', '(no obvious symbols/headings found)'].join('\n')
  );
});
