import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    codexWireSendOpts,
    ensureCodexWireSessionId,
    isUuidV7,
    mintUuidV7,
} from '../session/manager/session-id.mjs';
import { buildStableProviderPromptCacheKey } from '../agent-runtime/cache-strategy.mjs';
import {
    _codexWsCompatibilityHeaders,
    _withCodexWsClientMetadata,
} from './openai-codex-metadata.mjs';
import { codexOriginator, codexUserAgent } from './codex-client-meta.mjs';
import { _captureTurnStateFromEvent } from './openai-ws-stream.mjs';
import { _buildOpenAIHttpFallbackHeaders } from './openai-oauth-http-sse.mjs';
import {
    _clearCodexTurnStatesForTest,
    retireCodexTurnStateOwner,
} from './openai-turn-state.mjs';

test('Codex wire identity is a real time-based UUIDv7 and remains session-stable', () => {
    const now = Date.now();
    const first = mintUuidV7(now);
    const second = mintUuidV7(now);
    assert.equal(isUuidV7(first), true);
    assert.equal(isUuidV7(second), true);
    assert.notEqual(first, second);
    assert.equal(Number.parseInt(first.replace(/-/g, '').slice(0, 12), 16), now);

    const session = { provider: 'openai-oauth' };
    const sessionId = ensureCodexWireSessionId(session);
    assert.equal(isUuidV7(sessionId), true);
    assert.equal(ensureCodexWireSessionId(session), sessionId);
});

