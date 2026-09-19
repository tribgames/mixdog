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
    maxBytes: 3000,
  });
  assert.equal(report.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(report), 'utf8') <= 3000, 'report must fit the budget');
  assert.equal(report.results[0].diagnosticsCount, 300);
  assert.ok(report.results[0].diagnostics.length < DIAGNOSTIC_CAP, 'samples must shrink under budget pressure');
  assert.equal(report.results[0].more, 300 - report.results[0].diagnostics.length);
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
  assert.equal(result.diagnostics[0].file, 'src/f20.py');
  assert.equal(result.more, 25);
  assert.equal(result.diagnosticsCount, 55);
  assert.equal(result.offset, 20);
  assert.equal(result.nextOffset, 30);
  assert.equal(result.filesChanged.length, 10);
  assert.equal(result.filesChanged[0], 'src/f20.py');
  assert.equal(result.filesChangedCount, 40);
  assert.equal(report.structural.matches.length, 10);
  assert.equal(report.structural.matches[0].file, 'src/a20.js');
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

test('a structural rule error is not a clean report', () => {
  const report = buildTidyReport({
    action: 'check',
    engines: [],
    structural: {
      adapter: 'graph-binary',
      packs: ['kotlin/todo-marker'],
      matches: [],
      error: { kind: 'rules', language: 'kotlin', message: 'invalid rule' },
      ruleErrors: [{ language: 'kotlin', kind: 'rules', message: 'invalid rule' }],
    },
  });
  assert.equal(report.ok, false);
  assert.equal(report.structural.error.kind, 'rules');
  assert.equal(report.structural.matchesCount, 0);
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
  assert.deepEqual(JSON.parse(ok.content[0].text), { ok: true, action: 'scan' });
  assert.equal(ok.isError, undefined);
  assert.equal(tidyToolResult({ ok: false }, true).isError, true);
});
