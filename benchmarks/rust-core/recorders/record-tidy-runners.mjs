#!/usr/bin/env node
// Golden twin of the sixteen tidy engine runners (`src/runtime/tidy/runners/*.mjs`). Each scenario runs
// Node's real runner against `lib/fake-engine.mjs`, a scripted binary, and records the argv/stdin/env every
// spawn carried plus the runner's result. Rust `tidy::runners` must ask the same questions and make the
// same answer of the same output.
//
//   node benchmarks/rust-core/recorders/record-tidy-runners.mjs --tree <dir>
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { runnerFor } = await importFrom(tree, 'src/runtime/tidy/runners/index.mjs');
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'fake-engine.mjs');

const scenarios = [];
const add = (runner, mode, name, responses, extra = {}) => scenarios.push({ runner, mode, name, responses, files: ['a.x'], args: [], ...extra });
const both = (runner, name, responses, extra) => ['check', 'fix'].forEach((mode) => add(runner, mode, name, responses, extra));
const ESC = '\u001b';
const long = `${'x'.repeat(590)}😀😀😀 tail\nend`;
const files5 = ['f0.x', 'f1.x', 'f2.x', 'f3.x', 'f4.x'];

// Every runner: the failing/quiet/noisy shapes of a process.
for (const id of ['air', 'clang-format', 'dprint', 'eslint', 'gofmt', 'gofumpt', 'mago', 'prettier', 'ruff', 'rustfmt', 'shellcheck', 'shfmt', 'stylua', 'biome']) {
  both(id, 'quiet', [{}]);
  both(id, 'stderr only', [{ stderr: '  warming up\nsecond line  \n', code: 2 }]);
  both(id, 'long stderr tail', [{ stderr: long, code: 1 }]);
  both(id, 'no files', [{}], { files: [] });
  both(id, 'extra args and chunks', [{ call: 0, stderr: 'one\n' }, { call: 1, stderr: 'two\n' }, { call: 2, stderr: 'three\n' }], { files: files5, args: ['--cfg', 'x y'], filesPerSpawn: 2 });
  both(id, 'timeout', [{ stdout: 'partial\n', sleepMs: 8000 }], { timeoutMs: 500 });
}
both('gofmt', 'timeout default', [{ sleepMs: 8000 }], { timeoutMs: 500 });

// Path-list formatters.
for (const id of ['shfmt', 'gofmt', 'gofumpt', 'prettier']) {
  both(id, 'listing', [{ stdout: `a.sh\n[warn] note\n\n  a.sh \r\nsub\\c.sh\n./d.sh\n{CWD}/e.sh\n`, stderr: 'warn\n' }]);
  both(id, 'chunked listing', [{ call: 0, stdout: 'a\nb\n' }, { call: 1, stdout: 'b\nc\n' }, { call: 2, stdout: '' }], { files: files5, filesPerSpawn: 2 });
}
// Pattern formatters.
const air = (s) => ({ stderr: s, code: 1 });
add('air', 'check', 'reformat list', [air(`Would reformat: R/a.R\n${ESC}[4m{CWD}/R/b.R${ESC}[0m\nWould reformat: R/a.R\nnoise\n  Would reformat:   c.R  \r\n`)]);
add('air', 'check', 'on stdout is ignored', [{ stdout: 'Would reformat: R/a.R\n', stderr: 'real error\n' }]);
add('stylua', 'check', 'diff headers', [{ stdout: 'Diff in a.lua:\nDiff in {CWD}/b.lua\n- old\n+ new\nDiff in a.lua\n', stderr: 'Diff in c.lua:\n', code: 1 }]);
add('stylua', 'check', 'headers on stderr', [{ stderr: 'Diff in x/y.lua:  \n', code: 1 }]);
add('dprint', 'check', 'blocks', [{ stdout: 'from a.json:\n  1 | x\n--- b.md ---\nfrom {CWD}/c.ts:\n', stderr: 'from a.json:\n--- d.md ---\n', code: 1 }]);
add('mago', 'check', 'diff headers and lint', [
  { when: 'format', stdout: `diff of 'a.php':\n- x\n${ESC}[1mdiff of '{CWD}/b.php':${ESC}[0m\n`, stderr: `diff of 'a.php':\n`, code: 1 },
  { when: 'lint', stdout: JSON.stringify({ issues: [
    { level: 'Error', code: 'no-unused', message: 'unused ', annotations: [{ span: { file_id: { name: '{CWD}/a.php' }, start: { line: 4 } } }], edits: [{}] },
    { level: 'warn', code: 'style', message: 'meh', annotations: [{ span: { file_id: { path: 'b.php' }, start: { line: 'x' } } }], edits: [] },
    { level: 'Note', message: 'no code', annotations: [] },
    { level: 'warning', code: 'w', message: 'nested', annotations: [{ span: { file_id: { name: 'c.php' }, start: { line: 0 } } }], edits: 'no' },
  ] }), stderr: 'lint note\n' },
]);
add('mago', 'check', 'lint bare array and junk', [{ when: 'format' }, { when: 'lint', stdout: JSON.stringify([{ level: 'error', code: 'a', message: 'm', annotations: [{ span: { file_id: { name: 'x.php' }, start: { line: 2 } } }] }]) }]);
add('mago', 'check', 'lint malformed', [{ when: 'format' }, { when: 'lint', stdout: '{not json' }]);
add('mago', 'check', 'lint non-object', [{ when: 'format' }, { when: 'lint', stdout: '"text"' }]);
add('mago', 'check', 'lint empty issues object', [{ when: 'format' }, { when: 'lint', stdout: '{"issues":{}}' }]);
add('mago', 'fix', 'fix runs lint then format', [{ when: 'lint', stderr: 'fixed 2\n' }, { when: 'format', stderr: 'formatted\n' }]);
add('mago', 'fix', 'lint failure stops', [{ when: 'lint', sleepMs: 8000 }], { timeoutMs: 500 });
add('mago', 'check', 'format failure stops', [{ when: 'format', sleepMs: 8000 }], { timeoutMs: 500 });

