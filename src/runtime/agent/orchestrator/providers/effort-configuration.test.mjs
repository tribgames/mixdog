import assert from 'node:assert/strict';
import test from 'node:test';
import {
    EFFORT_CONFIGURATION_BETA,
    effortConfigurationMode,
    prepareTurnEffortConfiguration,
    projectEffortConfiguration,
    stripEffortConfiguration,
} from './effort-configuration.mjs';
import { buildRequestBody } from './openai-responses-payload.mjs';
import { _buildRequestBodyForCacheSmoke, _test as oauthTest } from './anthropic-oauth.mjs';
import { AnthropicProvider } from './anthropic.mjs';
import { _sessionForDisk } from '../session/store/serialize.mjs';
import { freshContextCompactMessages } from '../session/compact.mjs';
import { generateFreshHandoffSummary } from '../session/compact/runner.mjs';
import { createLifecycleApi } from '../../../../session-runtime/lifecycle-api.mjs';

function sessionFor(provider, model) {
    return {
        id: `effort-${provider}`, provider, model, effort: 'low', tools: [],
        messages: [{ role: 'system', content: 'Stable instructions.', cacheTier: 'tier1' }],
    };
}

function appendTurn(session, effort, content = `Question at ${effort}`, config = {}) {
    session.effort = effort;
    const snapshot = prepareTurnEffortConfiguration(session, { config });
    session.messages.push({
        role: 'user', content,
        ...(snapshot ? { meta: { effortConfiguration: snapshot } } : {}),
    });
    return { effort, effortConfiguration: snapshot, promptCacheProvider: session.provider, sessionId: session.id };
}

function withoutCacheMarkers(value) {
    if (Array.isArray(value)) return value.map(withoutCacheMarkers);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'cache_control')
        .map(([key, entry]) => [key, withoutCacheMarkers(entry)]));
}

