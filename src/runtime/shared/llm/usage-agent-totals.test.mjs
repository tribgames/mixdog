import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { accountScopedSessionId } from '../provider-accounts.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';
import { clearStoredSessionCatalog } from '../../agent/orchestrator/session/store-summary-reader.mjs';
import { closeSessionCatalogDb } from '../../agent/orchestrator/session/catalog-db/index.mjs';

const entry = (sessionId, responseId = sessionId, extra = {}) =>
  makeUsageRecord({
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    sessionId,
    responseId,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: 0.25,
    ...extra,
  });

function setup(t, links, live = []) {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  const api = createUsageStatsApi({
    ledger: () => ledger,
    getSessionId: () => 'lead',
    sessionLinks: async () => links,
    workerLinks: () => live,
    accountPool: (provider) => ({
      accounts: provider === 'anthropic-oauth' ? [{ id: 'account-1' }] : [],
    }),
  });
  return { ledger, api };
}

test('cumulative agents include closed generations, nested ownership and aliases exactly once beyond 64 rows', async (t) => {
  const links = Array.from({ length: 70 }, (_, i) => ({ id: `agent_${i}`, ownerSessionId: 'lead' }));
  links.push(
    { id: 'nested', ownerSessionId: 'agent_0' },
    { id: 'foreign', ownerSessionId: 'another-lead' },
    { id: 'cycle_a', ownerSessionId: 'cycle_b' },
    { id: 'cycle_b', ownerSessionId: 'cycle_a' },
    { id: 'lead', ownerSessionId: null }
  );
  const { ledger, api } = setup(t, links, [{ sessionId: 'agent_0', ownerSessionId: 'lead' }]);
  ledger.record([
    entry('lead'),
    ...Array.from({ length: 70 }, (_, i) => entry(`agent_${i}`)),
    entry('nested'),
    entry(accountScopedSessionId('anthropic-oauth', 'account-1', 'agent_0'), 'alias'),
    entry('agent_0', 'compact', { sourceType: 'compact' }),
    entry('foreign'),
    entry('cycle_a'),
    entry('cycle_b'),
  ]);
  const result = await api.getSessionUsage({ includeAgents: true, sessionIds: ['agent_69', 'agent_69', 'lead'] });
  assert.equal(result.tokens, 110);
  assert.equal(result.agents.turns, 73);
  assert.equal(result.agents.tokens, 73 * 110);
  assert.equal(result.agents.costUsd, 73 * 0.25);
  assert.equal(result.agents.unmeasuredTurns, 0);
  assert.deepEqual(Object.keys(result.sessions), ['agent_69']);
  assert.equal(result.sessions.agent_69.tokens, 110);
  assert.equal((await api.getSessionUsage({ includeAgents: true })).agents.tokens, 73 * 110);
});

test('live ownership covers unsaved children but cannot override foreign or ordinary catalog rows', async (t) => {
  const { ledger, api } = setup(
    t,
    [
      { id: 'foreign', ownerSessionId: 'another-lead' },
      { id: 'ordinary', ownerSessionId: null },
    ],
    [
      { sessionId: 'new', parentSessionId: 'lead' },
      { sessionId: 'foreign', ownerSessionId: 'lead' },
      { sessionId: 'ordinary', ownerSessionId: 'lead' },
    ]
  );
  ledger.record([entry('lead'), entry('new'), entry('foreign'), entry('ordinary')]);
  const result = await api.getSessionUsage({ includeAgents: true, sessionIds: ['new'] });
  assert.equal(result.agents.tokens, 110);
  for (const id of ['foreign', 'ordinary', 'unresolved']) {
    const unknown = await api.getSessionUsage({ includeAgents: true, sessionIds: [id] });
    assert.equal(unknown.agents, null, id);
  }
});

