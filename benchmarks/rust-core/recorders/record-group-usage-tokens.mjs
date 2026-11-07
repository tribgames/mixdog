#!/usr/bin/env node
// Golden twin of `groupUsageTokens(groups)` (`runtime/shared/llm/usage-group-tokens.mjs`): the tokens a listing
// is answered with and the pool wake-ups that follow, driven over the REAL usage ledger singleton
// (`getUsageLedger()`), which opens `<MIXDOG_DATA_DIR>/usage/ledger.sqlite` of an isolated temp data directory
// that the recorder seeds. Each step may add usage rows (which moves the ledger's commit stamp), then lists some
// groups, lets the background read settle and lists them again. The recording holds, per step: the rows added
// (the full usage records, so the Rust test seeds a real ledger with the same ones), the answer of the first
// listing (never waits), the answer after the settle, the number of pool wake-ups
// (`emitSessionActivityChange`) the settle caused, and the ledger's own token of each group.
//
//   node benchmarks/rust-core/recorders/record-group-usage-tokens.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'group-usage-tokens-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const tree = resolveTree(parseArgs());
const grouped = await importFrom(tree, 'src/runtime/shared/llm/usage-group-tokens.mjs');
const ledgerMod = await importFrom(tree, 'src/runtime/shared/llm/usage-ledger.mjs');
const signal = await importFrom(tree, 'src/runtime/shared/session-activity-signal.mjs');

let wakes = 0;
signal.onSessionActivityChange(() => {
  wakes += 1;
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
const plain = (map) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)));
const asMap = (groups) => new Map(groups.map(([owner, ids]) => [owner, new Set(ids)]));

let seq = 0;
const row = (sessionId, ownerSessionId) => {
  seq += 1;
  return ledgerMod.makeUsageRecord({ id: `row-${seq}`, provider: 'anthropic', model: 'claude-x', ts: 1_772_000_000_000 + seq * 1000, sessionId, ownerSessionId, sourceType: 'user', inputTokens: 10 + seq, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, costUsd: 0.01 * seq });
};

const STEPS = [
  { name: 'no ledger open yet', open: false, groups: [['lead', ['lead', 'w1']]] },
  { name: 'ledger open, nothing recorded', open: true, groups: [['lead', ['lead', 'w1']]] },
  { name: 'same stamp and groups: not asked again', groups: [['lead', ['lead', 'w1']]] },
  { name: 'a row of the group', rows: [['w1', 'lead']], groups: [['lead', ['lead', 'w1']]] },
  { name: 'a row of nobody listed', rows: [['stranger', null]], groups: [['lead', ['lead', 'w1']]] },
  { name: 'a second row of the group', rows: [['w1', 'lead'], ['lead', null]], groups: [['lead', ['lead', 'w1']]] },
  { name: 'ids in another order, same group', groups: [['lead', ['w1', 'lead']]] },
  { name: 'a second group', rows: [['x1', 'other']], groups: [['lead', ['lead', 'w1']], ['other', ['other', 'x1']]] },
  { name: 'one group dropped', groups: [['other', ['other', 'x1']]] },
  { name: 'a group with more ids', groups: [['other', ['other', 'x1', 'x2']]] },
  { name: 'nothing listed', groups: [] },
  { name: 'listed again after nothing', groups: [['lead', ['lead', 'w1']]] },
];

const steps = [];
for (const step of STEPS) {
  let ledger = null;
  if (step.open) ledger = ledgerMod.getUsageLedger();
  ledger ??= ledgerMod.usageLedgerIfOpen();
  const added = ledger && step.rows ? step.rows.map(([sessionId, ownerSessionId]) => row(sessionId, ownerSessionId)) : [];
  if (added.length) ledger.record(added);
  wakes = 0;
  const groups = step.groups;
  const first = plain(grouped.groupUsageTokens(asMap(groups)));
  await settle();
  const woke = wakes;
  const second = plain(grouped.groupUsageTokens(asMap(groups)));
  await settle();
  const truth = {};
  if (ledger) for (const [owner, ids] of groups) truth[owner] = (await ledger.usageTokensAsync([{ owner, ids }]))[0];
  steps.push({ name: step.name, open: Boolean(ledger), rows: added.map((r) => ({ ...r, rates: JSON.stringify(r.rates) })), groups, first, wakes: woke, second, truth });
}
writeFileSync(join(FIXTURES_ROOT, 'group-usage-tokens', 'golden.json'), `${JSON.stringify({ domain: 'group-usage-tokens', recorder: 'benchmarks/rust-core/recorders/record-group-usage-tokens.mjs', steps }, null, 1)}\n`);
console.log(`recorded ${steps.length} steps`);
ledgerMod.closeUsageLedgers();
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
