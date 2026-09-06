import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OpenAIDirectProvider,
    buildOpenAIOAuthRequestBody,
    httpSseResponse,
    sendViaHttpSse,
} from './_shared.mjs';
import { convertMessagesToResponsesInput } from '../../src/runtime/agent/orchestrator/providers/openai-responses-payload.mjs';
import { createProviderReplay } from '../../src/runtime/agent/orchestrator/providers/lib/provider-replay.mjs';

function restoreEnv(t, names) {
    const previous = names.map((name) => [name, process.env[name]]);
    t.after(() => {
        for (const [name, value] of previous) {
            if (value == null) delete process.env[name];
            else process.env[name] = value;
        }
    });
}

const output = [
    { type: 'reasoning', id: 'rs_history', encrypted_content: 'opaque-history', summary: [] },
    {
        type: 'message', id: 'msg_progress', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: 'Checking.', annotations: [] }],
    },
    {
        type: 'message', id: 'msg_final', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
    },
];

test('public Responses parsed output survives full-history requests across transports and storage modes', async (t) => {
    restoreEnv(t, ['MIXDOG_OAI_TRANSPORT', 'MIXDOG_OAI_STORE', 'MIXDOG_OAI_DISABLE_REASONING_REPLAY']);
    delete process.env.MIXDOG_OAI_DISABLE_REASONING_REPLAY;
    const parsed = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'fixture-key' },
        body: { model: 'gpt-6-astra', tools: [] },
        useModel: 'gpt-6-astra',
        fetchFn: async () => httpSseResponse([
            { type: 'response.created', response: { id: 'resp_history', model: 'gpt-6-astra' } },
            ...output.map((item) => ({ type: 'response.output_item.done', item })),
            { type: 'response.completed', response: { id: 'resp_history', output } },
        ]),
    });
    assert.deepEqual(parsed.providerReplay.items, output);
    const messages = [
        { role: 'user', content: 'Check.' },
        { role: 'assistant', content: parsed.content, providerReplay: parsed.providerReplay },
        { role: 'user', content: 'Continue.' },
    ];
    const snapshot = structuredClone(messages);
    const provider = new OpenAIDirectProvider({ apiKey: 'fixture-key' });
    for (const mode of ['ws-full', 'ws-delta', 'http-sse']) {
        process.env.MIXDOG_OAI_TRANSPORT = mode;
        for (const store of ['0', '1']) {
            process.env.MIXDOG_OAI_STORE = store;
            let captured;
            const capture = async ({ body }) => {
                captured = body;
                return { content: 'ok', toolCalls: [] };
            };
            await provider.send(messages, 'gpt-6-astra', [], {
                _sendViaWebSocketFn: capture,
                _sendViaHttpSseFn: capture,
            });
            assert.deepEqual(captured.input.slice(1, -1), output, `${mode}/store=${store}`);
            assert.deepEqual(captured.include, ['reasoning.encrypted_content']);
        }
    }
    assert.deepEqual(messages, snapshot);
});

test('reasoning opt-outs preserve assistant phases without replaying encrypted items', (t) => {
    restoreEnv(t, ['MIXDOG_OAI_DISABLE_REASONING_REPLAY']);
    const messages = [{
        role: 'assistant', content: 'Flattened projection.',
        providerReplay: createProviderReplay('openai-responses', output),
    }];
    for (const provider of ['openai', 'openai-oauth']) {
        for (const killSwitch of [false, true]) {
            if (killSwitch) process.env.MIXDOG_OAI_DISABLE_REASONING_REPLAY = '1';
            else delete process.env.MIXDOG_OAI_DISABLE_REASONING_REPLAY;
            const body = buildOpenAIOAuthRequestBody(messages, 'gpt-6-astra', [], {
                promptCacheProvider: provider,
                replayEncryptedReasoning: killSwitch,
            });
            assert.deepEqual(body.input, output.slice(1));
        }
    }
});

test('public WebSocket continuation sends only the tail, then restores full output history on reconnect', async (t) => {
    restoreEnv(t, ['MIXDOG_OAI_TRANSPORT', 'MIXDOG_OAI_STORE', 'MIXDOG_OAI_DISABLE_REASONING_REPLAY']);
    process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
    process.env.MIXDOG_OAI_STORE = '1';
    delete process.env.MIXDOG_OAI_DISABLE_REASONING_REPLAY;
    let entry = { socket: { close() {} }, ephemeral: true };
    const frames = [];
    const provider = new OpenAIDirectProvider({ apiKey: 'fixture-key' });
    const options = {
        _webSocketTestSeams: {
            _acquireWithRetryFn: async () => ({ entry, reused: !!entry.lastResponseId }),
            _sendFrameFn: async (_entry, frame) => { frames.push(structuredClone(frame)); },
            _streamFn: async () => ({
                content: 'Done.',
                responseId: `resp_${frames.length}`,
                responseItems: frames.length === 1 ? output : [],
                providerReplay: frames.length === 1 ? createProviderReplay('openai-responses', output) : undefined,
                toolCalls: [],
            }),
            _sleepFn: async () => {},
            _sendSpanTraceFn: () => {},
            _agentTraceFn: () => {},
        },
        _sendViaHttpSseFn: async () => { throw new Error('unexpected fallback'); },
    };
    const history = [{ role: 'user', content: 'Check.' }];
    const first = await provider.send(history, 'gpt-6-astra', [], options);
    history.push(
        { role: 'assistant', content: first.content, providerReplay: first.providerReplay },
        { role: 'user', content: 'Continue.' },
    );
    await provider.send(history, 'gpt-6-astra', [], options);
    assert.equal(frames[1].previous_response_id, 'resp_1');
    assert.equal(frames[1].input.length, 1);
    assert.equal(frames[1].input[0].role, 'user');
    entry = { socket: { close() {} }, ephemeral: true };
    await provider.send(history, 'gpt-6-astra', [], options);
    assert.equal(frames[2].previous_response_id, undefined);
    assert.deepEqual(frames[2].input.slice(1, -1), output);
});

test('legacy assistant phases survive conversion and never leak onto user messages', () => {
    const input = convertMessagesToResponsesInput([
        { role: 'user', content: 'Hello.', phase: 'commentary' },
        { role: 'assistant', content: 'Checking.', phase: 'commentary' },
        { role: 'assistant', content: 'Done.', phase: 'final_answer' },
        { role: 'assistant', content: 'Legacy.' },
    ]);
    assert.deepEqual(input.map((item) => item.phase), [undefined, 'commentary', 'final_answer', undefined]);
});
