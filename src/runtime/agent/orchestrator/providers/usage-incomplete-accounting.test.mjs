import '../../../shared/llm/usage-test-support.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger } from '../../../shared/llm/usage-ledger.mjs';
import { accountProviderSend } from '../../../shared/llm/usage-accounting.mjs';
import { geminiIncompleteError, geminiSendResult, resolveGeminiUsage } from './gemini-response.mjs';
import { compatReportedCostUsd, normalizeCompatChatResponse } from './openai-compat-response-normalization.mjs';
import { handleCompatResponsesStreamEvent } from './openai-compat-responses-events.mjs';
import { attachPartialState } from './openai-compat-responses-state.mjs';

test('a compat Responses incomplete error keeps the terminal model through partial-state enrichment', () => {
  const state = { model: '', content: '', toolCalls: [], pendingCalls: new Map() };
  const usage = { input_tokens: 1000, output_tokens: 100 };
  let error;
  try {
    handleCompatResponsesStreamEvent(
      {
        type: 'response.incomplete',
        response: { status: 'incomplete', model: 'grok-4.20', incomplete_details: { reason: 'content_filter' }, usage },
      },
      state,
      { label: 'xai' }
    );
  } catch (caught) {
    error = caught;
  }
  attachPartialState(error, state, []);
  assert.equal(error.partialModel, 'grok-4.20');
  assert.equal(error.partialUsage.inputTokens, 1000);
});

function useLedger(t) {
  const path = join(mkdtempSync(join(tmpdir(), 'mixdog-incomplete-usage-')), 'ledger.sqlite');
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
  return () => {
    const ledger = new UsageLedger(path);
    try {
      return ledger.db.prepare('SELECT * FROM events ORDER BY session_id').all();
    } finally {
      ledger.close();
    }
  };
}

const figures = (row) => [row.input, row.output, row.cache_read];

test('Gemini MAX_TOKENS error records one row equal to the success row', async (t) => {
  const readRows = useLedger(t);
  const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50 };
  const model = 'gemini-2.5-pro';
  const parsed = (finishReason) => ({
    candidate: { finishReason },
    content: 'partial',
    toolCalls: undefined,
    citations: [],
  });
  const build = (finishReason) => {
    const response = { usageMetadata };
    const usage = resolveGeminiUsage(response, {}, null, model);
    return { response, usage, parsed: parsed(finishReason) };
  };
  await accountProviderSend(
    'gemini',
    {},
    async () => {
      const { usage, parsed: p } = build('STOP');
      return geminiSendResult(p, model, {}, usage);
    },
    model,
    { sessionId: 'a-success' }
  );
  await assert.rejects(
    accountProviderSend(
      'gemini',
      {},
      async () => {
        const { response, usage, parsed: p } = build('MAX_TOKENS');
        throw geminiIncompleteError(response, p, model, usage);
      },
      model,
      { sessionId: 'b-incomplete' }
    )
  );
  const rows = readRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(figures(rows[1]), figures(rows[0]));
  assert.equal(rows[1].input, 1000);
  assert.equal(rows[1].output, 150);
});

test('compat incomplete error records one row equal to the success row', async (t) => {
  const readRows = useLedger(t);
  const model = 'some/model';
  const usageBody = { prompt_tokens: 500, completion_tokens: 40, cost: 0.01 };
  const run = (finish_reason, toolCalls) =>
    normalizeCompatChatResponse({
      providerName: 'openrouter',
      useModel: model,
      tools: [],
      opts: {},
      params: {},
      assembled: {
        response: { model, choices: [{ finish_reason, message: { content: 'x' } }], usage: { ...usageBody } },
        toolCalls,
      },
    });
  await accountProviderSend('openrouter', {}, async () => run('stop', []), model, { sessionId: 'a-success' });
  await assert.rejects(
    accountProviderSend('openrouter', {}, async () => run('content_filter', []), model, {
      sessionId: 'b-incomplete',
    })
  );
  const rows = readRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(figures(rows[1]), figures(rows[0]));
  assert.equal(rows[1].cost_usd, rows[0].cost_usd);
  assert.equal(rows[1].cost_source, 'provider');
});

test('null or empty reported cost is not a provider-reported zero', () => {
  assert.equal(compatReportedCostUsd('openrouter', { cost: null }), undefined);
  assert.equal(compatReportedCostUsd('openrouter', { cost: '' }), undefined);
  assert.equal(compatReportedCostUsd('openrouter', {}), undefined);
  assert.equal(compatReportedCostUsd('xai', { cost_in_usd_ticks: null }), undefined);
  assert.equal(compatReportedCostUsd('xai', { cost_in_usd_ticks: '' }), undefined);
  assert.equal(compatReportedCostUsd('openrouter', { cost: 0 }), 0);
  assert.equal(compatReportedCostUsd('xai', { cost_in_usd_ticks: 0 }), 0);
});
