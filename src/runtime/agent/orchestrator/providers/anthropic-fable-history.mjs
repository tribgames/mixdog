const FABLE_51_BATCHING_GUIDANCE = 'Privately identify all independent next actions, then request them together in this response.';
const TURN_SCOPED = 'next_user_message';

function toolResultIds(message) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) return [];
    return message.content
        .filter(block => block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
        .map(block => block.tool_use_id);
}

// The request-only reminder is not stored as a transcript row. Persist its
// scope with the response it produced, including partial responses, so replay
// can reconstruct that prefix without changing older signed conversations.
export function withFable51BatchingContext(replay, body) {
    if (!replay || replay.provider !== 'anthropic' || !usesFable51PromptBundle(body?.model)) return replay;
    const tail = body.messages?.at(-1);
    if (tail?.role !== 'system' || tail.clear_at !== TURN_SCOPED
        || tail.content !== FABLE_51_BATCHING_GUIDANCE) return replay;
    const ids = toolResultIds(body.messages.at(-2));
    if (!ids.length) return replay;
    return {
        ...replay,
        requestContext: {
            ...replay.requestContext,
            fable51Batching: { version: 1, toolResultIds: ids },
        },
    };
}

function scopedResultIds(history) {
    const ids = new Set();
    for (const message of history) {
        const replay = message?.providerReplay;
        const context = replay?.requestContext?.fable51Batching;
        if (message?.role !== 'assistant' || replay?.provider !== 'anthropic'
            || context?.version !== 1 || !Array.isArray(context.toolResultIds)) continue;
        for (const id of context.toolResultIds) {
            if (typeof id === 'string') ids.add(id);
        }
    }
    return ids;
}

export function usesFable51PromptBundle(model) {
    const id = String(model || '').toLowerCase().replace(/\./g, '-');
    return /^claude-fable-5-1(?:$|[-@])/.test(id);
}

// Rebuild each request-only boundary at its original place, not just at the
// latest tool result. Later signed thinking is bound to that earlier prefix.
export function appendFable51BatchingGuidance(messages, model, history = []) {
    if (!usesFable51PromptBundle(model) || !Array.isArray(messages)) return false;
    const scopedIds = scopedResultIds(history);
    let changed = false;
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const next = messages[index + 1];
        const followsToolResult = message?.role === 'user'
            && Array.isArray(message.content)
            && message.content.some(block => block?.type === 'tool_result');
        // A user interjection before the next assistant response takes
        // precedence. An already-present system boundary must not be doubled.
        if (!followsToolResult || (next && next.role !== 'assistant')) continue;
        // Unmarked historical responses predate turn-scoped reminders. Keep
        // those boundaries byte-identical; only new or recorded scopes expire.
        const ids = toolResultIds(message);
        const scoped = !next || (ids.length > 0 && ids.every(id => scopedIds.has(id)));
        messages.splice(index + 1, 0, {
            role: 'system',
            content: FABLE_51_BATCHING_GUIDANCE,
            ...(scoped ? { clear_at: TURN_SCOPED } : {}),
        });
        index += 1;
        changed = true;
    }
    return changed;
}
