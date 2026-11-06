// Records the goldens of the compact marker's numbers: the "before" count a pass shows
// (`compactDisplayBeforeTokens`) and the marker's label/detail text.
//
//   node native/core/fixtures/agent/record-compact-marker.mjs [--tree <node checkout with node_modules>]
//
// Results go to `compact_marker/cases.json`, replayed by `tests/compact_marker.rs` and the
// marker text test in mixdog-core (`session/live_rows.rs`).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const stage = stageSet(here, ['compact_marker']);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-marker-'));
const load = (path) => import(pathToFileURL(join(nodeRoot, path)).href);
const { compactDisplayBeforeTokens } = await load('src/runtime/agent/orchestrator/session/loop/compact-policy.mjs');
const { compactEventDetail } = await load('src/tui/session/labels.mjs');
const { compactEventLabel } = await load('src/runtime/shared/compact-event-label.mjs');

// The provider's last measured context against the pass's own (estimated) pressure.
const readings = [
  { lastContextTokens: 959_921, stale: false, fallback: 1_756_616 },
  { lastContextTokens: 959_921, stale: true, fallback: 1_756_616 },
  { lastContextTokens: 0, stale: false, fallback: 42_000 },
  { lastContextTokens: null, stale: false, fallback: 42_000 },
  { lastContextTokens: 8_000, stale: false, fallback: 31_000 },
  { lastContextTokens: 31_000, stale: false, fallback: 8_000 },
];
const before = readings.map((r) => ({
  ...r,
  before: compactDisplayBeforeTokens(
    { lastContextTokens: r.lastContextTokens, lastContextTokensStaleAfterCompact: r.stale },
    r.fallback
  ),
}));

const events = [
  { durationMs: 0, beforeTokens: 0, pressureTokens: 0, afterTokens: 0 },
  { durationMs: 1200, beforeTokens: 12_345, pressureTokens: 40_000, afterTokens: 3400 },
  { durationMs: 40, beforeTokens: 900, pressureTokens: 900, afterTokens: 900 },
  { durationMs: 1000, beforeTokens: 1250, pressureTokens: 5, afterTokens: 640 },
  { durationMs: 1001, beforeTokens: 12_500, pressureTokens: 5, afterTokens: 1250 },
  { durationMs: 59_001, beforeTokens: 959_921, pressureTokens: 1_756_616, afterTokens: 120_000 },
  { durationMs: 5, beforeTokens: 0, pressureTokens: 7500, afterTokens: 2500 },
];
const statuses = ['compacted', 'no_change', 'skipped', 'failed'];
const details = events.map((event) => ({ event, detail: compactEventDetail(event) }));
const labels = [];
for (const status of statuses) for (const trigger of ['auto', 'reactive', 'cache_expired'])
  labels.push({ status, trigger, label: compactEventLabel({ status, trigger }) });

const dir = join(stage, 'compact_marker');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'cases.json'), `${JSON.stringify({ before, details, labels }, null, 2)}\n`);
refreshSetManifest(stage, nodeRoot);
commitStage(stage, here);
console.log(JSON.stringify(before.map((b) => [b.lastContextTokens, b.stale, b.fallback, b.before])));
console.log(JSON.stringify(details.map((d) => d.detail)));