// clang-format
add('clang-format', 'check', 'violations', [{ stderr: [
  'a.c:3:5: error: code should be clang-formatted [-Wclang-format-violations]', '  int  x;', '       ^',
  '{CWD}/src/b.c:10:1: warning: code should be clang-formatted', 'a.c:4:2: warning: second  ', 'not a violation: nope', 'c.c:x:1: error: bad', 'd.c:1:1: note: ignored',
].join('\r\n'), code: 1 }]);
// rustfmt
add('rustfmt', 'check', 'legacy and modern headers', [{ stdout: ['Diff in a.rs at line 3:', ' Diff in ctx.rs:99:', 'Diff in b.rs:12:', 'Diff in \\\\?\\{CWD}\\c.rs:7:', 'Diff in a.rs at line 40:', 'Diff in \\\\?\\UNC\\srv\\share\\d.rs:1:', 'Diff in {CWD}/e.rs at line 1:\r', 'Diff in bad:x:'].join('\n'), code: 1 }]);
add('rustfmt', 'check', 'headers on stderr only', [{ stderr: 'Diff in z.rs:5:\n', code: 1 }]);
add('rustfmt', 'check', 'stdout wins over stderr', [{ stdout: 'Diff in a.rs:1:\n', stderr: 'Diff in b.rs:1:\nerr' }]);
// eslint
const es = (rows) => ({ stdout: JSON.stringify(rows), stderr: 'eslint note\n' });
both('eslint', 'rows', [es([
  { filePath: '{CWD}/a.js', fixableErrorCount: 1, fixableWarningCount: 0, messages: [{ ruleId: 'semi', severity: 2, line: 3, column: 9, message: 'Missing semicolon.', fix: { range: [1, 2] } }, { ruleId: null, severity: 1, message: 'Unused', line: 0 }] },
  { filePath: 'b.js', fixableErrorCount: 0, fixableWarningCount: 2, messages: [{ ruleId: 'x', severity: 0, line: '4', column: '2', message: 5 }] },
  { filePath: 'c.js', messages: 'nope' }, null,
])]);
both('eslint', 'not an array', [{ stdout: '{"a":1}' }]);
both('eslint', 'malformed', [{ stdout: 'oops [' }]);
both('eslint', 'blank', [{ stdout: '   \n' }]);
both('eslint', 'chunked', [{ call: 0, stdout: JSON.stringify([{ filePath: 'a.js', fixableErrorCount: 1, messages: [] }]) }, { call: 1, stdout: JSON.stringify([{ filePath: 'a.js', fixableErrorCount: 1, messages: [] }]) }], { files: files5.slice(0, 4), filesPerSpawn: 2 });
// shellcheck
both('shellcheck', 'rows', [{ stdout: JSON.stringify([
  { file: '{CWD}/a.sh', line: 3, column: 5, level: 'error', code: 2086, message: 'Double quote  ' },
  { file: 'b.sh', line: 1, column: 1, level: 'warning', code: 1090, message: 'w' },
  { file: 'b.sh', level: 'style', message: 'no code' }, { file: 'c.sh', level: 'info', code: 0, message: 'zero' }, {},
]), stderr: 'x\n' }]);
both('shellcheck', 'not json', [{ stdout: 'x' }]);
both('shellcheck', 'object', [{ stdout: '{}' }]);
// ruff
add('ruff', 'check', 'rows and reformat', [
  { when: 'check', stdout: JSON.stringify([{ filename: '{CWD}/a.py', location: { row: 3, column: 7 }, code: 'F401', message: 'unused import', fix: { applicability: 'safe' } }, { filename: 'b.py', message: 'syntax error' }, { filename: 'c.py', code: 7, location: {}, message: 'm', fix: null }]), stderr: 'lint err\n' },
  { when: 'format', stdout: 'Would reformat: a.py\nWould reformat: {CWD}/b.py\nnoise\nWould reformat: a.py\n', stderr: 'fmt err\n', code: 1 },
]);
add('ruff', 'check', 'malformed and object', [{ when: 'check', stdout: '{"a":1}' }, { when: 'format', stdout: '  Would reformat:   x.py  \r\n' }]);
add('ruff', 'check', 'malformed lint', [{ when: 'check', stdout: '[1,' }]);
add('ruff', 'check', 'format step failing', [{ when: 'check', stdout: '[]' }, { when: 'format', sleepMs: 8000 }], { timeoutMs: 500 });
add('ruff', 'fix', 'two writes', [{ when: 'check', stderr: 'Found 2 errors (2 fixed)\n' }, { when: 'format', stderr: '1 file reformatted\n' }]);
add('ruff', 'fix', 'lint failure stops', [{ when: 'check', sleepMs: 8000 }], { timeoutMs: 500 });

