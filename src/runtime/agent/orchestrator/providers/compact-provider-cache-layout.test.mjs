import assert from 'node:assert/strict';
import test from 'node:test';

import {
    _geminiCachePrefixContents,
    _geminiCachePrefixCount,
} from './gemini-cache.mjs';
import { toGeminiContents } from './gemini-schema.mjs';
import { buildRequestBody as buildOpenAIRequestBody } from './openai-responses-payload.mjs';
import { SUMMARY_PREFIX } from '../session/compact/constants.mjs';

const summary = `${SUMMARY_PREFIX}\n\nFULL_CUMULATIVE_SUMMARY`;
const volatileTail = '<system-reminder>GOAL_AND_CURRENT_TIME</system-reminder>\n\nLATEST_USER_INSTRUCTION';

test('OpenAI keeps stable system instructions and compact summary ahead of the volatile tail', () => {
    const body = buildOpenAIRequestBody([
        { role: 'system', content: 'BP1 tool policy' },
        { role: 'system', content: 'BP2 profile and skills' },
        { role: 'system', content: 'BP3 workflow and memory', cacheTier: 'tier3' },
        { role: 'system', content: 'SESSION_ENVIRONMENT', cacheTier: 'env' },
        { role: 'user', content: summary },
        { role: 'assistant', content: '.' },
        { role: 'user', content: volatileTail },
    ], 'gpt-5.6-sol', [], {
        promptCacheProvider: 'openai-oauth',
        sessionId: 'cache-layout-session',
    });

    assert.match(body.instructions, /BP1 tool policy/);
    assert.doesNotMatch(body.instructions, /SESSION_ENVIRONMENT/);
    const texts = body.input.map((item) => (
        item?.content?.map?.((block) => block?.text || '').join('') || ''
    ));
    assert.match(texts[0], /SESSION_ENVIRONMENT/);
    const summaryIndex = texts.findIndex((text) => text.includes('FULL_CUMULATIVE_SUMMARY'));
    const volatileIndex = texts.findIndex((text) => text.includes('LATEST_USER_INSTRUCTION'));
    assert.ok(summaryIndex > 0);
    assert.ok(volatileIndex > summaryIndex);
});

test('Gemini cachedContent includes summary and ack but excludes the volatile latest user item', () => {
    const contents = toGeminiContents([
        { role: 'user', content: summary },
        { role: 'assistant', content: '.' },
        { role: 'user', content: volatileTail },
    ], 'gemini-3.1-pro-preview');
    const prefixCount = _geminiCachePrefixCount(contents);
    const prefix = _geminiCachePrefixContents(contents, prefixCount);
    const prefixText = JSON.stringify(prefix);

    assert.equal(prefixCount, contents.length - 1);
    assert.match(prefixText, /FULL_CUMULATIVE_SUMMARY/);
    assert.doesNotMatch(prefixText, /LATEST_USER_INSTRUCTION/);
    assert.match(JSON.stringify(contents.at(-1)), /LATEST_USER_INSTRUCTION/);
});
