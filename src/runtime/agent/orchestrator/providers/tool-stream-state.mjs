/**
 * tool-stream-state.mjs — shared active tool-item / alias tracking and the
 * complete-tool early-settle predicate for the OpenAI Responses stream
 * consumers.
 *
 * Extracted verbatim (no behavior change) from openai-ws-stream.mjs, where the
 * activeToolItems Set + activeToolAliases Map (id/call_id/fallback-key alias
 * union) and the hasCompleteToolCall gate were WS-local closures. Kept as a
 * plain factory + pure predicate so any Responses-shaped stream can reuse the
 * same lifecycle-tracking semantics.
 */

/**
 * Per-stream active tool-item tracker. Tracks in-flight function/custom/
 * tool_search items by every key they surface under (id, call_id, and any
 * fallback item_id from delta frames), unioning aliases so a mark under one key
 * and a clear under another still resolve to the same item.
 */
export function createActiveToolItemTracker() {
    const activeToolItems = new Set();
    const activeToolAliases = new Map();
    const activeToolKeys = (item, fallback = '') => {
        const keys = [];
        const add = (value) => {
            const key = String(value || '');
            if (key && !keys.includes(key)) keys.push(key);
        };
        add(fallback);
        add(item?.id);
        add(item?.call_id);
        return keys;
    };
    const mark = (item, fallback = '') => {
        const keys = new Set(activeToolKeys(item, fallback));
        for (const key of [...keys]) {
            const aliases = activeToolAliases.get(key);
            if (aliases) for (const alias of aliases) keys.add(alias);
        }
        for (const key of keys) {
            activeToolItems.add(key);
            activeToolAliases.set(key, new Set(keys));
        }
    };
    const clear = (item, fallback = '') => {
        const keys = new Set(activeToolKeys(item, fallback));
        for (const key of [...keys]) {
            const aliases = activeToolAliases.get(key);
            if (aliases) for (const alias of aliases) keys.add(alias);
        }
        for (const key of keys) {
            activeToolItems.delete(key);
            activeToolAliases.delete(key);
        }
    };
    return {
        items: activeToolItems,
        aliases: activeToolAliases,
        keys: activeToolKeys,
        mark,
        clear,
    };
}

/**
 * Early tool-call settle predicate. True only when a fully-formed tool call
 * (real id + name, not a deferred salvage placeholder) is captured and no tool
 * work is still in flight — pendingCalls drained, no active lifecycle item, and
 * the in-flight latch cleared. Callers pass the current sizes/flag rather than
 * the live collections so the check stays a pure snapshot.
 */
export function hasCompleteToolCall({ toolCalls, pendingSize, activeSize, toolInFlight }) {
    return toolCalls.length > 0
        && pendingSize === 0
        && activeSize === 0
        && toolInFlight !== true
        && !toolCalls.some((t) => t && t._deferred)
        && toolCalls.every((t) => t && t.id && t.name);
}