test('unavailable ownership differs from a known empty group and does not affect ordinary Context reads', async (t) => {
  const { ledger, api } = setup(t, null, [{ sessionId: 'live', ownerSessionId: 'lead' }]);
  ledger.record([entry('lead'), entry('live')]);
  const unknown = await api.getSessionUsage({ includeAgents: true, sessionIds: ['live'] });
  assert.equal(unknown.agents, null);
  assert.equal(unknown.sessions.live.tokens, 110);
  assert.equal(Object.hasOwn(await api.getSessionUsage(), 'agents'), false);
  const { api: empty } = setup(t, []);
  const known = await empty.getSessionUsage({ includeAgents: true });
  assert.equal(known.agents.turns, 0);
  assert.equal(known.agents.tokens, 0);
  assert.equal(known.agents.unmeasuredTurns, 0);
  const { api: unreadableWorkers } = setup(t, [], null);
  assert.equal((await unreadableWorkers.getSessionUsage({ includeAgents: true })).agents, null);
});

test('closed unmeasured and unpriced calls retain their coverage flags', async (t) => {
  const { ledger, api } = setup(t, [
    { id: 'closed', ownerSessionId: 'lead' },
    { id: 'live', ownerSessionId: 'lead' },
  ]);
  ledger.record([
    entry('lead'),
    entry('live'),
    entry('closed', 'measured'),
    entry('closed', 'unmeasured', { inputTokens: null, inputTokensKnown: false, outputTokens: 0, costUsd: null }),
  ]);
  const result = await api.getSessionUsage({ includeAgents: true, sessionIds: ['live'] });
  assert.equal(result.agents.turns, 3);
  assert.equal(result.agents.unmeasuredTurns, 1);
  assert.equal(result.agents.costUnpricedTurns, 1);
  assert.equal(result.sessions.live.unmeasuredTurns, 0);
});

test('persisted closed agents survive API restart, a reused tag and lead compaction without pool rows', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-usage-history-'));
  const prior = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  mkdirSync(join(root, 'sessions'));
  let ledger = new UsageLedger(join(root, 'usage.sqlite'));
  t.after(async () => {
    ledger.close();
    await closeSessionCatalogDb();
    clearStoredSessionCatalog();
    if (prior === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = prior;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const save = (id, closed = false) =>
    writeFileSync(
      join(root, 'sessions', `${id}.json`),
      JSON.stringify({
        id,
        owner: id === 'lead' ? 'user' : 'agent',
        agent: id === 'lead' ? 'lead' : 'worker',
        ownerSessionId: id === 'lead' ? null : 'lead',
        agentTag: id === 'lead' ? null : 'same-tag',
        closed,
        messages: [],
      })
    );
  const create = () =>
    createUsageStatsApi({ ledger: () => ledger, getSessionId: () => 'lead', accountPool: () => ({ accounts: [] }) });
  save('lead');
  for (let i = 0; i < 6; i++) save(`agent_${i}`);
  ledger.record([entry('lead'), ...Array.from({ length: 6 }, (_, i) => entry(`agent_${i}`))]);
  const read = (api, ids) => api.getSessionUsage({ includeAgents: true, sessionIds: ids });
  const first = await read(create(), ['agent_5']);
  assert.equal(first.agents.tokens, 660);
  for (let i = 0; i < 6; i++) save(`agent_${i}`, true);
  save('agent_6');
  ledger.record([entry('agent_6'), entry('lead', 'lead-compact', { sourceType: 'compact' })]);
  ledger.close();
  ledger = new UsageLedger(join(root, 'usage.sqlite'));
  clearStoredSessionCatalog();
  const restored = await read(create(), ['agent_6']);
  assert.equal(restored.tokens, 220);
  assert.equal(restored.agents.tokens, 770);
  assert.equal(restored.agents.costUsd, 1.75);
  assert.deepEqual(Object.keys(restored.sessions), ['agent_6']);
  // A worker can have durable usage before its first session save. Losing
  // access to its ownership index must not turn that spend into exact zero.
  ledger.record([entry('unsaved')]);
  const workerPath = join(root, 'agent-workers.json');
  writeFileSync(workerPath, JSON.stringify({ workers: [{ sessionId: 'unsaved', ownerSessionId: 'lead' }] }));
  assert.equal((await read(create(), [])).agents.tokens, 880);
  writeFileSync(workerPath, '{');
  assert.equal((await read(create(), [])).agents, null);
});
