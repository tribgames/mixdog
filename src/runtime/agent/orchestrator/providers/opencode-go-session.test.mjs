import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { OpenCodeGoProvider } from './opencode-go.mjs';
import { AnthropicProvider } from './anthropic.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';

const prompt = [{ role: 'user', content: 'hello' }];
const routes = [
    { model: 'minimax-header-fixture', path: '/v1/messages' },
    { model: 'glm-header-fixture', path: '/v1/chat/completions' },
    { model: 'gpt-header-fixture', path: '/v1/responses' },
];
const config = {
    apiKey: 'fixture-key',
    baseURL: 'https://opencode.ai/zen/go/v1',
    preconnect: false,
    extraHeaders: { 'x-fixture-default': 'kept' },
};

function frame(event) {
    return `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
}

function responseFor({ path, body }) {
    const anthropic = path.endsWith('/messages');
    const responses = path.endsWith('/responses');
    const message = {
        id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
    };
    const chat = {
        id: 'chat_fixture', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    };
    if (!body.stream) return Response.json(anthropic ? message : chat);
    const events = anthropic ? [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
        { type: 'message_stop' },
    ] : responses ? [
        { type: 'response.completed', response: {
            id: 'resp_fixture', model: body.model, status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        } },
    ] : [
        { id: chat.id, model: body.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ];
    return new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

function harness(provider = new OpenCodeGoProvider(config), respond = responseFor) {
    const requests = [];
    const fetch = async (url, init) => {
        const request = {
            path: new URL(url).pathname,
            headers: new Headers(init.headers),
            body: JSON.parse(init.body),
        };
        requests.push(request);
        // Keep requests overlapping on the shared SDK clients.
        await setImmediate();
        return respond(request, requests);
    };
    for (const inner of provider instanceof OpenCodeGoProvider
        ? [provider.anthropic, provider.openai] : [provider]) {
        inner.client.fetch = fetch;
    }
    return { provider, requests };
}

for (const { model, path } of routes) {
    test(`Go ${path} keeps concurrent and continued conversations isolated on the wire`, async () => {
        const defaults = { ...config.extraHeaders, 'x-opencode-session': 'stale-default' };
        const { provider, requests } = harness(new OpenCodeGoProvider({ ...config, extraHeaders: defaults }));
        const requestHeaders = Object.freeze({ 'x-fixture-request': 'kept', 'x-opencode-session': 'stale-request' });
        const first = Object.freeze({ sessionId: 'conversation-a', session: { id: 'not-the-owner' }, requestHeaders });
        const second = Object.freeze({ session: Object.freeze({ id: 'conversation-b' }) });
        await Promise.all([
            provider.send(prompt, model, [], first),
            provider.send(prompt, model, [], second),
        ]);
        await provider.send(prompt, model, [], { sessionId: 'conversation-a' });
        assert.deepEqual(requests.map(r => r.headers.get('x-opencode-session')), [
            'conversation-a', 'conversation-b', 'conversation-a',
        ]);
        assert.ok(requests.every(r => r.path.endsWith(path)));
        assert.ok(requests.every(r => r.headers.get('x-fixture-default') === 'kept'));
        assert.equal(requests[0].headers.get('x-fixture-request'), 'kept');
        assert.equal(requests[1].headers.get('x-fixture-request'), null);
        assert.equal(defaults['x-opencode-session'], 'stale-default');
        if (path.endsWith('/messages')) {
            assert.ok(requests.every(r => !r.headers.has('anthropic-beta')));
        }
    });

    test(`Go ${path} reuses its generated session header on retries without sharing it with another send`, async () => {
        let attempts = 0;
        const { provider, requests } = harness(undefined, request => {
            if (++attempts === 1) {
                return Response.json({ error: { type: 'rate_limit_error', message: 'fixture retry' } }, {
                    status: 429, headers: { 'retry-after': '0' },
                });
            }
            return responseFor(request);
        });
        await provider.send(prompt, model, []);
        await provider.send(prompt, model, [], { sessionId: ' ', session: { id: '' } });
        const ids = requests.map(r => r.headers.get('x-opencode-session'));
        assert.equal(ids.length, 3);
        assert.ok(ids.every(id => typeof id === 'string' && id.trim()));
        assert.equal(ids[0], ids[1]);
        assert.notEqual(ids[1], ids[2]);
    });
}

function stalledResponse(request) {
    let started = false;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
        pull(controller) {
            if (!started) {
                started = true;
                const event = request.path.endsWith('/messages')
                    ? { type: 'message_start', message: { id: 'msg_stall', model: request.body.model, content: [] } }
                    : { choices: [{ index: 0, delta: {}, finish_reason: null }] };
                controller.enqueue(encoder.encode(frame(event)));
                return;
            }
            controller.error(Object.assign(new Error('fixture stream stall'), {
                name: 'StreamStalledError', code: 'ESTREAMSTALL', streamStalled: true,
                headers: { 'x-should-retry': 'false' },
            }));
        },
    }), { headers: { 'content-type': 'text/event-stream' } });
}

for (const { model, path } of routes.filter(route => !route.path.endsWith('/responses'))) {
    test(`Go ${path} retains its session header in non-streaming recovery`, async () => {
        const { provider, requests } = harness(undefined, request =>
            request.body.stream ? stalledResponse(request) : responseFor(request));
        await provider.send(prompt, model, [], { sessionId: 'fallback-conversation' });
        assert.deepEqual(requests.map(r => r.body.stream), [true, false]);
        assert.deepEqual(requests.map(r => r.headers.get('x-opencode-session')), [
            'fallback-conversation', 'fallback-conversation',
        ]);
    });
}

test('switching Go model wire formats keeps the same conversation header', async () => {
    const { provider, requests } = harness();
    for (const { model } of routes) {
        await provider.send(prompt, model, [], { sessionId: 'model-switch-conversation' });
    }
    assert.deepEqual(requests.map(r => r.headers.get('x-opencode-session')),
        routes.map(() => 'model-switch-conversation'));
});

test('ordinary Anthropic and OpenAI-compatible requests do not gain Go headers', async () => {
    for (const provider of [
        new AnthropicProvider({ ...config, name: 'anthropic', baseURL: 'https://api.anthropic.com' }),
        new OpenAICompatProvider('deepseek', { ...config, baseURL: 'https://api.deepseek.com/v1' }),
    ]) {
        const { requests } = harness(provider);
        await provider.send(prompt, 'fixture-model', [], { sessionId: 'ordinary-conversation' });
        assert.equal(requests[0].headers.get('x-opencode-session'), null);
        assert.equal(requests[0].headers.get('x-fixture-default'), 'kept');
        if (provider.name === 'anthropic') assert.ok(requests[0].headers.has('anthropic-beta'));
    }
});
