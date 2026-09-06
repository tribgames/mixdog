import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { classifyError } from './retry-classifier.mjs';
import { EFFORT_CONFIGURATION_BETA, prepareTurnEffortConfiguration } from './effort-configuration.mjs';
import { TURN_SCOPED_SYSTEM_BETA_HEADER } from './anthropic-betas.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';

function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

function undiciTerminated() {
    const err = new TypeError('terminated');
    err.cause = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
    return err;
}

async function withProvider(run) {
    const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-anthropic-exposed-recovery-'));
    const previousDataDir = process.env.MIXDOG_DATA_DIR;
    const previousProxy = process.env.HTTPS_PROXY;
    try {
        process.env.MIXDOG_DATA_DIR = dataDir;
        process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
        const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const { AnthropicOAuthProvider } = await import(`./anthropic-oauth.mjs?exposed=${nonce}`);
        const provider = Object.create(AnthropicOAuthProvider.prototype);
        provider.config = {};
        provider.fastModeBetaHeaderLatched = false;
        provider.ensureAuth = async () => ({ accessToken: 'test-access-token' });
        provider.scrubTokens = (text) => String(text || '');
        provider._refreshModelCache = async () => [];
        await run(provider);
    } finally {
        restoreEnv('MIXDOG_DATA_DIR', previousDataDir);
        restoreEnv('HTTPS_PROXY', previousProxy);
        await rm(dataDir, { recursive: true, force: true });
    }
}

// Streaming attempt: message_start seen, thinking AND text already relayed,
// then the peer closes the socket mid-body (undici `terminated`).
function exposedThenTerminated(args) {
    const midState = args[5];
    midState.sawMessageStart = true;
    midState.emittedThinking = true;
    midState.emittedText = true;
    midState.emittedTextChars = 12;
    throw undiciTerminated();
}

function requestFor(bodies) {
    return async (_token, _signal, body) => {
        bodies.push(body);
        const controller = new AbortController();
        if (body.stream === false) {
            return {
                controller,
                cancelHandler: null,
                response: {
                    status: 200,
                    ok: true,
                    headers: new Headers(),
                    text: async () => '',
                    json: async () => ({
                        id: 'msg_fallback',
                        model: 'claude-fable-5-1',
                        stop_reason: 'end_turn',
                        content: [
                            { type: 'thinking', thinking: 'plan', signature: 'sig' },
                            { type: 'text', text: 'recovered answer' },
                        ],
                        usage: { input_tokens: 10, output_tokens: 4 },
                    }),
                },
            };
        }
        return { controller, cancelHandler: null, response: { status: 200, ok: true, headers: new Headers(), text: async () => '' } };
    };
}

test('a bare undici terminated is a transient transport failure', () => {
    assert.equal(classifyError(new TypeError('terminated')), 'transient');
    assert.equal(classifyError(undiciTerminated()), 'transient');
    assert.equal(classifyError(new Error('other side closed')), 'transient');
});

test('exposed thinking + text is retracted through the owner ack and recovered non-streaming', async () => {
    await withProvider(async (provider) => {
        const bodies = [];
        const resets = [];
        const result = await provider.send(
            [{ role: 'user', content: 'hello' }],
            'claude-fable-5-1',
            [],
            {
                _doRequestFn: requestFor(bodies),
                _parseSSEFn: async (...args) => exposedThenTerminated(args),
                onTextReset: async (detail) => { resets.push(detail); return true; },
            },
        );
        assert.equal(result.content, 'recovered answer');
        assert.deepEqual(resets, [{ chars: 12, reasoning: true, reason: 'anthropic-streaming-fallback' }]);
        assert.equal(bodies.length, 2);
        assert.notEqual(bodies[0].stream, false);
        assert.equal(bodies[1].stream, false);
    });
});

test('exposed thinking alone is retractable too', async () => {
    await withProvider(async (provider) => {
        const bodies = [];
        const resets = [];
        const result = await provider.send(
            [{ role: 'user', content: 'hello' }],
            'claude-fable-5-1',
            [],
            {
                _doRequestFn: requestFor(bodies),
                _parseSSEFn: async (...args) => {
                    const midState = args[5];
                    midState.sawMessageStart = true;
                    midState.emittedThinking = true;
                    throw undiciTerminated();
                },
                onTextReset: async (detail) => { resets.push(detail); return true; },
            },
        );
        assert.equal(result.content, 'recovered answer');
        assert.deepEqual(resets, [{ chars: 0, reasoning: true, reason: 'anthropic-streaming-fallback' }]);
        assert.equal(bodies[1].stream, false);
    });
});

test('a rejected retraction keeps the exposed stream terminal and replay-unsafe', async () => {
    await withProvider(async (provider) => {
        const bodies = [];
        await assert.rejects(
            provider.send(
                [{ role: 'user', content: 'hello' }],
                'claude-fable-5-1',
                [],
                {
                    _doRequestFn: requestFor(bodies),
                    _parseSSEFn: async (...args) => exposedThenTerminated(args),
                    onTextReset: async () => false,
                },
            ),
            (err) => err.message === 'terminated' && err.unsafeToRetry === true && err.liveTextEmitted === true,
        );
        assert.equal(bodies.length, 1);
    });
});

