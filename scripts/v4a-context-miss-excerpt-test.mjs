#!/usr/bin/env node
// Regression tests: a V4A context miss reports the CURRENT file lines around
// the true divergence (bounded), so the retry can be built from the error
// itself instead of costing an extra read turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyV4AHunksToLines } from '../src/runtime/agent/orchestrator/tools/patch/v4a-convert.mjs';
import { splitTextLinesForPatch } from '../src/runtime/agent/orchestrator/tools/patch/matcher.mjs';

// Import block whose 4th line changed on disk (Signal -> Sparkles): the model
// retypes the pre-edit block from memory, so old[4] diverges.
const SOURCE = splitTextLinesForPatch([
  "import {",
  "  Command,",
  "  Plus,",
  "  RotateCcw,",
  "  ShieldAlert,",
  "  Sparkles,",
  "  Users,",
  "} from 'lucide-react';",
  "",
  "export const NAV = [Command, Plus];",
  "",
].join('\n'));

const STALE_HUNK = {
  anchors: [],
  lines: [
    '   Plus,',
    '   RotateCcw,',
    '   ShieldAlert,',
    '-  Signal,',
    '   Users,',
  ],
};

function contextMissError(hunk = STALE_HUNK) {
  try {
    applyV4AHunksToLines(SOURCE, [hunk]);
  } catch (err) {
    return String(err?.message || '');
  }
  throw new Error('expected the stale hunk to fail');
}

test('context miss carries a verbatim excerpt of the current file', () => {
  const msg = contextMissError();
  assert.match(msg, /context not found/);
  assert.match(msg, /current file lines \d+-\d+ \(verbatim/);
  // The line that actually sits where the patch expected "Signal," must be
  // present verbatim, with its real line number.
  assert.match(msg, /^\s*6\|\s+Sparkles,$/m);
});

test('the excerpt is centred on the divergence, not the file head', () => {
  const msg = contextMissError();
  assert.match(msg, /first divergent line: old\[4\][\s\S]*file line 6/);
  assert.doesNotMatch(msg, /^\s*1\| import \{$/m);
});

test('the excerpt stays bounded', () => {
  const msg = contextMissError();
  const excerpt = msg.slice(msg.indexOf('current file lines'));
  const rows = excerpt.split('\n').filter((line) => /^\s*(?:\d+|)\| /.test(line));
  assert.ok(rows.length <= 14, `excerpt rows ${rows.length} > 14`);
  assert.ok(excerpt.length <= 1200, `excerpt chars ${excerpt.length} > 1200`);
});

test('a hunk whose context still matches applies unchanged', () => {
  const applied = applyV4AHunksToLines(SOURCE, [{
    anchors: [],
    lines: ['   ShieldAlert,', '-  Sparkles,', '   Users,'],
  }]);
  assert.ok(!applied.includes('  Sparkles,'));
  assert.ok(applied.includes('  ShieldAlert,'));
});

const OUTER_CONTEXT_SOURCE = splitTextLinesForPatch([
  'const tools = {',
  '  shell_step: {',
  "    command: 'node test.js',",
  '    cwd: root,',
  '    timeout: 30000,',
  '  },',
  '};',
  '',
].join('\n'));

const STALE_LEADING_OUTER_CONTEXT_HUNK = {
  anchors: [],
  lines: [
    ' stale outer context',
    '   shell_step: {',
    "     command: 'node test.js',",
    '-    cwd: root,',
    '-    timeout: 30000,',
    '   },',
  ],
};

test('one stale leading outer context line is trimmed around a unique exact deletion core', () => {
  const applied = applyV4AHunksToLines(OUTER_CONTEXT_SOURCE, [STALE_LEADING_OUTER_CONTEXT_HUNK]);
  assert.equal(applied.join('\n'), [
    'const tools = {',
    '  shell_step: {',
    "    command: 'node test.js',",
    '  },',
    '};',
  ].join('\n'));
});

test('one stale trailing outer context line is trimmed too', () => {
  const applied = applyV4AHunksToLines(OUTER_CONTEXT_SOURCE, [{
    anchors: [],
    lines: [
      '   shell_step: {',
      "     command: 'node test.js',",
      '-    cwd: root,',
      '-    timeout: 30000,',
      '   },',
      ' stale trailing context',
    ],
  }]);
  assert.equal(applied.join('\n'), [
    'const tools = {',
    '  shell_step: {',
    "    command: 'node test.js',",
    '  },',
    '};',
  ].join('\n'));
});

test('outer-context trimming rejects a deletion core that occurs more than once', () => {
  const duplicated = splitTextLinesForPatch([
    ...OUTER_CONTEXT_SOURCE,
    '',
    ...OUTER_CONTEXT_SOURCE,
  ].join('\n'));
  assert.throws(
    () => applyV4AHunksToLines(duplicated, [STALE_LEADING_OUTER_CONTEXT_HUNK]),
    /context not found/,
  );
});

test('outer-context trimming never tolerates a stale deletion line', () => {
  const staleDeletion = {
    ...STALE_LEADING_OUTER_CONTEXT_HUNK,
    lines: STALE_LEADING_OUTER_CONTEXT_HUNK.lines.map((line) =>
      line === '-    cwd: root,' ? '-    cwd: staleRoot,' : line),
  };
  assert.throws(
    () => applyV4AHunksToLines(OUTER_CONTEXT_SOURCE, [staleDeletion]),
    /context not found/,
  );
});

test('outer-context trimming stays disabled for fuzzy:false and EOF hunks', () => {
  assert.throws(
    () => applyV4AHunksToLines(OUTER_CONTEXT_SOURCE, [STALE_LEADING_OUTER_CONTEXT_HUNK], { fuzzy: false }),
    /context not found/,
  );
  assert.throws(
    () => applyV4AHunksToLines(OUTER_CONTEXT_SOURCE, [{
      ...STALE_LEADING_OUTER_CONTEXT_HUNK,
      isEndOfFile: true,
    }]),
    /context not found/,
  );
});
