import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { closeUsageLedgers, getUsageLedger } from './usage-ledger.mjs';
import { accountProviderSend } from './usage-accounting.mjs';
import { groupUsageTokens, resetGroupUsageTokens } from './usage-group-tokens.mjs';
import { withLedgerToken } from '../../agent/orchestrator/session/agent-pool-progress.mjs';

const send = (session, responseId, usage = { inputTokens: 100, outputTokens: 10 }) =>
  accountProviderSend(
    'anthropic',
    {},
    async () => ({ model: 'claude-opus-4-8', responseId, ...(usage ? { usage } : {}) }),
    'claude-opus-4-8',
    { sessionId: session.id, session }
  );

const groups = () =>
  new Map([
    ['lead', new Set(['lead', 'agent-1'])],
    ['lead-b', new Set(['lead-b', 'b-1'])],
  ]);

/** Asks until the background refresh has landed `ready`. */
async function settled(ready) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const tokens = groupUsageTokens(groups());
    if (ready(tokens)) return tokens;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the group tokens never settled');
}

test('group tokens are read in the background and move only for the groups whose figures can change', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-group-tokens-'));
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = join(dir, 'ledger.sqlite');
  let wakes = 0;
  const { onSessionActivityChange } = await import('../session-activity-signal.mjs');
  const stop = onSessionActivityChange(() => (wakes += 1));
  t.after(async () => {
    // A background token read may still hold the file.
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop();
    resetGroupUsageTokens();
    closeUsageLedgers();
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  assert.equal(groupUsageTokens(groups()).size, 0, 'no ledger open: nothing to ask');
  getUsageLedger();
  await send({ id: 'lead' }, 'a');
  await send({ id: 'agent-1', ownerSessionId: 'lead' }, 'b');
  await send({ id: 'b-1', ownerSessionId: 'lead-b' }, 'c');

  // A listing never waits: the first call returns what is known (nothing) and asks.
  assert.equal(groupUsageTokens(groups()).size, 0);
  const first = new Map(await settled((tokens) => tokens.size === 2));
  assert.match(first.get('lead'), /^\d+\.\d+\.\d+\.\d+$/);

  // Sessions of no group commit, on the same day and model.
  await send({ id: 'unrelated-1', ownerSessionId: 'someone' }, 'd');
  await send({ id: 'unrelated-2' }, 'e');
  const before = wakes;
  await new Promise((resolve) => setTimeout(resolve, 100));
  groupUsageTokens(groups());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual([...groupUsageTokens(groups())], [...first], 'unrelated commits leave every token alone');
  assert.ok(wakes >= before, 'the commits themselves woke the pool');

  // A response with no usage from an agent of one group moves that group only.
  await send({ id: 'agent-1', ownerSessionId: 'lead' }, 'f', null);
  const moved = await settled((tokens) => tokens.get('lead') !== first.get('lead'));
  assert.equal(moved.get('lead-b'), first.get('lead-b'));

  // Rows carry the token of the group they name as owner.
  const rows = withLedgerToken(
    [
      { sessionId: 'lead', ownerSessionId: 'lead' },
      { sessionId: 'agent-1', ownerSessionId: 'lead' },
      { sessionId: 'b-1', ownerSessionId: 'lead-b' },
      { sessionId: 'lonely', ownerSessionId: null },
    ],
    groupUsageTokens
  );
  assert.deepEqual(
    rows.map((row) => row.ledgerToken),
    [moved.get('lead'), moved.get('lead'), moved.get('lead-b'), undefined]
  );

  // A group that is no longer listed is forgotten.
  groupUsageTokens(new Map([['lead', new Set(['lead', 'agent-1'])]]));
  await settled(() => groupUsageTokens(new Map([['lead', new Set(['lead', 'agent-1'])]])).size === 1);

  // An empty pool forgets the last groups at once...
  assert.equal(groupUsageTokens(new Map()).size, 0);
  // ...and a refresh still out for groups since removed does not bring them back.
  await send({ id: 'agent-1', ownerSessionId: 'lead' }, 'g');
  groupUsageTokens(groups());
  assert.equal(groupUsageTokens(new Map()).size, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(groupUsageTokens(new Map()).size, 0, 'removed groups stay removed');
});
