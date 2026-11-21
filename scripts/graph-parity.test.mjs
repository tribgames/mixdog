import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  compareManifests,
  compareWalks,
  evaluateGate,
  formatMarkdown,
  kindMapActive,
  loadKindMap,
  matchSymbols,
  parseArgs,
  parseJsonl,
  parseKindMap,
  parseLangsStdout,
  runParity,
} from './graph-parity.mjs';

const SCRIPT = resolve('scripts/graph-parity.mjs');

function rec(overrides = {}) {
  return {
    rel: 'src/a.js',
    lang: 'javascript',
    fp: 'fp',
    size: 1,
    parseError: '',
    rawImports: [],
    packageName: '',
    namespaceName: '',
    goPackageName: '',
    topLevelTypes: [],
    resolvedImports: [],
    importedBy: [],
    symbols: [],
    ...overrides,
  };
}

function sym(name, kind, startLine, startCol = 1, endCol = name.length + 1) {
  return { name, kind, startLine, startCol, endCol };
}

function tempDir(t, prefix = 'graph-parity-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(dir, name, records) {
  const path = join(dir, name);
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return path;
}

function runCli(args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error?.killed) reject(new Error(`CLI timed out after ${timeoutMs}ms\n${stderr}${stdout}`));
        else resolvePromise({ code: error ? error.code : 0, stdout, stderr });
      }
    );
  });
}

test('parseArgs accepts binaries, jsonl, files, and thresholds', () => {
  const opts = parseArgs([
    '--old',
    'old.exe',
    '--new',
    'new.exe',
    '--root',
    'src',
    '--files',
    'a.js',
    'b.ts',
    '--json',
    'out.json',
    '--max-symbol-loss',
    '2',
    '--max-import-diff',
    '3',
    '--max-time-ratio',
    '1.25',
    '--runs',
    '5',
    '--kind-map',
    'kinds.json',
    '--tokens',
    '--max-token-loss',
    '4',
    '--allow-new-languages',
    'haskell,hcl',
    'solidity',
  ]);
  assert.equal(opts.old, 'old.exe');
  assert.equal(opts.new, 'new.exe');
  assert.deepEqual(opts.files, ['a.js', 'b.ts']);
  assert.equal(opts.maxSymbolLoss, 2);
  assert.equal(opts.runs, 5);
  assert.equal(opts.kindMap, 'kinds.json');
  assert.equal(opts.tokens, true);
  assert.equal(opts.maxTokenLoss, 4);
  assert.deepEqual(opts.allowNewLanguages, ['haskell', 'hcl', 'solidity']);
  const jsonl = parseArgs(['--old-jsonl', 'o.jsonl', '--new-jsonl', 'n.jsonl']);
  assert.equal(jsonl.oldJsonl, 'o.jsonl');
  assert.throws(() => parseArgs(['--old', 'x']), /--new/);
});

test('matchSymbols classifies LOSS, ADDITION, KIND_CHANGE, COL_DRIFT', () => {
  const { loss, addition, kindChange, colDrift } = matchSymbols(
    [
      sym('keep', 'function', 1, 1, 5),
      sym('gone', 'function', 2),
      sym('renamedKind', 'function', 3),
      sym('drift', 'function', 4, 1, 6),
    ],
    [
      sym('keep', 'function', 1, 1, 5),
      sym('added', 'class', 8),
      sym('renamedKind', 'method', 3),
      sym('drift', 'function', 4, 4, 9),
    ]
  );
  assert.deepEqual(
    loss.map((s) => s.name),
    ['gone']
  );
  assert.deepEqual(
    addition.map((s) => s.name),
    ['added']
  );
  assert.equal(kindChange.length, 1);
  assert.equal(kindChange[0].old.kind, 'function');
  assert.equal(kindChange[0].new.kind, 'method');
  assert.equal(colDrift.length, 1);
  assert.equal(colDrift[0].old.name, 'drift');
});

test('compareWalks aggregates by language and counts import/scalar/file-only diffs', () => {
  const report = aggregateByLanguageFixture();
  assert.equal(report.totals.loss, 1);
  assert.equal(report.totals.addition, 1);
  assert.equal(report.totals.importDiff, 1);
  assert.equal(report.totals.scalar, 1);
  assert.deepEqual(report.filesOnlyOld, ['src/only-old.py']);
  assert.deepEqual(report.filesOnlyNew, ['src/only-new.go']);
  assert.equal(report.byLanguage.javascript.LOSS.count, 1);
  assert.equal(report.byLanguage.javascript.ADDITION.count, 1);
  assert.equal(report.byLanguage.javascript.IMPORT.count, 1);
  assert.equal(report.byLanguage.python.FILE_ONLY_OLD.count, 1);
  assert.equal(report.byLanguage.go.FILE_ONLY_NEW.count, 1);
  assert.equal(report.byLanguage.rust.LOSS.count, 0);
});