// biome
const bdiag = (category, extra = {}) => ({ category, severity: 'error', description: 'Some  thing\n happened', location: { path: { file: 'a.js' }, span: [4, 9], sourceCode: 'ab\ncdefgh\n' }, ...extra });
const bjson = (rows, summary = {}) => JSON.stringify({ summary: { errors: rows.length, ...summary }, diagnostics: rows });
add('biome', 'check', 'mixed diagnostics with explain', [
  { when: 'explain', stdout: 'Fix: ...\n- Fix: safe\n', call: undefined },
  { when: 'check', stdout: bjson([
    bdiag('format', { location: { path: 'src/f.js' } }),
    bdiag('lint/style/useConst', { tags: ['fixable'] }),
    bdiag('lint/suspicious/noDebugger', { tags: ['unsafe'], suggestions: [{}] }),
    bdiag('lint/style/noVar', { suggestions: [] }),
    bdiag('assist/source/organizeImports', { severity: 'warning' }),
    bdiag('parse', { severity: 'fatal', location: { path: { file: '{CWD}/p.js' }, start: { line: 2, column: 3 } } }),
    bdiag('lint/a11y/x', { severity: 'information', code: { value: 'v' }, location: { range: { start: { line: 5, column: 6 } } } }),
  ]), stderr: 'The `json` and `json-pretty` reporters are experimental\ncheck ━━━━\n× Some errors were emitted while running checks.\nreal stderr\n', code: 1 },
], { unordered: true });
add('biome', 'check', 'explain verdicts', [
  { when: 'explain', stdout: '- Fix: unsafe\n', call: 1 }, { when: 'explain', stdout: 'No fix available.\n', call: 2 }, { when: 'explain', stdout: '- Fix: safe\n', call: 3 },
  { when: 'check', stdout: bjson([bdiag('lint/a/r1'), bdiag('lint/a/r2'), bdiag('lint/a/r3')]) },
], { unordered: true });
add('biome', 'check', 'two documents and notprinted', [{ stdout: `${bjson([bdiag('format')])}\nnoise {"x":1}\n${bjson([bdiag('lint/z/q', { tags: ['fixable'] })], { diagnosticsNotPrinted: 3 })}` }], { unordered: true });
add('biome', 'check', 'truncated mid-array recovers rows', [{ stdout: `{"summary":{},"diagnostics":[${JSON.stringify(bdiag('format'))},${JSON.stringify(bdiag('lint/s/a', { tags: ['fixable'] })).slice(0, 40)}` }], { unordered: true });
add('biome', 'check', 'truncated nothing', [{ stdout: '{"summary":{"errors":' }]);
add('biome', 'check', 'garbage without braces', [{ stdout: 'just text' }]);
add('biome', 'check', 'garbage then truncated', [{ stdout: 'x {"a":[1,2' }]);
add('biome', 'check', 'chunks merge', [{ call: 0, stdout: bjson([bdiag('format', { location: { path: 'a.js' } })]) }, { call: 1, stdout: bjson([bdiag('format', { location: { path: 'a.js' } }), bdiag('format', { location: { path: 'b.js' } })]) }], { files: files5.slice(0, 4), filesPerSpawn: 2 });
add('biome', 'fix', 'legacy flag falls back', [{ when: '--write', stderr: 'error: unexpected argument --write', code: 2 }, { when: '--apply', stderr: 'applied\n' }]);
add('biome', 'fix', 'unknown option fallback ignored on code 0', [{ when: '--write', stderr: 'unknown option noted' }]);
add('biome', 'fix', 'no fallback on other failures', [{ when: '--write', stderr: 'boom', code: 1 }]);

