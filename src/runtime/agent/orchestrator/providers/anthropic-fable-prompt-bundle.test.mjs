import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MID_CONVERSATION_SYSTEM_BETA_HEADER,
    buildAnthropicBetaHeaders,
} from './anthropic-betas.mjs';
import {
    _buildRequestBodyForCacheSmoke,
    _test as oauthTest,
} from './anthropic-oauth.mjs';

function toolContinuation() {
    return [
        {
            role: 'assistant',
            content: '',
            toolCalls: [{
                id: 'toolu_read',
                name: 'read',
                arguments: { file_path: 'C:\\Project\\fixture.txt' },
            }],
        },
        {
            role: 'tool',
            toolCallId: 'toolu_read',
            content: 'fixture output',
        },
    ];
}

test('Fable 5.1 projects a transient system turn after a tool result', () => {
    const source = toolContinuation();
    const sourceSnapshot = structuredClone(source);
    const body = _buildRequestBodyForCacheSmoke(source, 'claude-fable-5-1');

    assert.deepEqual(source, sourceSnapshot);
    assert.equal(body.messages.at(-2).role, 'user');
    assert.equal(body.messages.at(-2).content[0].type, 'tool_result');
    assert.equal(body.messages.at(-1).role, 'system');
    assert.equal(typeof body.messages.at(-1).content, 'string');
    assert.ok(body.messages.at(-1).content.length > 0);
});

test('the prompt bundle follows Fable 5.1 aliases but leaves other models unchanged', () => {
    assert.equal(oauthTest.usesFable51PromptBundle('claude-fable-5.1'), true);
    assert.equal(oauthTest.usesFable51PromptBundle('claude-fable-5-1-20260901'), true);
    assert.equal(oauthTest.usesFable51PromptBundle('claude-fable-5-0'), false);
    assert.equal(oauthTest.usesFable51PromptBundle('claude-opus-5-1'), false);

    const firstTurn = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: '첫 요청입니다.' }],
        'claude-fable-5-1',
    );
    assert.equal(firstTurn.messages.some((message) => message.role === 'system'), false);

    const body = _buildRequestBodyForCacheSmoke(toolContinuation(), 'claude-opus-5-1');
    assert.equal(body.messages.some((message) => message.role === 'system'), false);
});

test('a steering user turn remains the final instruction and suppresses batching guidance', () => {
    const messages = [
        ...toolContinuation(),
        {
            role: 'user',
            content: '이 요청을 먼저 처리해 주세요.',
            meta: { source: 'steering' },
        },
    ];
    const body = _buildRequestBodyForCacheSmoke(messages, 'claude-fable-5-1');

    assert.equal(body.messages.at(-1).role, 'user');
    assert.equal(body.messages.some((message) => message.role === 'system'), false);
});

test('the mid-conversation system beta is request-gated and deduplicated', () => {
    assert.equal(
        buildAnthropicBetaHeaders({ base: '', midConversationSystem: false })
            .includes(MID_CONVERSATION_SYSTEM_BETA_HEADER),
        false,
    );
    const headers = buildAnthropicBetaHeaders({
        base: MID_CONVERSATION_SYSTEM_BETA_HEADER,
        midConversationSystem: true,
    }).split(',');
    assert.equal(
        headers.filter((item) => item === MID_CONVERSATION_SYSTEM_BETA_HEADER).length,
        1,
    );

    const continuationBody = _buildRequestBodyForCacheSmoke(
        toolContinuation(),
        'claude-fable-5-1',
    );
    assert.equal(
        oauthTest.buildOAuthBetaHeaders(continuationBody, {
            model: 'claude-fable-5-1',
            opts: { effort: 'medium' },
        }).split(',').includes(MID_CONVERSATION_SYSTEM_BETA_HEADER),
        true,
    );
    const firstTurnBody = _buildRequestBodyForCacheSmoke(
        [{ role: 'user', content: '첫 요청입니다.' }],
        'claude-fable-5-1',
    );
    assert.equal(
        oauthTest.buildOAuthBetaHeaders(firstTurnBody, {
            model: 'claude-fable-5-1',
            opts: { effort: 'medium' },
        }).split(',').includes(MID_CONVERSATION_SYSTEM_BETA_HEADER),
        false,
    );
});
