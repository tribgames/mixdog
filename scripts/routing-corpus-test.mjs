import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseGrepCoverage, summarizeToolArgs } from '../src/runtime/agent/orchestrator/agent-trace-format.mjs';
import { executeGrepTool } from '../src/runtime/agent/orchestrator/tools/builtin/search-tool.mjs';
import { validateBuiltinArgs } from '../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';

test('grep coverage parser follows path:line and path-line formatter syntax', () => {
  assert.deepEqual(
    parseGrepCoverage('src/a.mjs:10:match\nsrc/a.mjs-11-context', 'grep', { output_mode: 'content_with_context' }, 'normal'),
    [{ path: 'src/a.mjs', line: 10 }, { path: 'src/a.mjs', line: 11 }],
  );
  assert.deepEqual(
    parseGrepCoverage('10:match\n11-context', 'grep', { path: 'src/a.mjs', output_mode: 'content_with_context' }, 'normal'),
    [{ path: 'src/a.mjs', line: 10 }, { path: 'src/a.mjs', line: 11 }],
  );
  assert.deepEqual(
    parseGrepCoverage('10:match', 'grep', { path: 'src/a.mjs' }, 'normal'),
    [{ path: 'src/a.mjs', line: 10 }],
  );
  assert.equal(parseGrepCoverage('src/a.mjs:10:match', 'grep', { output_mode: 'files_with_matches' }, 'normal'), null);
  assert.equal(parseGrepCoverage('Error: failed', 'grep', { output_mode: 'content_with_context' }, 'error'), null);
});

test('omitted grep mode receives contextual head-limit clamping', () => {
  const args = { pattern: 'needle', head_limit: 999 };
  assert.equal(validateBuiltinArgs('grep', args), null);
  assert.equal(args.head_limit, 40);
});

test('production summaries retain code_graph files[]', () => {
  assert.deepEqual(summarizeToolArgs('code_graph', { mode: 'symbols', files: ['src/a.mjs', 'src/b.mjs'] }).files, ['src/a.mjs', 'src/b.mjs']);
});

test('grep content_with_context supplies surrounding lines without explicit context', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-grep-'));
  writeFileSync(join(dir, 'sample.mjs'), 'before\nneedle\nafter\n');
  const output = await executeGrepTool(
    { pattern: 'needle', path: 'sample.mjs', output_mode: 'content_with_context' },
    dir,
    async () => '',
  );
  assert.match(String(output), /before/);
  assert.match(String(output), /needle/);
  assert.match(String(output), /after/);
});

test('grep output defaults to context while explicit content stays bare', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-grep-mode-'));
  writeFileSync(join(dir, 'sample.mjs'), 'before\nneedle\nafter\n');
  const run = (args) => executeGrepTool(args, dir, async () => '');
  const omitted = await run({ pattern: 'needle', path: 'sample.mjs' });
  const bare = await run({ pattern: 'needle', path: 'sample.mjs', output_mode: 'content' });
  const explicitZero = await run({ pattern: 'needle', path: 'sample.mjs', '-A': 0, '-B': 0, '-C': 0 });
  assert.match(String(omitted), /before/);
  assert.match(String(omitted), /after/);
  assert.doesNotMatch(String(bare), /before/);
  assert.doesNotMatch(String(bare), /after/);
  assert.doesNotMatch(String(explicitZero), /before/);
  assert.doesNotMatch(String(explicitZero), /after/);
});

