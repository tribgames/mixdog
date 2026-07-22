/**
 * tool-envelope.mjs — general optional `newMessages` channel for tool results.
 *
 * A tool MAY return either:
 *   - legacy: a string (or existing structured media object) — unchanged, OR
 *   - an envelope object:
 *       { __toolEnvelope: true, result: <string|structured>,
 *         newMessages: [{ role:'user', content:'...' }, ...],
 *         explicitSuccess?: true }
 *
 * The `__toolEnvelope` marker is deliberately namespaced so it can NEVER be
 * confused with the existing structured media content objects that
 * PostToolUse hooks/tests preserve (those use `{ content: [...] }`, never
 * `__toolEnvelope`). `normalizeToolEnvelope` is the single split point: it
 * returns `{ result, newMessages }` so ALL downstream loop code sees only
 * `result` and the loop alone is responsible for flushing `newMessages`.
 */

const TOOL_ENVELOPE_MARKER = '__toolEnvelope';

export function isToolEnvelope(value) {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && value[TOOL_ENVELOPE_MARKER] === true;
}

function isValidNewMessage(m) {
    return !!m
        && typeof m === 'object'
        && m.role === 'user'
        && typeof m.content === 'string'
        && m.content.length > 0;
}

/**
 * Build a tool-result envelope. `result` is the short stub/data the model
 * sees as the tool_result; `newMessages` are appended (as their own
 * messages, e.g. role:'user') AFTER the batch's tool results.
 */
export function makeToolEnvelope(result, newMessages = [], options = {}) {
    return {
        [TOOL_ENVELOPE_MARKER]: true,
        result,
        newMessages: Array.isArray(newMessages) ? newMessages.filter(isValidNewMessage) : [],
        ...(options.explicitSuccess === true ? { explicitSuccess: true } : {}),
    };
}

/**
 * Split a tool return value into `{ result, newMessages, explicitSuccess }`.
 *   - legacy string/object → { result: value, newMessages: [], explicitSuccess: false }
 *   - envelope             → { result, newMessages } (newMessages validated)
 */
export function normalizeToolEnvelope(value) {
    if (isToolEnvelope(value)) {
        const newMessages = Array.isArray(value.newMessages)
            ? value.newMessages.filter(isValidNewMessage)
            : [];
        return { result: value.result, newMessages, explicitSuccess: value.explicitSuccess === true };
    }
    return { result: value, newMessages: [], explicitSuccess: false };
}
