import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ARTIFACT_PATH,
  EXCLUSION_REASONS,
  coverageStaleness,
  foldCoverage,
  formatCoverageAnswer,
  formatStaleness,
  queryCoverage,
  readRawCoverage,
  reportCoverage,
  sourceDigest,
  writeCoverageArtifact,
} from './lib/coverage.mjs';

const queryCliPath = fileURLToPath(new URL('./coverage-query.mjs', import.meta.url));

// One fixed source, its line numbers counted by hand in the comments, so the
// assertions below check the offset-to-line translation rather than restate it.
const APP_SOURCE = [
  '// alpha is called by a test; beta is reached only through alpha',
  'export function alpha(values) {',
  '  return values.map((value) => beta(value));',
  '}',
  '',
  'function beta(value) {',
  '  return value * 2;',
  '}',
  '',
  'function gamma() {',
  "  return 'nobody calls this';",
  '}',
  '',
].join('\n');

const IDLE = ['export function idle() {', '  return 0;', '}'].join('\n');
const IDLE_SOURCE = `${IDLE}\n`;
const GENERATED_SOURCE = 'export const generated = 1;\n';

// A range as V8 records it: the function's own span, first in its list.
function range(source, snippet, count) {
  const startOffset = source.indexOf(snippet);
  assert.notEqual(startOffset, -1, `snippet missing from fixture: ${snippet}`);
  return { startOffset, endOffset: startOffset + snippet.length, count };
}

const ARROW = '(value) => beta(value)';
const BETA = ['function beta(value) {', '  return value * 2;', '}'].join('\n');
const GAMMA = ['function gamma() {', "  return 'nobody calls this';", '}'].join('\n');
const ALPHA = ['export function alpha(values) {', '  return values.map((value) => beta(value));', '}'].join('\n');

function scriptEntry(url, functions) {
  return { scriptId: '1', url, functions };
}

// Two dumps stand in for two spawned batches of the same run.
function sample(cwd) {
  const url = (relative) => pathToFileURL(join(cwd, relative)).href;
  const appFunctions = (betaCount, gammaCount) => [
    { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: APP_SOURCE.length, count: 1 }] },
    { functionName: 'alpha', isBlockCoverage: true, ranges: [range(APP_SOURCE, ALPHA, 2)] },
    { functionName: '', isBlockCoverage: true, ranges: [range(APP_SOURCE, ARROW, 3)] },
    { functionName: 'beta', isBlockCoverage: true, ranges: [range(APP_SOURCE, BETA, betaCount)] },
    { functionName: 'gamma', isBlockCoverage: true, ranges: [range(APP_SOURCE, GAMMA, gammaCount)] },
  ];
  return [
    {
      result: [
        scriptEntry(url('src/nested/app.mjs'), appFunctions(0, 0)),
        scriptEntry(url('src/nested/idle.mjs'), [
          {
            functionName: '',
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: IDLE_SOURCE.length, count: 1 }],
          },
          { functionName: 'idle', isBlockCoverage: true, ranges: [range(IDLE_SOURCE, IDLE, 0)] },
        ]),
        // Excluded, each for its own recorded reason.
        scriptEntry(url('apps/desktop/src/main.ts'), [
          { functionName: 'bootstrap', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 40, count: 1 }] },
        ]),
        scriptEntry(url('src/nested/generated.mjs'), [
          {
            functionName: 'phantom',
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: GENERATED_SOURCE.length + 500, count: 1 }],
          },
        ]),
        // Dropped without a trace: outside the repository, inside
        // node_modules, the test files themselves, and Node internals.
        scriptEntry(pathToFileURL(join(dirname(cwd), 'outside-the-repo.mjs')).href, [
          { functionName: 'outside', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
        ]),
        scriptEntry(url('node_modules/vendor/index.mjs'), [
          { functionName: 'vendor', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
        ]),
        scriptEntry(url('src/nested/app.test.mjs'), [
          { functionName: 'suite', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
        ]),
        scriptEntry(url('scripts/legacy-test.mjs'), [
          { functionName: 'legacy', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
        ]),
        scriptEntry('node:internal/modules/esm/loader', [
          { functionName: 'load', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
        ]),
      ],
    },
    // The second batch is where beta finally runs.
    { result: [scriptEntry(url('src/nested/app.mjs'), appFunctions(4, 0))] },
  ];
}

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'mixdog-coverage-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'src/nested'), { recursive: true });
  await writeFile(join(cwd, 'src/nested/app.mjs'), APP_SOURCE);
  await writeFile(join(cwd, 'src/nested/idle.mjs'), IDLE_SOURCE);
  await writeFile(join(cwd, 'src/nested/generated.mjs'), GENERATED_SOURCE);
  return cwd;
}

