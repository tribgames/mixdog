// Cache accounting only; parsing happens outside the measured region.
// Run before the change with --baseline, then without it after the change.
// node --expose-gc --import tsx scripts/renderer-cache-weight-bench.mjs [--baseline]
import { performance } from 'node:perf_hooks';
import { parseMarkdownToHast } from '../src/renderer/markdown-ast.ts';

const baseline = process.argv.includes('--baseline');
const measure = baseline
  ? (value) => JSON.stringify(value).length
  : (await import('../src/renderer/renderer-value-weight.ts')).estimateRetainedChars;
const astWeight = baseline ? null : await import('../src/renderer/markdown-ast-weight.ts');
const fixtures = [
  { name: 'long-prose', value: parseMarkdownToHast('long response '.repeat(7_000)), limit: 1024 * 1024 },
  { name: 'highlighted-code', value: parseMarkdownToHast(`\`\`\`js\n${'const answer = 42;\n'.repeat(1_200)}\`\`\``), limit: 1024 * 1024 },
  { name: 'large-diff', value: { files: [], patch: 'context\n'.repeat(128 * 1024) }, limit: 8 * 1024 * 1024 },
  { name: 'oversized-diff', value: { files: [], patch: 'context\n'.repeat(2 * 1024 * 1024) }, limit: 8 * 1024 * 1024 },
];
for (const { name, value, limit } of fixtures) {
  if (process.argv.includes('--markdown-only') && value.type !== 'root') continue;
  let workerAccountingMs = null;
  let measureOnRenderer = measure;
  if (!baseline && value.type === 'root') {
    // Mirrors production: worker accounting is separate from UI cache admission.
    const started = performance.now();
    const weight = measure(value, limit);
    workerAccountingMs = +(performance.now() - started).toFixed(3);
    astWeight.rememberMarkdownAstWeight(value, weight);
    measureOnRenderer = (root) => astWeight.markdownAstCacheChars(root, '');
  }
  const samples = [];
  let chars = 0;
  for (let sample = 0; sample < 4; sample += 1) {
    globalThis.gc?.();
    const start = performance.now();
    for (let index = 0; index < 50; index += 1) chars = measureOnRenderer(value, limit);
    if (sample > 0) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({
    mode: baseline ? 'baseline' : 'bounded-weight',
    name, measurements: 50,
    medianMs: +samples[1].toFixed(3),
    cacheable: chars <= limit,
    ...(workerAccountingMs !== null ? { workerAccountingMsPerResult: workerAccountingMs } : {}),
  }));
}
