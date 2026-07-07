import test from 'node:test';
import assert from 'node:assert/strict';
import { foldUserTextIntoToolResultTail } from '../src/runtime/agent/orchestrator/session/context-utils.mjs';
import { _buildRequestBodyForCacheSmoke } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';

// A tool_result turn followed by a plain user text turn.
function baseTranscript(userMeta) {
    return [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read', arguments: {} }] },
        { role: 'tool', toolCallId: 't1', content: 'file contents here' },
        { role: 'user', content: 'actually stop and do X instead', ...(userMeta ? { meta: userMeta } : {}) },
    ];
}

test('plain user text after tool_result is folded into the tool_result turn', () => {
    const body = _buildRequestBodyForCacheSmoke(baseTranscript(null), 'claude-sonnet-4');
    const msgs = body.messages;
    const lastUser = msgs[msgs.length - 1];
    assert.equal(lastUser.role, 'user');
    const hasToolResult = lastUser.content.some((b) => b.type === 'tool_result');
    assert.ok(hasToolResult, 'trailing user turn carries the tool_result');
    assert.ok(JSON.stringify(lastUser.content).includes('do X instead'), 'plain text folded into tool_result');
});

test('steering-tagged user text after tool_result stays a separate user turn', () => {
    const body = _buildRequestBodyForCacheSmoke(baseTranscript({ source: 'steering' }), 'claude-sonnet-4');
    const msgs = body.messages;
    const lastUser = msgs[msgs.length - 1];
    assert.equal(lastUser.role, 'user', 'steering message is its own user turn');
    const isToolResultTurn = Array.isArray(lastUser.content)
        && lastUser.content.some((b) => b.type === 'tool_result');
    assert.equal(isToolResultTurn, false, 'steering turn is not a tool_result turn');
    assert.ok(JSON.stringify(lastUser.content).includes('do X instead'), 'steering text preserved as user input');
    const prev = msgs[msgs.length - 2];
    assert.ok(
        Array.isArray(prev.content) && prev.content.some((b) => b.type === 'tool_result'),
        'tool_result stays on its own preceding turn',
    );
});

test('foldUserTextIntoToolResultTail unit: folds plain text tail', () => {
    const result = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] }];
    assert.equal(foldUserTextIntoToolResultTail(result, 'hi'), true);
});

// --- API-key Anthropic provider (anthropic.mjs) path ---
import { _toAnthropicMessagesForTest } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';

test('anthropic.mjs: plain user text after tool_result is folded', () => {
    const msgs = _toAnthropicMessagesForTest(baseTranscript(null));
    const lastUser = msgs[msgs.length - 1];
    assert.equal(lastUser.role, 'user');
    assert.ok(lastUser.content.some((b) => b.type === 'tool_result'), 'trailing turn carries tool_result');
    assert.ok(JSON.stringify(lastUser.content).includes('do X instead'), 'plain text folded into tool_result');
});

test('anthropic.mjs: steering-tagged user text stays a separate user turn', () => {
    const msgs = _toAnthropicMessagesForTest(baseTranscript({ source: 'steering' }));
    const lastUser = msgs[msgs.length - 1];
    assert.equal(lastUser.role, 'user', 'steering message is its own user turn');
    const isToolResultTurn = Array.isArray(lastUser.content)
        && lastUser.content.some((b) => b.type === 'tool_result');
    assert.equal(isToolResultTurn, false, 'steering turn is not a tool_result turn');
    assert.ok(JSON.stringify(lastUser.content).includes('do X instead'), 'steering text preserved as user input');
    const prev = msgs[msgs.length - 2];
    assert.ok(
        Array.isArray(prev.content) && prev.content.some((b) => b.type === 'tool_result'),
        'tool_result stays on its own preceding turn',
    );
});