// dotnet-format
const dn = (rows) => JSON.stringify(rows);
add('dotnet-format', 'check', 'report with changes', [{ report: `\uFEFF${dn([
  { FilePath: '{CWD}/src/A.cs', FileChanges: [{ LineNumber: 3, CharNumber: 5, FormatDescription: 'Fix whitespace formatting.' }, { Line: 9, Column: 2, Message: ' second ' }, {}] },
  { filePath: 'src/B.cs', fileChanges: [] }, { fileName: 'C.cs' }, { FilePath: '' }, null,
])}`, code: 2, stderr: 'verify failed\n' }], { files: ['src/A.cs', 'src/B.cs', 'C.cs', 'src/sub/D.cs'] });
add('dotnet-format', 'check', 'report object shapes', [{ report: JSON.stringify({ DocumentReports: [{ FileName: 'x/Y.cs', Changes: [{ lineNumber: 1, charNumber: 2 }] }] }), code: 2 }], { files: ['x/Y.cs'] });
add('dotnet-format', 'check', 'files object', [{ report: JSON.stringify({ files: [{ FilePath: 'k.cs' }] }), code: 2 }], { files: ['k.cs'] });
add('dotnet-format', 'check', 'failure without report', [{ code: 1, stderr: 'internal error\n' }], { files: ['a/B.cs'] });
add('dotnet-format', 'check', 'clean', [{ code: 0, stderr: 'ok\n' }], { files: ['a/B.cs'] });
add('dotnet-format', 'check', 'malformed report', [{ report: '{oops', code: 0 }], { files: ['a/B.cs'] });
add('dotnet-format', 'check', 'missing sdk', [{ code: 1, stderr: 'Could not execute because the specified command or file was not found.' }], { files: ['a/B.cs'] });
add('dotnet-format', 'check', 'old sdk', [{ code: 1, stdout: 'Unrecognized command or argument whitespace' }], { files: ['a/B.cs'] });
add('dotnet-format', 'check', 'timeout', [{ sleepMs: 8000 }], { files: ['a/B.cs'], timeoutMs: 500 });
add('dotnet-format', 'check', 'folders and chunks', [{ call: 0, report: dn([{ FilePath: 'a/1.cs' }]), code: 2 }, { call: 1, report: dn([{ FilePath: 'a/3.cs' }]), code: 2 }, { call: 2, report: dn([{ FilePath: 'b/4.cs' }]), code: 2 }, { call: 3, code: 0 }], { files: ['a/1.cs', 'a/2.cs', 'a/3.cs', 'b/4.cs', 'top.cs'], filesPerSpawn: 2, args: ['--x'] });
add('dotnet-format', 'fix', 'writes without report', [{ code: 0, stderr: 'formatted\n' }], { files: ['a/B.cs', 'C.cs'] });
add('dotnet-format', 'fix', 'unsupported', [{ code: 1, stderr: 'dotnet-format does not exist' }], { files: ['a/B.cs'] });
add('dotnet-format', 'fix', 'no files', [{}], { files: [] });