test('grep path fan-out is bounded, ordered, isolated, and capped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-grep-paths-'));
  const paths = Array.from({ length: 11 }, (_, index) => `missing-${index}.mjs`);
  let active = 0;
  let peak = 0;
  const child = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return '';
  };
  const scopedCacheOutcome = {};
  const output = await executeGrepTool(
    { pattern: 'needle', path: paths },
    dir,
    child,
    null,
    { scopedCacheOutcome },
  );
  assert.equal(peak, 4);
  assert.match(output, /^# grep missing-0\.mjs\nError: path does not exist:/);
  assert.match(output, /# grep missing-9\.mjs\nError: path does not exist:/);
  assert.doesNotMatch(output, /# grep missing-10\.mjs\n/);
  assert.match(output, /\[capped at 10 of 11 paths\]$/);
  assert.equal(scopedCacheOutcome.complete, false);
});

test('nested grep path and pattern fan-out stays within four concurrent calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-grep-nested-'));
  let active = 0;
  let peak = 0;
  const child = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return '';
  };
  await executeGrepTool(
    { pattern: ['needle-a', 'needle-b', 'needle-c'], path: ['missing-a.mjs', 'missing-b.mjs', 'missing-c.mjs', 'missing-d.mjs'] },
    dir,
    child,
  );
  assert.equal(peak, 4);
});

test('path-section grep coverage survives legacy aggregate output', () => {
  assert.deepEqual(
    parseGrepCoverage(
      '# grep src/a.mjs\n1:match\n# grep src/b.mjs\n2-context',
      'grep',
      { path: ['src/a.mjs', 'src/b.mjs'], output_mode: 'content_with_context' },
      'normal',
    ),
    [{ path: 'src/a.mjs', line: 1 }, { path: 'src/b.mjs', line: 2 }],
  );
  assert.deepEqual(
    parseGrepCoverage(
      '# grep src/a.mjs\n# grep pattern:"one"\n1:match\n# grep pattern:"two"\n2-context\n# grep src/b.mjs\n# grep pattern:"one"\n3:match',
      'grep',
      { path: ['src/a.mjs', 'src/b.mjs'], pattern: ['one', 'two'], output_mode: 'content_with_context' },
      'normal',
    ),
    [{ path: 'src/a.mjs', line: 1 }, { path: 'src/a.mjs', line: 2 }, { path: 'src/b.mjs', line: 3 }],
  );
});

test('oversized path aggregate marks scoped cache incomplete before outer cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-grep-output-cap-'));
  const body = Array.from({ length: 1_500 }, () => 'needle\n').join('');
  writeFileSync(join(dir, 'a.txt'), body);
  writeFileSync(join(dir, 'b.txt'), body);
  const scopedCacheOutcome = { complete: true };
  const output = await executeGrepTool(
    { pattern: 'needle', path: ['a.txt', 'b.txt'], output_mode: 'content', head_limit: 0 },
    dir,
    async () => '',
    null,
    { scopedCacheOutcome, toolOutputMaxBytes: 100 },
  );
  assert.ok(output.length > 100);
  assert.equal(scopedCacheOutcome.complete, false);
});

