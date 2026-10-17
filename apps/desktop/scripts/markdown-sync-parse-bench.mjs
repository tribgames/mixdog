// Main-thread parse cost of representative markdown (prose, lists, a table and
// a highlighted code block) by size in UTF-16 code units. It justifies
// SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS: the largest reply that parses on the
// main thread must fit well inside one 16.7ms frame.
// Run: node --import tsx scripts/markdown-sync-parse-bench.mjs
import { parseMarkdownToHast } from '../src/renderer/markdown-ast.ts';

const block = (n) =>
  [
    `## Step ${n}: update the renderer`,
    '',
    `The settled reply keeps its **final structure** on first paint, see \`parseSettledMarkdownAstNow\` and [the docs](https://example.com/${n}). Prose like this wraps over a couple of lines so the paragraph parser has real inline work to do.`,
    '',
    `- first item ${n} with \`inline code\``,
    '- second item with a [link](https://example.com)',
    '  - nested item with **bold** and _emphasis_',
    `- third item ${n}`,
    '',
    '| file | change | status |',
    '| --- | --- | --- |',
    `| src/renderer/a${n}.ts | rewrite the allowance | done |`,
    `| src/renderer/b${n}.tsx | gate the sync parse | pending |`,
    '',
    '```ts',
    `export function step${n}(input: string): number {`,
    '  const parts = input.split(",").map((part) => part.trim());',
    '  let total = 0;',
    '  for (const part of parts) total += Number(part) || 0;',
    '  return total;',
    '}',
    '```',
    '',
  ].join('\n');

function sample(units, salt) {
  let text = '';
  for (let n = salt; text.length < units; n += 1) text += block(n);
  return text.slice(0, units);
}

const sizes = [1024, 2048, 4096, 6144, 8192, 12288, 16384, 32768];
const runs = 40;
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
// Warm the parser (module load, highlight grammars) the way the app has by the
// time a transcript renders; the first measured row of each size is a new text.
for (let i = 0; i < 20; i += 1) parseMarkdownToHast(sample(4096, i));
const rows = [];
for (const units of sizes) {
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const text = sample(units, 1000 + i);
    const startedAt = performance.now();
    parseMarkdownToHast(text);
    times.push(performance.now() - startedAt);
  }
  const sorted = [...times].sort((a, b) => a - b);
  rows.push({
    utf16Units: units,
    medianMs: Number(quantile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(quantile(sorted, 0.95).toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
    msPerKUnitMedian: Number((quantile(sorted, 0.5) / (units / 1024)).toFixed(2)),
  });
}
console.table(rows);