test('a dispatched tool call still denies the non-streaming replay', async () => {
    await withProvider(async (provider) => {
        const bodies = [];
        let resets = 0;
        await assert.rejects(
            provider.send(
                [{ role: 'user', content: 'hello' }],
                'claude-fable-5-1',
                [],
                {
                    _doRequestFn: requestFor(bodies),
                    _parseSSEFn: async (...args) => {
                        const midState = args[5];
                        midState.sawMessageStart = true;
                        midState.emittedThinking = true;
                        midState.emittedText = true;
                        midState.emittedTextChars = 3;
                        midState.emittedToolCall = true;
                        throw undiciTerminated();
                    },
                    onTextReset: async () => { resets += 1; return true; },
                },
            ),
            (err) => err.message === 'terminated' && err.unsafeToRetry === true,
        );
        assert.equal(resets, 0);
        assert.equal(bodies.length, 1);
    });
});

test('non-streaming recovery preserves the effort beta on the actual HTTP request', async () => {
    await withProvider(async (provider) => {
        const previousFetch = globalThis.fetch;
        try {
            for (const efforts of [[], ['low'], ['low', 'high']]) {
                const session = { provider: 'anthropic-oauth', model: 'claude-fable-5-1', messages: [] };
                for (const effort of efforts) {
                    session.effort = effort;
                    const snapshot = prepareTurnEffortConfiguration(session, provider);
                    session.messages.push({ role: 'user', content: 'question', meta: { effortConfiguration: snapshot } });
                    session.messages.push({ role: 'assistant', content: 'answer' });
                }
                session.messages.push({ role: 'user', content: 'continue' });
                const requests = [];
                globalThis.fetch = async (_url, init) => {
                    const body = JSON.parse(String(init.body));
                    requests.push({ body, beta: init.headers['anthropic-beta'] });
                    if (body.stream !== false) return new Response('', { status: 200 });
                    return Response.json({
                        id: 'msg_effort_fallback', model: session.model,
                        stop_reason: 'end_turn', content: [{ type: 'text', text: 'recovered' }],
                        usage: { input_tokens: 1, output_tokens: 1 },
                    });
                };
                await provider.send(session.messages, session.model, [], {
                    effort: session.effort,
                    effortConfiguration: session.effortConfiguration,
                    _parseSSEFn: async (...args) => exposedThenTerminated(args),
                    onTextReset: async () => true,
                });
                assert.equal(requests.length, 2);
                assert.equal(requests[1].body.stream, false);
                assert.equal(requests[0].beta, requests[1].beta);
                assert.equal(requests[1].beta.includes(EFFORT_CONFIGURATION_BETA), efforts.length > 0);
                assert.deepEqual(requests[1].body.messages, requests[0].body.messages);
            }
        } finally {
            globalThis.fetch = previousFetch;
        }
    });
});

test('Fable carries scoped-reminder headers and replay context through every response path', async () => {
    await withProvider(async (provider) => {
        const previousFetch = globalThis.fetch;
        const model = 'claude-fable-5-1';
        const history = [
            { role: 'user', content: '한국어로 파일을 확인해 주세요.' },
            {
                role: 'assistant', content: '',
                toolCalls: [{ id: 'toolu_before', name: 'read', arguments: { file_path: 'before.txt' } }],
            },
            { role: 'tool', toolCallId: 'toolu_before', content: 'file contents' },
        ];
        const blocks = [
            { type: 'thinking', thinking: 'Continue.', signature: 'scoped-response-signature' },
            { type: 'tool_use', id: 'toolu_after', name: 'read', input: { file_path: 'after.txt' } },
        ];
        try {
            for (const transport of ['stream', 'non-streaming', 'partial']) {
                const requests = [];
                globalThis.fetch = async (_url, init) => {
                    const body = JSON.parse(String(init.body));
                    requests.push({ body, beta: init.headers['anthropic-beta'] });
                    if (body.stream !== false) return new Response('', { status: 200 });
                    return Response.json({
                        id: 'msg_scoped', model, stop_reason: 'tool_use', content: blocks,
                        usage: { input_tokens: 1, output_tokens: 1 },
                    });
                };
                const send = () => provider.send(history, model, [], {
                    onTextReset: async () => true,
                    _parseSSEFn: async (...args) => {
                        if (transport === 'non-streaming') return exposedThenTerminated(args);
                        const midState = args[5];
                        midState.sawMessageStart = true;
                        const providerReplay = createProviderReplay('anthropic', blocks);
                        if (transport === 'partial') {
                            midState.emittedToolCall = true;
                            const error = undiciTerminated();
                            error.partialProviderReplay = providerReplay;
                            throw error;
                        }
                        return { model, content: '', providerReplay, usage: { inputTokens: 1 } };
                    },
                });
                let replay;
                if (transport === 'partial') {
                    await assert.rejects(send, error => {
                        replay = error.partialProviderReplay;
                        return error.message === 'terminated' && error.unsafeToRetry === true;
                    });
                } else {
                    replay = (await send()).providerReplay;
                }
                assert.deepEqual(replay.requestContext.fable51Batching, {
                    version: 1, toolResultIds: ['toolu_before'],
                }, transport);
                assert.deepEqual(replay.items, blocks, transport);
                assert.equal(requests.length, transport === 'non-streaming' ? 2 : 1);
                for (const request of requests) {
                    assert.equal(request.body.messages.at(-1).clear_at, 'next_user_message');
                    assert.equal(request.beta.split(',').filter(beta => beta === TURN_SCOPED_SYSTEM_BETA_HEADER).length, 1);
                    assert.deepEqual(request.body.messages, requests[0].body.messages);
                    assert.equal(request.beta, requests[0].beta);
                }
            }
        } finally {
            globalThis.fetch = previousFetch;
        }
    });
});
