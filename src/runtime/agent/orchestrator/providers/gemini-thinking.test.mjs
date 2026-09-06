import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiThinkingConfig } from './gemini-thinking.mjs';
import { GeminiProvider } from './gemini.mjs';

test('Gemini thinking controls preserve explicit values and reject unsupported combinations without invented budgets', () => {
    assert.equal(geminiThinkingConfig('gemini-3.1-pro'), undefined);
    assert.deepEqual(geminiThinkingConfig('gemini-3.1-pro', { effort: 'medium' }), { thinkingLevel: 'medium' });
    assert.deepEqual(geminiThinkingConfig('gemini-2.5-flash', { effort: 'high', thinkingBudget: 0 }), { thinkingBudget: 0 });
    assert.deepEqual(geminiThinkingConfig('gemini-2.5-pro', { thinkingBudgetTokens: -1 }), { thinkingBudget: -1 });
    assert.throws(() => geminiThinkingConfig('gemini-3.8-flash', { effort: 'minimal' }), /supports thinking levels/);
    assert.throws(() => geminiThinkingConfig('gemini-3-pro', { effort: 'medium' }), /supports thinking levels/);
    assert.throws(() => geminiThinkingConfig('gemini-3.1-pro', { effort: 'max' }), /supports thinking levels/);
    assert.throws(() => geminiThinkingConfig('gemini-2.5-pro', { thinkingBudget: 0 }), /requires thinkingBudget/);
    assert.throws(() => geminiThinkingConfig('gemini-2.5-flash-lite', { thinkingBudget: 1 }), /requires thinkingBudget/);
    assert.throws(() => geminiThinkingConfig('gemini-2.5-flash', { thinkingBudget: 30000 }), /requires thinkingBudget/);
    assert.throws(() => geminiThinkingConfig('gemini-3.1-pro', { thinkingLevel: 'low', thinkingBudget: 1024 }), /not both/);
});

test('Gemini sends selected thinking configuration with and without cachedContent', async () => {
    const payload = {
        candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
    };
    for (const cached of [false, true]) {
        for (const effort of ['low', 'high']) {
            let captured;
            const provider = new GeminiProvider({
                apiKey: 'fixture-key',
                preconnectFn: () => {},
                genAI: {
                    getGenerativeModel(config) {
                        captured = config;
                        return {
                            async generateContentStream() {
                                return { stream: (async function* () { yield payload; })(), response: Promise.resolve(payload) };
                            },
                        };
                    },
                },
                fetchFn: async (_url, init) => {
                    captured = JSON.parse(init.body);
                    return new Response(`data: ${JSON.stringify(payload)}\n\n`, {
                        headers: { 'content-type': 'text/event-stream' },
                    });
                },
            });
            provider._ensureGeminiCache = async () => cached ? 'cachedContents/fixture' : null;
            const response = await provider.send(
                [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello.' }],
                'gemini-3.1-pro',
                [],
                { effort },
            );
            assert.equal(response.content, 'ok');
            assert.deepEqual(captured.generationConfig, { thinkingConfig: { thinkingLevel: effort } });
            if (cached) {
                assert.equal(captured.cachedContent, 'cachedContents/fixture');
                assert.equal(captured.systemInstruction, undefined);
                assert.equal(captured.tools, undefined);
            }
        }
    }
});
