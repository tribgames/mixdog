import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeUsageLedgers, getUsageLedger } from './usage-ledger.mjs';
import { accountProviderSend } from './usage-accounting.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';

const TURN_TOKENS = 110;

// A live send of one measured turn, as the agent loop makes it: the session
// record rides in the send options.
const turn = (session, responseId) =>
  accountProviderSend(
    'anthropic',
    {},
    async () => ({ model: 'claude-opus-4-8', responseId, usage: { inputTokens: 100, outputTokens: 10 } }),
    'claude-opus-4-8',
    { sessionId: session.id, session }
  );

const leadUsage = (options) =>
  createUsageStatsApi({
    ledger: getUsageLedger,
    importHistory: async () => {},
    accountPool: () => ({ accounts: [] }),
    getSessionId: () => 'lead-a',
  }).getSessionUsage(options);

test("a Lead's agents total keeps every agent it ran once they finish, close or are replaced", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-usage-agents-'));
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = join(dir, 'ledger.sqlite');
  t.after(() => {
    closeUsageLedgers();
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const read = (sessionIds) => leadUsage({ sessionIds, agents: true });

  await turn({ id: 'lead-a' }, 'lead');
  // More agents than a usage request may name, one spawned by an agent
  // (linked by its parent only), and another Lead's agent.
  const agents = Array.from({ length: 70 }, (_, index) => `agent-${index}`);
  for (const id of agents) await turn({ id, ownerSessionId: 'lead-a', parentSessionId: 'lead-a' }, id);
  await turn({ id: 'nested', parentSessionId: 'agent-0' }, 'nested');
  await turn({ id: 'other-agent', ownerSessionId: 'lead-b' }, 'other');
  // A record from before owners were kept counts only while it is listed.
  await turn({ id: 'unlinked' }, 'unlinked');

  const live = await read(['agent-67', 'agent-68', 'agent-69', 'unlinked']);
  assert.equal(live.tokens, TURN_TOKENS, 'the Lead is its own figure');
  assert.equal(live.agents.turns, 72);
  assert.equal(live.agents.tokens, 72 * TURN_TOKENS);
  assert.equal(live.agents.unmeasuredTurns, 0);

  // Every listed agent finished and closed; one replacement now runs.
  await turn({ id: 'replacement', ownerSessionId: 'lead-a' }, 'replacement');
  const replaced = await read(['replacement']);
  assert.equal(replaced.agents.tokens, 72 * TURN_TOKENS);
  assert.deepEqual(Object.keys(replaced.sessions), ['replacement']);
  // No live agent at all, and the same read again: the total holds.
  const closed = await read([]);
  assert.deepEqual(closed.agents, replaced.agents);
  assert.deepEqual(await read([]), closed);
  // A listed agent the ledger already links is counted once.
  assert.equal((await read(['agent-1', 'replacement'])).agents.tokens, 72 * TURN_TOKENS);
  // Without the option the answer is unchanged.
  assert.equal(Object.hasOwn(await leadUsage(), 'agents'), false);
});
