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

test('check names engines briefly while scan keeps resolution details', () => {
  const check = buildTidyReport({ action: 'check', engines, results: [] });
  assert.deepEqual(check.engines, [{ id: 'ruff' }]);
  assert.deepEqual(check.missing, [
    { id: 'shfmt', installable: true, installHint: 'install mvdan/sh' },
    { id: 'rustfmt', installHint: 'rustup component add rustfmt' },
  ]);
  const scan = buildTidyReport({ action: 'scan', engines });
  assert.equal(scan.engines[0].path, '/repo/.venv/bin/ruff');
  assert.deepEqual(scan.missing[1].languages, ['rust']);
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
  assert.deepEqual(result.byRule, {
    F401: { count: 55, severity: 'error', fixable: 55, message: 'imported but unused' },
  });
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

test('the working-tree split, a failed git and a missing git stay three distinguishable states', () => {
  const split = buildTidyReport({
    action: 'fix',
    engines,
    workingTree: {
      modified: { files: ['src/a.py'], findings: 2 },
      clean: { files: ['scripts/build.mjs'], findings: 1 },
    },
  });
  assert.deepEqual(split.workingTree.modified, { files: ['src/a.py'], fileCount: 1, findings: 2 });
  assert.deepEqual(split.workingTree.clean, { files: ['scripts/build.mjs'], fileCount: 1, findings: 1 });
  assert.match(split.notes.join(' '), /workingTree\.clean: 1 file\(s\)/);
  const modifiedOnly = buildTidyReport({
    action: 'check',
    engines,
    workingTree: { modified: { files: ['src/a.py'], findings: 2 }, clean: { files: [], findings: 0 } },
  });
  assert.deepEqual(modifiedOnly.workingTree, { modified: { files: ['src/a.py'], fileCount: 1, findings: 2 } });

  const failed = buildTidyReport({ action: 'check', engines, workingTree: { error: 'not a git repository' } });
  assert.deepEqual(failed.workingTree, { error: 'not a git repository' });
  assert.equal(failed.workingTree.skipped, undefined);
  assert.match(failed.notes.join(' '), /working-tree split unavailable: not a git repository/);

  const noGit = buildTidyReport({ action: 'check', engines, workingTree: { skipped: 'git is not installed' } });
  assert.deepEqual(noGit.workingTree, { skipped: 'git is not installed' });
  assert.equal(noGit.workingTree.error, undefined);
  assert.deepEqual(noGit.notes || [], [], 'a machine without git gets no warning');

  const absent = buildTidyReport({ action: 'check', engines });
  assert.equal(Object.hasOwn(absent, 'workingTree'), false, 'no findings means no split to report');
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
    maxBytes: 2500,
  });
  assert.equal(report.truncated, true);
  assert.ok(
    Buffer.byteLength(tidyToolResult(report).content[0].text, 'utf8') <= 2500,
    'wire report must fit the budget'
  );
  assert.equal(report.results[0].diagnosticsCount, 300);
  assert.ok(report.results[0].diagnostics.length < DIAGNOSTIC_CAP, 'samples must shrink under budget pressure');
  assert.equal(report.results[0].more, 300 - report.results[0].diagnostics.length);
  assert.deepEqual(report.results[0].byRule, {
    F401: { count: 300, severity: 'error', fixable: 300, message: 'imported but unused' },
  });
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

test('scan keeps the full header, check/fix only the engines that ran, results none', () => {
  const header = {
    languages: [{ id: 'python', files: 12 }],
    languageSource: 'git',
    engines,
    policy: { downloads: 'ask' },
  };
  const full = ['languages', 'languageSource', 'engines', 'missing', 'policy'];
  const expected = { scan: full, install: full, check: ['engines'], fix: ['engines'], results: [] };
  for (const action of ['scan', 'install', 'check', 'fix', 'results']) {
    const report = buildTidyReport({ action, ...header, scope: ['.'], results: [] });
    for (const key of full) {
      assert.equal(Object.hasOwn(report, key), expected[action].includes(key), `${action}.${key}`);
    }
    assert.equal(Object.hasOwn(report, 'scope'), action !== 'check' && action !== 'fix', `${action}.scope`);
    assert.deepEqual(report.results, []);
  }
  const install = buildTidyReport({ action: 'install', ...header, results: [] });
  assert.deepEqual(
    install.missing.map((engine) => engine.id),
    ['shfmt', 'rustfmt'],
    'install lists every missing engine, covered or not'
  );
});

test('a results page that only overflows its changed-file list still reports paging', () => {
  const report = buildTidyReport({
    action: 'results',
    engines,
    results: [
      {
        id: 'ruff',
        filesChecked: 12,
        filesChanged: Array.from({ length: 12 }, (_unused, index) => `src/f${index}.py`),
        diagnostics: [],
      },
    ],
    limit: 10,
  });
  assert.equal(report.results[0].filesChangedMore, 2);
  assert.deepEqual(report.paging, { offset: 0, limit: 10 });
});

test('a clean check is only the verdict, the engines that ran and per-engine totals', () => {
  const report = buildTidyReport({
    action: 'check',
    languages: [{ id: 'javascript', files: 2 }],
    engines: [
      { id: 'biome', source: 'managed', kind: ['format', 'lint'], languages: ['javascript', 'json'] },
      { id: 'dprint', source: 'managed', kind: ['format'], languages: ['javascript'], skipped: 'no project config' },
      {
        id: 'prettier',
        missing: true,
        kind: ['format'],
        languages: ['javascript', 'markdown'],
        installHint: 'npm i -D prettier',
      },
    ],
    shadows: [{ id: 'biome', via: 'npx-cache', shadow: { path: 'x', version: '1' }, engine: { source: 'managed' } }],
    scope: ['a.js', 'b.js'],
    results: [
      {
        id: 'biome',
        filesChecked: 2,
        filesChanged: [],
        diagnostics: [],
        counts: { filesToFormat: 0, diagnostics: 0, bySeverity: { error: 0 }, byFixability: { safe: 0 } },
      },
    ],
    elapsedMs: 5,
  });
  assert.deepEqual(report, {
    ok: true,
    status: 'complete',
    action: 'check',
    engines: [{ id: 'biome' }],
    results: [{ id: 'biome', filesChecked: 2, diagnosticsCount: 0 }],
    elapsedMs: 5,
  });
});

test('rows keep severity and message only where they differ from their rule summary', () => {
  const rows = [
    { file: 'a.js', line: 1, ruleId: 'no-unused', severity: 'warning', message: "'x' is unused" },
    { file: 'b.js', line: 2, ruleId: 'no-unused', severity: 'error', message: "'y' is unused" },
    { file: 'c.js', line: 3, ruleId: 'no-unused', severity: 'warning', message: "'x' is unused", fix: {} },
  ];
  const report = buildTidyReport({ action: 'check', structural: { matches: rows } });
  assert.deepEqual(report.structural.byRule['no-unused'], {
    count: 3,
    severity: 'error',
    fixable: 1,
    message: "'x' is unused",
  });
  assert.deepEqual(report.structural.matches, [
    { loc: 'a.js:1:0', rule: 'no-unused', severity: 'warning' },
    { loc: 'b.js:2:0', rule: 'no-unused', message: "'y' is unused" },
    { loc: 'c.js:3:0', rule: 'no-unused', severity: 'warning', fix: true },
  ]);
});

test('format-only engines have no byRule, so their rows stay complete', () => {
  const report = buildTidyReport({
    action: 'check',
    engines: [{ id: 'gofumpt', kind: ['format'] }],
    results: [
      {
        id: 'gofumpt',
        diagnostics: [{ file: 'a.go', line: 1, code: 'fmt', severity: 'warning', message: 'reformat' }],
      },
    ],
  });
  assert.deepEqual(report.results[0].diagnostics, [
    { loc: 'a.go:1:0', rule: 'fmt', severity: 'warning', message: 'reformat' },
  ]);
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
  assert.deepEqual(report.results[0].diagnostics[0], { loc: 'src/f0.py:1:1', rule: 'F401', fix: true });
  assert.deepEqual(report.results[0].byRule.F401, {
    count: 1,
    severity: 'error',
    fixable: 1,
    message: 'imported but unused',
  });
  assert.deepEqual(report.structural.matches[0], { loc: 'src/runtime/a.js:2:3', rule: 'no-debugger', fix: true });
  assert.equal(report.structural.byRule['no-debugger'].message, 'Remove debugger.');
  assert.deepEqual(source, original);
  const before = Buffer.byteLength(JSON.stringify(match, null, 2));
  const after = Buffer.byteLength(JSON.stringify(report.structural.matches[0]));
  assert.ok(after < before);
  t.diagnostic(
    `diagnostic row bytes: ${before} pretty/full -> ${after} compact/projected (${(before / after).toFixed(2)}x)`
  );
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
  assert.equal(report.results[1].byRule, undefined);
  assert.equal(report.truncated, true);
  assert.equal(report.ok, true, 'sample trimming is not an engine failure');
});
