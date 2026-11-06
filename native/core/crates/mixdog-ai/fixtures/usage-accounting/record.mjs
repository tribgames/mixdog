// Records the ledger rows `accountProviderSend` writes for completed, cancelled
// and failed sends (usage-accounting.mjs, makeUsageRecord in usage-ledger.mjs):
//   node record.mjs > golden.json
// from the Mixdog Node tree (MIXDOG_NODE_ROOT, default C:/Project/mixdog).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.MIXDOG_NODE_ROOT || 'C:/Project/mixdog';
const at = (path) => import(pathToFileURL(join(root, path)).href);
await at('src/runtime/shared/llm/usage-test-support.mjs');
process.env.MIXDOG_USAGE_LEDGER_PATH = join(mkdtempSync(join(tmpdir(), 'usage-acct-')), 'ledger.sqlite');
const { UsageLedger, closeUsageLedgers } = await at('src/runtime/shared/llm/usage-ledger.mjs');
const { accountProviderSend } = await at('src/runtime/shared/llm/usage-accounting.mjs');
const { noteAbandonedUsage } = await at('src/runtime/shared/llm/usage-context.mjs');

const START = 1_700_000_000_000;
let clock = START;
Date.now = () => clock;
let captured = [];
UsageLedger.prototype.recordQueued = async function recordQueued(row) {
  captured.push(row);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const view = (row) => ({ ...row, id: row.id.replace(UUID, '<req>'), rates: JSON.stringify(row.rates) });

// Each case: how the send ends, in plain data.
const cases = [
  {
    name: 'completed with usage',
    provider: 'openai', model: 'zz-test-model',
    end: { kind: 'completed', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 } },
  },
  {
    name: 'completed with a response id, a served snapshot and a timed first output',
    provider: 'anthropic', model: 'zz-claude', inputExcludesCache: true,
    end: {
      kind: 'completed', model: 'zz-claude-20260101', responseId: 'msg_1', generationMs: 400, streamMs: 1500,
      usage: { inputTokens: 50, outputTokens: 10, cachedTokens: 5, cacheWriteTokens: 7 },
    },
  },
  {
    name: 'completed with one-hour cache writes',
    provider: 'anthropic', model: 'zz-claude', inputExcludesCache: true,
    end: { kind: 'completed', usage: { inputTokens: 50, outputTokens: 10, cacheWriteTokens: 9, cacheWrite1hTokens: 4 } },
  },
  { name: 'completed without usage', provider: 'openai', model: 'zz-test-model', end: { kind: 'completed' } },
  {
    name: 'completed on a fallback model',
    provider: 'openai', model: 'zz-test-model',
    end: { kind: 'completed', model: 'zz-other', fallback: true, usage: { inputTokens: 10, outputTokens: 2 } },
  },
  {
    name: 'completed with a provider-reported cost',
    provider: 'xai', model: 'zz-grok',
    end: { kind: 'completed', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.5 } },
  },
  {
    name: 'completed on a subscription route',
    provider: 'openai-oauth', model: 'zz-test-model', sessionId: 'no-session',
    end: { kind: 'completed', usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.25 } },
  },
  {
    name: 'completed on the local runtime',
    provider: 'mixdog-local', model: 'zz-local',
    end: { kind: 'completed', generationMs: 100, streamMs: 900, usage: { inputTokens: 10, outputTokens: 2 } },
  },
  {
    name: 'completed after an abandoned attempt',
    provider: 'openai', model: 'zz-test-model',
    abandoned: [{ usage: { inputTokens: 40, outputTokens: 4 }, model: 'zz-test-model' }],
    end: { kind: 'completed', usage: { inputTokens: 60, outputTokens: 6 } },
  },
  {
    name: 'cancelled with reported usage',
    provider: 'openai', model: 'zz-test-model',
    end: { kind: 'cancelled', usage: { inputTokens: 80, outputTokens: 3, cachedTokens: 10 } },
  },
  { name: 'cancelled without usage', provider: 'openai', model: 'zz-test-model', end: { kind: 'cancelled' } },
  {
    name: 'cancelled after an abandoned attempt',
    provider: 'openai', model: 'zz-test-model',
    abandoned: [{ usage: { inputTokens: 40, outputTokens: 4 } }],
    end: { kind: 'cancelled', usage: { inputTokens: 5, outputTokens: 1 } },
  },
  {
    name: 'failed with partial usage',
    provider: 'openai', model: 'zz-test-model',
    end: { kind: 'failed', usage: { inputTokens: 70, outputTokens: 2, cachedTokens: 20 } },
  },
  { name: 'failed without usage', provider: 'openai', model: 'zz-test-model', end: { kind: 'failed' } },
  {
    name: 'failed with partial usage from a served model',
    provider: 'openai', model: 'zz-test-model',
    end: { kind: 'failed', usage: { inputTokens: 30, outputTokens: 1 }, model: 'zz-served-model' },
  },
  {
    name: 'failed after an abandoned attempt',
    provider: 'anthropic', model: 'zz-claude', inputExcludesCache: true, ownerSessionId: 'lead-1',
    abandoned: [{ usage: { inputTokens: 40, outputTokens: 4 }, model: 'zz-claude' }],
    end: { kind: 'failed' },
  },
  {
    name: 'failed with a provider-reported cost only',
    provider: 'xai', model: 'zz-grok',
    end: { kind: 'failed', usage: { costUsd: 0.125 } },
  },
];

const out = [];
for (const spec of cases) {
  captured = [];
  clock = START;
  const controller = new AbortController();
  const instance = { constructor: { inputExcludesCache: spec.inputExcludesCache === true } };
  const send = async () => {
    for (const attempt of spec.abandoned || []) noteAbandonedUsage({ ...attempt.usage }, attempt.model);
    clock = START + (spec.end.streamMs ?? 1500);
    const { kind, usage } = spec.end;
    if (kind === 'completed') {
      return {
        ...(usage ? { usage: { ...usage } } : {}),
        ...(spec.end.model ? { model: spec.end.model } : {}),
        ...(spec.end.responseId ? { responseId: spec.end.responseId } : {}),
        ...(spec.end.generationMs !== undefined ? { generationMs: spec.end.generationMs } : {}),
        ...(spec.end.fallback ? { providerMetadata: { anthropicFallbacks: ['x'] } } : {}),
      };
    }
    const error = new Error(kind);
    if (usage) error.partialUsage = { ...usage };
    if (spec.end.model) error.partialModel = spec.end.model;
    if (kind === 'cancelled') {
      controller.abort();
      error.name = 'AbortError';
    }
    throw error;
  };
  try {
    await accountProviderSend(spec.provider, instance, send, spec.model, {
      sessionId: spec.sessionId || 'session-1',
      sourceType: 'lead',
      signal: controller.signal,
      ...(spec.ownerSessionId ? { session: { id: 'session-1', sourceType: 'lead', ownerSessionId: spec.ownerSessionId } } : {}),
    });
  } catch {
    // the send's own error is rethrown
  }
  out.push({ ...spec, startedAt: START, rows: captured.map(view) });
}
process.stdout.write(`${JSON.stringify({ startedAt: START, cases: out }, null, 1)}\n`);
closeUsageLedgers();
