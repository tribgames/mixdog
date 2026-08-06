#!/usr/bin/env node
// Regression cover for the tool-call failure classes absorbed from the
// 24h tool-failure log: V4A envelope decoration, anchor seek strictness,
// duplicate-context visibility, undefined/JSON-shaped args, truncated path
// arrays, sentinel-free project roots, transient host memory dips, and
// test-run pollution of the user's failure log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseV4APatch } from '../src/runtime/agent/orchestrator/tools/patch/parsing.mjs';
import { applyV4AHunksToLines } from '../src/runtime/agent/orchestrator/tools/patch/v4a-convert.mjs';
import validateBuiltinArgs from '../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';
import { coerceReadFamilyPathArg } from '../src/runtime/agent/orchestrator/tools/builtin/path-utils.mjs';
import { _childProjectRoots, _findDirProjectRoot } from '../src/runtime/agent/orchestrator/tools/code-graph/project-root.mjs';
import { ResourceAdmissionController } from '../src/runtime/shared/resource-admission.mjs';

const MB = 1024 * 1024;

test('decorated `*** End Patch ***` is an envelope marker, not hunk context', () => {
  const parsed = parseV4APatch([
    '*** Begin Patch',
    '*** Update File: a.mjs',
    '@@',
    ' keep',
    '-old',
    '+new',
    '*** End Patch ***',
  ].join('\n'));
  assert.equal(parsed.length, 1);
  const lines = parsed[0].hunks.flatMap((hunk) => hunk.lines);
  assert.deepEqual(lines, [' keep', '-old', '+new']);
});

test('hunks listed out of file order still resolve against unique anchors', () => {
  const source = [
    'function a() {',
    '  return 1;',
    '}',
    '',
    'function b() {',
    '  return 2;',
    '}',
  ];
  const parsed = parseV4APatch([
    '*** Begin Patch',
    '*** Update File: x.mjs',
    '@@ function b() {',
    '   return 2;',
    '+  // b',
    '@@ function a() {',
    '   return 1;',
    '+  // a',
    '*** End Patch',
  ].join('\n'));
  const out = applyV4AHunksToLines(source, parsed[0].hunks, {});
  assert.ok(out.includes('  // a'), 'first-function hunk applied');
  assert.ok(out.includes('  // b'), 'second-function hunk applied');
});

test('an anchor differing only by trailing whitespace still resolves', () => {
  const source = ['export function f(a) {   ', '  return a;', '}'];
  const parsed = parseV4APatch([
    '*** Begin Patch',
    '*** Update File: x.mjs',
    '@@ export function f(a) {',
    '   return a;',
    '+  // noted',
    '*** End Patch',
  ].join('\n'));
  const out = applyV4AHunksToLines(source, parsed[0].hunks, {});
  assert.ok(out.includes('  // noted'));
});

test('grep tolerates an optional key materialized as undefined', () => {
  const args = { pattern: 'x', path: '.', glob: undefined };
  assert.equal(validateBuiltinArgs('grep', args), null);
  assert.equal('glob' in args, false);
});

test('find absorbs a single-entry path batch and names the multi-path limit', () => {
  const single = { query: 'x', path: ['apps/desktop'] };
  assert.equal(validateBuiltinArgs('find', single), null);
  assert.equal(single.path, 'apps/desktop');

  const jsonish = { query: 'x', path: '["apps/desktop"]' };
  assert.equal(validateBuiltinArgs('find', jsonish), null);
  assert.equal(jsonish.path, 'apps/desktop');

  const many = { query: 'x', path: ['a', 'b'] };
  assert.match(String(validateBuiltinArgs('find', many)), /single base directory/);
});

test('a truncated JSON path array repairs to its one surviving path', () => {
  assert.equal(
    coerceReadFamilyPathArg('["C:\\\\Project\\\\mixdog\\\\src\\\\a.mjs'),
    'C:\\Project\\mixdog\\src\\a.mjs',
  );
  // A truncated MULTI-path array is not repairable and must stay untouched.
  const multi = '["a.mjs","b.mjs';
  assert.equal(coerceReadFamilyPathArg(multi), multi);
});

test('child project roots separate a single tree from a multi-repo parent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-child-roots-'));
  try {
    mkdirSync(join(dir, 'repo-a'), { recursive: true });
    writeFileSync(join(dir, 'repo-a', 'package.json'), '{}', 'utf8');
    mkdirSync(join(dir, 'repo-b', '.git'), { recursive: true });
    mkdirSync(join(dir, 'plain', 'src'), { recursive: true });
    assert.equal(_childProjectRoots(dir).length, 2);
    assert.equal(_childProjectRoots(join(dir, 'plain')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host free-memory telemetry never delays or refuses valid work', async () => {
  let samples = 0;
  const admission = new ResourceAdmissionController({
    limits: { minFreeMemoryMb: 1024, maxRssMb: 0 },
    metrics: () => {
      samples += 1;
      return { rssBytes: 10 * MB, freeMemoryBytes: 700 * MB };
    },
    env: { MIXDOG_MEMORY_PRESSURE_RETRY_MS: '5' },
  });
  const lease = await admission.acquire('shell');
  assert.equal(admission.snapshot().active.shell, 1);
  await lease.release();
  assert.equal(samples, 1);
});

test('test runs never write to the default tool-failure log', async () => {
  const io = await import('../src/runtime/agent/orchestrator/agent-trace-io.mjs?absorption-test');
  const previous = process.env.MIXDOG_TOOL_FAILURE_LOG_PATH;
  delete process.env.MIXDOG_TOOL_FAILURE_LOG_PATH;
  process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT || 'test';
  try {
    assert.equal(io._resolveToolFailurePath(), null);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_TOOL_FAILURE_LOG_PATH;
    else process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = previous;
  }
});

test('an implicit root walk stops at the home/temp boundary, an explicit one does not', () => {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-boundary-'));
  try {
    // `base` stands in for the home directory: a stray sentinel sits there,
    // and the tree we actually care about is a sentinel-free child.
    writeFileSync(join(base, 'package.json'), '{}\n');
    const child = join(base, 'work', 'nested');
    mkdirSync(child, { recursive: true });

    assert.equal(
      _findDirProjectRoot(child, { stopAtUserBoundary: true, boundaries: [base] }),
      null,
    );
    assert.equal(_findDirProjectRoot(child), base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a real project below the boundary is still found by the implicit walk', () => {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-boundary-'));
  try {
    writeFileSync(join(base, 'package.json'), '{}\n');
    const repo = join(base, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), '{}\n');

    assert.equal(
      _findDirProjectRoot(join(repo, 'src'), { stopAtUserBoundary: true, boundaries: [base] }),
      repo,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
