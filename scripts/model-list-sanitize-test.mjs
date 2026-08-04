import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeModelList } from '../src/runtime/agent/orchestrator/providers/model-list-sanitize.mjs';

test('Anthropic staleness keeps Claude subfamilies separate', () => {
  const prev = process.env.MIXDOG_MODEL_STALE_MONTHS;
  process.env.MIXDOG_MODEL_STALE_MONTHS = '0';
  try {
    const models = [
      { id: 'claude-opus-4-8', mode: 'chat' },
      { id: 'claude-sonnet-4-6', mode: 'chat' },
      { id: 'claude-haiku-4-5-20251001', mode: 'chat' },
    ];
    const catalogRow = (release_date) => ({
      family: 'claude',
      release_date,
      tool_call: true,
      modalities: { output: ['text'] },
    });
    const out = sanitizeModelList(models, {
      provider: 'anthropic',
      _testCatalog: {
        anthropic: {
          models: {
            'claude-opus-4-8': catalogRow('2025-12-01'),
            'claude-sonnet-4-6': catalogRow('2025-11-01'),
            'claude-haiku-4-5-20251001': catalogRow('2025-10-15'),
          },
        },
      },
    });
    assert.deepEqual(out.map((m) => m.id), models.map((m) => m.id));
  } finally {
    if (prev == null) delete process.env.MIXDOG_MODEL_STALE_MONTHS;
    else process.env.MIXDOG_MODEL_STALE_MONTHS = prev;
  }
});
