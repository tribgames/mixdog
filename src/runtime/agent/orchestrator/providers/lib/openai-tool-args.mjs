export function truncatedCompatStreamError(label, detail) {
    return Object.assign(
        new Error(`${label} SSE stream truncated${detail ? `: ${detail}` : ''}`),
        { name: 'TruncatedStreamError', code: 'TRUNCATED_STREAM', truncatedStream: true },
    );
}

// Invalid-tool-args marker: completed-but-malformed tool_call arguments JSON must NOT throw
// (kills the turn) NOR be silently swallowed to `{}`. Instead the parse
// failure is carried as data on the tool call's `arguments` slot so the
// dispatch loop can turn it into an is_error tool_result and let the model
// re-issue the call with valid JSON in the SAME turn (follow-up retry).
//   { __invalidToolArgs: true, __rawArguments: <raw string>, __parseError: <msg> }
export function makeInvalidToolArgsMarker(rawArguments, parseError) {
    return {
        __invalidToolArgs: true,
        __rawArguments: typeof rawArguments === 'string' ? rawArguments : String(rawArguments ?? ''),
        __parseError: typeof parseError === 'string' ? parseError : String(parseError ?? 'parse error'),
    };
}
export function isInvalidToolArgsMarker(value) {
    return !!value && typeof value === 'object' && value.__invalidToolArgs === true;
}
/** Model-facing tool_result text for a tool call whose arguments failed to
 * parse; instructs the model to retry with valid JSON in the same turn. */
export function formatInvalidToolArgsResult(call) {
    const name = call?.name || 'tool';
    const detail = call?.arguments?.__parseError || 'arguments were not valid JSON';
    return `The arguments provided to \`${name}\` are invalid JSON and could not be parsed: ${detail}. Re-issue this tool call with valid JSON arguments.`;
}

/** Completed tool_call.arguments must be valid JSON; empty/missing → {}.
 * @param {any} raw - raw arguments value (string or object)
 * @param {string} label - provider label for error messages
 * @param {{id?:string,name?:string,index?:number,finishReason?:string}} [meta] - optional tool-call identity for diagnostics.
 *   When `meta.finishReason` is set, a completion/finish signal was observed for
 *   the call: a JSON.parse failure is then deterministic bad JSON (permanent),
 *   not a mid-stream truncation (retryable). */
export function parseCompletedToolCallArgumentsJson(raw, label, meta) {
    const text = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
    const src = text === '' ? '{}' : text;
    try {
        return JSON.parse(src);
    } catch (err) {
        const preview = text.length <= 64
            ? text
            : text.slice(0, 32) + '...' + text.slice(-32);
        const detailParts = [`invalid tool_call arguments JSON: len=${text.length} preview=${JSON.stringify(preview)}`];
        if (meta) {
            const m = {};
            if (meta.id) m.id = meta.id;
            if (meta.name) m.name = meta.name;
            if (meta.index != null) m.index = meta.index;
            if (meta.finishReason) m.finishReason = meta.finishReason;
            detailParts.push(`tool=${JSON.stringify(m)}`);
        }
        // Invariant: a completion/finish signal was observed for this tool call
        // (finish_reason present, or a per-call/response "done" event fired), so
        // the arguments are NOT mid-stream-truncated — they are complete but
        // malformed. Return an invalid-args MARKER (not a throw) so the
        // dispatch loop feeds the parse error back to the model as a
        // tool_result and the model self-corrects in the same turn. Only an
        // unfinished stream (no finishReason) stays the retryable truncation
        // case — that transient behavior is deliberately preserved.
        if (meta?.finishReason) {
            return makeInvalidToolArgsMarker(text, err instanceof Error ? err.message : String(err));
        }
        throw truncatedCompatStreamError(label, detailParts.join(' '));
    }
}