function runCases(cases) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-routing-'));
  const trace = join(dir, 'trace.jsonl');
  const rows = cases.flatMap(([session_id, calls]) => calls.map((call, index) => ({
    kind: 'tool', session_id, ts: index + 1, ...call,
  })));
  writeFileSync(trace, rows.map((row) => JSON.stringify(row)).join('\n'));
  const result = spawnSync(process.execPath, ['scripts/routing-corpus.mjs', '--trace', trace, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function flags(corpus, session) {
  return corpus.cases.find((item) => item.session_id === session)?.flags || [];
}
function observations(corpus, session) {
  return corpus.cases.find((item) => item.session_id === session)?.observations || [];
}
const call = (tool_name, tool_args, extra = {}) => ({
  tool_name, tool_args,
  tool_args_hash: `synthetic-${tool_name}-${JSON.stringify(tool_args)}`,
  ...extra,
});

test('routing corpus uses full hashes, result status, and mutation boundaries', () => {
  const corpus = runCases([
    ['hash-collision', [
      call('grep', { pattern: 'same-summary' }, { tool_args_hash: 'hash-a', iteration: 1 }),
      call('grep', { pattern: 'same-summary' }, { tool_args_hash: 'hash-b', iteration: 2 }),
    ]],
    ['failed-retry', [
      call('read', { path: 'a.mjs' }, { result_kind: 'error', tool_args_hash: 'same', iteration: 1 }),
      call('read', { path: 'a.mjs' }, { result_kind: 'success', tool_args_hash: 'same', iteration: 2 }),
    ]],
    ['mutation-reset', [
      call('read', { path: 'a.mjs' }, { tool_args_hash: 'same', iteration: 1 }),
      call('shell', { command: 'echo changed' }, { iteration: 2 }),
      call('read', { path: 'a.mjs' }, { tool_args_hash: 'same', iteration: 3 }),
    ]],
    ['positive-relookup', [
      call('grep', { pattern: 'same' }, { tool_args_hash: 'same-hash', iteration: 1 }),
      call('grep', { pattern: 'same' }, { tool_args_hash: 'same-hash', iteration: 2 }),
    ]],
  ]);
  assert.deepEqual(flags(corpus, 'hash-collision'), []);
  assert.deepEqual(flags(corpus, 'failed-retry'), []);
  assert.deepEqual(flags(corpus, 'mutation-reset'), []);
  assert.ok(flags(corpus, 'positive-relookup').includes('grep_relookup'));
});

test('valid explore inspection is clean and context grep to same-file read is high-confidence', () => {
  const corpus = runCases([
    ['explore-inspection', [
      call('explore', { query: 'where is config' }, { result_kind: 'success', iteration: 1 }),
      call('read', { path: 'config.mjs' }, { result_kind: 'success', iteration: 2 }),
    ]],
    ['context-read', [
      call('grep', { pattern: 'needle', path: 'a.mjs', output_mode: 'content_with_context' }, { result_kind: 'success', result_lines_est: 4, grep_coverage: [{ path: 'a.mjs', line: 1 }, { path: 'a.mjs', line: 2 }, { path: 'a.mjs', line: 3 }], iteration: 1 }),
      call('read', { path: 'a.mjs', offset: 0, limit: 3 }, { result_kind: 'success', iteration: 2 }),
    ]],
    ['files-only', [
      call('grep', { pattern: 'needle', path: 'a.mjs', output_mode: 'files_with_matches' }, { result_kind: 'success', result_lines_est: 1, iteration: 1 }),
      call('read', { path: 'a.mjs' }, { result_kind: 'success', iteration: 2 }),
    ]],
    ['different-path', [
      call('grep', { pattern: 'needle', path: 'a.mjs', output_mode: 'content_with_context' }, { result_kind: 'success', result_lines_est: 1, grep_coverage: [{ path: 'a.mjs', line: 1 }], iteration: 1 }),
      call('read', { path: 'b.mjs', offset: 0, limit: 1 }, { result_kind: 'success', iteration: 2 }),
    ]],
    ['full-file-read', [
      call('grep', { pattern: 'needle', path: 'a.mjs', output_mode: 'content_with_context' }, { result_kind: 'success', grep_coverage: [{ path: 'a.mjs', line: 1 }], iteration: 1 }),
      call('read', { path: 'a.mjs' }, { result_kind: 'success', iteration: 2 }),
    ]],
    ['zero-limit', [
      call('grep', { pattern: 'needle', path: 'a.mjs', output_mode: 'content_with_context' }, { grep_coverage: [{ path: 'a.mjs', line: 1 }], iteration: 1 }),
      call('read', { path: 'a.mjs', offset: 0, limit: 0 }, { iteration: 2 }),
    ]],
    ['partial-coverage', [
      call('grep', { pattern: 'needle', path: 'a.mjs', output_mode: 'content_with_context' }, { grep_coverage: [{ path: 'a.mjs', line: 1 }, { path: 'a.mjs', line: 3 }], iteration: 1 }),
      call('read', { path: 'a.mjs', offset: 0, limit: 3 }, { iteration: 2 }),
    ]],
    ['relative-absolute', [
      call('grep', { pattern: 'needle', path: 'a.mjs', output_mode: 'content_with_context' }, { cwd: '/tmp/project', grep_coverage: [{ path: 'a.mjs', line: 1 }], iteration: 1 }),
      call('read', { path: '/tmp/project/a.mjs', offset: 0, limit: 1 }, { cwd: '/tmp/project', iteration: 2 }),
    ]],
    ['posix-case', [
      call('grep', { pattern: 'needle', path: 'A.mjs', output_mode: 'content_with_context' }, { cwd: '/tmp/project', grep_coverage: [{ path: 'A.mjs', line: 1 }], iteration: 1 }),
      call('read', { path: '/tmp/project/a.mjs', offset: 0, limit: 1 }, { cwd: '/tmp/project', iteration: 2 }),
    ]],
  ]);
  assert.deepEqual(flags(corpus, 'explore-inspection'), []);
  assert.ok(flags(corpus, 'context-read').includes('grep_context_then_read'));
  assert.ok(!flags(corpus, 'files-only').includes('grep_context_then_read'));
  assert.ok(!flags(corpus, 'different-path').includes('grep_context_then_read'));
  assert.ok(!flags(corpus, 'full-file-read').includes('grep_context_then_read'));
  assert.ok(!flags(corpus, 'zero-limit').includes('grep_context_then_read'));
  assert.ok(!flags(corpus, 'partial-coverage').includes('grep_context_then_read'));
  assert.ok(flags(corpus, 'relative-absolute').includes('grep_context_then_read'));
  assert.ok(!flags(corpus, 'posix-case').includes('grep_context_then_read'));
});

test('same-iteration compatible calls are visible observations, not defects', () => {
  const families = [
    ['read', [{ path: 'a', offset: 0, limit: 10 }, { path: 'b', offset: 10, limit: 10 }]],
    ['grep', [{ pattern: 'a', path: '.' }, { pattern: 'b', path: '.' }]],
    ['find', [{ query: 'a' }, { query: 'b' }]],
    ['glob', [{ pattern: '*.a', path: '.' }, { pattern: '*.b', path: '.' }]],
    ['list', [{ path: 'a' }, { path: 'b' }]],
    ['explore', [{ query: 'a' }, { query: 'b' }]],
    ['code_graph', [{ mode: 'symbols', symbols: ['A'] }, { mode: 'symbols', symbols: ['B'] }]],
  ];
  const cases = families.map(([tool, args], index) => [`batch-${index}`, args.map((tool_args) => call(tool, tool_args, { iteration: 1 }))]);
  cases.push(
    ['grep-paths', [
      call('grep', { pattern: 'same', path: 'a' }, { iteration: 1 }),
      call('grep', { pattern: 'same', path: 'b' }, { iteration: 1 }),
    ]],
    ['graph-files-in-symbol-mode', [
      call('code_graph', { mode: 'symbols', files: ['src/a.mjs'] }, { iteration: 1 }),
      call('code_graph', { mode: 'symbols', files: ['src/b.mjs'] }, { iteration: 1 }),
    ]],
    ['graph-singular-symbols-mode', [
      call('code_graph', { mode: 'symbols', symbol: 'A' }, { iteration: 1 }),
      call('code_graph', { mode: 'symbols', symbol: 'B' }, { iteration: 1 }),
    ]],
    ['unsupported-symbol-files', [
      call('code_graph', { mode: 'symbol_search', files: ['src/a.mjs'] }, { iteration: 1 }),
      call('code_graph', { mode: 'symbol_search', files: ['src/b.mjs'] }, { iteration: 1 }),
    ]],
    ['plain-reads', [
      call('read', { path: 'a' }, { iteration: 1 }),
      call('read', { path: 'b' }, { iteration: 1 }),
    ]],
    ['mixed-read-regions', [
      call('read', { path: 'a', offset: 0, limit: 4 }, { iteration: 1 }),
      call('read', { path: [{ path: 'b', offset: 4, limit: 4 }] }, { iteration: 1 }),
    ]],
    ['singleton-array-read', [
      call('read', { path: ['a'] }, { iteration: 1 }),
      call('read', { path: ['b'] }, { iteration: 1 }),
    ]],
    ['incompatible', [
      call('grep', { pattern: 'a', path: '.', output_mode: 'count' }, { iteration: 1 }),
      call('grep', { pattern: 'b', path: '.', output_mode: 'content' }, { iteration: 1 }),
    ]],
    ['mixed-three', [
      call('grep', { pattern: 'a', path: '.' }, { iteration: 1 }),
      call('grep', { pattern: 'b', path: '.' }, { iteration: 1 }),
      call('grep', { pattern: 'c', path: '.', output_mode: 'count' }, { iteration: 1 }),
    ]],
    ['different-iteration', [
      call('read', { path: 'a' }, { iteration: 1 }),
      call('read', { path: 'b' }, { iteration: 2 }),
    ]],
  );
  const corpus = runCases(cases);
  for (let index = 0; index < families.length; index += 1) {
    assert.ok(observations(corpus, `batch-${index}`).includes('same_turn_batch_opportunity'), `${families[index][0]}: ${observations(corpus, `batch-${index}`)}`);
    assert.deepEqual(flags(corpus, `batch-${index}`), []);
  }
  for (const session of ['grep-paths', 'graph-files-in-symbol-mode', 'graph-singular-symbols-mode', 'plain-reads', 'mixed-read-regions', 'singleton-array-read']) {
    assert.ok(observations(corpus, session).includes('same_turn_batch_opportunity'));
    assert.deepEqual(flags(corpus, session), []);
  }
  assert.ok(!flags(corpus, 'incompatible').includes('missed_array_batch'));
  assert.ok(observations(corpus, 'mixed-three').includes('same_turn_batch_opportunity'));
  assert.deepEqual(flags(corpus, 'mixed-three'), []);
  assert.ok(!flags(corpus, 'different-iteration').includes('missed_array_batch'));
});

test('successful overlapping reads flag once, while exact relookup does not double-count overlap', () => {
  const corpus = runCases([
    ['overlap', [
      call('read', { path: 'src/a.mjs', offset: 0, limit: 10 }, { iteration: 1 }),
      call('read', { path: './src/a.mjs', offset: 5, limit: 10 }, { iteration: 2 }),
    ]],
    ['duplicate', [
      call('read', { path: 'src/a.mjs', offset: 0, limit: 10 }, { iteration: 1, tool_args_hash: 'same' }),
      call('read', { path: 'src/a.mjs', offset: 0, limit: 10 }, { iteration: 2, tool_args_hash: 'same' }),
    ]],
    ['posix-case', [
      call('read', { path: 'A.mjs', offset: 0, limit: 10 }, { cwd: '/tmp/project', iteration: 1 }),
      call('read', { path: 'a.mjs', offset: 5, limit: 10 }, { cwd: '/tmp/project', iteration: 2 }),
    ]],
    ['windows-case', [
      call('read', { path: 'C:\\Project\\A.mjs', offset: 0, limit: 10 }, { cwd: 'C:\\Project', iteration: 1 }),
      call('read', { path: 'c:/project/a.mjs', offset: 5, limit: 10 }, { cwd: 'C:\\Project', iteration: 2 }),
    ]],
  ]);
  assert.deepEqual(flags(corpus, 'overlap'), ['read_overlap']);
  assert.deepEqual(flags(corpus, 'duplicate'), ['read_relookup']);
  assert.deepEqual(flags(corpus, 'posix-case'), []);
  assert.deepEqual(flags(corpus, 'windows-case'), ['read_overlap']);
});

test('corpus summary exposes precise flags', () => {
  const corpus = runCases([['empty', [call('read', { path: 'a' })]]]);
  for (const key of ['grep_relookup', 'read_relookup', 'read_overlap', 'grep_context_then_read', 'missed_array_batch']) {
    assert.equal(typeof corpus.summary[key].count, 'number');
  }
});
