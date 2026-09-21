import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { classifyHistoryComment, isHistorySentence, refineHistoryCommentMatches } from './history-comment.mjs';
import { applyReplacements } from './apply.mjs';
import { loadRulePacks, resolveStructuralAdapter, graphSupportsScan } from './structural.mjs';
import { graphBinaryPath } from '../agent/orchestrator/tools/code-graph/graph-binary.mjs';
import { buildTidyReport } from './report.mjs';

function stripComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index + 1 < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          out += source[index] + (source[index + 1] || '');
          index += 2;
          continue;
        }
        out += source[index];
        index += 1;
      }
      if (index < source.length) {
        out += source[index];
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function codeTokens(source) {
  return stripComments(source).match(/[A-Za-z_$][\w$]*|[{}()[\];,]|=>|===|!==|==|!=|<=|>=|[+\-*/%=<>!&|]+/g) || [];
}

function applyHistoryFixes(source, matches) {
  const refined = refine(source, matches);
  const fixes = refined.filter((match) => match.fix).map((match) => match.fix);
  const plan = {
    replacements: [...fixes]
      .map((fix) => ({
        start: fix.byteOffset[0],
        end: fix.byteOffset[1],
        text: fix.text,
      }))
      .sort((a, b) => b.start - a.start),
  };
  return {
    refined,
    after: applyReplacements(Buffer.from(source, 'utf8'), plan.replacements).toString('utf8'),
  };
}

function hit(file, start, end, extra = {}) {
  return {
    file,
    lang: 'javascript',
    ruleId: 'no-history-comment',
    severity: 'warning',
    message: 'Delete comments that only record a move or copy.',
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 }, byteOffset: [start, end] },
    fix: { byteOffset: [start, end], text: '' },
    ...extra,
  };
}

function refine(source, matches) {
  return refineHistoryCommentMatches(matches, { sourceFor: () => Buffer.from(source, 'utf8') });
}

const PURE_HISTORY_SENTENCES = [
  'Extracted verbatim from foo.mjs.',
  'copied from baz',
  'Previously lived in bar.mjs.',
  'behavior-preserving move',
  'formerly ./x/y.ts',
];

const ADVERSARIAL_HISTORY_SENTENCES = [
  'Moved from the retired Channels cluster into the picker so the user can choose.',
  'copied from upstream; adds retry',
  'Formerly this was the only entry point for focus.',
  'Split from the parent so tests can import it.',
  'Extracted from user input before validation.',
  'Extracted from collect.mjs so skill discovery no longer shares a god-file.',
  'Extracted from anthropic-oauth.mjs so anthropic.mjs gets the same table.',
  'Split out of anthropic-oauth.mjs (section-scoped extraction).',
  'Extracted from openai-ws-stream.mjs (no behavior change): the pure helpers.',
  'Lifted from the old helper without changing the contract.',
  'Copied from a CRLF checkout and normalized.',
  'A seed copied from a CRLF checkout must be normalized.',
  'shared with the slide it was copied from',
  'behavior-preserving refactor of the overlay',
  'Formerly the default export.',
  'Previously reviewed by the team',
  'was previously in the hot path',
  'Moved here from bar.ts to keep the picker in one file.',
  'Extracted verbatim from foo.mjs during the split.',
  'copied from upstream and adds retry',
];

test('history sentences require the phrase at the start, not inside other prose', () => {
  assert.equal(isHistorySentence('Extracted verbatim from foo.mjs.'), true);
  assert.equal(isHistorySentence('copied from baz'), true);
  assert.equal(isHistorySentence('Previously lived in bar.mjs.'), true);
  assert.equal(isHistorySentence('A seed copied from a CRLF checkout must be normalized.'), false);
  assert.equal(isHistorySentence('shared with the slide it was copied from'), false);
  assert.equal(classifyHistoryComment('// A seed copied from a CRLF checkout must be normalized.').kind, 'none');
});

