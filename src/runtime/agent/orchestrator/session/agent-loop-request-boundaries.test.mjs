import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoop } from './agent-loop.mjs';
import { setInternalToolsProvider } from '../internal-tools.mjs';

function registerLookup(t, completed) {
    const tools = [{ name: 'lookup', inputSchema: { type: 'object', properties: { item: { type: 'integer' } } } }];
    setInternalToolsProvider({
        tools,
        executor: async (_name, args) => {
            completed.push(args.item);
            return `Found item ${args.item}.`;
        },
    });
    t.after(() => setInternalToolsProvider({ tools: [], executor: async () => null }));
    return tools;
}

test('ordinary requests preserve the opening user message across tool continuation', async () => {
    const opening = { role: 'user', content: 'Inspect the requested item.' };
    const history = [opening];
    const requests = [];
    const provider = {
        async send(messages) {
            requests.push(structuredClone(messages));
            return requests.length === 1
                ? { content: '', toolCalls: [{ id: 'lookup-1', name: 'lookup', arguments: {} }], stopReason: 'tool_calls' }
                : { content: 'done', toolCalls: [], stopReason: 'end_turn' };
        },
    };
    await agentLoop(provider, history, 'fake-model',
        [{ name: 'lookup', inputSchema: { type: 'object', properties: {} } }],
        async () => 'Found.', process.cwd(), { session: { owner: 'cli', compaction: { auto: false } } });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], [opening]);
    assert.deepEqual(requests[1][0], opening);
    assert.ok(requests[1].some(message => message.role === 'tool'));
});

test('productive work continues beyond 200 iterations even with a legacy session ceiling', async (t) => {
    const completed = [];
    const tools = registerLookup(t, completed);
    let requests = 0;
    const provider = {
        async send(_messages, _model, _tools, options) {
            requests += 1;
            assert.notEqual(options.toolChoice, 'none');
            return requests <= 205
                ? {
                    content: '',
                    toolCalls: [{ id: `lookup-${requests}`, name: 'lookup', arguments: { item: requests } }],
                    stopReason: 'tool_calls',
                }
                : { content: 'All 205 items inspected.', toolCalls: [], stopReason: 'end_turn' };
        },
    };
    const result = await agentLoop(provider, [{ role: 'user', content: 'Inspect.' }], 'fake-model',
        tools, null, process.cwd(),
        { session: { owner: 'cli', maxLoopIterations: 1, compaction: { auto: false } } });
    assert.equal(result.content, 'All 205 items inspected.');
    assert.deepEqual(completed, Array.from({ length: 205 }, (_, index) => index + 1));
    assert.equal(requests, 206);
    assert.equal(result.terminationReason, undefined);
});

test('cancellation still stops a productive loop before dispatching further tools', async (t) => {
    const controller = new AbortController();
    const cancellation = new Error('requested stop');
    let requests = 0;
    const completed = [];
    const tools = registerLookup(t, completed);
    const provider = {
        async send() {
            requests += 1;
            if (requests === 2) controller.abort(cancellation);
            return {
                content: '',
                toolCalls: [{ id: `lookup-${requests}`, name: 'lookup', arguments: { item: requests } }],
                stopReason: 'tool_calls',
            };
        },
    };
    await assert.rejects(agentLoop(provider, [{ role: 'user', content: 'Inspect.' }], 'fake-model',
        tools, null, process.cwd(), {
            signal: controller.signal,
            session: { owner: 'cli', compaction: { auto: false } },
        }), error => error === cancellation);
    assert.equal(requests, 2);
    assert.deepEqual(completed, [1]);
});
