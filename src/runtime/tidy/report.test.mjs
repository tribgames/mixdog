import test from 'node:test';
import assert from 'node:assert/strict';

import { DIAGNOSTIC_CAP, buildTidyReport, tidyToolResult } from './report.mjs';

const engines = [
  {
    id: 'ruff',
    version: '0.6.9',
    source: 'project-local',
    path: '/repo/.venv/bin/ruff',
    kind: ['format', 'lint'],
    languages: ['python'],
  },
  {
    id: 'shfmt',
    source: 'missing',
    missing: true,
    installable: true,
    kind: ['format'],
    languages: ['bash'],
    installHint: 'install mvdan/sh',
  },
  {
    id: 'rustfmt',
    source: 'missing',
    missing: true,
    toolchain: true,
    kind: ['format'],
    languages: ['rust'],
    installHint: 'rustup component add rustfmt',
  },
];

function diagnostics(count) {
  return Array.from({ length: count }, (_unused, index) => ({
    file: `src/f${index}.py`,
    line: index + 1,
    col: 1,
    code: 'F401',
    message: 'imported but unused',
    severity: 'error',
    fixable: true,
  }));
}

test('the report splits resolved from missing engines and keeps hints', () => {
  const report = buildTidyReport({
    action: 'scan',
    languages: [{ id: 'python', files: 12 }],
    languageSource: 'graph-binary',
    engines,
    policy: { downloads: 'ask', source: 'default' },
    elapsedMs: 42,
  });
  assert.deepEqual(
    report.engines.map((engine) => engine.id),
    ['ruff']
  );
  assert.deepEqual(
    report.missing.map((engine) => engine.id),
    ['shfmt', 'rustfmt']
  );
  assert.equal(report.missing[0].installHint, 'install mvdan/sh');
  assert.equal(report.missing[0].installable, true);
  assert.equal(report.missing[1].toolchain, true);
  assert.equal(report.missing[1].installable, undefined);
  assert.equal(report.policy.downloads, 'ask');
  assert.equal(report.languageSource, 'graph-binary');
  assert.equal(report.elapsedMs, 42);
  assert.equal(report.ok, true);
});

test('per-engine diagnostics are capped with a `more` count and exact totals', () => {
  const report = buildTidyReport({
    action: 'check',
    engines,
    results: [
      {
        id: 'ruff',
        source: 'project-local',
        filesChecked: 30,
        filesChanged: Array.from({ length: 40 }, (_unused, index) => `src/f${index}.py`),
        diagnostics: diagnostics(55),
      },
    ],
  });
  const [result] = report.results;
  assert.equal(result.diagnostics.length, DIAGNOSTIC_CAP);
  assert.equal(result.more, 55 - DIAGNOSTIC_CAP);
  assert.equal(result.diagnosticsCount, 55);
  assert.equal(result.filesChanged.length, 25);
  assert.equal(result.filesChangedMore, 15);
  assert.equal(result.filesChangedCount, 40);
  assert.deepEqual(result.byRule, { F401: { count: 55, severity: 'error', fixable: 55 } });
  assert.deepEqual(result.byDir, { src: 55 });
});

test('structural output reports matches, fixable count, applied files and rejections', () => {
  const report = buildTidyReport({
    action: 'fix',
    engines: [],
    structural: {
      adapter: 'graph-binary',
      packs: ['javascript/no-var'],
      matches: [
        { file: 'a.js', ruleId: 'no-var', fix: { byteOffset: [0, 3], text: 'const' } },
        { file: 'b.js', ruleId: 'no-debugger', fix: null },
      ],
      applied: [{ file: 'a.js', fixes: 1 }],
      rejected: [{ file: 'c.js', reason: 'overlapping fixes' }],
    },
  });
  assert.equal(report.structural.adapter, 'graph-binary');
  assert.equal(report.structural.matchesCount, 2);
  assert.equal(report.structural.fixable, 1);
  assert.deepEqual(report.structural.applied, [{ file: 'a.js', fixes: 1 }]);
  assert.deepEqual(report.structural.rejected, [{ file: 'c.js', reason: 'overlapping fixes' }]);
});

test('needsApproval and dry-run notes ride along with the report', () => {
  const report = buildTidyReport({
    action: 'fix',
    engines,
    needsApproval: { engines: [{ id: 'shfmt', version: '3.8.0', bytes: 2_000_000 }], bytes: 2_000_000 },
    notes: ['dry run: pass apply:true to write these changes'],
  });
  assert.equal(report.needsApproval.engines[0].id, 'shfmt');
  assert.deepEqual(report.notes, ['dry run: pass apply:true to write these changes']);
});

