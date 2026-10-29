// node:test reporter the local gate adds to each shard it runs: one JSON line
// per test file, { file, ms }, the file's top-level test time (relative to the
// package the run started in, like `scripts/test.mjs --list`). The gate turns
// these into the per-file estimates its next run plans shards from.
import { relative } from 'node:path';

export default async function* gateTimingReporter(source) {
  const byFile = new Map();
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    if (event.data.nesting !== 0 || !event.data.file) continue;
    const file = relative(process.cwd(), String(event.data.file)).replaceAll('\\', '/');
    byFile.set(file, (byFile.get(file) ?? 0) + (Number(event.data.details?.duration_ms) || 0));
  }
  for (const [file, ms] of byFile) yield `${JSON.stringify({ file, ms })}\n`;
}
