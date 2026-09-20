import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  BIOME_CHECK_ARGS,
  BIOME_TRUNCATED_NOTE,
  applyBiomeFixKinds,
  biomeCounts,
  mergeBiomeParses,
  parseBiomeJson,
  parseExplainFix,
  runner,
} from './runners/biome.mjs';
import { buildTidyReport } from './report.mjs';

const CWD = resolve('/repo');

function biomeDoc(rows, extra = {}) {
  return JSON.stringify({
    summary: { diagnosticsNotPrinted: 0, ...extra.summary },
    diagnostics: rows,
  });
}

function formatRow(file, extra = {}) {
  return {
    category: 'format',
    severity: 'error',
    message: 'Formatter would have printed the following content:',
    location: { path: file, start: { line: 1, column: 1 } },
    ...extra,
  };
}

function lintRow(file, category = 'lint/style/noVar', extra = {}) {
  return {
    category,
    severity: 'error',
    message: 'Use let or const instead of var.',
    location: { path: file, start: { line: 2, column: 3 } },
    ...extra,
  };
}

function filesFromArgs(args) {
  return args.filter((value) => value !== 'check' && !String(value).startsWith('-'));
}

test('concatenated per-chunk JSON is merged instead of collapsing to empty', () => {
  const first = biomeDoc([formatRow('src/a.js')]);
  const second = biomeDoc([lintRow('src/b.js')]);
  const parsed = parseBiomeJson(first + second, CWD);
  assert.equal(parsed.diagnostics.length, 2);
  assert.deepEqual(parsed.changedFiles, ['src/a.js']);
  assert.equal(parsed.truncated, undefined);
  assert.equal(parsed.diagnostics[1].line, 2);
  assert.equal(parsed.diagnostics[1].col, 3);
});

test('truncated JSON recovers complete diagnostics and flags truncation', () => {
  const full = biomeDoc([formatRow('src/a.js'), lintRow('src/a.js'), lintRow('src/a.js', 'lint/style/noEval')]);
  const cut = full.slice(0, full.indexOf('noEval') + 8);
  const parsed = parseBiomeJson(cut, CWD);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.diagnostics.length, 2);
  assert.deepEqual(parsed.changedFiles, ['src/a.js']);
  assert.notEqual(parsed.diagnostics.length, 0);
});

test('Biome 2 location paths and start.line/column are accepted', () => {
  const parsed = parseBiomeJson(
    biomeDoc([
      {
        category: 'lint/complexity/useFlatMap',
        severity: 'info',
        message: 'use flatMap',
        location: { path: 'src\\a.js', start: { line: 4, column: 8 } },
      },
    ]),
    CWD
  );
  assert.equal(parsed.diagnostics[0].file, 'src/a.js');
  assert.equal(parsed.diagnostics[0].line, 4);
  assert.equal(parsed.diagnostics[0].col, 8);
  assert.equal(parsed.diagnostics[0].severity, 'info');
  assert.equal(parsed.diagnostics[0].fixable, false);
});

test('format findings stay fixable; diagnosticsNotPrinted marks truncation', () => {
  const parsed = parseBiomeJson(
    biomeDoc([formatRow('src/a.js')], {
      summary: { diagnosticsNotPrinted: 12 },
    }),
    CWD
  );
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.diagnostics[0].fixable, true);
  assert.equal(parsed.changedFiles.length, 1);
});

test('mergeBiomeParses and biomeCounts keep totals across chunks', () => {
  const merged = mergeBiomeParses([
    parseBiomeJson(biomeDoc([formatRow('a.js'), lintRow('a.js')]), CWD),
    parseBiomeJson(biomeDoc([formatRow('b.js')]), CWD),
  ]);
  const counts = biomeCounts(merged.diagnostics, merged.changedFiles);
  assert.equal(counts.filesToFormat, 2);
  assert.equal(counts.diagnostics, 3);
  assert.equal(counts.bySeverity.error, 3);
  assert.equal(counts.byFixability.fixable, 2);
  assert.equal(counts.byFixability.safe, 2);
  assert.equal(counts.byFixability.unfixable, 1);
  assert.equal(counts.byFixability.manual, 1);
  assert.equal(counts.byRule.format, 2);
  assert.equal(counts.byRule['lint/style/noVar'], 1);
});

