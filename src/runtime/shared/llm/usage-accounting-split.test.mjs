import './usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger } from './usage-ledger.mjs';
import { accountProviderSend } from './usage-accounting.mjs';
import { noteAbandonedUsage } from './usage-context.mjs';
import { OpenCodeGoProvider } from '../../agent/orchestrator/providers/opencode-go.mjs';

function useLedger(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-usage-split-')), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  return path;
}

test('OpenCode Go messages route records failure and abandoned usage like success', async (t) => {
  const path = useLedger(t);
  const model = 'minimax-m2.5';
  const usage = () => ({ inputTokens: 100, outputTokens: 100, cachedTokens: 900, cacheWriteTokens: 0 });
  const provider = new OpenCodeGoProvider({ apiKey: 'k' });
  const run = (sessionId, inner) => {
    provider.anthropic = { send: inner };
    return accountProviderSend('opencode-go', provider, () => provider.send([], model, [], { sessionId }), model, {
      sessionId,
    });
  };
  await run('ok', async () => ({ model, usage: usage() }));
  await assert.rejects(run('usage', async () => Promise.reject(Object.assign(new Error('x'), { usage: usage() }))));
  await assert.rejects(
    run('partial', async () =>
      Promise.reject(Object.assign(new Error('x'), { partialUsage: usage(), partialModel: model }))
    )
  );
  await run('abandoned', async () => {
    noteAbandonedUsage(usage(), model);
    return { model, usage: { inputTokens: 0, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0 } };
  });
  const ledger = new UsageLedger(path);
  t.after(() => ledger.close());
  const rowFor = (sessionId, minOut = 100) =>
    ledger.db.prepare('SELECT * FROM events WHERE session_id=? AND output>=?').get(sessionId, minOut);
  const ok = rowFor('ok');
  for (const id of ['usage', 'partial', 'abandoned']) {
    const row = rowFor(id);
    assert.equal(row.input, ok.input, id);
    assert.equal(row.cost_usd, ok.cost_usd, id);
  }
  // An attempt noted as abandoned whose error later surfaces stays one row,
  // also through the OpenCode Go conversion of the surfacing error.
  await assert.rejects(
    run('noted-then-thrown', async () => {
      const error = Object.assign(new Error('x'), { partialUsage: usage(), partialModel: model });
      noteAbandonedUsage(error.partialUsage, model);
      noteAbandonedUsage(error.partialUsage, model);
      throw error;
    })
  );
  const noted = ledger.db.prepare('SELECT * FROM events WHERE session_id=?').all('noted-then-thrown');
  assert.equal(noted.length, 1);
  assert.equal(noted[0].input, ok.input);
});