test('Codex cache key and every wire session identity use the same UUIDv7', () => {
    const sessionId = mintUuidV7();
    const turnStartedAtUnixMs = Date.now();
    const turnId = mintUuidV7(turnStartedAtUnixMs);
    const session = {
        provider: 'openai-oauth',
        id: 'exec_internal_id',
        codexWireSessionId: sessionId,
        promptCacheKey: 'mixdog-codex',
    };
    const promptCacheKey = buildStableProviderPromptCacheKey('openai-oauth', {
        sessionId: session.id,
        codexSessionId: sessionId,
        codexThreadId: sessionId,
        session,
    });
    assert.equal(promptCacheKey, sessionId);
    // The reference client derives its User-Agent from the originator, so the
    // pair can never disagree on the wire.
    assert.equal(codexUserAgent().startsWith(`${codexOriginator()}/`), true);

    const frame = _withCodexWsClientMetadata(
        { prompt_cache_key: promptCacheKey },
        {},
        true,
        {
            cacheKey: promptCacheKey,
            poolKey: session.id,
            sendOpts: {
                codexSessionId: sessionId,
                codexThreadId: sessionId,
                turnId,
                windowId: `${sessionId}:0`,
                turnStartedAtUnixMs,
                session,
            },
        },
    );
    assert.equal(frame.prompt_cache_key, sessionId);
    assert.equal(frame.client_metadata.session_id, sessionId);
    assert.equal(frame.client_metadata.thread_id, sessionId);
    assert.equal(frame.client_metadata.turn_id, turnId);
    assert.equal(frame.client_metadata['x-codex-window-id'], `${sessionId}:0`);
    const turnMetadata = JSON.parse(frame.client_metadata['x-codex-turn-metadata']);
    assert.equal(turnMetadata.session_id, sessionId);
    assert.equal(turnMetadata.thread_id, sessionId);
    assert.equal(turnMetadata.turn_id, turnId);
    assert.match(turnMetadata.installation_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(turnMetadata.agent_name, '/root');
    assert.equal(turnMetadata.sandbox, 'none');
    assert.equal(turnMetadata.sandbox_mode, 'danger-full-access');
    assert.equal(turnMetadata.auto_review_enabled, false);
    assert.equal(turnMetadata.node_repl_auto_review_required, false);
    assert.equal(turnMetadata.node_repl_disabled, false);
    assert.equal(turnMetadata.turn_started_at_unix_ms, turnStartedAtUnixMs);

    const prewarmHeaders = _codexWsCompatibilityHeaders({
        cacheKey: promptCacheKey,
        poolKey: session.id,
        model: 'gpt-5.6-sol',
        handshake: true,
        sendOpts: {
            codexSessionId: sessionId,
            codexThreadId: sessionId,
            requestKind: 'prewarm',
            session,
        },
    });
    assert.equal(prewarmHeaders['session-id'], sessionId);
    assert.equal(prewarmHeaders['thread-id'], sessionId);
    assert.equal(prewarmHeaders['x-client-request-id'], sessionId);
    assert.equal('x-codex-installation-id' in prewarmHeaders, false);
    const prewarmMetadata = JSON.parse(prewarmHeaders['x-codex-turn-metadata']);
    assert.equal(prewarmMetadata.request_kind, 'prewarm');
    assert.equal(prewarmMetadata.turn_id, '');
    assert.equal(prewarmMetadata.installation_id, turnMetadata.installation_id);
    assert.equal('turn_started_at_unix_ms' in prewarmMetadata, false);
});

// A compaction summary is a request of the same session: same thread identity,
// same window, same prompt-cache slot — only the request kind and turn id move.
test('compaction shares the session identity and cache slot with its turns', () => {
    const session = { provider: 'openai-oauth', id: 'sess_internal_1' };
    const turn = codexWireSendOpts(session, {
        turnId: mintUuidV7(),
        startedAtMs: Date.now(),
    });
    const compaction = codexWireSendOpts(session, { requestKind: 'compaction' });

    assert.equal(compaction.codexSessionId, turn.codexSessionId);
    assert.equal(compaction.codexThreadId, turn.codexThreadId);
    assert.equal(compaction.windowId, turn.windowId);
    assert.equal(turn.requestKind, 'turn');
    assert.equal(compaction.requestKind, 'compaction');
    assert.notEqual(compaction.turnId, turn.turnId);
    assert.equal(isUuidV7(compaction.turnId), true);

    // The compaction call runs on its own socket bucket (`:compact` session id)
    // yet must still resolve to the turn's prompt-cache key.
    assert.equal(
        buildStableProviderPromptCacheKey('openai-oauth', {
            sessionId: `${session.id}:compact`,
            session,
            ...compaction,
        }),
        buildStableProviderPromptCacheKey('openai-oauth', {
            sessionId: session.id,
            session,
            ...turn,
        }),
    );

    const frame = _withCodexWsClientMetadata({}, {}, true, {
        cacheKey: compaction.codexSessionId,
        poolKey: `${session.id}:compact`,
        sendOpts: { ...compaction, session },
    });
    const turnMetadata = JSON.parse(frame.client_metadata['x-codex-turn-metadata']);
    assert.equal(turnMetadata.request_kind, 'compaction');
    assert.equal(turnMetadata.session_id, turn.codexSessionId);
    assert.equal(turnMetadata.thread_id, turn.codexThreadId);
});

test('Codex turn state follows the logical turn across WS reconnect and HTTP fallback', (t) => {
    _clearCodexTurnStatesForTest();
    t.after(_clearCodexTurnStatesForTest);
    const poolKey = 'turn-state-parity-session';
    const cacheKey = mintUuidV7();
    const turnId = mintUuidV7();
    const nextTurnId = mintUuidV7();
    const context = {
        poolKey,
        cacheKey,
        sendOpts: { turnId },
    };

    const firstEntry = {};
    const firstFrame = _withCodexWsClientMetadata({}, firstEntry, true, context);
    assert.equal(firstFrame.client_metadata['x-codex-turn-state'], undefined);

    _captureTurnStateFromEvent(firstEntry, {
        type: 'response.metadata',
        headers: { 'x-codex-turn-state': 'ts-first' },
    });
    _captureTurnStateFromEvent(firstEntry, {
        type: 'response.metadata',
        headers: { 'x-codex-turn-state': 'ts-later' },
    });

    const siblingEntry = {};
    const siblingFrame = _withCodexWsClientMetadata({}, siblingEntry, true, context);
    assert.equal(siblingFrame.client_metadata['x-codex-turn-state'], undefined);

    const httpHeaders = _buildOpenAIHttpFallbackHeaders({
        auth: { type: 'openai-oauth', access_token: 'token', account_id: 'account' },
        cacheKey,
        poolKey,
        turnId,
    });
    assert.equal(httpHeaders['x-codex-turn-state'], 'ts-first');

    retireCodexTurnStateOwner(poolKey, firstEntry);
    const reconnectEntry = {};
    const reconnectFrame = _withCodexWsClientMetadata({}, reconnectEntry, true, context);
    assert.equal(reconnectFrame.client_metadata['x-codex-turn-state'], 'ts-first');

    const nextTurnFrame = _withCodexWsClientMetadata({}, reconnectEntry, true, {
        ...context,
        sendOpts: { turnId: nextTurnId },
    });
    assert.equal(nextTurnFrame.client_metadata['x-codex-turn-state'], undefined);
    const nextTurnHttpHeaders = _buildOpenAIHttpFallbackHeaders({
        auth: { type: 'openai-oauth', access_token: 'token', account_id: 'account' },
        cacheKey,
        poolKey,
        turnId: nextTurnId,
    });
    assert.equal(nextTurnHttpHeaders['x-codex-turn-state'], undefined);

    const directHeaders = _buildOpenAIHttpFallbackHeaders({
        auth: { type: 'openai-direct', apiKey: 'key' },
        cacheKey,
        poolKey,
        turnId,
    });
    assert.equal(directHeaders['x-codex-turn-state'], undefined);
});
