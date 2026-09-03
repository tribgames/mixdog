/**
 * Wire-level tool-call pairing guards for non-Anthropic request builders.
 *
 * Session history can hold an assistant tool call with no matching result
 * (user cancel or stream abort between call dispatch and result commit).
 * Loop-level repair works on the internal message shape and cannot see
 * inside provider replay envelopes, so a wire builder that replays such a
 * call verbatim produces a request the provider hard-rejects
 * (Responses `invalid_request_error`, chat `tool_calls` without tool
 * messages). The failure is deterministic: every retry resends the same
 * unpaired call.
 *
 * These post-passes run on the FINAL wire arrays, after replay expansion,
 * and insert a synthetic result immediately after each unpaired call so the
 * request is always well-formed. Orphan results (a result with no visible
 * call) are left alone: incremental continuations legitimately carry only
 * the new results while the call lives server-side.
 */

// Synthetic result body for calls that never completed. Matches the
// cancellation vocabulary used for interrupted tool results elsewhere.
export const WIRE_PAIRING_STUB = 'Cancelled';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responsesCallId(item) {
    if (!isObject(item)) return null;
    if (item.type !== 'function_call' && item.type !== 'custom_tool_call' && item.type !== 'tool_search_call') return null;
    const id = item.call_id || item.id || '';
    return typeof id === 'string' && id ? id : null;
}

function responsesOutputId(item) {
    if (!isObject(item)) return null;
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output' && item.type !== 'tool_search_output') return null;
    const id = item.call_id || item.id || '';
    return typeof id === 'string' && id ? id : null;
}

function syntheticResponsesOutput(call) {
    if (call.type === 'custom_tool_call') {
        return {
            type: 'custom_tool_call_output',
            call_id: call.call_id || call.id || '',
            ...(typeof call.name === 'string' && call.name ? { name: call.name } : {}),
            output: WIRE_PAIRING_STUB,
        };
    }
    if (call.type === 'tool_search_call') {
        return {
            type: 'tool_search_output',
            call_id: call.call_id || call.id || '',
            status: 'completed',
            execution: 'client',
            tools: [],
        };
    }
    return {
        type: 'function_call_output',
        call_id: call.call_id || call.id || '',
        output: WIRE_PAIRING_STUB,
    };
}

/**
 * Ensure every Responses call item in a finished input array has a matching
 * output item. Returns the original array when already paired, otherwise a
 * new array with synthetic outputs inserted right after their calls.
 */
export function ensureResponsesCallOutputs(items) {
    if (!Array.isArray(items) || items.length === 0) return items;
    const outputIds = new Set();
    for (const item of items) {
        const id = responsesOutputId(item);
        if (id) outputIds.add(id);
    }
    let missing = 0;
    for (const item of items) {
        const id = responsesCallId(item);
        if (id && !outputIds.has(id)) missing += 1;
    }
    if (missing === 0) return items;
    const out = [];
    for (const item of items) {
        out.push(item);
        const id = responsesCallId(item);
        if (id && !outputIds.has(id)) {
            out.push(syntheticResponsesOutput(item));
            outputIds.add(id);
        }
    }
    return out;
}

function chatToolCallIds(message) {
    if (!isObject(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return [];
    const ids = [];
    for (const call of message.tool_calls) {
        const id = call?.id;
        if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

function chatResultId(message) {
    if (!isObject(message) || message.role !== 'tool') return null;
    const id = message.tool_call_id;
    return typeof id === 'string' && id ? id : null;
}

/**
 * Ensure every chat assistant `tool_calls` entry has a following tool
 * message. Returns the original array when already paired, otherwise a new
 * array with synthetic tool messages inserted right after their assistant
 * message (providers require the results to follow the call message).
 */
export function ensureChatToolPairs(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages;
    const resultIds = new Set();
    for (const message of messages) {
        const id = chatResultId(message);
        if (id) resultIds.add(id);
    }
    let missing = 0;
    for (const message of messages) {
        for (const id of chatToolCallIds(message)) {
            if (!resultIds.has(id)) missing += 1;
        }
    }
    if (missing === 0) return messages;
    const out = [];
    for (const message of messages) {
        out.push(message);
        for (const id of chatToolCallIds(message)) {
            if (resultIds.has(id)) continue;
            out.push({ role: 'tool', tool_call_id: id, content: WIRE_PAIRING_STUB });
            resultIds.add(id);
        }
    }
    return out;
}
