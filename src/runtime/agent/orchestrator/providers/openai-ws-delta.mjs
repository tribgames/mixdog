/**
 * openai-ws-delta.mjs — request/response item matching + incremental-input
 * delta computation for the OpenAI OAuth WebSocket transport.
 *
 * Extracted from openai-ws-stream.mjs (no behavior change): the pure helpers
 * that decide whether a warm socket can send only the input tail
 * (_computeDelta / _sansInput / _logicalResponseItemMatch / ...). No socket or
 * stream state — deterministic functions over request bodies + prior-response
 * snapshots. openai-ws-stream.mjs re-exports these so existing importers
 * (openai-oauth-ws.mjs et al) resolve unchanged.
 */

import {
    resolveResponsesTransportPolicy,
    RESPONSES_TRANSPORT_CAPABILITIES,
    FULL_RESPONSES_TRANSPORT_CAPS,
} from './openai-transport-policy.mjs';
import { createHash } from 'node:crypto';

// If the cached request (sans input) matches the current one and the current
// input starts with the cached input, return only the tail. Otherwise return
// the full input (fresh turn).
export function _sansInput(body, { normalizeWarmupGenerate = false } = {}) {
    const { input: _ignored, previous_response_id: _prevIgnored, generate, ...rest } = body;
    // Only OpenAI OAuth/Codex startup prewarm treats generate:false as a
    // transport marker. Shared xAI callers retain it as a real request
    // property so their existing property guard still falls back to full.
    if (!(normalizeWarmupGenerate && generate === false) && generate !== undefined) {
        rest.generate = generate;
    }
    return rest;
}

export function _stableStringify(obj) {
    // Shallow stable-ish: JSON.stringify with sorted top-level keys. Nested
    // arrays (tools, include) are order-sensitive and reflect intent, so we
    // do not sort them.
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
    const keys = Object.keys(obj).sort();
    const parts = [];
    for (const k of keys) parts.push(JSON.stringify(k) + ':' + _stableStringify(obj[k]));
    return '{' + parts.join(',') + '}';
}

