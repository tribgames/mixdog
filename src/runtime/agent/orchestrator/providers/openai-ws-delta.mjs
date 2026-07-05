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

// If the cached request (sans input) matches the current one and the current
// input starts with the cached input, return only the tail. Otherwise return
// the full input (fresh turn).
export function _sansInput(body) {
    const { input: _ignored, previous_response_id: _prevIgnored, ...rest } = body;
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

function _isReplayLikeHead(item, responseItem) {
    if (!item || !responseItem) return false;
    const inputType = item.type || (item.role === 'assistant' ? 'message' : '');
    const responseType = responseItem.type || '';
    if (responseType === 'message') return inputType === 'message';
    if (responseType === 'function_call') return inputType === 'function_call';
    if (responseType === 'tool_search_call') return inputType === 'tool_search_call';
    return inputType === responseType;
}

export function _stripResponseItemsFromHead(items, responseItems) {
    const tail = Array.isArray(items) ? items : [];
    const outputs = Array.isArray(responseItems) ? responseItems : [];
    let cursor = 0;
    let stripped = 0;
    let skipped = 0;
    for (const output of outputs) {
        if (cursor >= tail.length) break;
        if (_logicalResponseItemMatch(tail[cursor], output)) {
            cursor += 1;
            stripped += 1;
            continue;
        }
        if (_isReplayLikeHead(tail[cursor], output)) {
            return {
                ok: false,
                reason: `response_output_mismatch:${output?.type || 'unknown'}`,
                tail,
                stripped,
                skipped,
            };
        }
        skipped += 1;
    }
    return { ok: true, reason: null, tail: tail.slice(cursor), stripped, skipped };
}

export function _computeDelta({ entry, body }) {
    // DEFAULT: full-frame sends. codex's delta path is only cache-safe with
    // the x-codex-turn-state sticky-routing token, which the backend issues to
    // codex but never to us (R11-R14 2026-07-03: zero turn-state events across
    // 200+ calls despite UA/version/beta-features/client_metadata parity;
    // delta measured 18-28% warm miss vs full-frame 0.0%). Without the sticky
    // token, previous_response_id requests hop cache nodes and only the first
    // prefix blocks hit. Re-enable delta explicitly via MIXDOG_OAI_WS_DELTA=1
    // for future probes if the backend starts issuing turn-state.
    const deltaMode = String(process.env.MIXDOG_OAI_WS_DELTA || '').trim().toLowerCase();
    const deltaForce = ['force', 'unsafe', 'always'].includes(deltaMode);
    const deltaOptIn = deltaForce || ['1', 'true', 'yes', 'on'].includes(deltaMode);
    if (!deltaOptIn) {
        return { mode: 'full', reason: 'full_default', frame: { type: 'response.create', ...body } };
    }
    if (!entry || !entry.lastRequestSansInput || !entry.lastResponseId) {
        return { mode: 'full', reason: 'no_anchor', frame: { type: 'response.create', ...body } };
    }
    if (!deltaForce && !entry.turnState) {
        return { mode: 'full', reason: 'delta_missing_turn_state', frame: { type: 'response.create', ...body } };
    }
    if (!Array.isArray(entry.lastRequestInput)) {
        return { mode: 'full', reason: 'no_input_snapshot', frame: { type: 'response.create', ...body } };
    }
    const curSans = _stableStringify(_sansInput(body));
    if (curSans !== entry.lastRequestSansInput) {
        return { mode: 'full', reason: 'request_properties_changed', frame: { type: 'response.create', ...body } };
    }
    const curInput = Array.isArray(body.input) ? body.input : [];
    const afterPreviousInput = _stripRequestPrefix(curInput, entry.lastRequestInput);
    if (!afterPreviousInput) {
        return { mode: 'full', reason: 'input_prefix_mismatch', frame: { type: 'response.create', ...body } };
    }
    const stripped = _stripResponseItemsFromHead(afterPreviousInput, entry.lastResponseItems);
    if (!stripped.ok) {
        return { mode: 'full', reason: stripped.reason, frame: { type: 'response.create', ...body } };
    }
    return {
        mode: 'delta',
        reason: null,
        strippedResponseItems: stripped.stripped,
        skippedResponseItems: stripped.skipped,
        frame: (() => {
            const { model, instructions, input: _input, ...rest } = body;
            return {
                type: 'response.create',
                model,
                ...(typeof instructions === 'string' && instructions.length ? { instructions } : {}),
                previous_response_id: entry.lastResponseId,
                input: stripped.tail,
                ...rest,
            };
        })(),
    };
}

export function _estimateFrameTokens(frame) {
    try {
        const s = JSON.stringify(frame);
        return Math.ceil(s.length / 4);
    } catch { return 0; }
}
