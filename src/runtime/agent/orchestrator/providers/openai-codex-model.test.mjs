import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    _codexMaxContextWindow,
    _normalizeCodexModel,
} from './openai-codex-model.mjs';

test('validated GPT-5.6 Codex models expose a 272k default and 1M maximum', () => {
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
        const model = _normalizeCodexModel({
            slug: id,
            context_window: 272_000,
            max_context_window: 272_000,
        });
        assert.equal(model.contextWindow, 272_000);
        assert.equal(model.maxContextWindow, 1_000_000);
    }
});

test('Codex maximum overrides preserve larger provider values and unrelated models', () => {
    assert.equal(_codexMaxContextWindow('gpt-5.6-sol', 1_050_000), 1_050_000);
    assert.equal(_codexMaxContextWindow('gpt-5.5', 272_000), 272_000);
});