test('a history sentence must be only the history clause; 20 adversarial are never pure', () => {
  assert.equal(ADVERSARIAL_HISTORY_SENTENCES.length, 20);
  assert.equal(PURE_HISTORY_SENTENCES.length, 5);
  for (const sentence of PURE_HISTORY_SENTENCES) {
    assert.equal(isHistorySentence(sentence), true, sentence);
    assert.equal(classifyHistoryComment(`// ${sentence}`).kind, 'pure', sentence);
  }
  for (const sentence of ADVERSARIAL_HISTORY_SENTENCES) {
    assert.notEqual(classifyHistoryComment(`// ${sentence}`).kind, 'pure', sentence);
  }
  assert.equal(isHistorySentence('Formerly this was the only entry point for focus.'), false);
  assert.equal(isHistorySentence('behavior-preserving refactor of the overlay'), false);
  assert.equal(isHistorySentence('Extracted from gemini.mjs (no behavior change).'), true);
});

test('(a) prose that only contains a history phrase is not a match', () => {
  const source = '// A seed copied from a CRLF checkout must be normalized.\nconst x = 1;\n';
  const start = 0;
  const end = source.indexOf('\n');
  const refined = refine(source, [hit('a.js', start, end)]);
  assert.equal(refined.length, 0);
});

test('(b) one history // line in a contiguous // paragraph is manual, not a one-line delete', () => {
  const source = [
    '// File-level docs about the algorithm.',
    '// Extracted verbatim from foo.mjs.',
    '// More notes for the reader.',
    'const x = 1;',
    '',
  ].join('\n');
  const line2 = source.indexOf('// Extracted');
  const line2End = source.indexOf('\n', line2);
  const refined = refine(source, [hit('a.js', line2, line2End)]);
  assert.equal(refined.length, 1);
  assert.equal(refined[0].manual, true);
  assert.equal(refined[0].fix, null);
  assert.equal(refined[0].range.byteOffset[0], 0);
  assert.ok(refined[0].range.byteOffset[1] > line2End);
  assert.match(refined[0].message, /Extracted verbatim from foo\.mjs/);
});

test('(c) a /** */ header with one history sentence is manual and keeps the block', () => {
  const source = [
    '/**',
    ' * Formats the payload for the renderer.',
    ' * Extracted verbatim from foo.mjs.',
    ' */',
    'export function f() {}',
    '',
  ].join('\n');
  const start = 0;
  const end = source.indexOf('*/') + 2;
  const refined = refine(source, [hit('a.js', start, end)]);
  assert.equal(refined.length, 1);
  assert.equal(refined[0].manual, true);
  assert.equal(refined[0].fix, null);
  assert.deepEqual(refined[0].range.byteOffset, [start, end]);
});

test('a pure-history // block is one autofix covering the whole run', () => {
  const source = ['// Extracted verbatim from foo.mjs.', '// Previously lived in bar.mjs.', 'const x = 1;', ''].join(
    '\n'
  );
  const first = source.indexOf('// Extracted');
  const firstEnd = source.indexOf('\n', first);
  const second = source.indexOf('// Previously');
  const secondEnd = source.indexOf('\n', second);
  const refined = refine(source, [hit('a.js', first, firstEnd), hit('a.js', second, secondEnd)]);
  assert.equal(refined.length, 1);
  assert.equal(refined[0].manual, false);
  assert.deepEqual(refined[0].fix, { byteOffset: [0, secondEnd], text: '' });
});

test('a pure-history /** */ block is autofixed', () => {
  const source = '/** Extracted verbatim from foo.mjs. */\nconst x = 1;\n';
  const end = source.indexOf('*/') + 2;
  const refined = refine(source, [hit('a.js', 0, end)]);
  assert.equal(refined.length, 1);
  assert.equal(refined[0].fix.text, '');
  assert.equal(refined[0].manual, false);
  assert.equal(refined[0].fix.byteOffset[0], 0);
  assert.ok(refined[0].fix.byteOffset[1] >= end);
});

