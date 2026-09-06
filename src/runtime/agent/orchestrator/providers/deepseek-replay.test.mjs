import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatProvider, parseToolCalls } from './openai-compat.mjs';
import { consumeCompatChatCompletionStream } from './openai-compat-stream.mjs';
import { toOpenAIMessages } from './openai-compat-wire.mjs';
import { agentLoop } from '../session/agent-loop.mjs';

async function* chunks(values) { yield* values; }

test('the chat stream collector distinguishes empty reasoning from an absent field', async () => {
    for (const reasoning of ['', undefined]) {
        const result = await consumeCompatChatCompletionStream(chunks([
            { choices: [{ delta: { content: 'answer', ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}) }, finish_reason: 'stop' }] },
        ]), { label: 'fixture', parseToolCalls, knownToolNames: new Set() });
        assert.equal(result.reasoningContent, reasoning === undefined ? null : '');
        assert.equal(Object.hasOwn(result.response.choices[0].message, 'reasoning_content'), reasoning !== undefined);
    }
});

test('DeepSeek retains empty reasoning through stream, provider, tool history, and next request', async () => {
    const provider = new OpenAICompatProvider('deepseek', { apiKey: 'fixture', preconnect: false });
    const requests = [];
    provider.client = { chat: { completions: { async create(params) {
        requests.push(structuredClone(params));
        if (requests.length === 1) {
            return chunks([{
                model: 'deepseek-v4-pro',
                choices: [{
                    delta: {
                        role: 'assistant', reasoning_content: '',
                        tool_calls: [{ index: 0, id: 'call_empty', type: 'function', function: { name: 'missing_fixture_tool', arguments: '{}' } }],
                    },
                    finish_reason: 'tool_calls',
                }],
            }]);
        }
        return chunks([{
            model: 'deepseek-v4-pro',
            choices: [{ delta: { content: 'done', reasoning_content: '' }, finish_reason: 'stop' }],
        }]);
    } } } };
    const history = [{ role: 'user', content: 'Check.' }];
    const committed = [];
    const result = await agentLoop(provider, history, 'deepseek-v4-pro', [], null, process.cwd(), {
        session: { id: 'empty-reasoning-fixture', owner: 'agent', agent: 'worker', contextWindow: 200000, rawContextWindow: 200000, compaction: { auto: false } },
        onAssistantMessageCommitted: message => committed.push(message),
    });
    assert.equal(requests.length, 2);
    assert.equal(committed[0].reasoningContent, '');
    assert.equal(Object.hasOwn(committed[0], 'reasoningContent'), true);
    assert.equal(requests[1].messages.find(message => message.role === 'assistant').reasoning_content, '');
    assert.equal(result.reasoningContent, '');
    const persisted = JSON.parse(JSON.stringify([
        ...history, { role: 'assistant', content: result.content, reasoningContent: result.reasoningContent },
    ]));
    const replay = toOpenAIMessages(persisted, 'deepseek', { replaysReasoningContent: true });
    assert.ok(replay.filter(message => message.role === 'assistant').every(message => message.reasoning_content === ''));
    const otherProvider = toOpenAIMessages(persisted, 'openrouter');
    assert.ok(otherProvider.every(message => !Object.hasOwn(message, 'reasoning_content')));
});
