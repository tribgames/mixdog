// Runner output parsing, driven from fixture strings: no engine binary is
// installed in CI, and the parsers are the part that can silently drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { parseBiomeJson } from './runners/biome.mjs';
import { parseRuffFormatCheck, parseRuffJson } from './runners/ruff.mjs';
import { parseClangFormatDryRun } from './runners/clang-format.mjs';
import { parseShellcheckJson } from './runners/shellcheck.mjs';
import { parseStyluaCheck } from './runners/stylua.mjs';
import { parseDprintCheck } from './runners/dprint.mjs';
import { parseRustfmtCheck } from './runners/rustfmt.mjs';
import { parseEslintJson } from './runners/eslint.mjs';
import { parsePsScriptAnalyzerJson } from './runners/psscriptanalyzer.mjs';
import { parseAirCheck } from './runners/air.mjs';
import { parseMagoFormatDryRun, parseMagoLintJson } from './runners/mago.mjs';
import { parsePathList, positionAt } from './runners/shared.mjs';
import { RUNNERS, runnerFor } from './runners/index.mjs';
import { fixCandidates } from './run-engines.mjs';
import { fullPathFor, guardTidyWritePath } from './apply.mjs';

const CWD = resolve('/repo');

test('every v1 engine has a runner with the check/fix interface', () => {
  for (const id of ['biome', 'ruff', 'clang-format', 'shfmt', 'shellcheck', 'stylua', 'gofumpt', 'dprint', 'air', 'mago', 'rustfmt', 'gofmt', 'psscriptanalyzer']) {
    const runner = runnerFor(id);
    assert.ok(runner, `${id} runner missing`);
    assert.equal(typeof runner.check, 'function');
    assert.equal(typeof runner.fix, 'function');
  }
  assert.equal(runnerFor('zig'), null);
  assert.ok(RUNNERS.prettier && RUNNERS.eslint, 'project-local engines need runners too');
});

test('biome JSON diagnostics carry positions, categories, and fixability', () => {
  const output = JSON.stringify({
    summary: { changed: 0, unchanged: 2 },
    diagnostics: [
      {
        category: 'lint/style/noVar',
        severity: 'error',
        description: 'Use let or const instead of var.',
        tags: ['fixable'],
        // span starts at the `v` of `var`, i.e. the first byte of line 2.
        location: { path: { file: 'src/a.js' }, span: [13, 16], sourceCode: 'const a = 1;\nvar b = 2;\n' },
      },
      {
        category: 'format',
        severity: 'information',
        description: 'Formatter would have printed the following content:',
        location: { path: { file: 'src/b.js' } },
      },
    ],
  });
  const parsed = parseBiomeJson(output, CWD);
  assert.equal(parsed.diagnostics.length, 2);
  assert.deepEqual(parsed.changedFiles, ['src/b.js']);
  const [lint] = parsed.diagnostics;
  assert.equal(lint.file, 'src/a.js');
  assert.equal(lint.code, 'lint/style/noVar');
  assert.equal(lint.severity, 'error');
  assert.equal(lint.fixable, true);
  assert.equal(lint.line, 2);
  assert.equal(lint.col, 1);
  assert.deepEqual(parseBiomeJson('', CWD), { diagnostics: [], changedFiles: [] });
  assert.deepEqual(parseBiomeJson('not json', CWD), { diagnostics: [], changedFiles: [] });
});

test('ruff lint JSON and format --check are parsed separately', () => {
  const lint = parseRuffJson(JSON.stringify([
    { code: 'F401', message: '`os` imported but unused', filename: `${CWD}/pkg/mod.py`, location: { row: 3, column: 8 }, fix: { applicability: 'safe' } },
    { code: 'E741', message: 'ambiguous variable name', filename: 'pkg/other.py', location: { row: 9, column: 1 }, fix: null },
  ]), CWD);
  assert.equal(lint[0].file, 'pkg/mod.py');
  assert.equal(lint[0].line, 3);
  assert.equal(lint[0].fixable, true);
  assert.equal(lint[1].fixable, false);

  assert.deepEqual(
    parseRuffFormatCheck('Would reformat: pkg/mod.py\nWould reformat: pkg/other.py\n2 files would be reformatted\n', CWD),
    ['pkg/mod.py', 'pkg/other.py'],
  );
  assert.deepEqual(parseRuffJson('[]', CWD), []);
});

