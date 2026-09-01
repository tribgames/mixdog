import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ANTHROPIC_CACHE_TTL_STABLE,
    applyAnthropicCacheMarkers,
} from './lib/anthropic-request-utils.mjs';
import { SUMMARY_PREFIX } from '../session/compact/constants.mjs';

function cacheControlOf(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    return blocks.at(-1)?.cache_control || null;
}

test('Anthropic uses the compact summary as the stable message cache anchor', () => {
    const messages = [
        { role: 'user', content: `${SUMMARY_PREFIX}\n\nfull cumulative handoff` },
        { role: 'assistant', content: '.' },
        { role: 'user', content: '<system-reminder>GOAL</system-reminder>\n\nlatest instruction' },
    ];
    const marked = applyAnthropicCacheMarkers(structuredClone(messages), {
        messageTtl: ANTHROPIC_CACHE_TTL_STABLE,
        messageSlots: 1,
    });

    assert.deepEqual(cacheControlOf(marked[0]), ANTHROPIC_CACHE_TTL_STABLE);
    assert.equal(cacheControlOf(marked[2]), null);
});

test('Anthropic keeps the live-tail cache anchor when no compact summary exists', () => {
    const messages = [
        { role: 'user', content: 'older instruction' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'latest instruction' },
    ];
    const marked = applyAnthropicCacheMarkers(structuredClone(messages), {
        messageTtl: ANTHROPIC_CACHE_TTL_STABLE,
        messageSlots: 1,
    });

    assert.deepEqual(cacheControlOf(marked[2]), ANTHROPIC_CACHE_TTL_STABLE);
});