test('folding merges batches, translates offsets to lines, and keeps repository-relative paths', async (t) => {
  const cwd = await fixture(t);
  const artifact = await foldCoverage(sample(cwd), { root: cwd });
  assert.equal(artifact.version, 2);
  assert.deepEqual(Object.keys(artifact.files), ['src/nested/app.mjs', 'src/nested/idle.mjs']);
  assert.deepEqual(artifact.files['src/nested/app.mjs'], {
    loaded: true,
    sha256: sourceDigest(APP_SOURCE),
    functions: [
      { name: 'alpha', startLine: 2, endLine: 4, executed: true },
      // beta runs only in the second batch; both batches fold into one answer.
      { name: '(anonymous)', startLine: 3, endLine: 3, executed: true },
      { name: 'beta', startLine: 6, endLine: 8, executed: true },
      { name: 'gamma', startLine: 10, endLine: 12, executed: false },
    ],
  });
  assert.deepEqual(artifact.files['src/nested/idle.mjs'], {
    loaded: true,
    sha256: sourceDigest(IDLE_SOURCE),
    functions: [{ name: 'idle', startLine: 1, endLine: 3, executed: false }],
  });
  assert.deepEqual(artifact.summary, {
    filesWithExecutedFunctions: 1,
    filesWithoutExecutedFunctions: 1,
    excludedFiles: 2,
  });
});

test('folding records excluded paths with their reason and drops the rest silently', async (t) => {
  const cwd = await fixture(t);
  const artifact = await foldCoverage(sample(cwd), { root: cwd });
  assert.deepEqual(artifact.excluded, [
    { path: 'apps/desktop/src/main.ts', reason: 'transpiled-by-tsx' },
    { path: 'src/nested/generated.mjs', reason: 'offsets-beyond-source' },
  ]);
  assert.deepEqual(artifact.exclusionReasons, EXCLUSION_REASONS);
  assert.match(artifact.exclusionReasons['transpiled-by-tsx'], /tsx/);
  for (const dropped of [
    'node_modules/vendor/index.mjs',
    'src/nested/app.test.mjs',
    'scripts/legacy-test.mjs',
    '../outside-the-repo.mjs',
  ]) {
    assert.equal(dropped in artifact.files, false);
    assert.equal(
      artifact.excluded.some((entry) => entry.path === dropped),
      false
    );
  }
});

test('empty and rangeless input folds into an empty artifact instead of failing', async (t) => {
  const cwd = await fixture(t);
  const artifact = await foldCoverage([{ result: [] }, {}], { root: cwd });
  assert.deepEqual(artifact.files, {});
  assert.deepEqual(artifact.excluded, []);
  assert.deepEqual(artifact.summary, {
    filesWithExecutedFunctions: 0,
    filesWithoutExecutedFunctions: 0,
    excludedFiles: 0,
  });
});

test('the query answers executed, unexecuted, outside-function, excluded and unknown lines', async (t) => {
  const cwd = await fixture(t);
  const artifact = await foldCoverage(sample(cwd), { root: cwd });
  const generatedAt = artifact.generatedAt;
  const app = 'src/nested/app.mjs';
  const ask = (file, line) => queryCoverage(artifact, file, line, { root: cwd });
  assert.deepEqual(await ask(app, 7), {
    path: app,
    line: 7,
    status: 'executed',
    loaded: true,
    generatedAt,
    function: { name: 'beta', startLine: 6, endLine: 8, executed: true },
  });
  assert.deepEqual(await ask(app, 11), {
    path: app,
    line: 11,
    status: 'not-executed',
    loaded: true,
    generatedAt,
    function: { name: 'gamma', startLine: 10, endLine: 12, executed: false },
  });
  assert.deepEqual(await ask(app, 1), {
    path: app,
    line: 1,
    status: 'outside-functions',
    loaded: true,
    generatedAt,
  });
  // The innermost enclosing function wins, never the one wrapped around it.
  assert.equal((await ask(app, 3)).function.name, '(anonymous)');
  assert.equal((await ask(app, 2)).function.name, 'alpha');
  // Windows separators and ./ prefixes name the same file.
  assert.equal((await ask('src\\nested\\app.mjs', 7)).status, 'executed');
  assert.equal((await ask('./src/nested/app.mjs', 7)).status, 'executed');
  assert.deepEqual(await ask('src/nested/absent.mjs', 2), {
    path: 'src/nested/absent.mjs',
    line: 2,
    status: 'unknown-file',
    generatedAt,
    changedSinceCollection: false,
  });
  assert.deepEqual(await ask('apps/desktop/src/main.ts', 2), {
    path: 'apps/desktop/src/main.ts',
    line: 2,
    status: 'excluded',
    reason: 'transpiled-by-tsx',
    generatedAt,
  });
});

