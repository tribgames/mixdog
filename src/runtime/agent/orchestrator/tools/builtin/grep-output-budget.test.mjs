import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuiltinTool } from '../builtin.mjs';
import { formatGrepOutput, formatGrepContextOutput } from './lib/grep-output.mjs';
import { expandGrepAnchorContextOutput } from './lib/grep-context-expander.mjs';
import { extractGrepChunkResultLines } from './lib/search-grep-chunks.mjs';

test('grep rendered output is capped at 10 KiB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-grep-budget-'));
  try {
    const file = join(root, 'large.txt');
    // One match line has to exceed the budget on its own. The context expander
    // narrows its window and drops anchors until the rendered text fits, so a
    // pile of ordinary matches now stays under the limit by construction and
    // only an irreducible line still exercises the hard output cap.
    const body = Array.from({ length: 40 }, (_, index) => `${index + 1} needle ${'x'.repeat(12 * 1024)}`).join('\n');
    await writeFile(file, body);
    const out = await executeBuiltinTool(
      'grep',
      {
        pattern: 'needle',
        path: file,
        mode: 'content',
        limit: 250,
        offset: 0,
        context: 2,
      },
      root
    );
    assert.ok(Buffer.byteLength(out, 'utf8') <= 10 * 1024);
    assert.match(out, /\[grep output capped at 10240 bytes;/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grep paging is one concise line and chunk merging retains partial-result detection', () => {
  const base = {
    windowed: ['a.mjs:1:needle', 'a.mjs:2:needle'],
    totalWindowed: 3,
    totalKnown: true,
    headLimit: 2,
    offset: 4,
    outputMode: 'content',
    workDir: process.cwd(),
    searchPath: '.',
    disableContentGrouping: true,
  };
  for (const totalKnown of [true, false]) {
    const out = formatGrepOutput({ ...base, totalKnown });
    const expected = totalKnown ? '[2 of 7 shown; offset:6 for the rest]' : '[2 shown, more exist; offset:6 for the rest]';
    assert.equal(out, `a.mjs:1:needle\na.mjs:2:needle\n${expected}`);
    assert.deepEqual(extractGrepChunkResultLines(out), { lines: base.windowed, truncated: true });
  }
  const complete = formatGrepOutput({ ...base, totalWindowed: 2 });
  assert.equal(complete, base.windowed.join('\n'));
  assert.deepEqual(extractGrepChunkResultLines(complete), { lines: base.windowed, truncated: false });
});

test('context paging retains head-tail offsets and distinguishes partial streams from EOF', () => {
  const base = {
    allLines: ['a.mjs:1:one', '--', 'a.mjs:5:five', '--', 'a.mjs:9:nine'],
    workDir: process.cwd(),
    outputMode: 'content',
    filenameOmitted: false,
    headLimit: 2,
    offset: 0,
    searchPath: '.',
  };
  const page = formatGrepContextOutput(base);
  assert.match(page.text, /\[2 of 3 shown; offset:1 for the rest\]$/);
  assert.match(page.text, /# a\.mjs:1 \[lines 1-1\]\none/);
  assert.match(page.text, /# a\.mjs:9 \[lines 9-9\]\nnine/);
  for (const totalKnown of [true, false]) {
    const empty = formatGrepContextOutput({ ...base, offset: 10, totalKnown });
    assert.equal(empty.text, totalKnown
      ? '[0 of 3 shown; offset:10 past end]'
      : '[0 shown, results partial; offset:10 beyond streamed window; narrow path/glob/pattern]');
    assert.deepEqual(extractGrepChunkResultLines(empty.text), { lines: [], truncated: !totalKnown });
  }
});

test('grep omits raw-span and match-block clamp banners but keeps pattern sections', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-grep-banners-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'a.mjs'), 'alpha\nbeta\ngamma\n');
  const out = await executeBuiltinTool('grep', {
    path: 'a.mjs', pattern: ['alpha', 'gamma'], context: 1, limit: 250,
  }, root);
  assert.match(out, /# grep pattern:"alpha"/);
  assert.match(out, /# grep pattern:"gamma"/);
  assert.match(out, /# a\.mjs:1 \[lines 1-2\]\nalpha\nbeta/);
  assert.doesNotMatch(out, /Raw source spans|\[arg-guard\]|Showing|\[\d+.* shown/);
});

test('focused grep spans and paging share one summary line', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-grep-focused-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `needle ${'x '.repeat(500)}`;
  const allLines = [];
  for (let i = 0; i < 4; i++) {
    const file = join(root, `${i}.mjs`);
    await writeFile(file, source);
    allLines.push(`${file}:1:${source}`);
  }
  for (const totalKnown of [true, false]) {
    const out = await expandGrepAnchorContextOutput({
      allLines, workDir: root, rgSpawnCwd: root, grepResolvedPath: root, searchPath: '.',
      outputMode: 'content', filenameOmitted: false, headLimit: 4, offset: 0,
      requestedContext: 0, maxContext: 0, charBudget: 3700, totalKnown,
    });
    const summaries = out.text.split('\n').filter((line) => /^\[/.test(line));
    assert.deepEqual(summaries, [totalKnown
      ? '[3 of 4 shown; rest as path:line anchors]'
      : '[4 shown, more exist; offset:4 for the rest; 3 source spans, rest as path:line anchors]']);
    assert.equal(out.shown, 4);
    assert.match(out.text, /3\.mjs:1:needle.*\[lines 1-1\]/);
    assert.doesNotMatch(out.text, /Raw source spans|\[Top /);
  }
});
