// Recovery for an assistant turn whose stored replay blocks the API refuses.
//
// Anthropic validates the LATEST assistant message of every request: its
// consecutive thinking/redacted_thinking blocks must be exactly what the model
// produced, and no text block may be empty. A turn that violates either rule is
// rejected deterministically — and because the turn is already persisted, every
// retry rebuilds the identical body, so the session is unusable for good. The
// parser no longer produces such a turn (providers/lib/anthropic-replay-blocks.mjs),
// but transcripts written by earlier builds still carry them, and any future
// wire shape we have not seen would wedge a session the same way.
//
// The repair is the one the API documents as safe: drop the opaque reasoning
// replay from that turn and keep its text and tool calls. Reasoning replay is
// an optimization; the turn's decisions live in the text/tool_use blocks.
import {
    isAnthropicThinkingBlock,
    isEmptyAnthropicTextBlock,
} from '../providers/lib/anthropic-replay-blocks.mjs';

function errorStatus(err) {
    return Number(err?.httpStatus || err?.status || err?.response?.status || 0) || 0;
}

function errorText(err) {
    const detail = err?.providerError || err?.responseFailed?.response?.error || null;
    return `${detail?.message || ''} ${err?.message || ''}`;
}

/**
 * True for the deterministic 400s that a replay repair can actually clear.
 * "must start with a thinking block" is deliberately absent: stripping is the
 * wrong move there — that error asks for MORE reasoning replay, not less.
 */
export function isThinkingReplayRejection(err) {
    if (!err || typeof err !== 'object') return false;
    if (errorStatus(err) !== 400) return false;
    const text = errorText(err);
    return /blocks in the latest assistant message cannot be modified/i.test(text)
        || /text content blocks must be non-empty/i.test(text);
}

function keepsReplayBlock(block) {
    return !isAnthropicThinkingBlock(block) && !isEmptyAnthropicTextBlock(block);
}

function strippedList(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const kept = list.filter(keepsReplayBlock);
    return kept.length === list.length ? null : kept;
}

/**
 * Replay-free copy of one assistant message, or null when it carries nothing
 * the API could have objected to (so the failure is not this message's shape).
 */
export function assistantMessageWithoutThinkingReplay(message) {
    if (message?.role !== 'assistant') return null;
    const next = { ...message };
    let changed = false;

    const replayItems = Array.isArray(message.providerReplay?.items)
        ? strippedList(message.providerReplay.items)
        : null;
    if (replayItems) {
        changed = true;
        // An assistant turn whose ordered replay is now empty has nothing to
        // replay verbatim; the flattened content/toolCalls lowering takes over.
        if (replayItems.length) next.providerReplay = { ...message.providerReplay, items: replayItems };
        else delete next.providerReplay;
    }
    const assistantBlocks = strippedList(message.assistantBlocks);
    if (assistantBlocks) {
        changed = true;
        if (assistantBlocks.length) next.assistantBlocks = assistantBlocks;
        else delete next.assistantBlocks;
    }
    if (Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length) {
        changed = true;
        delete next.thinkingBlocks;
    }
    return changed ? next : null;
}

/** Whether any assistant turn still carries replay blocks a repair would drop. */
export function canRepairThinkingReplay(messages) {
    if (!Array.isArray(messages)) return false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;
        if (assistantMessageWithoutThinkingReplay(message)) return true;
    }
    return false;
}

/**
 * Repair the newest assistant turn that still carries reasoning replay, in
 * place, so the fix is persisted with the session and the turn cannot poison
 * any later request. Returns the repaired index, or -1 when nothing matched.
 */
export function repairThinkingReplayInPlace(messages) {
    if (!Array.isArray(messages)) return -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;
        const repaired = assistantMessageWithoutThinkingReplay(message);
        if (!repaired) continue;
        // Replace the reference (never edit in place): the session store's
        // delta writer only re-sends messages whose reference changed.
        messages[index] = repaired;
        return index;
    }
    return -1;
}
