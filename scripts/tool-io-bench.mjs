#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeBuiltinTool } from '../src/runtime/agent/orchestrator/tools/builtin.mjs';
import { invalidateBuiltinResultCache } from '../src/runtime/agent/orchestrator/tools/builtin/cache-layers.mjs';
import {
  shutdownNativeSearchServer,
  warmNativeSearchServer,
} from '../src/runtime/agent/orchestrator/tools/builtin/native-search-client.mjs';
import { normalizeToolEnvelope } from '../src/runtime/agent/orchestrator/session/tool-envelope.mjs';

const repeats = Math.max(1, Math.min(20, Number(process.argv[2]) || 5));
const fixture = await mkdtemp(join(tmpdir(), 'mixdog-io-bench-'));
const entriesDir = join(fixture, 'entries');
const largeFile = join(fixture, 'large.txt');
const options = { sessionId: 'io-bench', suppressReadUnchangedStub: true };

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
}

function summarize(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  return `avg=${average.toFixed(2)}ms p95=${percentile(values, 0.95).toFixed(2)}ms`;
}

async function timed(run) {
  const startedAt = performance.now();
  const raw = await run();
  const result = String(normalizeToolEnvelope(raw).result ?? '');
  return { elapsed: performance.now() - startedAt, result };
}

try {
  await mkdir(entriesDir);
  await Promise.all(Array.from({ length: 512 }, (_, index) => (
    writeFile(join(entriesDir, `entry-${String(index).padStart(4, '0')}.txt`), `row ${index}\n`)
  )));
  await mkdir(join(entriesDir, 'nested', 'deeper'), { recursive: true });
  await writeFile(join(entriesDir, 'nested', 'deeper', 'leaf.txt'), 'deep\n');
  const chunk = Array.from({ length: 4096 }, (_, index) => `line ${index} ${'x'.repeat(240)}`).join('\n');
  await writeFile(largeFile, `${chunk}\n${chunk}\n${chunk}\n${chunk}\n`);
  await warmNativeSearchServer();

  const cases = [
    ['list_meta', () => executeBuiltinTool('list', {
      path: entriesDir,
      meta: true,
      limit: 200,
    }, fixture, options), /entry-0000\.txt\tfile/],
    ['list_deep', () => executeBuiltinTool('list', {
      path: entriesDir,
      depth: 3,
      hidden: true,
      limit: 1000,
    }, fixture, options), /nested\/deeper\/leaf\.txt\tfile/],
    ['read_range', () => executeBuiltinTool('read', {
      path: largeFile,
      offset: 3000,
      limit: 120,
    }, fixture, options), /3001→line 3000/],
  ];

  for (const [name, run, expected] of cases) {
    const cold = [];
    const warm = [];
    for (let index = 0; index < repeats; index += 1) {
      invalidateBuiltinResultCache();
      const first = await timed(run);
      const second = await timed(run);
      if (!expected.test(first.result) || !expected.test(second.result)) {
        throw new Error(
          `${name} produced unexpected output: ${JSON.stringify(first.result.slice(0, 160))}`,
        );
      }
      cold.push(first.elapsed);
      warm.push(second.elapsed);
    }
    console.log(`${name} cold ${summarize(cold)} | warm ${summarize(warm)}`);
  }
} finally {
  await shutdownNativeSearchServer('io-bench');
  await rm(fixture, { recursive: true, force: true });
}