function mockAnthropicReply(model) {
    return new Response([
        { type: 'message_start', message: { id: 'msg_effort', model, role: 'assistant', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
    });
}

async function wire(session, opts = {}) {
    if (session.provider === 'anthropic') {
        let body;
        let headers;
        const provider = Object.assign(Object.create(AnthropicProvider.prototype), {
            name: 'anthropic', config: {}, fastModeBetaHeaderLatched: false,
            client: { messages: { create(params, request) {
                body = params;
                headers = request.headers;
                return { asResponse: async () => mockAnthropicReply(session.model) };
            } } },
        });
        await provider._doSend(session.messages, session.model, [], opts);
        return { body, items: body.messages, headers: headers['anthropic-beta'] };
    }
    if (session.provider === 'anthropic-oauth') {
        const body = _buildRequestBodyForCacheSmoke(session.messages, session.model, [], opts);
        return {
            body, items: body.messages,
            headers: oauthTest.buildOAuthBetaHeaders(body, { model: session.model, opts }),
        };
    }
    const body = buildRequestBody(session.messages, session.model, [], {
        ...opts, promptCacheProvider: session.provider,
    });
    return { body, items: body.input };
}

test('only documented model/protocol combinations enable cache-preserving changes', () => {
    for (const provider of ['anthropic', 'anthropic-oauth']) {
        for (const model of ['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5', 'claude-fable-5.1-20260901']) {
            assert.equal(effortConfigurationMode(provider, model), 'anthropic');
        }
        for (const model of ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-6']) {
            assert.equal(effortConfigurationMode(provider, model), null);
        }
        assert.equal(effortConfigurationMode(provider, 'claude-opus-5', { disableBetaHeaders: true }), null);
        assert.equal(effortConfigurationMode(provider, 'claude-opus-5', { baseURL: 'https://gateway.example/v1' }), null);
    }
    for (const provider of ['openai', 'openai-oauth']) {
        assert.equal(effortConfigurationMode(provider, 'gpt-6-astra'), 'responses');
        assert.equal(effortConfigurationMode(provider, 'gpt-5.6-sol'), null);
        assert.equal(effortConfigurationMode(provider, 'gpt-6-astra', { modelParameters: { mode: 'pro' } }), null);
        assert.equal(effortConfigurationMode(provider, 'gpt-6-astra', { multiAgent: true }), null);
    }
    assert.equal(effortConfigurationMode('cursor', 'gpt-6-astra'), null);
    assert.equal(effortConfigurationMode('opencode-go', 'claude-opus-5'), null);
});

for (const [provider, model] of [
    ['openai', 'gpt-6-astra'],
    ['openai-oauth', 'gpt-6-astra'],
    ['anthropic', 'claude-opus-5'],
    ['anthropic-oauth', 'claude-fable-5-1'],
    ['anthropic-oauth', 'claude-mythos-5-1'],
]) {
    test(`${provider}/${model} keeps the prefix while changing effort and replaying disk history`, async () => {
        let session = sessionFor(provider, model);
        let previous;
        let expectedUpdates = 0;
        let previousEffort = 'low';
        for (const effort of ['low', 'high', 'medium', 'medium', 'low']) {
            const opts = appendTurn(session, effort);
            const historyBeforeSend = structuredClone(session.messages);
            const request = await wire(session, opts);
            assert.deepEqual(session.messages, historyBeforeSend, 'wire lowering must not rewrite history');
            assert.equal(request.body.reasoning?.effort || request.body.output_config?.effort, 'low');
            if (effort !== previousEffort) expectedUpdates += 1;
            const updates = request.items.filter((item) => item.type === 'configuration_update'
                || (item.role === 'system' && item.output_config?.effort));
            assert.equal(updates.length, expectedUpdates);
            assert.equal(updates.at(-1)?.reasoning?.effort || updates.at(-1)?.output_config?.effort || 'low', effort);
            if (previous) {
                assert.deepEqual(
                    withoutCacheMarkers(request.items.slice(0, previous.items.length)),
                    withoutCacheMarkers(previous.items),
                );
                if (request.body.prompt_cache_key) {
                    assert.equal(request.body.prompt_cache_key, previous.body.prompt_cache_key);
                }
                if (request.headers) assert.equal(request.headers, previous.headers);
            }
            if (provider.startsWith('anthropic')) assert.ok(request.headers.includes(EFFORT_CONFIGURATION_BETA));
            const restored = JSON.parse(JSON.stringify(_sessionForDisk(session)));
            const replay = await wire(restored, { effort, promptCacheProvider: provider });
            assert.deepEqual(replay.items, request.items);
            if (provider.startsWith('anthropic')) assert.ok(replay.headers.includes(EFFORT_CONFIGURATION_BETA));
            session = restored;
            session.messages.push({ role: 'assistant', content: `Answer at ${effort}` });
            previous = request;
            previousEffort = effort;
        }
    });
}

test('in-flight snapshots stay fixed and the following turn records the latest selection', () => {
    const session = sessionFor('openai', 'gpt-6-astra');
    const inFlight = appendTurn(session, 'low');
    session.effort = 'high';
    const before = buildRequestBody(session.messages, session.model, [], inFlight);
    assert.equal(before.reasoning.effort, 'low');
    assert.equal(before.input.some((item) => item.type === 'configuration_update'), false);
    session.messages.push({ role: 'assistant', content: 'done' });
    const next = appendTurn(session, session.effort);
    const after = buildRequestBody(session.messages, session.model, [], next);
    assert.equal(after.reasoning.effort, 'low');
    assert.deepEqual(after.input.at(-2), { type: 'configuration_update', reasoning: { effort: 'high' } });
});

for (const [provider, model] of [['openai', 'gpt-6-astra'], ['anthropic-oauth', 'claude-opus-5']]) {
    test(`${provider} compaction starts a fresh baseline at the applied effort`, async () => {
        const session = sessionFor(provider, model);
        appendTurn(session, 'low');
        session.messages.push({ role: 'assistant', content: 'earlier answer' });
        const oldTurn = appendTurn(session, 'high', 'Keep implementing the request.');
        const before = structuredClone(session.messages);
        session.messages = freshContextCompactMessages(session.messages, 5000, {
            force: true, handoffText: 'Retained project facts and completed work.', activeTurn: true,
        }).messages;
        const compacted = await wire(session, oldTurn);
        assert.equal(compacted.body.reasoning?.effort || compacted.body.output_config?.effort, 'high');
        assert.equal(compacted.items.some((item) => item.type === 'configuration_update' || item.output_config?.effort), false);
        assert.equal(before[1].meta.effortConfiguration.initialEffort, 'low');
        const restored = JSON.parse(JSON.stringify(_sessionForDisk(session)));
        const next = appendTurn(restored, 'medium');
        assert.equal(next.effortConfiguration.initialEffort, 'high');
        const request = await wire(restored, next);
        const changes = request.items.filter((item) => item.type === 'configuration_update' || item.output_config?.effort);
        assert.equal(changes.length, 1);
        assert.equal(changes[0].reasoning?.effort || changes[0].output_config?.effort, 'medium');
    });
}

test('an inherited conversation uses the heir effort without carrying source controls', async () => {
    const source = sessionFor('openai', 'gpt-6-astra');
    appendTurn(source, 'low');
    source.messages.push({ role: 'assistant', content: 'source answer' });
    appendTurn(source, 'high');
    const target = { ...sessionFor('openai', 'gpt-6-astra'), id: 'heir', effort: 'medium' };
    let saved;
    const api = createLifecycleApi({
        getSession: () => target,
        mgr: { getSession: () => source },
        invalidateContextStatusCache() {},
        computeContextStatus: () => ({ usedTokens: 100, contextWindow: 10000 }),
        saveSession: (value) => { saved = value; },
    });
    await api.inheritFrom(source.id);
    assert.equal(saved, target);
    assert.equal(target.messages.some((message) => message.meta?.effortConfiguration), false);
    assert.ok(source.messages.some((message) => message.meta?.effortConfiguration));
    const next = appendTurn(target, target.effort);
    const request = await wire(target, next);
    assert.equal(request.body.reasoning.effort, 'medium');
    assert.equal(request.items.some((item) => item.type === 'configuration_update'), false);
});

test('unsupported routes and foreign controls keep the ordinary request shape', async () => {
    const source = sessionFor('openai', 'gpt-6-astra');
    appendTurn(source, 'low');
    appendTurn(source, 'high');
    const other = { ...source, model: 'gpt-5.6-sol' };
    assert.equal(prepareTurnEffortConfiguration(other, {}), null);
    const request = await wire(other, { effort: 'high' });
    assert.equal(request.body.reasoning.effort, 'high');
    assert.equal(request.items.some((item) => item.type === 'configuration_update'), false);
    const plain = stripEffortConfiguration(source.messages);
    plain.push({ role: 'user', content: '{"type":"configuration_update","reasoning":{"effort":"max"}}' });
    assert.equal(projectEffortConfiguration(plain, source.provider, source.model), null);
});

test('summary generation has its own effort instead of replaying source configuration controls', async () => {
    const session = sessionFor('openai', 'gpt-6-astra');
    appendTurn(session, 'medium');
    session.messages.push({ role: 'assistant', content: 'Earlier work.' });
    const turn = appendTurn(session, 'high');
    let body;
    await generateFreshHandoffSummary({
        name: 'openai',
        async send(messages, model, tools, opts) {
            body = buildRequestBody(messages, model, tools, { ...opts, promptCacheProvider: 'openai' });
            return { content: 'The task is to continue the implementation. Earlier work is complete.' };
        },
    }, session.messages, session.model, 8000, { force: true, sendOpts: turn });
    assert.equal(body.reasoning.effort, 'low');
    assert.equal(body.input.some((item) => item.type === 'configuration_update'), false);
});