test('clang-format dry-run violations become positioned diagnostics', () => {
  const stderr = [
    'src/main.cpp:12:3: warning: code should be clang-formatted [-Wclang-format-violations]',
    'src/main.cpp:40:1: warning: code should be clang-formatted [-Wclang-format-violations]',
    'src/other.c:2:9: error: code should be clang-formatted [-Wclang-format-violations]',
  ].join('\n');
  const parsed = parseClangFormatDryRun(stderr, CWD);
  assert.deepEqual(parsed.changedFiles, ['src/main.cpp', 'src/other.c']);
  assert.equal(parsed.diagnostics.length, 3);
  assert.equal(parsed.diagnostics[0].line, 12);
  assert.equal(parsed.diagnostics[0].col, 3);
  assert.equal(parsed.diagnostics[2].severity, 'error');
  assert.ok(parsed.diagnostics.every((entry) => entry.fixable));
});

test('shellcheck JSON maps levels and fix availability', () => {
  const parsed = parseShellcheckJson(JSON.stringify([
    { file: 'scripts/run.sh', line: 4, column: 7, level: 'warning', code: 2086, message: 'Double quote to prevent globbing', fix: { replacements: [] } },
    { file: 'scripts/run.sh', line: 9, column: 1, level: 'info', code: 2034, message: 'appears unused' },
  ]), CWD);
  assert.equal(parsed[0].code, 'SC2086');
  assert.equal(parsed[0].severity, 'warning');
  assert.equal(parsed[0].fixable, true);
  assert.equal(parsed[1].severity, 'info');
  assert.deepEqual(parseShellcheckJson('', CWD), []);
});

test('list-mode and diff-mode formatters report the files they would rewrite', () => {
  assert.deepEqual(parsePathList('scripts/a.sh\nscripts/b.sh\n\n', CWD), ['scripts/a.sh', 'scripts/b.sh']);
  assert.deepEqual(parseStyluaCheck('Diff in src/init.lua:\n-local a\n+local  a\n', CWD).changedFiles, ['src/init.lua']);
  assert.deepEqual(parseDprintCheck('from src/a.json:\n1| -x\n--- src/b.md ---\n', CWD).changedFiles, ['src/a.json', 'src/b.md']);
  const rustfmt = parseRustfmtCheck('Diff in src/lib.rs at line 10:\n-foo\n+bar\nDiff in src/lib.rs at line 44:\n', CWD);
  assert.deepEqual(rustfmt.changedFiles, ['src/lib.rs']);
  assert.deepEqual(rustfmt.diagnostics.map((entry) => entry.line), [10, 44]);
  const rustfmt19 = parseRustfmtCheck('Diff in src/lib.rs:10:\n-foo\n+bar\nDiff in src/main.rs:44:\n', CWD);
  assert.deepEqual(rustfmt19.changedFiles, ['src/lib.rs', 'src/main.rs']);
  assert.deepEqual(rustfmt19.diagnostics.map((entry) => entry.line), [10, 44]);
});