test('embedded history comments preserve parsing and runtime behavior', () => {
  const fixtures = [
    { source: 'function/* Moved from old.js */f(){ return 7; } f();', expected: 7 },
    { source: 'function f(){ return /* Moved from old.js\n*/ 7; } f();', expected: undefined },
    { source: 'function f(){ return /* Moved from old.js\r\n*/ 7; } f();', expected: undefined },
    { source: 'function f(){ return /* Moved from old.js\u2028*/ 7; } f();', expected: undefined },
    { source: 'let n = 2; n +/* Moved from old.js */+n;', expected: 4 },
  ];
  for (const { source, expected } of fixtures) {
    const start = source.indexOf('/*');
    const end = source.indexOf('*/', start) + 2;
    const { refined, after } = applyHistoryFixes(source, [
      hit('a.js', Buffer.byteLength(source.slice(0, start)), Buffer.byteLength(source.slice(0, end))),
    ]);
    assert.equal(runInNewContext(source), expected);
    assert.equal(runInNewContext(after), expected);
    assert.equal(after, source);
    assert.equal(refined[0].manual, true);
    assert.equal(refined[0].fix, null);
  }
});

test('standalone history block removal preserves its line terminators', () => {
  const source = '/** Moved from old.js.\r\n * Previously lived in other.js.\r\n */\r\n7;\r\n';
  const end = source.indexOf('*/') + 2;
  const { after } = applyHistoryFixes(source, [hit('a.js', 0, end)]);
  assert.equal(after, '\r\n\r\n\r\n7;\r\n');
  assert.equal(runInNewContext(after), 7);
});

test('history phrases do not authorize deleting licenses or tool directives', () => {
  for (const protectedText of ['SPDX-License-Identifier: MIT', '@license Copyright 2026', 'eslint-disable no-alert']) {
    const source = `/* ${protectedText}\n * Moved from old.js.\n */\n7;\n`;
    const end = source.indexOf('*/') + 2;
    const { refined, after } = applyHistoryFixes(source, [hit('a.js', 0, end)]);
    assert.equal(after, source);
    assert.ok(refined.every((match) => match.fix === null && match.manual === true));
  }
});

test('the structural report counts manual history comments separately from autofixes', () => {
  const report = buildTidyReport({
    action: 'check',
    engines: [],
    structural: {
      adapter: 'graph-binary',
      packs: ['javascript/no-history-comment'],
      matches: [
        { file: 'a.js', ruleId: 'no-history-comment', fix: { byteOffset: [0, 10], text: '' }, manual: false },
        { file: 'b.js', ruleId: 'no-history-comment', fix: null, manual: true, message: 'edit by hand' },
      ],
    },
  });
  assert.equal(report.structural.fixable, 1);
  assert.equal(report.structural.manual, 1);
});

