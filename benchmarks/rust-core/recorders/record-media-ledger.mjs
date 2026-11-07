#!/usr/bin/env node
// Golden twin of the media usage ledger row (`media-usage.mjs` `recordMediaUsage`): Node's real function
// with the ledger replaced by one that keeps the row `makeUsageRecord` built, over a matrix of lanes,
// provider-reported usage and sessions. The clock is pinned and `crypto.randomUUID` is a counter, the
// pricing catalog is empty (no cache on this data dir), so the rows carry no catalog price: `rates` is the
// pricing layer's own output and is not compared by the Rust test.
//
//   node benchmarks/rust-core/recorders/record-media-ledger.mjs --tree <dir>
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'mixdog-media-ledger-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
process.env.MIXDOG_DATA_DIR = join(ROOT, 'data');
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const tree = resolveTree(parseArgs());
const mediaUsage = await importFrom(tree, 'src/runtime/media/media-usage.mjs');

const T0 = 1_700_000_000_000;
Date.now = () => T0;
let counter = 0;
createRequire(import.meta.url)('node:crypto').randomUUID = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
syncBuiltinESMExports();

const USAGES = [
  null,
  undefined,
  {},
  { inputTokens: 12, outputTokens: 1290, outputImageTokens: 1290 },
  { inputTokens: 5, cachedTokens: 2, outputTokens: 300, outputVideoTokens: 280 },
  { costUsd: 0.039 },
  { costUsd: 0 },
  { costUsd: 0.5, inputTokens: 3 },
  { images: 1 },
  { seconds: 8, resolution: '720p' },
  { costUsd: 0.1, seconds: 5, resolution: '480p' },
  { outputTokens: 7 },
  { cachedTokens: 9 },
];
const LANES = [
  { lane: 'gemini', model: 'gemini-2.5-flash-image' },
  { lane: 'gemini', model: 'veo-3.1' },
  { lane: 'xai', model: 'grok-imagine-image' },
  { lane: 'openrouter', model: 'google/gemini-image' },
  { lane: 'nano-gpt', model: 'flux' },
  { lane: 'openai-oauth', model: 'gpt-image-2', pricingModel: 'gpt-5.5', usageFilter: (u) => !u || u.costUsd === undefined },
  { lane: 'antigravity-oauth', model: 'gemini-3-pro-image', usageFilter: (u) => !u || u.costUsd === undefined },
  { lane: 'grok-oauth', model: 'grok-imagine-video', usageFilter: (u) => !u || u.costUsd === undefined },
];
const SESSIONS = [
  { sessionId: 'sess-1', sourceType: 'lead' },
  { sessionId: '', sourceType: '' },
  { sessionId: 'no-session', sourceType: 'tool' },
  { sessionId: '(none)', sourceType: 'studio' },
  { sessionId: undefined, sourceType: undefined },
];

const rows = [];
for (const lane of LANES) {
  for (const usage of USAGES) {
    if (lane.usageFilter && !lane.usageFilter(usage)) continue;
    for (const session of SESSIONS.slice(0, usage && Object.keys(usage).length ? 5 : 2)) {
      counter = 0;
      const saved = [];
      const args = { lane: lane.lane, model: lane.model, pricingModel: lane.pricingModel, usage, sessionId: session.sessionId, sourceType: session.sourceType };
      await mediaUsage.recordMediaUsage(args, () => ({ recordQueued: async (row) => { saved.push(row); } }));
      rows.push({ lane: lane.lane, model: lane.model, pricingModel: lane.pricingModel ?? null, usage: usage ?? null, sessionId: session.sessionId ?? null, sourceType: session.sourceType ?? null, row: saved[0] ?? null });
    }
  }
}
// A ledger that refuses the row never fails the generation.
let refused = null;
const realError = process.stderr.write.bind(process.stderr);
process.stderr.write = (text) => { refused = String(text); return true; };
await mediaUsage.recordMediaUsage({ lane: 'gemini', model: 'm', usage: { images: 1 } }, () => ({ recordQueued: async () => { throw new Error('disk full'); } }));
await mediaUsage.recordMediaUsage({ lane: '', model: 'm', usage: { images: 1 } }, () => ({ recordQueued: async () => {} }));
const missingLane = String(refused);
process.stderr.write = realError;
const failures = [];
failures.push({ ledger: 'throws', stderr: null });

writeJson(join(FIXTURES_ROOT, 'services', 'media-ledger-twin.json'), { domain: 'media-ledger-twin', recorder: 'benchmarks/rust-core/recorders/record-media-ledger.mjs', clock: T0, rows, lastStderr: missingLane });
rmSync(ROOT, { recursive: true, force: true });
console.log(`recorded ${rows.length} rows`);
process.exit(0);
