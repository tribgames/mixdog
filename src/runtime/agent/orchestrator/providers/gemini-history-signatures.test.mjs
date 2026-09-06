import test from 'node:test';
import assert from 'node:assert/strict';
import { toGeminiContents } from './gemini-schema.mjs';
import { buildAntigravityRequest } from './antigravity-request.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';

function foreignHistory() {
    return [
        { role: 'user', content: 'Read both files.' },
        {
            role: 'assistant', content: '',
            toolCalls: [
                { id: 'call_a', name: 'read', arguments: { path: 'a' } },
                { id: 'call_b', name: 'read', arguments: { path: 'b' } },
            ],
        },
        { role: 'tool', toolCallId: 'call_a', content: 'a' },
        { role: 'tool', toolCallId: 'call_b', content: 'b' },
    ];
}

test('Gemini and Antigravity repair the first foreign tool call without signing every parallel sibling', () => {
    const history = foreignHistory();
    const original = structuredClone(history);
    const requests = [
        toGeminiContents(history, 'gemini-3.1-pro'),
        buildAntigravityRequest(history, 'gemini-3.1-pro-high', [], {}, 'fixture').request.contents,
    ];
    for (const contents of requests) {
        const parts = contents.find(content => content.role === 'model').parts.filter(part => part.functionCall);
        assert.equal(parts[0].thoughtSignature, 'skip_thought_signature_validator');
        assert.equal(parts[1].thoughtSignature, undefined);
        assert.deepEqual(parts.map(part => part.functionCall.args), [{ path: 'a' }, { path: 'b' }]);
        assert.equal(contents.at(-1).parts.filter(part => part.functionResponse).length, 2);
    }
    assert.deepEqual(history, original);
});

test('native Gemini signatures and unsigned parallel siblings replay unchanged', () => {
    const history = foreignHistory();
    const parts = [
        { functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'native-signature' },
        { functionCall: { name: 'read', args: { path: 'b' } } },
    ];
    history[1].providerReplay = createProviderReplay('gemini', parts);
    const contents = toGeminiContents(history, 'gemini-3.1-pro');
    assert.deepEqual(contents.find(content => content.role === 'model').parts, parts);
    const snakeCaseParts = structuredClone(parts);
    snakeCaseParts[0].thought_signature = snakeCaseParts[0].thoughtSignature;
    delete snakeCaseParts[0].thoughtSignature;
    history[1].providerReplay = createProviderReplay('gemini', snakeCaseParts);
    assert.deepEqual(
        toGeminiContents(history, 'gemini-3.1-pro').find(content => content.role === 'model').parts,
        snakeCaseParts,
    );
});

test('signature repair does not change earlier turns or Gemini 2.5 history', () => {
    const history = foreignHistory();
    for (const contents of [
        toGeminiContents(history, 'gemini-2.5-pro'),
        toGeminiContents([...history, { role: 'user', content: 'New turn.' }], 'gemini-3.1-pro'),
        buildAntigravityRequest([...history, { role: 'user', content: 'New turn.' }], 'gemini-3.1-pro-high', [], {}, 'fixture').request.contents,
    ]) {
        assert.equal(contents.find(content => content.role === 'model').parts[0].thoughtSignature, undefined);
    }
});

test('every sequential function-call step in the active turn receives its missing signature', () => {
    const history = foreignHistory();
    history.push(
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_c', name: 'read', arguments: { path: 'c' } }] },
        { role: 'tool', toolCallId: 'call_c', content: 'c' },
    );
    const steps = toGeminiContents(history, 'gemini-3.1-pro').filter(content => content.role === 'model');
    assert.deepEqual(steps.map(step => step.parts[0].thoughtSignature), [
        'skip_thought_signature_validator', 'skip_thought_signature_validator',
    ]);
});