test('live graph scan: mixed comments are manual; pure history comments are deleted', async (t) => {
  const binPath = graphBinaryPath();
  const root = mkdtempSync(join(tmpdir(), 'tidy-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (!binPath || !existsSync(binPath) || !(await graphSupportsScan(binPath, { cwd: root }))) {
    t.skip('no mixdog-graph build with the --langs/--scan modes on this machine');
    return;
  }
  writeFileSync(
    join(root, 'mixed.js'),
    [
      '// File-level docs about the algorithm.',
      '// Extracted verbatim from foo.mjs.',
      '// More notes for the reader.',
      'export const n = 1;',
      '',
    ].join('\n')
  );
  writeFileSync(
    join(root, 'prose.js'),
    '// A seed copied from a CRLF checkout must be normalized.\nexport const n = 2;\n'
  );
  writeFileSync(
    join(root, 'header.js'),
    '/**\n * Formats the payload.\n * Extracted verbatim from foo.mjs.\n */\nexport function f() {}\n'
  );
  writeFileSync(
    join(root, 'pure-line.js'),
    '// Extracted verbatim from foo.mjs.\n// Previously lived in bar.mjs.\nexport const n = 3;\n'
  );
  writeFileSync(join(root, 'pure-block.js'), '/** Extracted verbatim from foo.mjs. */\nexport const n = 4;\n');

  const adapter = await resolveStructuralAdapter({ cwd: root, graphBinPath: binPath });
  const javascript = loadRulePacks().groups.find((group) => group.language === 'javascript');
  const scan = await adapter.scan({
    cwd: root,
    rulesText: javascript.rulesText,
    files: ['mixed.js', 'prose.js', 'header.js', 'pure-line.js', 'pure-block.js'],
    fix: true,
  });
  assert.equal(scan.error, undefined);
  const history = scan.matches.filter((match) => match.ruleId === 'no-history-comment');
  const byFile = Object.fromEntries(history.map((match) => [match.file, match]));
  assert.equal(byFile['prose.js'], undefined);
  assert.equal(byFile['mixed.js']?.manual, true);
  assert.equal(byFile['mixed.js']?.fix, null);
  assert.equal(byFile['header.js']?.manual, true);
  assert.equal(byFile['header.js']?.fix, null);
  assert.equal(byFile['pure-line.js']?.fix?.text, '');
  assert.equal(byFile['pure-block.js']?.fix?.text, '');
  assert.equal(readFileSync(join(root, 'mixed.js'), 'utf8').includes('Extracted verbatim'), true);
});

// HEAD lives at src/tui/app/use-transcript-window.mjs (the session/ path was renamed).
// The assistant-row `if` is `// <comment>\n        continue;` — deleting the
// comment must not eat `continue;` (the old fix:'' / lineEnd(end-1) path did).
const ASSISTANT_CONTINUE_FIXTURE = [
  "      if (it.kind === 'assistant') {",
  '        // Extracted verbatim from foo.mjs.',
  '        continue;',
  '      } else {',
  '        const prev = transcriptMeasuredRowsCache.get(it);',
  '      }',
  '',
].join('\n');

test('auto-delete of a pure history comment before continue; keeps every code token', () => {
  const source = ASSISTANT_CONTINUE_FIXTURE;
  const comment = source.indexOf('// Extracted');
  const commentEnd = source.indexOf('\n', comment);
  const continueAt = source.indexOf('continue;');
  const { refined, after } = applyHistoryFixes(source, [hit('use-transcript-window.mjs', comment, commentEnd)]);
  assert.equal(refined.length, 1);
  assert.equal(refined[0].fix.text, '');
  assert.ok(refined[0].fix.byteOffset[1] <= continueAt);
  assert.match(after, /\bcontinue;/);
  assert.deepEqual(codeTokens(source), codeTokens(after));
});

test('an oversized engine range that already covers continue; is clamped to the comment', () => {
  const source = ASSISTANT_CONTINUE_FIXTURE;
  const comment = source.indexOf('// Extracted');
  const continueEnd = source.indexOf('continue;') + 'continue;'.length;
  const { after } = applyHistoryFixes(source, [hit('use-transcript-window.mjs', comment, continueEnd)]);
  assert.match(after, /\bcontinue;/);
  assert.deepEqual(codeTokens(source), codeTokens(after));
});

test('every history autofix leaves the comment-stripped token stream unchanged', () => {
  const fixtures = [
    ASSISTANT_CONTINUE_FIXTURE,
    '// Extracted verbatim from foo.mjs.\n// Previously lived in bar.mjs.\nconst x = 1;\n',
    '/** Extracted verbatim from foo.mjs. */\nexport const n = 4;\n',
    'foo();\n        // Extracted verbatim from foo.mjs.\n        continue;\nbar();\n',
    '      if (ready) continue; // Extracted verbatim from foo.mjs.\n',
    '// Extracted verbatim from foo.mjs.\r\nconst x = 1;\r\n',
    '// Extracted verbatim from foo.mjs.\n\nconst x = 1;\n',
    '// Moved from the retired Channels cluster into the picker so the user can choose.\nconst x = 1;\n',
    '// copied from upstream; adds retry\ncontinue;\n',
    '// Formerly this was the only entry point for focus.\nif (ready) continue;\n',
  ];
  for (const source of fixtures) {
    const matches = [];
    const commentRe = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
    for (const found of source.matchAll(commentRe)) {
      matches.push(hit('a.js', found.index, found.index + found[0].length));
    }
    const { after } = applyHistoryFixes(source, matches);
    assert.deepEqual(codeTokens(source), codeTokens(after), source.slice(0, 80));
  }
});