test('biome check aggregates chunk JSON, passes max-diagnostics=none, and never reports silent zero', async () => {
  const calls = [];
  const files = Array.from({ length: 5 }, (_unused, index) => `src/f${index}.js`);
  const result = await runner.check({
    files,
    cwd: CWD,
    bin: 'biome',
    filesPerSpawn: 2,
    run: async (_bin, args) => {
      calls.push(args);
      const chunk = filesFromArgs(args);
      return {
        code: 1,
        stdout: biomeDoc(chunk.map((file) => formatRow(file))),
        stderr: '',
        truncated: false,
        error: '',
      };
    },
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((args) => args.includes('--max-diagnostics=none') && args.includes('--reporter=json')));
  assert.deepEqual(calls[0].slice(0, BIOME_CHECK_ARGS.length), BIOME_CHECK_ARGS);
  assert.equal(result.diagnostics.length, 5);
  assert.equal(result.changedFiles.length, 5);
  assert.equal(result.counts.filesToFormat, 5);
  assert.equal(result.truncated, undefined);
});

test('a truncated oversized chunk is bisected until counts are complete', async () => {
  const files = ['a.js', 'b.js', 'c.js', 'd.js'];
  const result = await runner.check({
    files,
    cwd: CWD,
    bin: 'biome',
    filesPerSpawn: 4,
    run: async (_bin, args) => {
      const chunk = filesFromArgs(args);
      if (chunk.length > 2) {
        return {
          code: 1,
          stdout: biomeDoc(chunk.map((file) => formatRow(file))).slice(0, 40),
          stderr: '',
          truncated: true,
          error: '',
        };
      }
      return {
        code: 1,
        stdout: biomeDoc(chunk.map((file) => formatRow(file))),
        stderr: '',
        truncated: false,
        error: '',
      };
    },
  });
  assert.equal(result.diagnostics.length, 4);
  assert.equal(result.counts.filesToFormat, 4);
  assert.equal(result.truncated, undefined);
});

test('a truncated single-file payload keeps emitted counts and tells the caller to split', async () => {
  const full = biomeDoc([formatRow('huge.js'), lintRow('huge.js')]);
  const result = await runner.check({
    files: ['huge.js'],
    cwd: CWD,
    bin: 'biome',
    filesPerSpawn: 80,
    run: async () => ({
      code: 1,
      stdout: full.slice(0, full.indexOf('noVar') + 6),
      stderr: '',
      truncated: true,
      error: '',
    }),
  });
  assert.equal(result.truncated, true);
  assert.equal(result.note, BIOME_TRUNCATED_NOTE);
  assert.ok(result.diagnostics.length >= 1);
  assert.equal(result.counts.filesToFormat, result.changedFiles.length);
  assert.equal(result.counts.diagnostics, result.diagnostics.length);
});

test('engine truncation is surfaced on the report with counts and a split-scope note', () => {
  const report = buildTidyReport({
    action: 'check',
    engines: [{ id: 'biome', source: 'managed', kind: ['format', 'lint'], languages: ['javascript'] }],
    results: [
      {
        id: 'biome',
        source: 'managed',
        filesChecked: 100,
        filesChanged: ['a.js'],
        diagnostics: [
          { file: 'a.js', line: 1, col: 1, code: 'format', message: 'fmt', severity: 'error', fixable: true },
        ],
        truncated: true,
        note: BIOME_TRUNCATED_NOTE,
        counts: {
          filesToFormat: 40,
          diagnostics: 90,
          bySeverity: { error: 80, warning: 10, info: 0 },
          byFixability: { safe: 40, unsafe: 20, manual: 30, fixable: 40, unfixable: 50 },
          byRule: { format: 40 },
        },
      },
    ],
  });
  assert.equal(report.truncated, true);
  assert.equal(report.results[0].truncated, true);
  assert.equal(report.results[0].counts.filesToFormat, 40);
  assert.equal(report.results[0].diagnosticsCount, 1);
  assert.equal(report.counts.byFixability.safe, 40);
  assert.equal(report.counts.byFixability.unsafe, 20);
  assert.equal(report.counts.byFixability.manual, 30);
  assert.ok(report.notes.includes(BIOME_TRUNCATED_NOTE));
});

// Captured from Biome 2.5.13 `--reporter=json` on src/runtime/tidy/tool.mjs:
// no `tags`, empty `advices`, path string + start/end. The same binary's
// `explain useFlatMap` reports `- Fix: safe`; useNodejsImportProtocol is unsafe.
const REAL_BIOME_2513_FLATMAP = {
  severity: 'info',
  message: 'The call chain .map().flat() can be replaced with a single .flatMap() call.',
  category: 'lint/complexity/useFlatMap',
  location: {
    path: 'src\\runtime\\tidy\\tool.mjs',
    start: { line: 136, column: 16 },
    end: { line: 136, column: 75 },
  },
  advices: [],
};
const REAL_BIOME_2513_PROTOCOL = {
  severity: 'info',
  message: 'A Node.js builtin module should be imported with the node: protocol.',
  category: 'lint/style/useNodejsImportProtocol',
  location: {
    path: 'src\\lib\\keychain-cjs.cjs',
    start: { line: 3, column: 38 },
    end: { line: 3, column: 53 },
  },
  advices: [],
};
const REAL_BIOME_2513_ASSIGN = {
  severity: 'error',
  message: 'The assignment should not be in an expression.',
  category: 'lint/suspicious/noAssignInExpressions',
  location: {
    path: 'src\\runtime\\tidy\\tool.mjs',
    start: { line: 187, column: 6 },
    end: { line: 187, column: 31 },
  },
  advices: [],
};

test('rdjson suggestions mark an applicable code fix; missing suggestions are manual', () => {
  const rdjson = JSON.stringify({
    source: { name: 'Biome' },
    diagnostics: [
      {
        code: { value: 'lint/complexity/useFlatMap' },
        message: 'use flatMap',
        severity: 'INFO',
        location: { path: 'src/a.js', range: { start: { line: 4, column: 8 }, end: { line: 4, column: 20 } } },
        suggestions: [{ range: { start: { line: 4, column: 8 }, end: { line: 4, column: 20 } }, text: '.flatMap()' }],
      },
      {
        code: { value: 'lint/suspicious/noAssignInExpressions' },
        message: 'assignment in expression',
        severity: 'ERROR',
        location: { path: 'src/a.js', range: { start: { line: 8, column: 1 } } },
      },
    ],
  });
  const parsed = parseBiomeJson(rdjson, CWD);
  assert.equal(parsed.diagnostics[0].line, 4);
  assert.equal(parsed.diagnostics[0].codeFix, true);
  assert.equal(parsed.diagnostics[1].codeFix, false);
  applyBiomeFixKinds(
    parsed.diagnostics,
    new Map([
      ['useFlatMap', 'safe'],
      ['noAssignInExpressions', 'none'],
    ])
  );
  assert.equal(parsed.diagnostics[0].fixKind, 'safe');
  assert.equal(parsed.diagnostics[1].fixKind, 'manual');
});

test('parseExplainFix reads Biome 2.5.13 explain summaries', () => {
  assert.equal(parseExplainFix('Summary\n- Name: useFlatMap\n- Fix: safe\n'), 'safe');
  assert.equal(parseExplainFix('Summary\n- Name: useNodejsImportProtocol\n- Fix: unsafe\n'), 'unsafe');
  assert.equal(parseExplainFix('Summary\n- Name: noAssignInExpressions\n- No fix available.\n'), 'none');
});

test('a real Biome 2.5.13 JSON diagnostic has no tags and is classified from the rule fix kind', () => {
  const parsed = parseBiomeJson(biomeDoc([REAL_BIOME_2513_FLATMAP]), CWD);
  assert.equal(parsed.diagnostics[0].tags, undefined);
  assert.equal(parsed.diagnostics[0].fixable, false);
  assert.equal(parsed.diagnostics[0].code, 'lint/complexity/useFlatMap');
  applyBiomeFixKinds(parsed.diagnostics, new Map([['useFlatMap', 'safe']]));
  assert.equal(parsed.diagnostics[0].fixable, true);
  assert.equal(parsed.diagnostics[0].fixKind, 'safe');
  const counts = biomeCounts(parsed.diagnostics, parsed.changedFiles);
  assert.equal(counts.byFixability.safe, 1);
  assert.equal(counts.byFixability.fixable, 1);
});

test('biome check classifies safe/unsafe/manual the way explain and --write do', async () => {
  const result = await runner.check({
    files: ['a.js'],
    cwd: CWD,
    bin: 'biome',
    run: async (_bin, args) => {
      if (args[0] === 'explain') {
        const name = args[1];
        let line = '- No fix available.';
        if (name === 'useFlatMap') line = '- Fix: safe';
        else if (name === 'useNodejsImportProtocol') line = '- Fix: unsafe';
        return { code: 0, stdout: `Summary\n- Name: ${name}\n${line}\n`, stderr: '', truncated: false, error: '' };
      }
      return {
        code: 1,
        stdout: biomeDoc([
          REAL_BIOME_2513_FLATMAP,
          REAL_BIOME_2513_PROTOCOL,
          REAL_BIOME_2513_ASSIGN,
          formatRow('a.js'),
        ]),
        stderr: '',
        truncated: false,
        error: '',
      };
    },
  });
  assert.equal(result.counts.byFixability.safe, 2);
  assert.equal(result.counts.byFixability.fixable, 2);
  assert.equal(result.counts.byFixability.unsafe, 1);
  assert.equal(result.counts.byFixability.manual, 1);
  assert.equal(result.diagnostics.find((row) => row.code === 'lint/complexity/useFlatMap').fixable, true);
  assert.equal(result.diagnostics.find((row) => row.code === 'lint/style/useNodejsImportProtocol').fixKind, 'unsafe');
  assert.equal(result.diagnostics.find((row) => row.code === 'lint/style/useNodejsImportProtocol').fixable, false);
  assert.equal(
    result.diagnostics.find((row) => row.code === 'lint/suspicious/noAssignInExpressions').fixKind,
    'manual'
  );
});

test('runner.fix passes --max-diagnostics=none on --write and the legacy --apply fallback', async () => {
  const writeCalls = [];
  await runner.fix({
    files: ['a.js'],
    cwd: CWD,
    bin: 'biome',
    run: async (_bin, args) => {
      writeCalls.push(args);
      return { code: 0, stdout: '', stderr: '', truncated: false, error: '' };
    },
  });
  assert.equal(writeCalls.length, 1);
  assert.ok(writeCalls[0].includes('--write'));
  assert.ok(writeCalls[0].includes('--max-diagnostics=none'));
  assert.equal(writeCalls[0].includes('--apply'), false);

  const applyCalls = [];
  await runner.fix({
    files: ['a.js'],
    cwd: CWD,
    bin: 'biome',
    run: async (_bin, args) => {
      applyCalls.push(args);
      return {
        code: 1,
        stdout: '',
        stderr: args.includes('--write') ? 'unexpected argument --write' : '',
        truncated: false,
        error: '',
      };
    },
  });
  assert.equal(applyCalls.length, 2);
  assert.ok(applyCalls[0].includes('--write') && applyCalls[0].includes('--max-diagnostics=none'));
  assert.ok(applyCalls[1].includes('--apply') && applyCalls[1].includes('--max-diagnostics=none'));
});

test('explain runs once per unique rule per check, not per chunk, and a failed explain is manual', async () => {
  const explains = [];
  const files = ['a.js', 'b.js', 'c.js'];
  const result = await runner.check({
    files,
    cwd: CWD,
    bin: 'biome',
    filesPerSpawn: 1,
    run: async (_bin, args) => {
      if (args[0] === 'explain') {
        explains.push(args[1]);
        if (args[1] === 'noAssignInExpressions') throw new Error('explain crashed');
        if (args[1] === 'useNodejsImportProtocol') {
          return { code: 1, stdout: '', stderr: 'unknown rule', truncated: false, error: 'unknown rule' };
        }
        return { code: 0, stdout: 'Summary\n- Fix: safe\n', stderr: '', truncated: false, error: '' };
      }
      const chunk = filesFromArgs(args);
      return {
        code: 1,
        stdout: biomeDoc(
          chunk.flatMap((file) => [
            {
              category: 'lint/complexity/useFlatMap',
              message: 'flat',
              location: { path: file, start: { line: 1, column: 1 } },
              advices: [],
            },
            {
              category: 'lint/suspicious/noAssignInExpressions',
              message: 'assign',
              location: { path: file, start: { line: 2, column: 1 } },
              advices: [],
            },
            {
              category: 'lint/style/useNodejsImportProtocol',
              message: 'protocol',
              location: { path: file, start: { line: 3, column: 1 } },
              advices: [],
            },
          ])
        ),
        stderr: '',
        truncated: false,
        error: '',
      };
    },
  });
  assert.equal(explains.length, 3);
  assert.deepEqual([...explains].sort(), ['noAssignInExpressions', 'useFlatMap', 'useNodejsImportProtocol']);
  assert.ok(
    result.diagnostics.filter((row) => row.code === 'lint/complexity/useFlatMap').every((row) => row.fixKind === 'safe')
  );
  assert.ok(
    result.diagnostics
      .filter((row) => row.code === 'lint/suspicious/noAssignInExpressions')
      .every((row) => row.fixKind === 'manual')
  );
  assert.ok(
    result.diagnostics
      .filter((row) => row.code === 'lint/style/useNodejsImportProtocol')
      .every((row) => row.fixKind === 'manual')
  );
});