test('rustfmt --check headers from live rustfmt 1.9 output map to repo-relative files', () => {
  const absLib = resolve(CWD, 'src/lib.rs');
  const extended = `\\\\?\\${absLib}`;
  const posix = `${CWD.replaceAll('\\', '/')}/src/lib.rs`;
  const red = '\u001b[31m';
  const green = '\u001b[32m';
  const reset = '\u001b[0m';
  const live = [
    `Diff in ${extended}:10:`,
    '     fn main() {',
    `${red}-    let x=1;${reset}`,
    `${green}+    let x = 1;${reset}`,
    ' Diff in src/other.rs:99:',
    '-Diff in src/skipped.rs:3:',
    '+Diff in src/skipped.rs:3:',
  ].join('\n');
  const parsed = parseRustfmtCheck(live, CWD);
  assert.deepEqual(parsed.changedFiles, ['src/lib.rs']);
  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.diagnostics[0].file, 'src/lib.rs');
  assert.equal(parsed.diagnostics[0].line, 10);
  assert.equal(parsed.diagnostics[0].code, 'rustfmt');
  assert.equal(parsed.diagnostics[0].severity, 'warning');
  assert.equal(parsed.diagnostics[0].fixable, true);

  const legacy = parseRustfmtCheck(`Diff in ${extended} at line 10:\n`, CWD);
  const modern = parseRustfmtCheck(`Diff in ${extended}:10:\n`, CWD);
  assert.equal(legacy.diagnostics[0].file, modern.diagnostics[0].file);
  assert.equal(legacy.diagnostics[0].file, 'src/lib.rs');
  assert.equal(legacy.diagnostics[0].line, 10);
  assert.equal(modern.diagnostics[0].line, 10);

  const posixParsed = parseRustfmtCheck(`Diff in ${posix}:10:\nDiff in ${posix} at line 44:\n`, CWD);
  assert.deepEqual(posixParsed.changedFiles, ['src/lib.rs']);
  assert.deepEqual(posixParsed.diagnostics.map((entry) => entry.line), [10, 44]);
  assert.equal(posixParsed.diagnostics[0].file, 'src/lib.rs');
  assert.equal(posixParsed.diagnostics[0].code, 'rustfmt');
  assert.equal(posixParsed.diagnostics[0].severity, 'warning');
  assert.equal(posixParsed.diagnostics[0].fixable, true);

  const unc = parseRustfmtCheck('Diff in \\\\?\\UNC\\server\\share\\src\\lib.rs:10:\n', CWD);
  assert.equal(unc.diagnostics.length, 1);
  assert.equal(unc.diagnostics[0].line, 10);
  assert.equal(unc.diagnostics[0].code, 'rustfmt');
  assert.equal(unc.diagnostics[0].severity, 'warning');
  assert.equal(unc.diagnostics[0].fixable, true);
  assert.match(unc.diagnostics[0].file, /^(\\\\|\/\/)/);
  assert.doesNotMatch(unc.diagnostics[0].file, /^UNC\//);
  assert.match(guardTidyWritePath(fullPathFor(CWD, unc.diagnostics[0].file)), /UNC/);
});