test('an oversized report trims samples but keeps counts and marks truncation', () => {
  const report = buildTidyReport({
    action: 'check',
    engines,
    results: [
      { id: 'ruff', source: 'path', filesChecked: 400, filesChanged: [], diagnostics: diagnostics(300) },
      { id: 'shellcheck', source: 'path', filesChecked: 40, filesChanged: [], diagnostics: diagnostics(300) },
    ],
    structural: { matches: [{ file: 'src/runtime/a.js', ruleId: 'no-debugger', severity: 'warning', fix: null }] },
    maxBytes: 3500,
  });
  assert.equal(report.truncated, true);
  assert.ok(Buffer.byteLength(tidyToolResult(report).content[0].text, 'utf8') <= 3500, 'wire report must fit the budget');
  assert.equal(report.results[0].diagnosticsCount, 300);
  assert.ok(report.results[0].diagnostics.length < DIAGNOSTIC_CAP, 'samples must shrink under budget pressure');
  assert.equal(report.results[0].more, 300 - report.results[0].diagnostics.length);
  assert.deepEqual(report.results[0].byRule, { F401: { count: 300, severity: 'error', fixable: 300 } });
  assert.deepEqual(report.results[0].byDir, { src: 300 });
  assert.deepEqual(report.structural.byRule, { 'no-debugger': { count: 1, severity: 'warning', fixable: 0 } });
  assert.deepEqual(report.structural.byDir, { 'src/runtime': 1 });
});

test('offset/limit page diagnostics and keep full counts', () => {
  const report = buildTidyReport({
    action: 'results',
    engines,
    results: [
      {
        id: 'ruff',
        source: 'project-local',
        filesChecked: 30,
        filesChanged: Array.from({ length: 40 }, (_unused, index) => `src/f${index}.py`),
        diagnostics: diagnostics(55),
      },
    ],
    structural: {
      adapter: 'graph-binary',
      packs: ['javascript/no-debugger'],
      matches: Array.from({ length: 45 }, (_unused, index) => ({
        file: `src/a${index}.js`,
        ruleId: 'no-debugger',
      })),
    },
    offset: 20,
    limit: 10,
  });
  const [result] = report.results;
  assert.equal(result.diagnostics.length, 10);
  assert.equal(result.diagnostics[0].loc, 'src/f20.py:21:1');
  assert.equal(result.more, 25);
  assert.equal(result.diagnosticsCount, 55);
  assert.equal(result.offset, 20);
  assert.equal(result.nextOffset, 30);
  assert.equal(result.filesChanged.length, 10);
  assert.equal(result.filesChanged[0], 'src/f20.py');
  assert.equal(result.filesChangedCount, 40);
  assert.equal(report.structural.matches.length, 10);
  assert.equal(report.structural.matches[0].loc, 'src/a20.js:0:0');
  assert.equal(report.structural.matchesCount, 45);
  assert.equal(report.structural.more, 15);
  assert.equal(report.structural.nextOffset, 30);
  assert.deepEqual(report.paging, { offset: 20, limit: 10 });
  assert.equal(report.ok, true);
});

test('a page past the end is empty rather than a dump', () => {
  const report = buildTidyReport({
    action: 'results',
    engines,
    results: [{ id: 'ruff', source: 'path', filesChecked: 1, filesChanged: [], diagnostics: diagnostics(5) }],
    offset: 40,
    limit: 10,
  });
  assert.equal(report.results[0].diagnostics.length, 0);
  assert.equal(report.results[0].more, 0);
  assert.equal(report.results[0].diagnosticsCount, 5);
  assert.equal(report.results[0].nextOffset, undefined);
});

test('structural language errors are partial, deduplicated, and never tool errors', () => {
  const error = { language: 'kotlin', kind: 'rules', message: 'invalid rule' };
  for (const action of ['check', 'fix', 'results']) {
    for (const failure of [{ error }, { ruleErrors: [error] }, { errors: [error] }, { error, ruleErrors: [error] }]) {
      const report = buildTidyReport({
        action,
        structural: { adapter: 'graph-binary', matches: [], ...failure },
      });
      assert.equal(report.ok, true);
      assert.equal(report.status, 'partial');
      assert.equal(tidyToolResult(report).isError, undefined);
      assert.deepEqual(report.structural.errors, [error]);
      assert.equal(report.structural.error, undefined);
      assert.equal(report.structural.ruleErrors, undefined);
      assert.equal(report.structural.matchesCount, 0);
      assert.match(report.notes.join(' '), /kotlin structural pass did not complete/);
      assert.match(report.notes.join(' '), /structural apply blocked for the entire run/);
    }
  }
});

test('engine failures and incomplete output cannot be reported as success', () => {
  for (const failure of [{ error: 'engine failed' }, { truncated: true }]) {
    const report = buildTidyReport({
      action: 'check',
      results: [{ id: 'biome', filesChecked: 0, diagnostics: [], filesChanged: [], ...failure }],
    });
    assert.equal(report.ok, false);
    assert.equal(report.status, 'failed');
    assert.equal(tidyToolResult(report).isError, true);
  }
});

