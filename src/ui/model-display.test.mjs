import test from 'node:test';
import assert from 'node:assert/strict';
import { displayModelName } from './model-display.mjs';

test('gateway brand ids get models.dev-style labels without a catalog', () => {
  const cases = {
    'kimi-k2.7-code': 'Kimi K2.7 Code',
    'qwen3.8-max': 'Qwen3.8 Max',
    'glm-5.3-flash': 'GLM-5.3-Flash',
    'minimax-m3': 'MiniMax-M3',
    'mimo-v2.5-pro': 'MiMo V2.5 Pro',
    'muse-spark-1.3-contributor': 'Muse Spark 1.3',
    'longcat-2.0': 'LongCat-2.0',
    'hy4-preview': 'Hy4 Preview',
  };
  for (const [id, expected] of Object.entries(cases)) {
    assert.equal(displayModelName(id, 'opencode-go'), expected, id);
  }
});

test('a curated hint (user alias) wins over the id-derived label', () => {
  assert.equal(displayModelName('muse-spark-1.3-contributor', 'opencode-go', 'Muse Spark 1.3'), 'Muse Spark 1.3');
  assert.equal(displayModelName('gpt-5.6-luna', 'opencode-go', 'Luna'), 'Luna');
});

test('a hint that only re-spaces the id does not override the canonical rule', () => {
  assert.equal(displayModelName('claude-sonnet-4-5', 'anthropic', 'Claude Sonnet 4.5'), 'Claude Sonnet 4.5');
  assert.equal(displayModelName('gpt-5.5', 'openai-oauth', 'gpt-5.5'), 'GPT-5.5');
  assert.equal(displayModelName('deepseek-v4-pro', 'opencode-go', 'DeepSeek V4 Pro'), 'DeepSeek V4 Pro');
});
