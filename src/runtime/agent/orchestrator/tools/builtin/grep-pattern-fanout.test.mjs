import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGrepPatternFanout } from './lib/grep-pattern-fanout.mjs';
import { runGrepPathFanout } from './lib/grep-path-fanout.mjs';

function fanoutRequest(root, overrides = {}) {
  return {
    args: {},
    patterns: ['alpha', 'beta'],
    workDir: root,
    executeChildBuiltinTool: async () => '',
    readStateScope: null,
    options: {},
    callContextCharBudget: 4_096,
    patternCapNote: '',
    searchPath: '.',
    grepResolvedPath: root,
    normalizedGlobPatterns: [],
    outputMode: 'content',
    headLimit: 10,
    offset: 0,
    caseInsensitive: false,
    showLineNumbers: true,
    beforeN: null,
    afterN: null,
    contextN: 0,
    multilineMode: false,
    pcre2Mode: false,
    fileType: '',
    executeGrepTool: async () => assert.fail('unexpected fallback'),
    ...overrides,
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-grep-sections-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const candidates = async () => ({ lines: ['sample.txt'], complete: true, partial: false });

test('successful combined pattern fanout performs one broad scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-grep-fanout-'));
  let scans = 0;
  let fallbacks = 0;
  try {
    const out = await runGrepPatternFanout({
      args: {},
      patterns: ['alpha', 'beta'],
      workDir: root,
      executeChildBuiltinTool: async () => '',
      readStateScope: null,
      options: {
        __runRgWindowedLines: async () => {
          scans += 1;
          return {
            lines: ['sample.txt:1:alpha beta'],
            complete: true,
            partial: false,
            cacheSafe: true,
          };
        },
      },
      callContextCharBudget: 4_096,
      patternCapNote: '',
      searchPath: '.',
      grepResolvedPath: root,
      normalizedGlobPatterns: [],
      outputMode: 'content',
      headLimit: 10,
      offset: 0,
      caseInsensitive: false,
      showLineNumbers: true,
      beforeN: null,
      afterN: null,
      contextN: 0,
      multilineMode: false,
      pcre2Mode: false,
      fileType: '',
      executeGrepTool: async () => {
        fallbacks += 1;
        return '';
      },
    });
    assert.equal(scans, 1);
    assert.equal(fallbacks, 0);
    assert.equal(out, '# grep pattern:"alpha"\nsample.txt:1:alpha beta');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nested path fanout runs patterns serially and preserves result and error order', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-grep-nested-fanout-'));
  const events = [];
  try {
    const out = await runGrepPatternFanout({
      args: {},
      patterns: ['alpha', 'beta', 'gamma'],
      workDir: root,
      executeChildBuiltinTool: async () => '',
      readStateScope: null,
      options: {
        _grepPathFanout: true,
        __runRgWindowedLines: async () => ({
          lines: ['sample.txt'],
          complete: true,
          partial: false,
        }),
      },
      callContextCharBudget: 4_096,
      patternCapNote: '',
      searchPath: '.',
      grepResolvedPath: root,
      normalizedGlobPatterns: [],
      outputMode: 'content',
      headLimit: 10,
      offset: 0,
      caseInsensitive: false,
      showLineNumbers: true,
      beforeN: null,
      afterN: null,
      contextN: 0,
      multilineMode: true,
      pcre2Mode: false,
      fileType: '',
      executeGrepTool: async ({ pattern }) => {
        events.push(`start:${pattern}`);
        await new Promise((resolve) => setImmediate(resolve));
        events.push(`end:${pattern}`);
        if (pattern === 'beta') throw new Error('beta failed');
        return `${pattern} result`;
      },
    });
    assert.deepEqual(events, ['start:alpha', 'end:alpha', 'start:beta', 'end:beta', 'start:gamma', 'end:gamma']);
    assert.equal(
      out,
      '# grep pattern:"alpha"\nalpha result\n\n# grep pattern:"beta"\nError: beta failed\n\n# grep pattern:"gamma"\ngamma result'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('combined patterns summarize only misses and retain per-pattern pages after deduplication', async (t) => {
  const root = fixture(t);
  const out = await runGrepPatternFanout(
    fanoutRequest(root, {
      patterns: ['alpha', 'beta', 'absent', 'missing'],
      headLimit: 1,
      options: {
        __runRgWindowedLines: async () => ({
          lines: ['sample.txt:2:alpha beta', 'sample.txt:4:alpha beta'],
          complete: true,
          partial: false,
        }),
      },
    })
  );
  assert.equal(
    out,
    [
      '# grep pattern:"alpha"\nsample.txt:2:alpha beta\n[1 of 2 shown; offset:1 for the rest]',
      '# grep pattern:"beta"\n[1 of 2 shown; offset:1 for the rest]',
      '(no matches) patterns=["absent","missing"]',
    ].join('\n\n')
  );
});

test('combined partial results retain timeout and execution warnings, not proven misses', async (t) => {
  const root = fixture(t);
  for (const diagnostic of [{ timeout: true }, { rgStderr: 'permission denied' }]) {
    const out = await runGrepPatternFanout(
      fanoutRequest(root, {
        patterns: ['alpha', 'absent', 'missing'],
        options: {
          __runRgWindowedLines: async () => ({
            lines: ['sample.txt:7:alpha'],
            complete: false,
            partial: true,
            ...diagnostic,
          }),
        },
      })
    );
    assert.match(out, /sample\.txt:7:alpha/);
    assert.match(out, /\[1 shown, more exist; offset:1 for the rest\]/);
    assert.match(out, /\(no matches in partial results\) patterns=\["absent","missing"\]/);
    assert.match(out, diagnostic.timeout ? /rg timed out/ : /rg exit 2.*permission denied/);
    assert.doesNotMatch(out, /\(no matches\)/);
  }
});

test('fallback pattern deduplication drops empty context headers but keeps diagnostics and pages', async (t) => {
  const root = fixture(t);
  const block = '# sample.txt:3 [lines 2-4]\nbefore\nalpha beta\nafter';
  const patterns = ['alpha', 'beta', 'page', 'absent', '[', 'timeout', 'scan', 'hint'];
  const bodies = [
    block,
    block,
    `${block}\n[1 of 3 shown; offset:1 for the rest]`,
    '(no matches)',
    new Error('regex parse error: unclosed character class'),
    '(no matches in partial results)\n[warning] rg timed out; partial results shown.',
    new Error('spawn failed'),
    '(no matches)\n[hint] retry with -i',
  ];
  const out = await runGrepPatternFanout(
    fanoutRequest(root, {
      patterns,
      multilineMode: true,
      options: { __runRgWindowedLines: candidates },
      executeGrepTool: async ({ pattern }) => {
        const body = bodies[patterns.indexOf(pattern)];
        if (body instanceof Error) throw body;
        return body;
      },
    })
  );
  assert.equal(
    out,
    [
      `# grep pattern:"alpha"\n${block}`,
      '# grep pattern:"page"\n[1 of 3 shown; offset:1 for the rest]',
      '# grep pattern:"["\nError: regex parse error: unclosed character class',
      `# grep pattern:"timeout"\n${bodies[5]}`,
      '# grep pattern:"scan"\nError: spawn failed',
      `# grep pattern:"hint"\n${bodies[7]}`,
      '(no matches) patterns=["absent"]',
    ].join('\n\n')
  );
});

test('all-miss combined and prefiltered fallback searches return one whole-scope notice', async (t) => {
  const root = fixture(t);
  for (const multilineMode of [false, true]) {
    const out = await runGrepPatternFanout(
      fanoutRequest(root, {
        multilineMode,
        options: {
          __runRgWindowedLines: async () => ({ lines: [], complete: true, partial: false }),
        },
      })
    );
    assert.equal(out, '(no matches)');
  }
});

test('path fallback consolidates only clean misses, preserving missing paths, errors and partials', async (t) => {
  const root = fixture(t);
  const list = ['hit', 'empty', 'missing', 'invalid', 'timeout', 'partial', 'failed', 'also empty'];
  const bodies = [
    'sample.txt:8:alpha\n[1 of 2 shown; offset:1 for the rest]',
    '(no matches)',
    'Error: path does not exist: missing',
    'Error: regex parse error',
    '(no matches in partial results)\n[warning] rg timed out; partial results shown.',
    '(no matches in partial results)',
    new Error('spawn failed'),
    '(no matches)',
  ];
  const out = await runGrepPathFanout({
    args: { pattern: ['alpha', 'beta'] },
    list,
    workDir: root,
    options: {},
    callContextCharBudget: 4_096,
    executeGrepTool: async ({ path }) => {
      const body = bodies[list.indexOf(path)];
      if (body instanceof Error) throw body;
      return body;
    },
  });
  assert.equal(
    out,
    [
      `# grep hit\n${bodies[0]}`,
      `# grep missing\n${bodies[2]}`,
      `# grep invalid\n${bodies[3]}`,
      `# grep timeout\n${bodies[4]}`,
      '# grep failed\nError: spawn failed',
      '(no matches) paths=["empty","also empty"]',
      '(no matches in partial results) paths=["partial"]',
    ].join('\n\n')
  );
});

test('nested path and pattern misses name only the unmatched subsets once', async (t) => {
  const root = fixture(t);
  const out = await runGrepPathFanout({
    args: { pattern: ['alpha', 'beta', 'absent'] },
    list: ['one', 'two', 'empty'],
    workDir: root,
    options: {},
    callContextCharBudget: 4_096,
    executeGrepTool: async ({ path, pattern }, _workDir, _child, _scope, options) =>
      runGrepPatternFanout(
        fanoutRequest(root, {
          patterns: pattern,
          searchPath: path,
          multilineMode: true,
          options: { ...options, __runRgWindowedLines: candidates },
          executeGrepTool: async ({ pattern: p }) =>
            path !== 'empty' && p === 'alpha' ? `${path}/sample.txt:6:alpha` : '(no matches)',
        })
      ),
  });
  assert.equal(
    out,
    [
      '# grep one\n# grep pattern:"alpha"\none/sample.txt:6:alpha\n\n(no matches) patterns=["beta","absent"]',
      '# grep two\n# grep pattern:"alpha"\ntwo/sample.txt:6:alpha\n\n(no matches) patterns=["beta","absent"]',
      '(no matches) paths=["empty"]',
    ].join('\n\n')
  );
});
