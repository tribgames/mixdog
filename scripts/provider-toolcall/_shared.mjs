#!/usr/bin/env node
// Regression tests pinning the cross-provider "native tool_call extraction"
// contract: when a provider's native parser is fed a well-formed tool_call
// payload, it MUST surface the call in our canonical toolCalls shape
// ({ id, name, arguments }). Synthetic inputs fed directly to the exported parser, asserting the
// resulting outcome. No network, no model. Each provider also gets one
// negative case (no native tool_call → undefined / empty).
//
// Parser entry points (file:line at authoring time) and sharing notes are
// documented inline per provider block below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';

import {
    OpenAICompatProvider,
    _toResponsesToolsForTest,
    _toXaiResponsesInputForTest,
    parseToolCalls as compatParseToolCalls,
    parseResponsesToolCalls as compatParseResponsesToolCalls,
} from '../../src/runtime/agent/orchestrator/providers/openai-compat.mjs';
import {
    _xaiResponsesFingerprintPayloadForTest,
    xaiResponsesCacheRouting,
} from '../../src/runtime/agent/orchestrator/providers/openai-compat-xai.mjs';
import {
    GrokOAuthProvider,
} from '../../src/runtime/agent/orchestrator/providers/grok-oauth.mjs';
import {
    consumeCompatResponsesStream,
    isInvalidToolArgsMarker,
} from '../../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import {
    consumeCompatChatCompletionStream,
} from '../../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import {
    _computeDelta,
    _buildResponseCreateFrame,
    _sansInput,
    _stableStringify,
} from '../../src/runtime/agent/orchestrator/providers/openai-ws-delta.mjs';
import {
    _cacheObservationForTest,
    _cacheContinuityResetReasonForTest,
    sendViaWebSocket,
} from '../../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import {
    _withCodexWsClientMetadata,
} from '../../src/runtime/agent/orchestrator/providers/openai-codex-metadata.mjs';
import {
    _captureTurnStateFromEvent,
} from '../../src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs';
import {
    createGeminiTextLeakGuard,
    geminiChunkProgressKind,
} from '../../src/runtime/agent/orchestrator/providers/gemini-stream.mjs';
import {
    parseToolCalls as geminiParseToolCalls,
} from '../../src/runtime/agent/orchestrator/providers/gemini-schema.mjs';
import {
    _resolveGeminiCacheUsage,
} from '../../src/runtime/agent/orchestrator/providers/gemini-cache.mjs';
import { parseSSEStream as anthropicParseSSEStream } from '../../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { _buildRequestBodyForCacheSmoke } from '../../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { _test as _anthropicApiKeyTest } from '../../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import { _toAnthropicMessagesForTest } from '../../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import { _test as _anthropicOAuthTest } from '../../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import {
    EFFORT_BETA_HEADER,
    LEGACY_EFFORT_BUDGET,
    effortValuesForModel,
    modelSupportsEffort,
    modelSupportsMaxEffort,
    modelSupportsXhighEffort,
    normalizeAnthropicEffortInput,
    setModelEffortCapabilities,
    shouldIncludeEffortBeta,
} from '../../src/runtime/agent/orchestrator/providers/anthropic-effort.mjs';
import { buildAnthropicBetaHeaders } from '../../src/runtime/agent/orchestrator/providers/anthropic-betas.mjs';
import { PATCH_TOOL_DEFS } from '../../src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs';
import { BUILTIN_TOOLS } from '../../src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs';
import { normalizeGrokToolSchemas } from '../../src/runtime/agent/orchestrator/providers/lib/grok-tool-schema.mjs';
import { sendViaHttpSse } from '../../src/runtime/agent/orchestrator/providers/openai-oauth-http-sse.mjs';
import {
    OpenAIOAuthProvider,
    buildCodexStartupPrewarmBody,
    buildRequestBody as buildOpenAIOAuthRequestBody,
} from '../../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { _convertMessagesToResponsesInputForTest } from '../../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { OpenAIDirectProvider } from '../../src/runtime/agent/orchestrator/providers/openai-ws.mjs';
import { isVisibleStreamProgress } from '../../src/runtime/shared/stream-progress.mjs';