test('formatMarkdown renders one section per language with its diff kinds', () => {
  const report = aggregateByLanguageFixture();
  const md = formatMarkdown({
    ...report,
    old: 'old',
    new: 'new',
    root: '.',
    manifestIdentical: true,
    timing: { oldMs: 10, newMs: 11, ratio: 1.1, runs: 3 },
    reasons: evaluateGate(report, { maxSymbolLoss: 0, maxImportDiff: 0, maxTimeRatio: 1.1 }),
  });
  assert.match(md, /## javascript/);
  assert.match(md, /## python/);
  assert.match(md, /LOSS/);
});

function aggregateByLanguageFixture() {
  const oldRecords = [
    rec({
      rel: 'src/a.js',
      lang: 'javascript',
      symbols: [sym('alpha', 'function', 1), sym('lost', 'function', 2)],
      rawImports: ['./b.js'],
      resolvedImports: ['src/b.js'],
      packageName: 'pkg',
    }),
    rec({ rel: 'src/only-old.py', lang: 'python', symbols: [sym('x', 'function', 1)] }),
    rec({ rel: 'src/c.rs', lang: 'rust', symbols: [sym('ok', 'function', 1, 1, 3)] }),
  ];
  const newRecords = [
    rec({
      rel: 'src/a.js',
      lang: 'javascript',
      symbols: [sym('alpha', 'function', 1), sym('fresh', 'function', 9)],
      rawImports: ['./b.js', './extra.js'],
      resolvedImports: ['src/b.js'],
      packageName: 'other',
    }),
    rec({ rel: 'src/only-new.go', lang: 'go', symbols: [sym('y', 'function', 1)] }),
    rec({ rel: 'src/c.rs', lang: 'rust', symbols: [sym('ok', 'function', 1, 1, 3)] }),
  ];
  return compareWalks(oldRecords, newRecords);
}

test('evaluateGate fails on LOSS, import diffs, time ratio, manifest, and one-sided files', () => {
  const base = compareWalks(
    [rec({ rel: 'a.js', symbols: [sym('a', 'function', 1)] })],
    [rec({ rel: 'a.js', symbols: [sym('a', 'function', 1)] })]
  );
  assert.deepEqual(
    evaluateGate({ ...base, manifestIdentical: true }, { maxSymbolLoss: 0, maxImportDiff: 0, maxTimeRatio: 1.1 }),
    []
  );

  const loss = compareWalks(
    [rec({ symbols: [sym('a', 'function', 1), sym('b', 'function', 2)] })],
    [rec({ symbols: [sym('a', 'function', 1)] })]
  );
  assert.match(evaluateGate(loss, { maxSymbolLoss: 0 }).join('\n'), /LOSS 1/);
  assert.equal(evaluateGate(loss, { maxSymbolLoss: 1 }).length, 0);

  const imports = compareWalks([rec({ rawImports: ['a'] })], [rec({ rawImports: ['b'] })]);
  assert.match(evaluateGate(imports, { maxImportDiff: 0 }).join('\n'), /import diffs 2/);
  assert.equal(evaluateGate(imports, { maxImportDiff: 2 }).length, 0);

  assert.match(
    evaluateGate(
      {
        ...base,
        timing: { ratio: 1.2 },
      },
      { maxTimeRatio: 1.1 }
    ).join('\n'),
    /time ratio/
  );

  assert.match(evaluateGate({ ...base, manifestIdentical: false }, {}).join('\n'), /manifest/);

  const oneSide = compareWalks([rec({ rel: 'a.js' })], [rec({ rel: 'b.js', lang: 'python' })]);
  assert.match(evaluateGate(oneSide, {}).join('\n'), /files only on one side/);
});

test('CLI jsonl mode: identical records exit 0', async (t) => {
  const dir = tempDir(t);
  const records = [rec({ symbols: [sym('alpha', 'function', 1)] })];
  const oldPath = writeJsonl(dir, 'old.jsonl', records);
  const newPath = writeJsonl(dir, 'new.jsonl', records);
  const jsonPath = join(dir, 'out.json');
  const result = await runCli(['--old-jsonl', oldPath, '--new-jsonl', newPath, '--json', jsonPath]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\*\*PASS\*\*/);
  const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.equal(json.ok, true);
  assert.equal(json.totals.loss, 0);
});

test('CLI jsonl mode: LOSS and import diffs exit 1; ADDITION-only does not', async (t) => {
  const dir = tempDir(t);
  const lossOld = writeJsonl(dir, 'loss-old.jsonl', [
    rec({ symbols: [sym('keep', 'function', 1), sym('gone', 'function', 2)] }),
  ]);
  const lossNew = writeJsonl(dir, 'loss-new.jsonl', [rec({ symbols: [sym('keep', 'function', 1)] })]);
  const loss = await runCli(['--old-jsonl', lossOld, '--new-jsonl', lossNew]);
  assert.equal(loss.code, 1);
  assert.match(loss.stdout, /LOSS/);
  assert.match(loss.stdout, /\*\*FAIL\*\*/);

  const addOld = writeJsonl(dir, 'add-old.jsonl', [rec({ symbols: [sym('keep', 'function', 1)] })]);
  const addNew = writeJsonl(dir, 'add-new.jsonl', [
    rec({ symbols: [sym('keep', 'function', 1), sym('extra', 'function', 2)] }),
  ]);
  const addition = await runCli(['--old-jsonl', addOld, '--new-jsonl', addNew]);
  assert.equal(addition.code, 0, addition.stdout);
  assert.match(addition.stdout, /ADDITION/);

  const impOld = writeJsonl(dir, 'imp-old.jsonl', [rec({ rawImports: ['a'], resolvedImports: ['src/a.js'] })]);
  const impNew = writeJsonl(dir, 'imp-new.jsonl', [rec({ rawImports: ['b'], resolvedImports: ['src/a.js'] })]);
  const imports = await runCli(['--old-jsonl', impOld, '--new-jsonl', impNew]);
  assert.equal(imports.code, 1);
  assert.match(imports.stdout, /IMPORT/);
});

test('CLI jsonl mode: KIND_CHANGE, COL_DRIFT, one-sided files, thresholds, language aggregation', async (t) => {
  const dir = tempDir(t);
  const kindOld = writeJsonl(dir, 'kind-old.jsonl', [rec({ symbols: [sym('foo', 'function', 4)] })]);
  const kindNew = writeJsonl(dir, 'kind-new.jsonl', [rec({ symbols: [sym('foo', 'method', 4)] })]);
  const kind = await runCli(['--old-jsonl', kindOld, '--new-jsonl', kindNew]);
  assert.equal(kind.code, 0);
  assert.match(kind.stdout, /KIND_CHANGE/);

  const colOld = writeJsonl(dir, 'col-old.jsonl', [rec({ symbols: [sym('foo', 'function', 4, 1, 4)] })]);
  const colNew = writeJsonl(dir, 'col-new.jsonl', [rec({ symbols: [sym('foo', 'function', 4, 8, 11)] })]);
  const col = await runCli(['--old-jsonl', colOld, '--new-jsonl', colNew]);
  assert.equal(col.code, 0);
  assert.match(col.stdout, /COL_DRIFT/);

  const sideOld = writeJsonl(dir, 'side-old.jsonl', [
    rec({ rel: 'a.js', lang: 'javascript', symbols: [sym('a', 'function', 1)] }),
    rec({ rel: 'gone.py', lang: 'python', symbols: [sym('p', 'function', 1)] }),
  ]);
  const sideNew = writeJsonl(dir, 'side-new.jsonl', [
    rec({ rel: 'a.js', lang: 'javascript', symbols: [sym('a', 'function', 1)] }),
    rec({ rel: 'new.go', lang: 'go', symbols: [sym('g', 'function', 1)] }),
  ]);
  const jsonPath = join(dir, 'side.json');
  const side = await runCli(['--old-jsonl', sideOld, '--new-jsonl', sideNew, '--json', jsonPath]);
  assert.equal(side.code, 1);
  assert.match(side.stdout, /## python/);
  assert.match(side.stdout, /## go/);
  const json = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.equal(json.byLanguage.python.FILE_ONLY_OLD.count, 1);
  assert.equal(json.byLanguage.go.FILE_ONLY_NEW.count, 1);

  const lossOld = writeJsonl(dir, 'thr-old.jsonl', [
    rec({ symbols: [sym('a', 'function', 1), sym('b', 'function', 2)] }),
  ]);
  const lossNew = writeJsonl(dir, 'thr-new.jsonl', [rec({ symbols: [sym('a', 'function', 1)] })]);
  const allowed = await runCli(['--old-jsonl', lossOld, '--new-jsonl', lossNew, '--max-symbol-loss', '1']);
  assert.equal(allowed.code, 0);
  const blocked = await runCli(['--old-jsonl', lossOld, '--new-jsonl', lossNew, '--max-symbol-loss', '0']);
  assert.equal(blocked.code, 1);
});

test('parseJsonl rejects malformed records', () => {
  assert.deepEqual(
    parseJsonl('{"rel":"a.js","lang":"javascript"}\n\n').map((r) => r.rel),
    ['a.js']
  );
  assert.throws(() => parseJsonl('{'), /invalid JSONL/);
  assert.throws(() => parseJsonl('{"lang":"javascript"}'), /missing string rel/);
});

test('missing symbols, empty walks, duplicate keys, and Windows rel separators', () => {
  const missing = compareWalks(
    [{ rel: 'a.js', lang: 'javascript', rawImports: [] }, rec({ rel: 'b.js', symbols: undefined })],
    [rec({ rel: 'a.js', symbols: [sym('a', 'function', 1)] }), rec({ rel: 'b.js', symbols: [sym('b', 'function', 1)] })]
  );
  assert.equal(missing.totals.addition, 2);
  assert.equal(missing.totals.loss, 0);

  const empty = compareWalks([], []);
  assert.equal(empty.filesCompared, 0);
  assert.deepEqual(evaluateGate(empty, {}), []);

  const emptyVsOne = compareWalks([], [rec({ rel: 'only.js' })]);
  assert.deepEqual(emptyVsOne.filesOnlyNew, ['only.js']);
  assert.match(evaluateGate(emptyVsOne, {}).join('\n'), /files only on one side/);

  const emptyCliOld = parseJsonl('');
  const emptyCliNew = parseJsonl('\n\n');
  assert.deepEqual(emptyCliOld, []);
  assert.deepEqual(emptyCliNew, []);

  const dups = matchSymbols([sym('dup', 'function', 1), sym('dup', 'function', 1)], [sym('dup', 'function', 1)]);
  assert.equal(dups.loss.length, 1);
  assert.equal(dups.addition.length, 0);

  const kindFromDup = matchSymbols(
    [sym('dup', 'function', 1), sym('dup', 'method', 1)],
    [sym('dup', 'function', 1), sym('dup', 'function', 1)]
  );
  assert.equal(kindFromDup.kindChange.length, 1);
  assert.equal(kindFromDup.loss.length, 0);
  assert.equal(kindFromDup.addition.length, 0);

  const mixedSeps = compareWalks(
    [rec({ rel: 'src\\pkg\\a.js', symbols: [sym('alpha', 'function', 1)] })],
    [rec({ rel: 'src/pkg/a.js', symbols: [sym('alpha', 'function', 1)] })]
  );
  assert.equal(mixedSeps.filesCompared, 1);
  assert.equal(mixedSeps.filesOnlyOld.length, 0);
  assert.equal(mixedSeps.filesOnlyNew.length, 0);
  assert.equal(mixedSeps.totals.loss, 0);

  const parsed = parseJsonl('{"rel":"src\\\\win\\\\a.js","lang":"javascript","symbols":[]}\n');
  assert.equal(parsed[0].rel, 'src/win/a.js');
});

test('CLI jsonl mode: empty output, missing symbols, backslash rels', async (t) => {
  const dir = tempDir(t);
  const emptyOld = writeJsonl(dir, 'empty-old.jsonl', []);
  const emptyNew = writeJsonl(dir, 'empty-new.jsonl', []);
  const empty = await runCli(['--old-jsonl', emptyOld, '--new-jsonl', emptyNew]);
  assert.equal(empty.code, 0, empty.stderr || empty.stdout);

  const missOld = join(dir, 'miss-old.jsonl');
  const missNew = join(dir, 'miss-new.jsonl');
  writeFileSync(missOld, `${JSON.stringify({ rel: 'a.js', lang: 'javascript' })}\n`);
  writeFileSync(missNew, `${JSON.stringify({ rel: 'a.js', lang: 'javascript' })}\n`);
  const missing = await runCli(['--old-jsonl', missOld, '--new-jsonl', missNew]);
  assert.equal(missing.code, 0, missing.stderr || missing.stdout);

  const slashOld = writeJsonl(dir, 'slash-old.jsonl', [
    rec({ rel: 'src\\a.js', symbols: [sym('alpha', 'function', 1)] }),
  ]);
  const slashNew = writeJsonl(dir, 'slash-new.jsonl', [
    rec({ rel: 'src/a.js', symbols: [sym('alpha', 'function', 1)] }),
  ]);
  const slashes = await runCli(['--old-jsonl', slashOld, '--new-jsonl', slashNew]);
  assert.equal(slashes.code, 0, slashes.stderr || slashes.stdout);
  assert.match(slashes.stdout, /\*\*PASS\*\*/);
});

test('missing binary exits non-zero without hanging', async () => {
  const result = await runCli(
    [
      '--old',
      join(tmpdir(), 'no-such-mixdog-graph-old.exe'),
      '--new',
      join(tmpdir(), 'no-such-mixdog-graph-new.exe'),
      '--runs',
      '1',
    ],
    { timeoutMs: 10_000 }
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /graph-parity:/);
});

test('parseKindMap reads --langs and per-language kinds objects', () => {
  const fromLangs = parseKindMap({
    languages: [
      { id: 'javascript', kinds: { function: 'method' } },
      { id: 'python', kinds: { function: 'function' } },
      { id: 'go' },
    ],
    callsFormat: 2,
  });
  assert.equal(fromLangs.javascript.function, 'method');
  assert.equal(fromLangs.python.function, 'function');
  assert.equal(fromLangs.go, undefined);
  const nested = parseKindMap({ javascript: { kinds: { class: 'class' } }, rust: { function: 'fn' } });
  assert.equal(nested.javascript.class, 'class');
  assert.equal(nested.rust.function, 'fn');
  assert.deepEqual(parseLangsStdout('{"languages":[{"id":"hcl","kinds":{"block":"block"}}]}\n'), {
    hcl: { block: 'block' },
  });
  assert.deepEqual(parseKindMap({ languages: [{ id: 'javascript' }] }), {});
  assert.deepEqual(parseLangsStdout('{"languages":[{"id":"javascript","extensions":["js"]}]}'), {});
  assert.equal(kindMapActive(parseLangsStdout('{"languages":[{"id":"javascript"}]}')), false);
});

const JS_KIND_MAP = { javascript: { function: 'method', class: 'class' } };

test('matchSymbols counts a declared kind remap as KIND_MAPPED', () => {
  const mapped = matchSymbols([sym('foo', 'function', 4)], [sym('foo', 'method', 4)], JS_KIND_MAP.javascript);
  assert.equal(mapped.kindMapped.length, 1);
  assert.equal(mapped.kindChange.length, 0);
  assert.equal(mapped.kindMapped[0].old.kind, 'function');
  assert.equal(mapped.kindMapped[0].new.kind, 'method');
});

test('matchSymbols keeps an undeclared kind remap as KIND_CHANGE', () => {
  const unmappedChange = matchSymbols([sym('Bar', 'class', 1)], [sym('Bar', 'interface', 1)], JS_KIND_MAP.javascript);
  assert.equal(unmappedChange.kindChange.length, 1);
  assert.equal(unmappedChange.kindMapped.length, 0);
});

test('compareWalks fails the gate on a kind missing from the kind map', () => {
  const map = JS_KIND_MAP;
  const report = compareWalks(
    [rec({ symbols: [sym('foo', 'function', 4), sym('Bar', 'class', 8), sym('miss', 'enum', 9)] })],
    [rec({ symbols: [sym('foo', 'method', 4), sym('Bar', 'class', 8), sym('miss', 'enum', 9)] })],
    { kindMap: map }
  );
  assert.equal(report.totals.kindMapped, 1);
  assert.equal(report.totals.kindChange, 0);
  assert.equal(report.kindMapActive, true);
  assert.deepEqual(report.unmappedKinds, [{ lang: 'javascript', kind: 'enum' }]);
  const reasons = evaluateGate(report, {});
  assert.match(reasons.join('\n'), /unmapped kind: javascript:enum/);
});

test('compareWalks reports a remap outside the kind map as KIND_CHANGE and fails the gate', () => {
  const map = JS_KIND_MAP;
  const unexpected = compareWalks(
    [rec({ symbols: [sym('foo', 'function', 4), sym('Bar', 'class', 1)] })],
    [rec({ symbols: [sym('foo', 'class', 4), sym('Bar', 'class', 1)] })],
    { kindMap: map }
  );
  assert.equal(unexpected.totals.kindChange, 1);
  assert.equal(unexpected.totals.kindMapped, 0);
  assert.match(evaluateGate(unexpected, {}).join('\n'), /KIND_CHANGE 1/);
});

test('matchSymbols counts a kind remap and a column drift on the same symbol', () => {
  const both = matchSymbols(
    [sym('foo', 'function', 4, 1, 4)],
    [sym('foo', 'method', 4, 8, 12)],
    JS_KIND_MAP.javascript
  );
  assert.equal(both.kindMapped.length, 1);
  assert.equal(both.colDrift.length, 1);
  assert.equal(both.kindChange.length, 0);
  assert.equal(both.loss.length, 0);
  assert.equal(both.addition.length, 0);
});

test('matchSymbols maps kinds independently for symbols sharing a name and line', () => {
  const shared = matchSymbols(
    [sym('foo', 'function', 4), sym('foo', 'class', 4)],
    [sym('foo', 'struct', 4), sym('foo', 'method', 4)],
    { function: 'method', class: 'struct' }
  );
  assert.equal(shared.kindMapped.length, 2);
  assert.equal(shared.kindChange.length, 0);
  assert.deepEqual(shared.kindMapped.map((item) => `${item.old.kind}->${item.new.kind}`).sort(), [
    'class->struct',
    'function->method',
  ]);
});

test('compareWalks applies the kind map per language', () => {
  const perLang = compareWalks(
    [
      rec({ rel: 'a.js', lang: 'javascript', symbols: [sym('foo', 'function', 1)] }),
      rec({ rel: 'a.py', lang: 'python', symbols: [sym('foo', 'function', 1)] }),
    ],
    [
      rec({ rel: 'a.js', lang: 'javascript', symbols: [sym('foo', 'method', 1)] }),
      rec({ rel: 'a.py', lang: 'python', symbols: [sym('foo', 'function', 1)] }),
    ],
    { kindMap: { javascript: { function: 'method' }, python: { function: 'function' } } }
  );
  assert.equal(perLang.totals.kindMapped, 1);
  assert.equal(perLang.byLanguage.javascript.KIND_MAPPED.count, 1);
  assert.equal(perLang.byLanguage.python.KIND_MAPPED.count, 0);
  assert.equal(perLang.byLanguage.python.KIND_CHANGE.count, 0);
});

test('additive exported/sig/parent/calls are ignored for equality and summarized', () => {
  const oldRecords = [
    rec({
      symbols: [sym('foo', 'function', 1)],
      calls: undefined,
    }),
  ];
  const newRecords = [
    rec({
      symbols: [{ ...sym('foo', 'function', 1), exported: true, sig: 'foo()', parent: 'Mod' }],
      calls: [['foo', 2, 1, 0, '', '']],
    }),
  ];
  const report = compareWalks(oldRecords, newRecords);
  assert.equal(report.totals.loss, 0);
  assert.equal(report.totals.addition, 0);
  assert.equal(report.totals.kindChange, 0);
  assert.equal(report.totals.scalar, 0);
  assert.equal(report.additive.javascript.symbols, 1);
  assert.equal(report.additive.javascript.exported, 1);
  assert.equal(report.additive.javascript.sig, 1);
  assert.equal(report.additive.javascript.parent, 1);
  assert.equal(report.additive.javascript.calls, 1);
  assert.deepEqual(evaluateGate(report, {}), []);
  const md = formatMarkdown({ ...report, manifestIdentical: true, reasons: [] });
  assert.match(md, /## Additive fields/);
  assert.match(md, /exported/);
  assert.match(md, /calls/);
});

test('--tokens ignores tokens that are not declared symbol names', () => {
  const oldRecords = [
    rec({
      symbols: [sym('Alpha', 'function', 1), sym('Beta', 'function', 2)],
      tokens: ['Alpha', 'noiseInComment', 'Beta'],
    }),
  ];
  const newRecords = [
    rec({
      symbols: [sym('Alpha', 'function', 1), sym('Beta', 'function', 2)],
      tokens: ['Alpha', 'Beta'],
    }),
  ];
  const noiseOnly = compareWalks(oldRecords, newRecords, { tokens: true });
  assert.equal(noiseOnly.totals.tokenLost, 0);
  assert.equal(noiseOnly.totals.tokenAdded, 0);
  assert.deepEqual(evaluateGate(noiseOnly, { tokens: true, maxTokenLoss: 0 }), []);
});

test('--tokens fails on a lost declared token within the max-token-loss threshold', () => {
  const lost = compareWalks(
    [rec({ symbols: [sym('Alpha', 'function', 1)], tokens: ['Alpha', 'stray'] })],
    [rec({ symbols: [sym('Alpha', 'function', 1), sym('Gamma', 'function', 3)], tokens: ['Gamma'] })],
    { tokens: true }
  );
  assert.equal(lost.totals.tokenLost, 1);
  assert.equal(lost.totals.tokenAdded, 1);
  assert.equal(lost.byLanguage.javascript.TOKEN_LOSS.examples[0].token, 'Alpha');
  assert.match(evaluateGate(lost, { tokens: true, maxTokenLoss: 0 }).join('\n'), /token loss 1/);
  assert.equal(evaluateGate(lost, { tokens: true, maxTokenLoss: 1 }).length, 0);
  assert.equal(evaluateGate(lost, { tokens: false, maxTokenLoss: 0 }).length, 0);
});

test('--tokens skips a record whose new side has no tokens field', () => {
  const absentNew = compareWalks(
    [rec({ symbols: [sym('Alpha', 'function', 1)], tokens: ['Alpha'] })],
    [rec({ symbols: [sym('Alpha', 'function', 1)] })],
    { tokens: true }
  );
  assert.equal(absentNew.totals.tokenLost, 0);
  assert.equal(absentNew.totals.tokenAdded, 0);
});

test('--tokens counts a declared token lost when the new side has an empty tokens list', () => {
  const emptyNew = compareWalks(
    [rec({ symbols: [sym('Alpha', 'function', 1)], tokens: ['Alpha'] })],
    [rec({ symbols: [sym('Alpha', 'function', 1)], tokens: [] })],
    { tokens: true }
  );
  assert.equal(emptyNew.totals.tokenLost, 1);
});

test('--tokens caps token-loss examples while counting every loss', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F'];
  const many = compareWalks(
    [
      rec({
        symbols: names.map((n, i) => sym(n, 'function', i + 1)),
        tokens: names,
      }),
    ],
    [
      rec({
        symbols: names.map((n, i) => sym(n, 'function', i + 1)),
        tokens: [],
      }),
    ],
    { tokens: true }
  );
  assert.equal(many.totals.tokenLost, 6);
  assert.equal(many.byLanguage.javascript.TOKEN_LOSS.count, 6);
  assert.equal(many.byLanguage.javascript.TOKEN_LOSS.examples.length, 5);
});

const NEW_LANGUAGES = ['haskell', 'hcl', 'solidity'];
const OLD_MANIFEST =
  '{"rel":"src/a.js","lang":"javascript","fp":"aa","size":1}\n{"rel":"src/b.ts","lang":"typescript","fp":"bb","size":2}\n';
const NEW_MANIFEST =
  '{"rel":"src/Main.hs","lang":"haskell","fp":"hh","size":3}\n{"rel":"src/Token.sol","lang":"solidity","fp":"ss","size":4}\n{"rel":"src/a.js","lang":"javascript","fp":"aa","size":1}\n{"rel":"src/b.ts","lang":"typescript","fp":"bb","size":2}\n';

function walkWithNewLanguageFiles() {
  return compareWalks(
    [rec({ rel: 'src/a.js', lang: 'javascript', symbols: [sym('a', 'function', 1)] })],
    [
      rec({ rel: 'src/a.js', lang: 'javascript', symbols: [sym('a', 'function', 1)] }),
      rec({ rel: 'src/Token.sol', lang: 'solidity', symbols: [sym('Token', 'contract', 1)] }),
      rec({ rel: 'src/Main.hs', lang: 'haskell', symbols: [sym('main', 'function', 1)] }),
    ]
  );
}

test('--allow-new-languages ignores files-only-new for the allowed languages', () => {
  const report = walkWithNewLanguageFiles();
  assert.deepEqual(report.filesOnlyNew, ['src/Main.hs', 'src/Token.sol']);
  assert.match(evaluateGate(report, {}).join('\n'), /files only on one side/);
  assert.deepEqual(evaluateGate(report, { allowNewLanguages: NEW_LANGUAGES }), []);
});

test('--allow-new-languages drops extra manifest rows only for the allowed languages', () => {
  const raw = compareManifests(OLD_MANIFEST, NEW_MANIFEST, new Set());
  assert.equal(raw.identical, false);
  const allowed = compareManifests(OLD_MANIFEST, NEW_MANIFEST, new Set(NEW_LANGUAGES));
  assert.equal(allowed.identical, true);
  assert.equal(allowed.newDropped.length, 2);
});

test('--allow-new-languages still fails a manifest whose shared row changed', () => {
  const drifted =
    '{"rel":"src/Main.hs","lang":"haskell","fp":"hh","size":3}\n{"rel":"src/a.js","lang":"javascript","fp":"CHANGED","size":1}\n{"rel":"src/b.ts","lang":"typescript","fp":"bb","size":2}\n';
  assert.equal(compareManifests(OLD_MANIFEST, drifted, new Set(NEW_LANGUAGES)).identical, false);
});

test('--allow-new-languages still fails a file lost from the old side', () => {
  const lostOther = compareWalks(
    [
      rec({ rel: 'src/a.js', lang: 'javascript', symbols: [sym('a', 'function', 1)] }),
      rec({ rel: 'src/gone.py', lang: 'python', symbols: [sym('g', 'function', 1)] }),
    ],
    [
      rec({ rel: 'src/a.js', lang: 'javascript', symbols: [sym('a', 'function', 1)] }),
      rec({ rel: 'src/Token.sol', lang: 'solidity', symbols: [sym('Token', 'contract', 1)] }),
    ]
  );
  const reasons = evaluateGate(lostOther, { allowNewLanguages: NEW_LANGUAGES });
  assert.match(reasons.join('\n'), /files only on one side: old=1 new=0/);
});

test('--allow-new-languages summarizes excluded files and manifest rows in the markdown', () => {
  const md = formatMarkdown({
    ...walkWithNewLanguageFiles(),
    allowNewLanguages: NEW_LANGUAGES,
    manifestIdentical: true,
    manifestRawIdentical: false,
    manifestDroppedNew: compareManifests(OLD_MANIFEST, NEW_MANIFEST, new Set(NEW_LANGUAGES)).newDropped,
    reasons: [],
  });
  assert.match(md, /excluded files-only-new: 2/);
  assert.match(md, /excluded manifest rows: 2/);
});

function kindMapCliFixture(t) {
  const dir = tempDir(t, 'graph-parity-stage3-');
  const mapPath = join(dir, 'kinds.json');
  writeFileSync(mapPath, JSON.stringify({ javascript: { kinds: { function: 'method', class: 'class' } } }));
  const mappedOld = writeJsonl(dir, 'map-old.jsonl', [
    rec({ symbols: [sym('foo', 'function', 4), sym('Bar', 'class', 1)] }),
  ]);
  const mappedNew = writeJsonl(dir, 'map-new.jsonl', [
    rec({ symbols: [sym('foo', 'method', 4), sym('Bar', 'class', 1)] }),
  ]);
  return { dir, mapPath, mappedOld, mappedNew };
}

test('CLI jsonl: a declared kind remap exits 0 as KIND_MAPPED', async (t) => {
  const { mapPath, mappedOld, mappedNew } = kindMapCliFixture(t);
  const mapped = await runCli(['--old-jsonl', mappedOld, '--new-jsonl', mappedNew, '--kind-map', mapPath]);
  assert.equal(mapped.code, 0, mapped.stdout);
  assert.match(mapped.stdout, /KIND_MAPPED/);
});

test('CLI jsonl: a kind outside the kind map exits 1', async (t) => {
  const { dir, mapPath } = kindMapCliFixture(t);
  const unmappedOld = writeJsonl(dir, 'unmap-old.jsonl', [
    rec({ symbols: [sym('foo', 'function', 4), sym('E', 'enum', 2)] }),
  ]);
  const unmappedNew = writeJsonl(dir, 'unmap-new.jsonl', [
    rec({ symbols: [sym('foo', 'method', 4), sym('E', 'enum', 2)] }),
  ]);
  const unmapped = await runCli(['--old-jsonl', unmappedOld, '--new-jsonl', unmappedNew, '--kind-map', mapPath]);
  assert.equal(unmapped.code, 1);
  assert.match(unmapped.stdout, /unmapped kind/);
});

test('CLI jsonl: a kind map that is not JSON exits 2', async (t) => {
  const { dir, mappedOld, mappedNew } = kindMapCliFixture(t);
  const badMap = join(dir, 'bad.json');
  writeFileSync(badMap, '{not json');
  const malformed = await runCli(['--old-jsonl', mappedOld, '--new-jsonl', mappedNew, '--kind-map', badMap]);
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /malformed kind map/);
});

test('CLI jsonl: a kind map that is a JSON array exits 2', async (t) => {
  const { dir, mappedOld, mappedNew } = kindMapCliFixture(t);
  const arrayMap = join(dir, 'array.json');
  writeFileSync(arrayMap, '[]');
  const badShape = await runCli(['--old-jsonl', mappedOld, '--new-jsonl', mappedNew, '--kind-map', arrayMap]);
  assert.equal(badShape.code, 2);
});

test('CLI jsonl: a remap outside the kind map exits 1 as KIND_CHANGE', async (t) => {
  const { dir, mapPath } = kindMapCliFixture(t);
  const changeOld = writeJsonl(dir, 'chg-old.jsonl', [
    rec({ symbols: [sym('foo', 'function', 4), sym('Bar', 'class', 1)] }),
  ]);
  const changeNew = writeJsonl(dir, 'chg-new.jsonl', [
    rec({ symbols: [sym('foo', 'class', 4), sym('Bar', 'class', 1)] }),
  ]);
  const changed = await runCli(['--old-jsonl', changeOld, '--new-jsonl', changeNew, '--kind-map', mapPath]);
  assert.equal(changed.code, 1);
  assert.match(changed.stdout, /KIND_CHANGE/);
});

test('CLI jsonl: --tokens exits 1 on token loss unless --max-token-loss allows it', async (t) => {
  const dir = tempDir(t, 'graph-parity-stage3-');
  const tokOld = writeJsonl(dir, 'tok-old.jsonl', [
    rec({
      symbols: [sym('Alpha', 'function', 1)],
      tokens: ['Alpha', 'commentWord'],
    }),
  ]);
  const tokNew = writeJsonl(dir, 'tok-new.jsonl', [
    rec({
      symbols: [sym('Alpha', 'function', 1)],
      tokens: [],
    }),
  ]);
  const tokFail = await runCli(['--old-jsonl', tokOld, '--new-jsonl', tokNew, '--tokens']);
  assert.equal(tokFail.code, 1);
  assert.match(tokFail.stdout, /TOKEN_LOSS/);
  const tokOk = await runCli(['--old-jsonl', tokOld, '--new-jsonl', tokNew, '--tokens', '--max-token-loss', '1']);
  assert.equal(tokOk.code, 0, tokOk.stdout);
});

test('CLI jsonl: --allow-new-languages lets an allowed new-language file pass', async (t) => {
  const dir = tempDir(t, 'graph-parity-stage3-');
  const sideOld = writeJsonl(dir, 'sol-old.jsonl', [
    rec({ rel: 'a.js', lang: 'javascript', symbols: [sym('a', 'function', 1)] }),
  ]);
  const sideNew = writeJsonl(dir, 'sol-new.jsonl', [
    rec({ rel: 'a.js', lang: 'javascript', symbols: [sym('a', 'function', 1)] }),
    rec({ rel: 'Token.sol', lang: 'solidity', symbols: [sym('Token', 'contract', 1)] }),
  ]);
  const blocked = await runCli(['--old-jsonl', sideOld, '--new-jsonl', sideNew]);
  assert.equal(blocked.code, 1);
  const allowed = await runCli([
    '--old-jsonl',
    sideOld,
    '--new-jsonl',
    sideNew,
    '--allow-new-languages',
    'haskell,hcl,solidity',
  ]);
  assert.equal(allowed.code, 0, allowed.stdout);
  assert.match(allowed.stdout, /FILE_ONLY_NEW/);
  assert.match(allowed.stdout, /excluded files-only-new: 1/);
});

function inactiveKindMapMarkdown(kindMapSource) {
  return formatMarkdown({
    filesCompared: 0,
    filesOnlyOld: [],
    filesOnlyNew: [],
    totals: {
      loss: 0,
      addition: 0,
      kindChange: 0,
      kindMapped: 0,
      colDrift: 0,
      importDiff: 0,
      scalar: 0,
      parseError: 0,
    },
    byLanguage: {},
    kindMapSource,
    kindMapActive: false,
    reasons: [],
  });
}

test('auto kind-map: --langs output without kinds leaves the kind map inactive', async () => {
  const empty = await loadKindMap({ new: 'graph' }, '.', async () => ({
    stdout: Buffer.from('{"languages":[{"id":"javascript","extensions":["js"]}]}\n'),
  }));
  assert.equal(kindMapActive(empty.map), false);
  assert.equal(empty.source, 'langs');
  assert.match(inactiveKindMapMarkdown(empty.source), /kind-map: inactive \(--langs produced no kinds\)/);
});

test('auto kind-map: a failing --langs run leaves the kind map inactive', async () => {
  const failed = await loadKindMap({ new: 'graph' }, '.', async () => {
    throw new Error('boom');
  });
  assert.equal(failed.source, 'langs-failed');
  assert.match(inactiveKindMapMarkdown(failed.source), /kind-map: inactive \(--langs failed\)/);
});

test('auto kind-map: identity kinds from --langs still activate the kind map', async () => {
  const mapped = await loadKindMap({ new: 'graph' }, '.', async () => ({
    stdout: Buffer.from(
      JSON.stringify({
        languages: [
          { id: 'javascript', kinds: { function: 'method' } },
          { id: 'python', kinds: { function: 'function' } },
        ],
      })
    ),
  }));
  assert.equal(mapped.map.javascript.function, 'method');
  assert.equal(mapped.map.python.function, 'function');
  assert.equal(kindMapActive(mapped.map), true);
});

test('same-name LOSS+ADDITION on one file is a likely line move and still fails', () => {
  const report = compareWalks(
    [rec({ rel: 'src/a.js', symbols: [sym('foo', 'function', 10)] })],
    [rec({ rel: 'src/a.js', symbols: [sym('foo', 'function', 20)] })]
  );
  assert.equal(report.totals.loss, 1);
  assert.equal(report.totals.addition, 1);
  assert.equal(report.lineMoves.length, 1);
  assert.equal(report.lineMoves[0].name, 'foo');
  assert.equal(report.lineMoves[0].rel, 'src/a.js');
  const reasons = evaluateGate(report, { maxSymbolLoss: 0 });
  assert.match(reasons.join('\n'), /LOSS 1/);
  const md = formatMarkdown({ ...report, manifestIdentical: true, reasons });
  assert.match(md, /likely line move/i);
  assert.match(md, /\*\*FAIL\*\*/);
});

function writeFakeWalker(dir) {
  const path = join(dir, 'walker.mjs');
  writeFileSync(
    path,
    [
      "import { readFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      "const rec = (rel) => JSON.stringify({ rel, lang: 'javascript', symbols: [{ name: rel, kind: 'function', startLine: 1, startCol: 1, endCol: 2 }] });",
      'if (args[0] === \'--manifest\') process.stdout.write(\'{"rel":"a.js","lang":"javascript","fp":"x","size":1}\\n\');',
      "else if (args[0] === '--files') process.stdout.write(readFileSync(0, 'utf8') + args.slice(1).map(rec).join('\\n') + '\\n');",
      "else process.stdout.write(['a.js', 'b.js'].map(rec).join('\\n') + '\\n');",
    ].join('\n')
  );
  return path;
}

test('runParity walks both binaries, compares manifests and reports timing', async (t) => {
  const walker = writeFakeWalker(tempDir(t));
  const { report, exitCode } = await runParity({
    old: process.execPath,
    new: process.execPath,
    root: walker,
    files: [],
    runs: 2,
    maxSymbolLoss: 0,
    maxImportDiff: 0,
    maxTokenLoss: 0,
    maxTimeRatio: 1000,
    allowNewLanguages: [],
  });
  assert.equal(exitCode, 0, JSON.stringify(report.reasons));
  assert.equal(report.filesCompared, 2);
  assert.equal(report.manifestRawIdentical, true);
  assert.equal(report.manifestIdentical, true);
  assert.equal(report.timing.runs, 2);
  assert.equal(report.timing.oldTimes.length, 2);
  assert.equal(report.oldManifestBytes, report.newManifestBytes);
  assert.ok(report.oldManifestBytes > 0);
});

test('runParity with --files re-walks the named files and reuses the other records', async (t) => {
  const walker = writeFakeWalker(tempDir(t));
  const { report, exitCode } = await runParity({
    old: process.execPath,
    new: process.execPath,
    root: walker,
    files: ['a.js'],
    runs: 1,
    maxSymbolLoss: 0,
    maxImportDiff: 0,
    maxTokenLoss: 0,
    maxTimeRatio: 1000,
    allowNewLanguages: [],
  });
  assert.equal(exitCode, 0, JSON.stringify(report.reasons));
  assert.equal(report.filesCompared, 2);
  assert.deepEqual(report.files, ['a.js']);
});