// psscriptanalyzer
const pss = (rows, modulePath) => JSON.stringify({ diagnostics: rows, ...(modulePath === undefined ? {} : { modulePath }) });
both('psscriptanalyzer', 'rows and module', [{ stdout: pss([
  { file: '{CWD}/a.ps1', line: 0, col: 0, code: 'PSFormatting', message: 'Invoke-Formatter would reformat this file', severity: 'Warning', format: true },
  { file: 'a.ps1', line: 3, col: 5, code: 'PSAvoidUsingCmdletAliases', message: 'alias', severity: 'Warning', format: false },
  { file: 'b.ps1', line: 1, col: 1, code: 'x', message: 'parse', severity: 'ParseError' }, { file: 'c.ps1', severity: 'Information' }, { file: 'd.ps1', severity: 'Error', message: 'e' },
], 'C:/Mods/PSScriptAnalyzer.psd1'), stderr: 'warn\n' }], { files: ['a.ps1', 'b.ps1'], modulePath: 'C:/Mods/PSScriptAnalyzer.psd1' });
both('psscriptanalyzer', 'chunks of four', [{ call: 0, stdout: pss([{ file: 'a.ps1', format: true, severity: 'Warning', message: 'm' }], 'M1') }, { call: 1, stdout: pss([{ file: 'f4.ps1', format: true, message: 'm' }], '') }], { files: ['a.ps1', 'f1.ps1', 'f2.ps1', 'f3.ps1', 'f4.ps1'] });
both('psscriptanalyzer', 'malformed and not diagnostics', [{ stdout: 'x' }, { stdout: '{"diagnostics":5}' }], { files: ['a.ps1'] });
both('psscriptanalyzer', 'blank', [{ stdout: ' ' }], { files: ['a.ps1'] });
both('psscriptanalyzer', 'no files', [{}], { files: [] });
both('psscriptanalyzer', 'timeout', [{ sleepMs: 8000 }], { files: ['a.ps1'], timeoutMs: 500 });

// Run everything.
const work = mkdtempSync(join(tmpdir(), 'tidy-runners-'));
const cwd = join(work, 'repo');
mkdirSync(cwd, { recursive: true });
const plain = (v) => JSON.parse(JSON.stringify(v));
const sub = (value) => JSON.parse(JSON.stringify(value).replaceAll('{CWD}', cwd.replaceAll('\\', '\\\\')));
const cases = [];
for (const [at, s] of scenarios.entries()) {
  const log = join(work, `log-${at}.jsonl`);
  const scenarioPath = join(work, `scenario-${at}.json`);
  writeFileSync(scenarioPath, JSON.stringify({ log, responses: sub(s.responses) }));
  const runner = runnerFor(s.runner);
  const result = await runner[s.mode]({
    files: s.files, cwd, bin: process.execPath, args: [FAKE, scenarioPath, ...s.args],
    timeoutMs: s.timeoutMs ?? 30_000, ...(s.filesPerSpawn ? { filesPerSpawn: s.filesPerSpawn } : {}), ...(s.modulePath ? { modulePath: s.modulePath } : {}),
  });
  let calls = [];
  try {
    calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    /* never spawned */
  }
  // The cwd differs between machines: it may only appear in the recorded text as the placeholder.
  const back = (value) => JSON.parse(JSON.stringify(value).replaceAll(cwd.replaceAll('\\', '\\\\'), '{CWD}'));
  cases.push({ ...s, calls: back(calls), result: back(plain(result)) });
}
rmSync(work, { recursive: true, force: true });

writeJson(join(FIXTURES_ROOT, 'services', 'tidy-runners-twin.json'), {
  domain: 'tidy-runners-twin',
  recorder: 'benchmarks/rust-core/recorders/record-tidy-runners.mjs',
  cases,
});
console.log(`recorded ${cases.length} runner scenarios`);
