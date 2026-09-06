import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MID_CONVERSATION_SYSTEM_BETA_HEADER,
    TURN_SCOPED_SYSTEM_BETA_HEADER,
    buildAnthropicBetaHeaders,
} from './anthropic-betas.mjs';
import {
    _buildRequestBodyForCacheSmoke,
    _test as oauthTest,
} from './anthropic-oauth.mjs';
import { cloneProviderReplay, createProviderReplay } from './lib/provider-replay.mjs';
import { withFable51BatchingContext } from './anthropic-fable-history.mjs';
import { _sessionForDisk } from '../session/store/serialize.mjs';

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

test('Fable 5.1 projects a system boundary after a tool result without mutating history', () => {
    const source = toolContinuation();
    const sourceSnapshot = structuredClone(source);
    const body = _buildRequestBodyForCacheSmoke(source, 'claude-fable-5-1');

    assert.deepEqual(source, sourceSnapshot);
    assert.equal(body.messages.at(-2).role, 'user');
    assert.equal(body.messages.at(-2).content[0].type, 'tool_result');
    assert.equal(body.messages.at(-1).role, 'system');
    assert.equal(body.messages.at(-1).clear_at, 'next_user_message');
    assert.equal(typeof body.messages.at(-1).content, 'string');
    assert.ok(body.messages.at(-1).content.length > 0);
});

test('Fable 5.1 keeps the prefix before signed thinking unchanged across tool continuations and resume', () => {
    const history = [{ role: 'user', content: 'Inspect the files.' }, ...toolContinuation()];
    const first = _buildRequestBodyForCacheSmoke(history, 'claude-fable-5-1');
    const signed = [
        { type: 'thinking', thinking: 'Continue.', signature: 'opaque-prefix-bound-signature' },
        { type: 'tool_use', id: 'toolu_second', name: 'read', input: { file_path: 'b.txt' } },
    ];
    history.push(
        {
            role: 'assistant', content: '',
            providerReplay: withFable51BatchingContext(createProviderReplay('anthropic', signed), first),
            toolCalls: [{ id: 'toolu_second', name: 'read', arguments: { file_path: 'b.txt' } }],
        },
        { role: 'tool', toolCallId: 'toolu_second', content: 'second result' },
    );
    // Cache marker movement is explicitly allowed by the binding contract.
    const withoutCacheMarkers = value => {
        if (Array.isArray(value)) return value.map(withoutCacheMarkers);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value)
            .filter(([key]) => key !== 'cache_control')
            .map(([key, entry]) => [key, withoutCacheMarkers(entry)]));
    };
    const persisted = _sessionForDisk({ id: 'fable-scoped', messages: history });
    const resumed = JSON.parse(JSON.stringify(persisted)).messages.map(message => ({
        ...message,
        ...(message.providerReplay ? { providerReplay: cloneProviderReplay(message.providerReplay) } : {}),
    }));
    for (const source of [history, resumed]) {
        const next = _buildRequestBodyForCacheSmoke(source, 'claude-fable-5-1');
        const signedIndex = next.messages.findIndex(message =>
            Array.isArray(message.content) && message.content.some(block => block.signature === signed[0].signature));
        assert.deepEqual(withoutCacheMarkers(next.messages.slice(0, signedIndex)), withoutCacheMarkers(first.messages));
        assert.deepEqual(withoutCacheMarkers(next.messages[signedIndex].content), signed);
        assert.equal(next.messages.at(-1).role, 'system');
        assert.equal(next.messages.at(-1).clear_at, 'next_user_message');
        const reminders = next.messages.filter(message => message.role === 'system');
        assert.equal(reminders.length, 2);
        assert.ok(reminders.every(message => message.clear_at === 'next_user_message'));
    }
    history.push({ role: 'user', content: 'Stop and explain.', meta: { source: 'steering' } });
    const steered = _buildRequestBodyForCacheSmoke(history, 'claude-fable-5-1');
    assert.equal(steered.messages.at(-1).role, 'user');
    assert.equal(steered.messages.filter(message => message.role === 'system').length, 1);
});

test('legacy signed boundaries keep their old scope while new continuations expire', () => {
    const signed = [
        { type: 'thinking', thinking: 'Legacy response.', signature: 'legacy-prefix' },
        { type: 'tool_use', id: 'toolu_legacy', name: 'read', input: { file_path: 'legacy.txt' } },
    ];
    const history = [
        { role: 'user', content: '한국어로 진행해 주세요.' },
        ...toolContinuation(),
        {
            role: 'assistant', content: '',
            providerReplay: createProviderReplay('anthropic', signed),
            toolCalls: [{ id: 'toolu_legacy', name: 'read', arguments: { file_path: 'legacy.txt' } }],
        },
        { role: 'tool', toolCallId: 'toolu_legacy', content: 'legacy result' },
    ];
    const body = _buildRequestBodyForCacheSmoke(history, 'claude-fable-5-1');
    const reminders = body.messages.filter(message => message.role === 'system');
    assert.equal(reminders.length, 2);
    assert.deepEqual(reminders[0], { role: 'system', content: reminders[1].content });
    assert.equal(reminders[1].clear_at, 'next_user_message');
    const replayed = body.messages.find(message => Array.isArray(message.content)
        && message.content.some(block => block.signature === 'legacy-prefix'));
    assert.deepEqual(replayed.content, signed);
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
        base: `${MID_CONVERSATION_SYSTEM_BETA_HEADER},${TURN_SCOPED_SYSTEM_BETA_HEADER}`,
        midConversationSystem: true,
        turnScopedSystem: true,
    }).split(',');
    assert.equal(
        headers.filter((item) => item === MID_CONVERSATION_SYSTEM_BETA_HEADER).length,
        1,
    );
    assert.equal(headers.filter(item => item === TURN_SCOPED_SYSTEM_BETA_HEADER).length, 1);
    assert.ok(!buildAnthropicBetaHeaders({ base: '', midConversationSystem: true })
        .includes(TURN_SCOPED_SYSTEM_BETA_HEADER));

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
    assert.ok(oauthTest.buildOAuthBetaHeaders(continuationBody, { model: 'claude-fable-5-1' })
        .includes(TURN_SCOPED_SYSTEM_BETA_HEADER));
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
    assert.ok(!oauthTest.buildOAuthBetaHeaders(firstTurnBody, { model: 'claude-fable-5-1' })
        .includes(TURN_SCOPED_SYSTEM_BETA_HEADER));
});