test('eslint JSON keeps rule ids, severities, and fixable counts', () => {
  const parsed = parseEslintJson(JSON.stringify([
    {
      filePath: `${CWD}/src/a.js`,
      fixableErrorCount: 1,
      fixableWarningCount: 0,
      messages: [
        { ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used.", line: 3, column: 7, fix: { range: [1, 2], text: '' } },
        { ruleId: 'eqeqeq', severity: 1, message: 'Expected ===', line: 8, column: 5 },
      ],
    },
  ]), CWD);
  assert.deepEqual(parsed.changedFiles, ['src/a.js']);
  assert.equal(parsed.diagnostics[0].severity, 'error');
  assert.equal(parsed.diagnostics[0].fixable, true);
  assert.equal(parsed.diagnostics[1].severity, 'warning');
});

test('PSScriptAnalyzer output separates formatting from analyzer rules', () => {
  const parsed = parsePsScriptAnalyzerJson(JSON.stringify({
    diagnostics: [
      { file: 'tools/deploy.ps1', line: 0, col: 0, code: 'PSFormatting', message: 'Invoke-Formatter would reformat this file', severity: 'Warning', format: true },
      { file: 'tools/deploy.ps1', line: 12, col: 5, code: 'PSAvoidUsingCmdletAliases', message: "'ls' is an alias", severity: 'Warning', format: false },
    ],
  }), CWD);
  assert.deepEqual(parsed.changedFiles, ['tools/deploy.ps1']);
  assert.equal(parsed.diagnostics[1].code, 'PSAvoidUsingCmdletAliases');
  assert.equal(parsed.diagnostics[1].fixable, false);
  assert.deepEqual(parsePsScriptAnalyzerJson('', CWD), { diagnostics: [], changedFiles: [] });
});

test('air --check names the files it would reformat, ANSI and all', () => {
  // `air format --check` prints this on stderr, with the path ANSI-underlined.
  const stderr = 'Would reformat: \u001B[4mR/plot.R\u001B[0m\nWould reformat: R/utils.R\n';
  const parsed = parseAirCheck(stderr, CWD);
  assert.deepEqual(parsed.changedFiles, ['R/plot.R', 'R/utils.R']);
  assert.ok(parsed.diagnostics.every((entry) => entry.fixable && entry.code === 'air'));
  assert.deepEqual(parseAirCheck('', CWD).changedFiles, []);
});

test('mago dry-run headers and lint JSON map onto the shared shape', () => {
  const dryRun = [
    "diff of 'src/Service.php':",
    '--- original',
    '+++ modified',
    "diff of 'src/Model.php':",
  ].join('\n');
  const format = parseMagoFormatDryRun(dryRun, CWD);
  assert.deepEqual(format.changedFiles, ['src/Service.php', 'src/Model.php']);
  assert.ok(format.diagnostics.every((entry) => entry.code === 'mago/format' && entry.fixable));

  // Colorized headers, an absolute path in the host's native form (backslashes
  // on Windows), and output split across the two streams (the caller merges
  // stdout + stderr) must parse the same way.
  const colored = [
    `\u001B[1mdiff of '${resolve(CWD, 'src', 'Colored.php')}'\u001B[0m\u001B[1m:\u001B[0m`,
    '\u001B[31m-old\u001B[0m',
    '', // stdout/stderr join
    "\u001B[32mdiff of 'src/FromStderr.php':\u001B[0m",
  ].join('\n');
  assert.deepEqual(
    parseMagoFormatDryRun(colored, CWD).changedFiles,
    ['src/Colored.php', 'src/FromStderr.php'],
  );
  assert.deepEqual(parseMagoFormatDryRun('', CWD).changedFiles, []);

  // crates/reporting/src/formatter/json.rs → {"issues":[ExpandedIssue]}; the
  // span line is zero-based (crates/database/src/file.rs line_number).
  const lint = parseMagoLintJson(JSON.stringify({
    issues: [
      {
        level: 'Error',
        code: 'no-empty-catch-clause',
        message: 'Empty catch clause.',
        annotations: [{ kind: 'Primary', span: { file_id: { name: 'src/Service.php', size: 120 }, start: { offset: 42, line: 11 }, end: { offset: 60, line: 11 } } }],
        edits: [[{ name: 'src/Service.php' }, [{ range: [42, 60], text: '' }]]],
      },
      {
        level: 'Warning',
        code: 'redundant-parentheses',
        message: 'Redundant parentheses.',
        annotations: [{ kind: 'Primary', span: { file_id: { name: 'src/Model.php' }, start: { offset: 7, line: 0 }, end: { offset: 9, line: 0 } } }],
      },
    ],
  }), CWD);
  assert.equal(lint.length, 2);
  assert.equal(lint[0].file, 'src/Service.php');
  assert.equal(lint[0].line, 12, 'zero-based mago lines become 1-based');
  assert.equal(lint[0].severity, 'error');
  assert.equal(lint[0].fixable, true);
  assert.equal(lint[1].line, 1);
  assert.equal(lint[1].severity, 'warning');
  assert.equal(lint[1].fixable, false);
  assert.deepEqual(parseMagoLintJson('', CWD), []);
});

test('positionAt maps byte offsets to 1-based line/column', () => {
  assert.deepEqual(positionAt('abc\ndef', 0), { line: 1, col: 1 });
  assert.deepEqual(positionAt('abc\ndef', 4), { line: 2, col: 1 });
  assert.deepEqual(positionAt('abc\ndef', 6), { line: 2, col: 3 });
});

test('fix candidates combine would-change files with fixable findings', () => {
  const candidates = fixCandidates({
    changedFiles: ['a.js'],
    diagnostics: [
      { file: 'b.js', fixable: true },
      { file: 'c.js', fixable: false },
      { file: 'a.js', fixable: true },
    ],
  });
  assert.deepEqual(candidates, ['a.js', 'b.js']);
});