test('a file edited after collection answers stale instead of its recorded verdict', async (t) => {
  const cwd = await fixture(t);
  const artifact = await foldCoverage(sample(cwd), { root: cwd });
  const app = 'src/nested/app.mjs';
  const ask = (file, line) => queryCoverage(artifact, file, line, { root: cwd });
  assert.equal((await ask(app, 7)).status, 'executed');
  assert.equal((await ask(app, 11)).status, 'not-executed');
  // Two lines pushed in front: every recorded range now points 2 lines high.
  await writeFile(join(cwd, app), `// a comment added later\n\n${APP_SOURCE}`);
  for (const line of [7, 11, 1]) {
    const answer = await ask(app, line);
    assert.deepEqual(answer, {
      path: app,
      line,
      status: 'stale',
      change: 'modified',
      generatedAt: artifact.generatedAt,
    });
    const text = formatCoverageAnswer(answer);
    assert.match(text, /^STALE src\/nested\/app\.mjs:\d+ — the file changed since coverage was collected /);
    assert.match(text, /re-run `node scripts\/test\.mjs --coverage`$/);
    assert.doesNotMatch(text, /\n/);
  }
  // A deleted file is stale too, and says so differently.
  await rm(join(cwd, 'src/nested/idle.mjs'));
  const gone = await ask('src/nested/idle.mjs', 2);
  assert.equal(gone.status, 'stale');
  assert.equal(gone.change, 'missing');
  assert.match(formatCoverageAnswer(gone), /^STALE .* the file is gone since coverage was collected .*--coverage`$/);
});

test('an unrecorded file touched after collection answers stale, an older one keeps NO COVERAGE', async (t) => {
  const cwd = await fixture(t);
  const artifact = await foldCoverage(sample(cwd), { root: cwd });
  const collected = Date.parse(artifact.generatedAt);
  const ask = (file) => queryCoverage(artifact, file, 2, { root: cwd });
  const added = 'src/nested/added-later.mjs';
  await writeFile(join(cwd, added), 'export const added = 1;\n');
  await utimes(join(cwd, added), new Date(collected + 60_000), new Date(collected + 60_000));
  const fresh = await ask(added);
  assert.deepEqual(fresh, {
    path: added,
    line: 2,
    status: 'unknown-file',
    generatedAt: artifact.generatedAt,
    changedSinceCollection: true,
  });
  assert.match(
    formatCoverageAnswer(fresh),
    /^STALE src\/nested\/added-later\.mjs:2 — no coverage was recorded for this file and it changed after coverage was collected .*re-run `node scripts\/test\.mjs --coverage`$/
  );
  const untouched = 'src/nested/older.mjs';
  await writeFile(join(cwd, untouched), 'export const older = 1;\n');
  await utimes(join(cwd, untouched), new Date(collected - 60_000), new Date(collected - 60_000));
  const stale = await ask(untouched);
  assert.equal(stale.changedSinceCollection, false);
  assert.match(formatCoverageAnswer(stale), /^NO COVERAGE src\/nested\/older\.mjs:2 — the run collected /);
});

test('the artifact-level signal counts changed and missing files and names the collection time', async (t) => {
  const cwd = await fixture(t);
  const artifact = await foldCoverage(sample(cwd), { root: cwd });
  const before = await coverageStaleness(artifact, { root: cwd });
  assert.deepEqual(before, {
    generatedAt: artifact.generatedAt,
    files: 2,
    changed: [],
    missing: [],
    changedCount: 0,
    stale: false,
  });
  assert.equal(
    formatStaleness(before),
    `FRESH coverage collected ${artifact.generatedAt}: all 2 files unchanged since`
  );
  await writeFile(join(cwd, 'src/nested/app.mjs'), `${APP_SOURCE}\n// edited\n`);
  await rm(join(cwd, 'src/nested/idle.mjs'));
  const after = await coverageStaleness(artifact, { root: cwd });
  assert.deepEqual(after, {
    generatedAt: artifact.generatedAt,
    files: 2,
    changed: ['src/nested/app.mjs'],
    missing: ['src/nested/idle.mjs'],
    changedCount: 2,
    stale: true,
  });
  assert.equal(
    formatStaleness(after),
    `STALE coverage collected ${artifact.generatedAt}: 2 of 2 files changed since (1 gone); re-run \`node scripts/test.mjs --coverage\``
  );
});

test('an artifact from before per-file identity cannot answer confidently', async (t) => {
  const cwd = await fixture(t);
  const artifact = await foldCoverage(sample(cwd), { root: cwd });
  for (const entry of Object.values(artifact.files)) delete entry.sha256;
  assert.equal((await queryCoverage(artifact, 'src/nested/app.mjs', 7, { root: cwd })).status, 'stale');
  assert.equal((await coverageStaleness(artifact, { root: cwd })).changedCount, 2);
});

test('answers are one line each and name the function they came from', async (t) => {
  const cwd = await fixture(t);
  const artifact = await foldCoverage(sample(cwd), { root: cwd });
  const answer = async (file, line) => formatCoverageAnswer(await queryCoverage(artifact, file, line, { root: cwd }));
  assert.equal(
    await answer('src/nested/app.mjs', 7),
    'EXECUTED src/nested/app.mjs:7 — inside beta (lines 6-8), which the suite ran'
  );
  assert.equal(
    await answer('src/nested/app.mjs', 11),
    'NOT EXECUTED src/nested/app.mjs:11 — inside gamma (lines 10-12), which no test ran'
  );
  assert.equal(
    await answer('src/nested/app.mjs', 1),
    'NO FUNCTION src/nested/app.mjs:1 — outside every covered function (module body ran)'
  );
  assert.equal(
    await answer('src/nested/absent.mjs', 1),
    `NO COVERAGE src/nested/absent.mjs:1 — the run collected ${artifact.generatedAt} recorded no coverage for this file; if a test was added since, re-run \`node scripts/test.mjs --coverage\``
  );
  assert.match(
    await answer('apps/desktop/src/main.ts', 1),
    /^EXCLUDED apps\/desktop\/src\/main\.ts:1 — not in the artifact/
  );
  for (const [file, line] of [
    ['src/nested/app.mjs', 7],
    ['src/nested/app.mjs', 1],
    ['src/nested/absent.mjs', 1],
  ])
    assert.doesNotMatch(await answer(file, line), /\n/);
});

test('raw dumps are read from disk, written as one artifact, and summarized in two lines', async (t) => {
  const cwd = await fixture(t);
  const rawDir = join(cwd, 'raw');
  await mkdir(rawDir, { recursive: true });
  const [first, second] = sample(cwd);
  await writeFile(join(rawDir, 'coverage-1-1-0.json'), JSON.stringify(first));
  await writeFile(join(rawDir, 'coverage-2-2-0.json'), JSON.stringify(second));
  await writeFile(join(rawDir, 'notes.txt'), 'ignored');
  const reports = await readRawCoverage(rawDir);
  assert.equal(reports.length, 2);
  const lines = [];
  const target = await reportCoverage(rawDir, { root: cwd, log: (line) => lines.push(line) });
  assert.equal(target, resolve(cwd, ARTIFACT_PATH));
  assert.deepEqual(lines, [
    'Coverage: 1 files with executed functions, 1 without, 2 excluded',
    `Coverage artifact: ${target}`,
  ]);
  const written = await readFile(target, 'utf8');
  assert.ok(written.endsWith('\n'));
  assert.equal((await queryCoverage(JSON.parse(written), 'src/nested/app.mjs', 7, { root: cwd })).status, 'executed');
});

test('the query CLI prints one line for a file and line, and rejects bad usage', async (t) => {
  const cwd = await fixture(t);
  await writeCoverageArtifact(await foldCoverage(sample(cwd), { root: cwd }), { root: cwd });
  const run = (...args) => spawnSync(process.execPath, [queryCliPath, ...args], { cwd, encoding: 'utf8' });
  const executed = run('src/nested/app.mjs', '7');
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stdout, 'EXECUTED src/nested/app.mjs:7 — inside beta (lines 6-8), which the suite ran\n');
  const unexecuted = run(join(cwd, 'src/nested/app.mjs'), '11');
  assert.equal(unexecuted.status, 0, unexecuted.stderr);
  assert.equal(
    unexecuted.stdout,
    'NOT EXECUTED src/nested/app.mjs:11 — inside gamma (lines 10-12), which no test ran\n'
  );
  const usage = run('src/nested/app.mjs');
  assert.equal(usage.status, 1);
  assert.equal(usage.stdout, '');
  assert.equal(usage.stderr, 'usage: node scripts/coverage-query.mjs <file> <line> | --status\n');
  const fresh = run('--status');
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /^FRESH coverage collected .*: all 2 files unchanged since\n$/);
  // The same query, after the file moved on, refuses its old verdict.
  await writeFile(join(cwd, 'src/nested/app.mjs'), `// inserted\n${APP_SOURCE}`);
  const stale = run('src/nested/app.mjs', '7');
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(
    stale.stdout,
    /^STALE src\/nested\/app\.mjs:7 — the file changed since coverage was collected .*re-run `node scripts\/test\.mjs --coverage`\n$/
  );
  const status = run('--status');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^STALE coverage collected .*: 1 of 2 files changed since \(0 gone\); re-run /);
});