test('write rejections preserve partial completion instead of claiming success', () => {
  const report = buildTidyReport({
    action: 'fix',
    structural: {
      matches: [],
      applied: [{ file: 'a.js', fixes: 1 }],
      rejected: [{ file: 'b.js', reason: 'overlap' }],
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.status, 'partial');
});

test('lint findings alone are a completed check, not an engine failure', () => {
  const report = buildTidyReport({
    action: 'check',
    results: [{ id: 'biome', diagnostics: [{ severity: 'error', message: 'unused import' }] }],
  });
  assert.equal(report.ok, true);
  assert.equal(report.status, 'complete');
});

test('the tool result is one JSON text block, like the other runtime tools', () => {
  const ok = tidyToolResult({ ok: true, action: 'scan' });
  assert.equal(ok.content.length, 1);
  assert.equal(ok.content[0].type, 'text');
  assert.equal(ok.content[0].text, '{"ok":true,"action":"scan"}');
  assert.deepEqual(JSON.parse(ok.content[0].text), { ok: true, action: 'scan' });
  assert.equal(ok.isError, undefined);
  assert.equal(tidyToolResult({ ok: false }, true).isError, true);
});

test('results omits the header while scan/check/fix retain it', () => {
  const header = {
    languages: [{ id: 'python', files: 12 }],
    languageSource: 'git',
    engines,
    policy: { downloads: 'ask' },
  };
  for (const action of ['scan', 'check', 'fix', 'results']) {
    const report = buildTidyReport({ action, ...header, scope: ['.'], results: [] });
    for (const key of ['languages', 'languageSource', 'engines', 'missing', 'policy']) {
      assert.equal(Object.hasOwn(report, key), action !== 'results', `${action}.${key}`);
    }
    assert.deepEqual(report.scope, ['.']);
    assert.deepEqual(report.results, []);
  }
});

test('flat report rows do not mutate full cached/write payloads', (t) => {
  const match = {
    file: 'src/runtime/a.js',
    lang: 'javascript',
    ruleId: 'no-debugger',
    severity: 'warning',
    message: 'Remove debugger.',
    range: { start: { line: 2, column: 3 }, end: { line: 2, column: 12 }, byteOffset: [20, 29] },
    fix: { byteOffset: [20, 29], text: '' },
  };
  const source = {
    action: 'check',
    results: [{ id: 'ruff', diagnostics: diagnostics(1) }],
    structural: { matches: [match] },
  };
  const original = structuredClone(source);
  const report = buildTidyReport(source);
  assert.deepEqual(report.results[0].diagnostics[0], {
    loc: 'src/f0.py:1:1', rule: 'F401', severity: 'error', message: 'imported but unused', fix: true,
  });
  assert.deepEqual(report.structural.matches[0], {
    loc: 'src/runtime/a.js:2:3', rule: 'no-debugger', severity: 'warning', message: 'Remove debugger.', fix: true,
  });
  assert.deepEqual(source, original);
  const before = Buffer.byteLength(JSON.stringify(match, null, 2));
  const after = Buffer.byteLength(JSON.stringify(report.structural.matches[0]));
  assert.ok(after < before);
  t.diagnostic(`diagnostic row bytes: ${before} pretty/full -> ${after} compact/projected (${(before / after).toFixed(2)}x)`);
});

test('summaries group directories, mixed fixability and severity, and survive zero-row trimming', () => {
  const rows = [
    { file: 'src/runtime/a.js', ruleId: 'no-debugger', severity: 'warning', fix: null },
    { file: 'src\\runtime\\deep\\b.js', ruleId: 'no-debugger', severity: 'error', fix: { text: '' } },
    { file: 'apps/desktop/c.js', ruleId: 'no-debugger', severity: 'info', fix: null },
    { file: 'root.js', ruleId: '__proto__', severity: 'warning', fix: null },
  ];
  const report = buildTidyReport({
    action: 'check',
    engines: [{ id: 'gofumpt', kind: ['format'] }],
    results: [
      { id: 'biome', diagnostics: rows },
      { id: 'gofumpt', diagnostics: [{ file: 'main.go', code: 'gofumpt', fixable: true }] },
    ],
    structural: { matches: rows },
    maxBytes: 1,
  });
  const expectedRules = {
    'no-debugger': { count: 3, severity: 'error', fixable: 1 },
    ['__proto__']: { count: 1, severity: 'warning', fixable: 0 },
  };
  for (const summary of [report.results[0], report.structural]) {
    assert.deepEqual(summary.byRule, expectedRules);
    assert.deepEqual(summary.byDir, { 'src/runtime': 2, 'apps/desktop': 1, '.': 1 });
  }
  assert.deepEqual(report.results[0].diagnostics, []);
  assert.deepEqual(report.structural.matches, []);
  assert.deepEqual(report.results[1].byRule, {});
  assert.equal(report.truncated, true);
  assert.equal(report.ok, true, 'sample trimming is not an engine failure');
});
