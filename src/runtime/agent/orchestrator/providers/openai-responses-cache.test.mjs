import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequestBody } from './openai-responses-payload.mjs';
import { _computeDelta, _sansInput, _stableStringify } from './openai-ws-delta.mjs';
import { _withCodexWsClientMetadata } from './openai-codex-metadata.mjs';

test('a new Codex turn keeps its history delta-safe without freezing request identity', (t) => {
    const previousTransport = process.env.MIXDOG_OAI_TRANSPORT;
    process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
    t.after(() => {
        if (previousTransport === undefined) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = previousTransport;
    });
    const options = {
        promptCacheProvider: 'openai-oauth',
        sessionId: 'responses-cache-regression',
        codexSessionId: '019fc135-f07a-7880-8767-ec3b7be1de60',
        turnId: '019fc135-f07a-7880-8767-ec3b7be1de64',
        installationId: '00000000-0000-4000-8000-000000000001',
        effort: 'medium',
    };
    const history = [
        { role: 'system', content: 'stable rules' },
        { role: 'system', content: 'stable environment', cacheTier: 'env' },
        { role: 'user', content: 'first question' },
    ];
    const first = buildRequestBody(history, 'gpt-5.6-sol', [], options);
    const reply = {
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'first answer' }],
    };
    const entry = {
        lastRequestSansInput: _stableStringify(_sansInput(first)),
        lastRequestInput: first.input,
        lastResponseId: 'resp-first',
        lastResponseItems: [reply],
    };
    // A persisted/reloaded transcript must work too; no object-identity memo
    // may conceal request metadata being stamped into historical input.
    const nextHistory = JSON.parse(JSON.stringify([
        ...history,
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
    ]));
    const nextOptions = { ...options, turnId: '019fc135-f07a-7880-8767-ec3b7be1de65' };
    const next = buildRequestBody(nextHistory, 'gpt-5.6-sol', [], nextOptions);
    const delta = _computeDelta({ entry, body: next, traceProvider: 'openai-oauth' });
    assert.equal(delta.mode, 'delta');
    assert.equal(delta.frame.previous_response_id, 'resp-first');
    assert.deepEqual(delta.frame.input, [next.input.at(-1)]);
    assert.equal(delta.frame.input[0].content[0].text, 'second question');

    const frame = _withCodexWsClientMetadata(delta.frame, {}, true, {
        cacheKey: next.prompt_cache_key, sendOpts: nextOptions,
    });
    assert.equal(frame.client_metadata.turn_id, nextOptions.turnId);
    assert.notEqual(frame.client_metadata.turn_id, options.turnId);

    // Stabilizing metadata must not bypass the real history-change guard.
    nextHistory[2] = { ...nextHistory[2], content: 'corrected first question' };
    const corrected = buildRequestBody(nextHistory, 'gpt-5.6-sol', [], nextOptions);
    const full = _computeDelta({ entry, body: corrected, traceProvider: 'openai-oauth' });
    assert.equal(full.mode, 'full');
    assert.equal(full.reason, 'input_prefix_mismatch');
    assert.equal(full.frame.previous_response_id, undefined);
    assert.deepEqual(full.frame.input, corrected.input);
});
