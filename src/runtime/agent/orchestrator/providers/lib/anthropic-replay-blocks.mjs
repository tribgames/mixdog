// Anthropic assistant-turn replay blocks: stream ordering, empty-text removal,
// and thinking-run integrity.
//
// The API enforces two rules that pull in opposite directions:
//   1. an empty `text` block anywhere in the request is rejected outright
//      ("messages: text content blocks must be non-empty"), so a streamed
//      empty text block can never be replayed; and
//   2. a run of CONSECUTIVE thinking blocks must be exactly a run the model
//      produced ("`thinking` or `redacted_thinking` blocks in the latest
//      assistant message cannot be modified").
//
// Dropping an empty text block that SEPARATED two thinking runs satisfies (1)
// and breaks (2): two runs of one become one run of two. That is a hard 400 on
// the next request, and since the merged turn is persisted every retry rebuilds
// the same body — the session is unusable until the turn is repaired.
//
// Measured against claude-opus-5 with a turn the model had streamed as
// [thinking, ""(text), thinking, text, tool_use x3]:
//   [t0, t1, text, tool_use…]        -> 400 (…content.1: cannot be modified)
//   [t0, text, tool_use…]            -> 200
//   [t1, text, tool_use…]            -> 200
//   [t0, ""(text), t1, text, …]      -> 400 (text blocks must be non-empty)
//   [t0, "."(text), t1, text, …]     -> 200
// So each run stays valid on its own; only the merge is rejected. Keeping the
// first run and dropping the blocks that would fuse onto it replays runs that
// are byte-identical to generated ones without inventing separator content.

const THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

export function isAnthropicThinkingBlock(block) {
    return THINKING_BLOCK_TYPES.has(block?.type);
}

export function isEmptyAnthropicTextBlock(block) {
    return block?.type === 'text'
        && (typeof block.text !== 'string' || block.text.length === 0);
}

/**
 * Reduce a stream-ordered assistant block list to the exact list that may be
 * replayed. Empty text blocks are removed (rule 1); a thinking block that would
 * only become adjacent to the previous thinking block BECAUSE of that removal
 * is removed too (rule 2). Thinking blocks the model really did emit
 * back-to-back are untouched — their run is already what it was.
 *
 * `onDrop(kind, block)` observes removals for logging; never throws upward.
 */
export function sanitizeAnthropicReplayBlocks(blocks, onDrop) {
    if (!Array.isArray(blocks)) return [];
    const out = [];
    // Whether an empty text block has been skipped since the last kept block:
    // the model put something between the neighbours, so they are not one run.
    let separatorRemoved = false;
    let lastKeptWasThinking = false;
    const note = (kind, block) => {
        if (typeof onDrop !== 'function') return;
        try { onDrop(kind, block); } catch { /* logging must never break replay */ }
    };
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (isEmptyAnthropicTextBlock(block)) {
            separatorRemoved = true;
            note('empty_text', block);
            continue;
        }
        if (isAnthropicThinkingBlock(block) && lastKeptWasThinking && separatorRemoved) {
            // Keeping this would advertise a two-block run the model never
            // produced. The run already in `out` stays intact.
            note('merged_thinking', block);
            continue;
        }
        out.push(block);
        lastKeptWasThinking = isAnthropicThinkingBlock(block);
        separatorRemoved = false;
    }
    return out;
}

/**
 * Same reduction for blocks still keyed by their provider content_block index
 * (the streaming parser's maps). Entries are [index, block] pairs.
 */
export function sanitizeAnthropicReplayEntries(entries, onDrop) {
    if (!Array.isArray(entries)) return [];
    const ordered = [...entries]
        .sort((a, b) => a[0] - b[0])
        .map(([, block]) => block);
    return sanitizeAnthropicReplayBlocks(ordered, onDrop);
}

/**
 * The thinking blocks that survive the same reduction, in stream order. The
 * flattened `thinkingBlocks` projection is replayed ahead of tool_use when a
 * turn carries no ordered block list, so it must honour the same run rule.
 */
export function sanitizeAnthropicThinkingRun(blocks, onDrop) {
    return sanitizeAnthropicReplayBlocks(blocks, onDrop).filter(isAnthropicThinkingBlock);
}
