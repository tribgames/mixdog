#!/usr/bin/env node
// What accountProviderSend reads off a send's options and its session to fill a ledger row's
// identity (usage-accounting.mjs:55-79): the session id (`usageSessionId || sessionId`), the
// source type, the owner session and the route-fallback primary. Rust
// `run_host::accounting_scope::HeaderScope` must give the same identity for the same session.
//
//   node benchmarks/rust-core/recorders/record-accounting-scope.mjs [--tree <dir>]
//
// Output: native/core/fixtures/accounting-scope/golden.json.
process.env.TZ = 'UTC';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'accounting-scope');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-accounting-scope.mjs';
const at = (path) => importFrom(tree, path);
await at('src/runtime/shared/llm/usage-test-support.mjs');
process.env.MIXDOG_USAGE_LEDGER_PATH = join(mkdtempSync(join(tmpdir(), 'acct-scope-')), 'ledger.sqlite');
const { UsageLedger, closeUsageLedgers } = await at('src/runtime/shared/llm/usage-ledger.mjs');
const { accountProviderSend } = await at('src/runtime/shared/llm/usage-accounting.mjs');

let captured = [];
UsageLedger.prototype.recordQueued = async function recordQueued(row) {
  captured.push(row);
};

const CASES = [
  { name: 'a request alone', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'lead' } },
  { name: 'no kind', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1' } },
  { name: 'a compaction under its source session', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1:compact', usageSessionId: 's1', requestKind: 'compaction' } },
  { name: 'the session type wins over the kind', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'lead' }, session: { id: 's1', provider: 'openai', sourceType: 'cli' } },
  { name: 'an empty session type falls to the kind', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'lead' }, session: { id: 's1', provider: 'openai', sourceType: '' } },
  { name: 'an owner session', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'agent' }, session: { id: 's1', provider: 'openai', ownerSessionId: 'o1' } },
  { name: 'a parent session', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'agent' }, session: { id: 's1', provider: 'openai', parentSessionId: 'p1' } },
  { name: 'the owner wins over the parent', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'agent' }, session: { id: 's1', provider: 'openai', ownerSessionId: 'o1', parentSessionId: 'p1' } },
  { name: 'a route hop asks the primary route', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'lead' }, session: { id: 's1', provider: 'openai', routeFallbackPrimary: { provider: 'anthropic', model: 'claude-x' } } },
  { name: 'a primary on another provider is not this send', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'lead' }, session: { id: 's1', provider: 'anthropic', routeFallbackPrimary: { provider: 'anthropic', model: 'claude-x' } } },
  { name: 'a primary equal to the route is no hop', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'lead' }, session: { id: 's1', provider: 'openai', routeFallbackPrimary: { provider: 'openai', model: 'gpt-x' } } },
  { name: 'a primary on the same provider but another model is a hop', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'lead' }, session: { id: 's1', provider: 'openai', routeFallbackPrimary: { provider: 'openai', model: 'gpt-y' } } },
  { name: 'a primary without a provider is no hop', provider: 'openai', model: 'gpt-x', opts: { sessionId: 's1', requestKind: 'lead' }, session: { id: 's1', provider: 'openai', routeFallbackPrimary: { model: 'gpt-y' } } },
];

const instance = { constructor: {} };
const out = [];
for (const spec of CASES) {
  captured = [];
  await accountProviderSend(spec.provider, instance, async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }), spec.model, {
    ...spec.opts,
    ...(spec.session ? { session: spec.session } : {}),
  });
  const [row] = captured;
  out.push({
    ...spec,
    identity: {
      sessionId: row.sessionId ?? null,
      sourceType: row.sourceType,
      ownerSessionId: row.ownerSessionId ?? null,
      requestedProvider: row.requestedProvider,
      requestedModel: row.requestedModel,
    },
  });
}
writeJson(join(stage, 'golden.json'), { cases: out });
writeSetManifest(stage, { set: 'accounting-scope', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
closeUsageLedgers();
