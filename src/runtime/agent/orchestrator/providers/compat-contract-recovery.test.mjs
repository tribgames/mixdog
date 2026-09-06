import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { sendCompatResponses } from './openai-compat-responses.mjs';
import { toXaiResponsesInput } from './openai-compat-wire.mjs';
import { buildRequestBody } from './openai-responses-payload.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';
import { createLifecycleApi } from '../../../../session-runtime/lifecycle-api.mjs';

const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }];
const prompt = [{ role: 'user', content: 'Read the file' }];
const call = { type: 'function_call', call_id: 'call_read', name: 'read', arguments: '{}' };
const reasoning = { type: 'reasoning', id: 'reasoning_gateway', encrypted_content: 'gateway-ciphertext', summary: [] };
const answer = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };

function providerFixture(name, output = [answer]) {
    const requests = [];
    const provider = Object.assign(Object.create(OpenAICompatProvider.prototype), {
        name, config: { preconnect: false }, getCachedModelInfo: () => null,
        client: {
            chat: { completions: { create: async (params) => {
                requests.push(params);
                return (async function* () {
                    yield { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] };
                })();
            } } },
            responses: { create: async (params) => {
                requests.push(params);
                return (async function* () {
                    yield { type: 'response.completed', response: {
                        id: 'response_fixture', model: params.model, status: 'completed', output,
                    } };
                })();
            } },
        },
    });
    return { provider, requests };
}

function history(replayProvider, items = [call]) {
    return [
        ...prompt,
        {
            role: 'assistant', content: '', toolCalls: [{ id: call.call_id, name: call.name, arguments: {} }],
            providerReplay: createProviderReplay(replayProvider, items),
        },
        { role: 'tool', toolCallId: call.call_id, content: 'ACTUAL_RESULT_42' },
    ];
}

async function inherit(messages, sourceProvider, targetProvider) {
    const source = { id: 'source', provider: sourceProvider, messages };
    const target = { id: 'target', provider: targetProvider, messages: [] };
    await createLifecycleApi({
        getSession: () => target, mgr: { getSession: () => source },
        invalidateContextStatusCache() {}, saveSession() {},
    }).inheritFrom(source.id);
    return target.messages;
}

for (const name of ['deepseek', 'openrouter', 'opencode-go', 'mixdog-local']) {
    test(`${name} Chat sends tool-use prohibition without removing tool definitions`, async () => {
        const { provider, requests } = providerFixture(name);
        await provider._doSend(prompt, 'fixture-model', tools, { toolChoice: 'none' });
        await provider._doSend(prompt, 'fixture-model', tools, {});
        await provider._doSend(prompt, 'fixture-model', [], { toolChoice: 'none' });
        assert.equal(requests[0].tool_choice, 'none');
        assert.deepEqual(requests[0].tools, requests[1].tools);
        assert.equal(requests[1].tool_choice, undefined);
        assert.equal(requests[2].tool_choice, undefined);
    });
}

for (const name of ['xai', 'opencode-go']) {
    test(`${name} Responses sends tool-use prohibition without changing the tool prefix`, async () => {
        const { provider, requests } = providerFixture(name);
        const send = (availableTools, opts) => name === 'xai'
            ? provider._doSendXaiResponses(prompt, 'grok-4.5', availableTools, opts)
            : sendCompatResponses(provider, prompt, 'muse-spark', availableTools, opts);
        await send(tools, { toolChoice: 'none' });
        await send(tools, {});
        await send([], { toolChoice: 'none' });
        assert.equal(requests[0].tool_choice, 'none');
        assert.deepEqual(requests[0].tools, requests[1].tools);
        assert.equal(requests[1].tool_choice, undefined);
        assert.equal(requests[2].tool_choice, undefined);
    });
}

for (const [provider, replay] of [['xai', 'xai-responses'], ['opencode-go', 'compat-responses:opencode-go']]) {
    test(`${provider} inheritance retains completed results with no connection state`, async () => {
        const source = history(replay);
        const original = structuredClone(source);
        const messages = await inherit(source, provider, provider);
        const { input } = toXaiResponsesInput(messages, undefined, { replayProvider: replay });
        assert.equal(input.find((item) => item.type === 'function_call_output')?.output, 'ACTUAL_RESULT_42');
        assert.deepEqual(source, original);
    });
}

test('gateway output replays only on the same provider, including after disk-style restoration and inheritance', async () => {
    const { provider, requests } = providerFixture('opencode-go', [reasoning, call]);
    const first = await sendCompatResponses(provider, prompt, 'muse-spark', tools);
    const messages = JSON.parse(JSON.stringify([
        ...prompt, { role: 'assistant', content: first.content, toolCalls: first.toolCalls, providerReplay: first.providerReplay },
        { role: 'tool', toolCallId: call.call_id, content: 'ACTUAL_RESULT_42' },
    ]));
    await sendCompatResponses(provider, messages, 'muse-spark', tools);
    assert.deepEqual(requests[1].input.find((item) => item.type === 'reasoning'), reasoning);
    assert.equal(requests[1].input.find((item) => item.type === 'function_call_output')?.output, 'ACTUAL_RESULT_42');
    const inherited = await inherit(messages, 'opencode-go', 'openai');
    const direct = buildRequestBody(inherited, 'gpt-6-astra', tools, { promptCacheProvider: 'openai' });
    assert.equal(direct.input.some((item) => item.type === 'reasoning'), false);
    assert.equal(direct.input.find((item) => item.type === 'function_call_output')?.output, 'ACTUAL_RESULT_42');
    const foreign = providerFixture('other-gateway');
    await sendCompatResponses(foreign.provider, messages, 'fixture-model', tools);
    assert.equal(foreign.requests[0].input.some((item) => item.type === 'reasoning'), false);
});

test('legacy gateway replay cannot carry unscoped encrypted items into either gateway or inherited OpenAI requests', async () => {
    const legacy = history('openai-responses', [reasoning, call]);
    const { provider, requests } = providerFixture('opencode-go');
    await sendCompatResponses(provider, legacy, 'muse-spark', tools);
    assert.equal(requests[0].input.some((item) => item.type === 'reasoning'), false);
    assert.equal(requests[0].input.find((item) => item.type === 'function_call_output')?.output, 'ACTUAL_RESULT_42');
    const inherited = await inherit(legacy, 'opencode-go', 'openai');
    const direct = buildRequestBody(inherited, 'gpt-6-astra', tools, { promptCacheProvider: 'openai' });
    assert.equal(direct.input.some((item) => item.type === 'reasoning'), false);
    assert.equal(direct.input.find((item) => item.type === 'function_call_output')?.output, 'ACTUAL_RESULT_42');
    assert.deepEqual(legacy[1].providerReplay.items, [reasoning, call], 'the stored source is unchanged');
    const sameOwner = await inherit(legacy, 'openai', 'openai');
    const retained = buildRequestBody(sameOwner, 'gpt-6-astra', tools, { promptCacheProvider: 'openai' });
    assert.deepEqual(retained.input.find((item) => item.type === 'reasoning'), reasoning);
});
