#!/usr/bin/env node
// Genuine 1.4.5 `getSessionUsage` of createUsageStatsApi over a real UsageLedger file: the
// session's own spend (with the per-account provider sessions of a subscription account), other
// named sessions and the agents total. The Rust SessionUsageService reads the same ledger file
// (ledger.sqlite, written by Node's UsageLedger) and must answer the same values.
//
//   node benchmarks/rust-core/recorders/record-session-usage.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/session-usage/{golden.json,ledger.sqlite}
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const base = mkdtempSync(join(tmpdir(), 'session-usage-'));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

const { UsageLedger, makeUsageRecord } = await importFrom(tree, 'src/runtime/shared/llm/usage-ledger.mjs');
const { accountScopedSessionId } = await importFrom(tree, 'src/runtime/shared/provider-accounts.mjs');
const { createUsageStatsApi } = await importFrom(tree, 'src/session-runtime/usage-stats-api.mjs');

const ts = 1_790_000_000_000;
const route = { provider: 'anthropic', model: 'claude-opus-4-8' };
const usage = (responseId, offset, extra = {}) =>
  makeUsageRecord({
    ...route,
    ts: ts + offset * 1000,
    inputTokens: 1000 + offset,
    outputTokens: 100 + offset,
    cacheReadTokens: 4000,
    cacheWriteTokens: 500,
    durationMs: 2000,
    sessionId: 'session-a',
    sourceType: 'lead',
    responseId,
    ...extra,
  });
const rows = [
  usage('turn', 0),
  usage('compaction', 1, { sourceType: 'compact' }),
  { ...usage('unpriced', 2), costUsd: null, costSource: 'unpriced' },
  usage('via-account', 3, { sessionId: accountScopedSessionId('anthropic-oauth', '7d1f3c52-0a4e-4b8e-9c61-2f5a6b3d8e10', 'session-a') }),
  usage('gateway', 4, { origin: 'gateway' }),
  usage('other-b', 5, { sessionId: 'session-b' }),
  usage('other-b-account', 6, { sessionId: accountScopedSessionId('anthropic-oauth', '7d1f3c52-0a4e-4b8e-9c61-2f5a6b3d8e10', 'session-b') }),
  usage('agent-1', 7, { sessionId: 'agent-1', sourceType: 'agent', ownerSessionId: 'session-a' }),
  usage('agent-2', 8, { sessionId: 'agent-2', sourceType: 'agent', ownerSessionId: 'session-a' }),
  usage('stranger', 9, { sessionId: 'agent-3', sourceType: 'agent', ownerSessionId: 'session-z' }),
];

const path = join(base, 'ledger.sqlite');
const ledger = new UsageLedger(path);
ledger.record(rows);
await ledger.settleWrites();

let current = 'session-a';
const accounts = { 'anthropic-oauth': [{ id: '7d1f3c52-0a4e-4b8e-9c61-2f5a6b3d8e10' }] };
const api = createUsageStatsApi({
  ledger: () => ledger,
  importHistory: async () => {},
  accountPool: (provider) => ({ accounts: accounts[provider] ?? [] }),
  getSessionId: () => current,
});
const cases = [
  { name: 'own', session: 'session-a', options: {} },
  { name: 'no options', session: 'session-a', options: undefined },
  { name: 'others', session: 'session-a', options: { sessionIds: ['session-b', 'agent-1', '', 7, 'session-a', 'session-b'] } },
  { name: 'agents', session: 'session-a', options: { agents: true, sessionIds: ['agent-1', 'agent-2', 'agent-3'] } },
  { name: 'agents without names', session: 'session-a', options: { agents: true } },
  { name: 'agents not true', session: 'session-a', options: { agents: 'yes', sessionIds: ['session-b'] } },
  { name: 'unknown session', session: 'nobody', options: { sessionIds: ['also-nobody'] } },
  { name: 'no session', session: null, options: {} },
];
const answers = [];
for (const c of cases) {
  current = c.session;
  answers.push({ name: c.name, session: c.session, options: c.options ?? null, result: (await api.getSessionUsage(c.options)) ?? null });
}
ledger.close();

const finalOut = join(FIXTURES_ROOT, 'session-usage');
const out = stageSet(finalOut);
copyFileSync(path, join(out, 'ledger.sqlite'));
writeJson(join(out, 'golden.json'), {
  note: 'getSessionUsage of the real 1.4.5 createUsageStatsApi over ledger.sqlite; the account pool holds 7d1f3c52-0a4e-4b8e-9c61-2f5a6b3d8e10 under anthropic-oauth',
  accounts,
  accountScopedIds: { 'session-a': accountScopedSessionId('anthropic-oauth', '7d1f3c52-0a4e-4b8e-9c61-2f5a6b3d8e10', 'session-a') },
  cases: answers,
});
writeSetManifest(out, {
  set: 'session-usage',
  recorder: 'benchmarks/rust-core/recorders/record-session-usage.mjs',
  command: 'node benchmarks/rust-core/recorders/record-session-usage.mjs --tree <tree>',
  extra: { cases: answers.length },
});
commitStage(out, finalOut);
console.log(`cases=${answers.length}`);