function directHandshakeError(status) {
    return Object.assign(new Error(`handshake ${status}`), { httpStatus: status });
}

function directWsEntry() {
    return { socket: { close() {} }, ephemeral: true };
}

// Wraps an array of Anthropic SSE event objects in a minimal Response-like
// shape exposing the single `body.getReader()` API that parseSSEStream uses.
// Each event becomes a `data: <json>` SSE frame, preceded by its `event:` line.
function anthropicSseResponse(events) {
    const encoder = new TextEncoder();
    const frames = events.map((e) => {
        const type = e.type || 'message';
        return `event: ${type}\ndata: ${JSON.stringify(e)}\n\n`;
    });
    const chunks = frames.map((f) => encoder.encode(f));
    let i = 0;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
                        return Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

function compatResponsesEventStream(events) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
        },
    };
}

// Minimal 200-OK Response-like shape for the HTTP/SSE Responses path: frames
// each event as `event:<type>\ndata:<json>\n\n`, delivered synchronously so the
// semantic-idle watchdog never arms during the test.
function httpSseResponse(events) {
    const encoder = new TextEncoder();
    const chunks = events.map((e) => encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    return {
        status: 200,
        ok: true,
        headers: new Map(),
        body: {
            getReader() {
                return {
                    read() {
                        return i < chunks.length
                            ? Promise.resolve({ done: false, value: chunks[i++] })
                            : Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

// --- Leaked tool-call recovery (shared parseSSEStream guard) ----------------
// The model sometimes emits a tool call as plain text tags inside text_delta
// instead of a native tool_use block. The guard (8th arg = known tool names)
// suppresses the tags from the visible stream, removes them from content, and
// synthesizes/dispatches a real tool call. anthropic.mjs reuses this SAME
// parseSSEStream, so both providers are covered by one guard.
const LEAK_TOOLS = new Set(['shell', 'read']);

function textDeltaEvents(chunks, stopReason = 'end_turn') {
    return [
        { type: 'message_start', message: { model: 'claude', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        ...chunks.map((text) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ];
}

// === 4. openai-oauth / openai-oauth-ws =====================================
// openai-oauth (HTTP/SSE) and openai-oauth-ws (WebSocket) both consume the
// Responses event stream inside large stateful stream loops, NOT a standalone
// parser. The HTTP path's handleEvent is a private closure inside
// sendViaHttpSse (openai-oauth.mjs:1038) and cannot be exported without
// extracting it (forbidden: no logic change). The WS path's _streamResponse
// (openai-oauth-ws.mjs:1190) IS exported but requires a live `entry.socket`
// EventEmitter and resolves only on response.completed — driving it needs a
// full fake-socket test rig, well beyond "inject synthetic input to a parser".
//
// Their canonical Responses function_call shape (call_id/name/arguments) and
// custom_tool_call handling are the SAME wire contract already asserted via
// openai-compat's parseResponsesToolCalls above, and the shared
// customToolCallFromResponseItem helper (custom-tool-wire.mjs) is imported by
// all three. We add a focused unit test for that shared custom-tool helper so
// the OAuth custom_tool_call extraction path has explicit coverage; the
// function_call path is covered by the openai-compat Responses test.

import { customToolCallFromResponseItem } from '../../src/runtime/agent/orchestrator/providers/custom-tool-wire.mjs';
import { parseToolSearchArgs } from '../../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import { _warmupContinuityTraceForTest } from '../../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';

// === 6. OpenAI leaked tool-call recovery ===================================
// The model sometimes emits a tool call as PLAIN TEXT (XML `<invoke>` family
// or gpt-oss harmony `<|channel|>...to=functions.NAME...<|call|>`) inside a
// text delta instead of a native structured tool_call. The stream guards
// suppress the tags from the visible stream, synthesize a native-shaped call
// (`call_leaked_*` id), and dispatch it via the same onToolCall path.
const OAI_LEAK_TOOLS = new Set(['shell', 'read']);

function chatCompletionStream(contentChunks) {
    // Each chunk is an assistant text delta; ends with a stop finish_reason.
    const events = contentChunks.map((text) => ({
        choices: [{ delta: { content: text } }],
    }));
    events.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 1 } });
    return compatResponsesEventStream(events);
}

function responsesTextStream(textChunks) {
    const events = textChunks.map((delta) => ({ type: 'response.output_text.delta', delta }));
    events.push({ type: 'response.completed', response: { id: 'r1', model: 'gpt', status: 'completed', output: [] } });
    return compatResponsesEventStream(events);
}

// === 10. OpenAI transport-policy switch (MIXDOG_OAI_TRANSPORT) ==============
// One clean knob selects among ws-full | ws-delta | http-sse | auto. The
// resolver is a pure function over an injected env, and the delta gate
// (_computeDelta) + transport dispatch both read it, so these unit tests pin
// the resolution and the delta branching without any network.
import {
    resolveOpenAiTransportPolicy,
    _normalizeTransportMode,
} from '../../src/runtime/agent/orchestrator/providers/openai-transport-policy.mjs';
import {
    resolveResponsesTransportPolicy,
    RESPONSES_TRANSPORT_CAPABILITIES,
    _gateTransportMode,
    FULL_RESPONSES_TRANSPORT_CAPS,
} from '../../src/runtime/agent/orchestrator/providers/openai-transport-policy.mjs';

import {
    acquireWebSocket,
    releaseWebSocket,
    _clearWebSocketPoolForTest,
    _setOpenSocketForTest,
} from '../../src/runtime/agent/orchestrator/providers/openai-ws-pool.mjs';

export {
  EventEmitter,
  readFileSync,
  parse,
  analyze,
  OpenAICompatProvider,
  _toResponsesToolsForTest,
  _toXaiResponsesInputForTest,
  compatParseToolCalls,
  compatParseResponsesToolCalls,
  _xaiResponsesFingerprintPayloadForTest,
  xaiResponsesCacheRouting,
  GrokOAuthProvider,
  consumeCompatResponsesStream,
  isInvalidToolArgsMarker,
  consumeCompatChatCompletionStream,
  _computeDelta,
  _buildResponseCreateFrame,
  _sansInput,
  _stableStringify,
  _cacheObservationForTest,
  _cacheContinuityResetReasonForTest,
  sendViaWebSocket,
  _withCodexWsClientMetadata,
  _captureTurnStateFromEvent,
  createGeminiTextLeakGuard,
  geminiChunkProgressKind,
  geminiParseToolCalls,
  _resolveGeminiCacheUsage,
  anthropicParseSSEStream,
  _buildRequestBodyForCacheSmoke,
  _anthropicApiKeyTest,
  _toAnthropicMessagesForTest,
  _anthropicOAuthTest,
  EFFORT_BETA_HEADER,
  LEGACY_EFFORT_BUDGET,
  effortValuesForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  normalizeAnthropicEffortInput,
  setModelEffortCapabilities,
  shouldIncludeEffortBeta,
  buildAnthropicBetaHeaders,
  PATCH_TOOL_DEFS,
  BUILTIN_TOOLS,
  normalizeGrokToolSchemas,
  sendViaHttpSse,
  OpenAIOAuthProvider,
  buildCodexStartupPrewarmBody,
  buildOpenAIOAuthRequestBody,
  _convertMessagesToResponsesInputForTest,
  OpenAIDirectProvider,
  isVisibleStreamProgress,
  directHandshakeError,
  directWsEntry,
  anthropicSseResponse,
  compatResponsesEventStream,
  httpSseResponse,
  LEAK_TOOLS,
  textDeltaEvents,
  customToolCallFromResponseItem,
  parseToolSearchArgs,
  _warmupContinuityTraceForTest,
  OAI_LEAK_TOOLS,
  chatCompletionStream,
  responsesTextStream,
  resolveOpenAiTransportPolicy,
  _normalizeTransportMode,
  resolveResponsesTransportPolicy,
  RESPONSES_TRANSPORT_CAPABILITIES,
  _gateTransportMode,
  FULL_RESPONSES_TRANSPORT_CAPS,
  acquireWebSocket,
  releaseWebSocket,
  _clearWebSocketPoolForTest,
  _setOpenSocketForTest,
};