export function _cloneJson(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function _normalizeArguments(value) {
    if (value == null) return '';
    if (typeof value === 'string') {
        const trimmed = value.trim();
        try { return _stableStringify(JSON.parse(trimmed || '{}')); } catch { return trimmed; }
    }
    return _stableStringify(value);
}

function _normalizeContentPart(part) {
    if (!part || typeof part !== 'object') return part;
    const type = part.type === 'input_text' ? 'output_text' : part.type;
    if (type === 'output_text') return { type, text: part.text || '' };
    return part;
}

function _contentPartsEqual(a, b) {
    const aa = Array.isArray(a) ? a.map(_normalizeContentPart) : [];
    const bb = Array.isArray(b) ? b.map(_normalizeContentPart) : [];
    return _stableStringify(aa) === _stableStringify(bb);
}

export function _logicalResponseItemMatch(inputItem, responseItem) {
    if (!inputItem || !responseItem) return false;
    const inputType = inputItem.type || (inputItem.role === 'assistant' ? 'message' : '');
    const responseType = responseItem.type || '';
    if (responseType === 'function_call') {
        if (inputType !== 'function_call') return false;
        const inputCallId = String(inputItem.call_id || '');
        const responseCallId = String(responseItem.call_id || '');
        const inputName = String(inputItem.name || '');
        const responseName = String(responseItem.name || '');
        if (inputCallId && responseCallId) {
            // call_id is the server-side anchor. The replayed history may carry
            // locally compacted arguments, but previous_response_id already
            // points at the canonical output item.
            return inputCallId === responseCallId && inputName === responseName;
        }
        return inputName === responseName
            && _normalizeArguments(inputItem.arguments) === _normalizeArguments(responseItem.arguments);
    }
    if (responseType === 'tool_search_call') {
        if (inputType !== 'tool_search_call') return false;
        const inputCallId = String(inputItem.call_id || '');
        const responseCallId = String(responseItem.call_id || '');
        if (inputCallId && responseCallId) return inputCallId === responseCallId;
        return _normalizeArguments(inputItem.arguments) === _normalizeArguments(responseItem.arguments);
    }
    if (responseType === 'custom_tool_call') {
        if (inputType !== 'custom_tool_call') return false;
        const inputCallId = String(inputItem.call_id || '');
        const responseCallId = String(responseItem.call_id || '');
        const inputName = String(inputItem.name || '');
        const responseName = String(responseItem.name || '');
        if (inputCallId && responseCallId) return inputCallId === responseCallId && inputName === responseName;
        return inputName === responseName && String(inputItem.input || '') === String(responseItem.input || '');
    }
    if (responseType === 'message') {
        const inputRole = inputItem.role || (inputType === 'message' ? 'assistant' : '');
        const responseRole = responseItem.role || 'assistant';
        return inputType === 'message'
            && inputRole === responseRole
            && _contentPartsEqual(inputItem.content, responseItem.content);
    }
    if (responseType === 'reasoning') {
        return inputType === 'reasoning'
            && (!!responseItem.id ? inputItem.id === responseItem.id : true)
            && (!!responseItem.encrypted_content
                ? inputItem.encrypted_content === responseItem.encrypted_content
                : true);
    }
    if (responseType === 'web_search_call') {
        return inputType === 'web_search_call'
            && (!!responseItem.id ? inputItem.id === responseItem.id : true)
            && _stableStringify(inputItem.action || null) === _stableStringify(responseItem.action || null);
    }
    if (inputType !== responseType) return false;
    const stripVolatile = (item) => {
        if (!item || typeof item !== 'object') return item;
        const { id: _id, status: _status, ...rest } = item;
        return rest;
    };
    return _stableStringify(stripVolatile(inputItem)) === _stableStringify(stripVolatile(responseItem));
}

function _requestInputItemsMatch(a, b) {
    return _stableStringify(a) === _stableStringify(b);
}

function _stripRequestPrefix(curInput, prevInput) {
    const current = Array.isArray(curInput) ? curInput : [];
    const previous = Array.isArray(prevInput) ? prevInput : [];
    if (current.length < previous.length) return null;
    for (let i = 0; i < previous.length; i += 1) {
        if (!_requestInputItemsMatch(current[i], previous[i])) return null;
    }
    return current.slice(previous.length);
}

// The hash input follows the same per-item normalizations used by
// _logicalResponseItemMatch, but is never emitted itself. This retains a
// stable comparison fingerprint after history compaction without putting
// message content, tool arguments, or custom-tool input into traces.
function _normalizedResponseItemDiagnosticShape(item) {
    if (!item || typeof item !== 'object') return item || null;
    const type = item.type || (item.role === 'assistant' ? 'message' : '');
    if (type === 'function_call' || type === 'tool_search_call') {
        return {
            type,
            call_id: String(item.call_id || ''),
            name: type === 'function_call' ? String(item.name || '') : undefined,
            arguments: _normalizeArguments(item.arguments),
        };
    }
    if (type === 'custom_tool_call') {
        return {
            type,
            call_id: String(item.call_id || ''),
            name: String(item.name || ''),
            input: String(item.input || ''),
        };
    }
    if (type === 'message') {
        return {
            type,
            role: item.role || 'assistant',
            content: Array.isArray(item.content) ? item.content.map(_normalizeContentPart) : [],
        };
    }
    if (type === 'reasoning') {
        return {
            type,
            id: item.id || null,
            encrypted_content: item.encrypted_content || null,
        };
    }
    if (type === 'web_search_call') {
        return { type, id: item.id || null, action: item.action || null };
    }
    const { id: _id, status: _status, ...rest } = item;
    return { type, ...rest };
}

function _normalizedResponseItemDiagnosticHash(item) {
    return createHash('sha256')
        .update(_stableStringify(_normalizedResponseItemDiagnosticShape(item)))
        .digest('hex');
}

export function _requestInputMismatchDiagnostics(currentInput, previousInput) {
    const current = Array.isArray(currentInput) ? currentInput : [];
    const previous = Array.isArray(previousInput) ? previousInput : [];
    let index = Math.min(current.length, previous.length);
    const limit = Math.min(current.length, previous.length);
    for (let cursor = 0; cursor < limit; cursor += 1) {
        if (_requestInputItemsMatch(current[cursor], previous[cursor])) continue;
        index = cursor;
        break;
    }
    const expected = previous[index];
    const actual = current[index];
    return {
        inputPrefixMismatchIndex: index,
        inputPrefixMismatchPreviousCount: previous.length,
        inputPrefixMismatchCurrentCount: current.length,
        inputPrefixMismatchExpectedType: expected?.type
            || (expected?.role === 'assistant' ? 'message' : (expected ? 'unknown' : 'missing')),
        inputPrefixMismatchExpectedHash: _normalizedResponseItemDiagnosticHash(expected),
        inputPrefixMismatchActualType: actual?.type
            || (actual?.role === 'assistant' ? 'message' : (actual ? 'unknown' : 'missing')),
        inputPrefixMismatchActualHash: _normalizedResponseItemDiagnosticHash(actual),
    };
}

function _responseOutputMismatchDiagnostics(inputItem, responseItem, replayItemCount, responseItemCount) {
    return {
        response_output_mismatch_expected_type: responseItem?.type || 'unknown',
        response_output_mismatch_expected_hash: _normalizedResponseItemDiagnosticHash(responseItem),
        response_output_mismatch_expected_response_item_count: responseItemCount,
        response_output_mismatch_actual_type: inputItem?.type || (inputItem?.role === 'assistant' ? 'message' : 'unknown'),
        response_output_mismatch_actual_hash: _normalizedResponseItemDiagnosticHash(inputItem),
        response_output_mismatch_actual_replayed_input_item_count: replayItemCount,
    };
}

export function _stripResponseItemsFromHead(items, responseItems) {
    const tail = Array.isArray(items) ? items : [];
    const outputs = Array.isArray(responseItems) ? responseItems : [];
    let cursor = 0;
    let stripped = 0;
    for (const output of outputs) {
        // The incremental request must extend the EXACT previous request plus
        // its response: every item the previous response produced has to appear
        // in the current prefix, in order, before anything new. Skipping a
        // missing one builds a delta against a logical history the server never
        // saw and can invalidate the cache chain while previous_response_id
        // stays syntactically valid, so any gap forces a full-frame fallback.
        // There is no per-item exception — reasoning included. Reasoning items
        // are kept in the logical history precisely so this proof holds, and
        // they leave the wire here, as part of the anchored prefix.
        if (cursor >= tail.length) {
            return {
                ok: false,
                reason: `response_output_mismatch:${output?.type || 'unknown'}`,
                tail,
                stripped,
                skipped: 0,
                responseOutputMismatch: _responseOutputMismatchDiagnostics(
                    undefined,
                    output,
                    tail.length,
                    outputs.length,
                ),
            };
        }
        if (_logicalResponseItemMatch(tail[cursor], output)) {
            cursor += 1;
            stripped += 1;
            continue;
        }
        return {
            ok: false,
            reason: `response_output_mismatch:${output?.type || 'unknown'}`,
            tail,
            stripped,
            skipped: 0,
            responseOutputMismatch: _responseOutputMismatchDiagnostics(
                tail[cursor],
                output,
                tail.length,
                outputs.length,
            ),
        };
    }
    return { ok: true, reason: null, tail: tail.slice(cursor), stripped, skipped: 0 };
}

// Official OpenAI Responses WebSocket guide: response.create WS frames mirror
// the Responses body EXCEPT the transport-only fields `stream`/`background`,
// which the socket carries implicitly and the guide says to omit. This set is
// stripped from a frame (any build shape) only when omitTransportFields is on.
const TRANSPORT_ONLY_FRAME_FIELDS = new Set(['stream', 'background']);

// Canonical response.create frame builder. Every WS send (warmup, main
// full-frame, and delta) routes through this so the serialized key order is
// identical byte-for-byte: `type` always leads, then the body's codex
// struct-order keys follow verbatim. A delta send passes previousResponseId
// (inserted immediately before `input`, matching codex's refs position) and
// inputOverride (the stripped tail). `instructions` MUST still be resent on
// previous_response_id frames: per the OpenAI Responses API, the previous
// response's top-level instructions are NOT carried over to the chained
// response, so dropping them here strips the system/lead prompt from every
// continuation turn. Only an empty instructions string is omitted.
// Full/warmup frames pass the body unchanged and keep every key in place.
// omitTransportFields is used by wire-parity/prewarm helpers to drop stream/background.
export function _buildResponseCreateFrame(body, { previousResponseId = null, inputOverride, omitTransportFields = false } = {}) {
    const src = body && typeof body === 'object' ? body : {};
    if (previousResponseId == null && inputOverride === undefined) {
        if (!omitTransportFields) return { type: 'response.create', ...src };
        const frame = { type: 'response.create' };
        for (const key of Object.keys(src)) {
            if (TRANSPORT_ONLY_FRAME_FIELDS.has(key)) continue;
            frame[key] = src[key];
        }
        return frame;
    }
    const frame = { type: 'response.create' };
    for (const key of Object.keys(src)) {
        if (omitTransportFields && TRANSPORT_ONLY_FRAME_FIELDS.has(key)) continue;
        if (key === 'instructions') {
            const instr = src.instructions;
            if (typeof instr === 'string' && instr.length) frame.instructions = instr;
            continue;
        }
        if (key === 'input') {
            if (previousResponseId != null) frame.previous_response_id = previousResponseId;
            frame.input = inputOverride === undefined ? src.input : inputOverride;
            continue;
        }
        frame[key] = src[key];
    }
    if (!('input' in frame) && inputOverride !== undefined) {
        if (previousResponseId != null) frame.previous_response_id = previousResponseId;
        frame.input = inputOverride;
    }
    return frame;
}

export function _computeDelta({ entry, body, traceProvider }) {
    // DEFAULT: full-frame sends. codex's delta path is only cache-safe with
    // the x-codex-turn-state sticky-routing token. The token is request-scoped:
    // response metadata establishes it, later response.create frames replay it
    // for the same logical turn, and a new turn starts empty even when it reuses
    // the physical connection. Handshake state is deliberately ignored because
    // a connection can outlive the turn that created it.
    // Delta gating flows through the single transport-policy switch
    // (MIXDOG_OAI_TRANSPORT: ws-full | ws-delta | http-sse). Default ws-delta
    // selects the refs-compatible safe delta; 'ws-full'/'http-sse' force full
    // frames.
    // refs-compatible mode actively uses previous_response_id without demanding
    // the x-codex-turn-state token, but KEEPS every structural safety check
    // (anchor present, request-props unchanged, input-prefix match, response
    // items strip clean). Any of those failing still retreats to a full frame.
    // Resolve the transport policy under the caller's provider capabilities so
    // the delta gate honors per-provider limits instead of always assuming full
    // OpenAI caps. xAI's WS path now carries delta capability (caps.delta=true),
    // so 'ws-delta' builds the OFFICIAL xAI continuation frame
    // (previous_response_id + incremental input tail) documented by the xAI
    // Responses WebSocket guide — NOT the codex prefix-strip hack: no
    // x-codex-turn-state token is required or fabricated for xAI, and the
    // structural refs guards below still bound any prefix mismatch. openai-oauth/
    // direct keep full capabilities, so their resolution stays byte-identical.
    const caps = traceProvider === 'xai'
        ? RESPONSES_TRANSPORT_CAPABILITIES.xai
        : FULL_RESPONSES_TRANSPORT_CAPS;
    const { delta } = resolveResponsesTransportPolicy(process.env, caps);
    const deltaForce = delta.force;
    const deltaRefs = delta.refs;
    const deltaOptIn = delta.optIn;
    const buildFrame = (b, opts) => _buildResponseCreateFrame(b, opts || {});
    if (!deltaOptIn) {
        return { mode: 'full', reason: 'full_default', frame: buildFrame(body) };
    }
    if (!entry || !entry.lastRequestSansInput || !entry.lastResponseId) {
        return { mode: 'full', reason: 'no_anchor', frame: buildFrame(body) };
    }
    // Public OpenAI resolves previous_response_id out of its response STORE, so
    // an anchor only exists when the anchored response was stored. store:false
    // there — e.g. an explicit MIXDOG_OAI_STORE=0 opt-out on the openai-direct
    // provider — makes a continuation frame fail with
    // previous_response_not_found, so the opt-out degrades to full frames.
    // openai-oauth/Codex (per-WS-session server state) and xAI (in-connection
    // ZDR continuation with encrypted reasoning) both anchor without the store
    // and are deliberately excluded from this gate.
    if (traceProvider === 'openai-direct' && body?.store !== true) {
        return { mode: 'full', reason: 'store_disabled', frame: buildFrame(body) };
    }
    if (!deltaForce && !deltaRefs && !entry.turnState) {
        return { mode: 'full', reason: 'delta_missing_turn_state', frame: buildFrame(body) };
    }
    if (!Array.isArray(entry.lastRequestInput)) {
        return { mode: 'full', reason: 'no_input_snapshot', frame: buildFrame(body) };
    }
    const curSans = _stableStringify(_sansInput(body, {
        normalizeWarmupGenerate: traceProvider === 'openai-oauth',
    }));
    if (curSans !== entry.lastRequestSansInput) {
        return { mode: 'full', reason: 'request_properties_changed', frame: buildFrame(body) };
    }
    const curInput = Array.isArray(body.input) ? body.input : [];
    const afterPreviousInput = _stripRequestPrefix(curInput, entry.lastRequestInput);
    if (!afterPreviousInput) {
        return {
            mode: 'full',
            reason: 'input_prefix_mismatch',
            requestInputMismatch: _requestInputMismatchDiagnostics(curInput, entry.lastRequestInput),
            frame: buildFrame(body),
        };
    }
    const stripped = _stripResponseItemsFromHead(afterPreviousInput, entry.lastResponseItems);
    if (!stripped.ok) {
        return {
            mode: 'full',
            reason: stripped.reason,
            responseOutputMismatch: stripped.responseOutputMismatch,
            frame: buildFrame(body),
        };
    }
    return {
        mode: 'delta',
        reason: null,
        strippedResponseItems: stripped.stripped,
        skippedResponseItems: stripped.skipped,
        frame: buildFrame(body, {
            previousResponseId: entry.lastResponseId,
            inputOverride: stripped.tail,
        }),
    };
}

export function _estimateFrameTokens(frame) {
    try {
        const s = JSON.stringify(frame);
        return Math.ceil(s.length / 4);
    } catch { return 0; }
}
