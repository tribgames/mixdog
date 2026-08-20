#!/usr/bin/env node
// Sequential, read-only benchmark for routine exploration diagnostics.
// It deliberately excludes shell, task, edit, and apply_patch.
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { executeCodeGraphTool } from '../src/runtime/agent/orchestrator/tools/code-graph.mjs';
import { normalizeToolEnvelope } from '../src/runtime/agent/orchestrator/session/tool-envelope.mjs';
import { runWithLocalSearchTelemetry } from '../src/runtime/agent/orchestrator/tools/builtin/local-search-telemetry.mjs';
import { shutdownNativeSearchServer } from '../src/runtime/agent/orchestrator/tools/builtin/native-search-client.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const warmRuns = Math.max(1, Math.min(20, Number(process.argv[2]) || 5));
const opts = { sessionId: 'search-bench' };
let broadGrepSequence = 0;

const cases = [
  ['list', /10-tool-workflow\.md|file/, () => executeBuiltinTool('list', {
    path: 'src/rules/shared',
  }, root, opts)],
  ['find', /tool-defs|no fuzzy match/, () => executeBuiltinTool('find', {
    query: 'tool-defs', limit: 8,
  }, root, opts)],
  ['glob', /tool-defs\.mjs|\.mjs/, () => executeBuiltinTool('glob', {
    pattern: '**/*.mjs', path: 'src/session-runtime', limit: 40,
  }, root, opts)],
  ['glob_broad', /\.mjs|more entries/, () => executeBuiltinTool('glob', {
    pattern: '**/*.mjs', path: 'src', limit: 40,
  }, root, opts)],
  ['grep', /path-string|paths only|grep|\(no matches\)|Fuzzy/i, () => executeBuiltinTool('grep', {
    pattern: 'Fuzzy filename|paths only',
    path: 'src/runtime/agent/orchestrator/tools/builtin',
    glob: '*.mjs',
    limit: 20,
    context: 0,
  }, root, opts)],
  ['grep_broad_new', /\(no matches\)/i, () => executeBuiltinTool('grep', {
    pattern: `__mixdog_search_bench_absent_${broadGrepSequence++}_9f31__`,
    path: 'src',
    glob: '*.{mjs,js,ts,tsx,rs}',
    limit: 20,
    context: 0,
  }, root, opts)],
  ['find_multi', /search|client|no fuzzy match/i, () => executeBuiltinTool('find', {
    query: 'search client', limit: 8,
  }, root, opts)],
  ['read', /Tool Workflow|read/, () => executeBuiltinTool('read', {
    path: [['src/rules/shared/10-tool-workflow.md', 0, 10], ['package.json', 0, 5]],
  }, root, opts)],
  ['code_graph', /symbol|binding|files|edges/i, () => executeCodeGraphTool('code_graph', {
    mode: 'symbols', files: 'scripts/smoke.mjs',
  }, root)],
];

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function telemetryTotal(telemetry, suffix) {
  return Object.entries(telemetry)
    .filter(([key, value]) => key.endsWith(suffix) && Number.isFinite(Number(value)))
    .reduce((sum, [, value]) => sum + Number(value), 0);
}

function ms(value) {
  return `${Math.round(value * 10) / 10}ms`;
}

const failures = [];
try {
  for (const [name, expected, run] of cases) {
    const samples = [];
    for (let index = 0; index <= warmRuns; index += 1) {
      const telemetry = {};
      const startedAt = performance.now();
      try {
        const raw = await runWithLocalSearchTelemetry(telemetry, run);
        const result = String(normalizeToolEnvelope(raw).result ?? '');
        const elapsedMs = performance.now() - startedAt;
        if (!expected.test(result)) failures.push(`${name} unexpected output: ${result.slice(0, 160)}`);
        samples.push({ elapsedMs, telemetry });
      } catch (error) {
        failures.push(`${name} threw: ${error?.message || error}`);
        samples.push({ elapsedMs: performance.now() - startedAt, telemetry });
      }
    }
    const cold = samples[0];
    const warm = samples.slice(1);
    const queue = warm.map((sample) => telemetryTotal(sample.telemetry, '_queue_ms')).filter((value) => value > 0);
    const handler = warm.map((sample) => telemetryTotal(sample.telemetry, '_handler_ms')).filter((value) => value > 0);
    console.log(
      `${name.padEnd(10)} cold=${ms(cold.elapsedMs)}`
      + ` warm_p50=${ms(percentile(warm.map((sample) => sample.elapsedMs), 50))}`
      + ` warm_p95=${ms(percentile(warm.map((sample) => sample.elapsedMs), 95))}`
      + ` backend_queue_p95=${queue.length ? ms(percentile(queue, 95)) : '-'}`
      + ` backend_handler_p95=${handler.length ? ms(percentile(handler, 95)) : '-'}`,
    );
  }
} finally {
  await shutdownNativeSearchServer('search-bench-complete');
}

for (const failure of failures) console.error(`FAIL ${failure}`);
console.log(`search tool bench ${failures.length ? 'FAILED' : 'passed'} tools=${cases.length} warm_runs=${warmRuns}`);
process.exit(failures.length ? 1 : 0);
