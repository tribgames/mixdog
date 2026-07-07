// Pre-provider transcript pairing repair, extracted from loop.mjs.
// Anthropic 400-rejects when an assistant message ends with tool_use blocks and
// the next message isn't tool results for those exact ids. abort/timeout/error
// races in the loop body can leave a dangling assistant tool_use at the tail;
// strip any trailing/orphaned tool_use|tool_result so provider.send sees a
// valid transcript instead of leaking the 400 to the user.
import { sanitizeToolPairs } from '../context-utils.mjs';
import { scrubCompactedPlaceholderToolCalls } from './stored-tool-args.mjs';

// Transcript pairing guard. Anthropic 400-rejects when an assistant message
// ends with tool_use blocks and the next message isn't tool results for
// those exact ids. abort/timeout/error race in the loop body can leave a
// dangling assistant tool_use at the tail (e.g. the structure_probe loop
// running 12 deep then aborting between push-assistant and push-tool).
// Strip any trailing assistant tool_use that has no matching tool result
// so provider.send sees a valid transcript instead of leaking the 400 to
// the user. Repair runs every iteration but is a no-op on healthy paths.
function _ensureTranscriptPairing(msgs, sessionId) {
    // Walk backwards to find the last assistant message that emitted
    // tool_use, then validate that every id has a matching tool result
    // inside the CONTIGUOUS tool-message block immediately following it.
    // Earlier guard splice'd the entire tail — which silently deleted any
    // user prompt appended after the dangling assistant by manager.mjs:
    // when the guard fired with shape
    //     [..., assistant{a,b}, tool{a}, user{new prompt}]
    // the splice removed user{new prompt} along with the orphan suffix.
    // Fix: remove only assistant + the contiguous tool block; preserve
    // anything past it (user / system / next assistant) untouched.
    let popped = 0;
    while (msgs.length > 0) {
        let lastAssistantIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m?.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
                lastAssistantIdx = i;
                break;
            }
        }
        if (lastAssistantIdx === -1) break;
        // Collect the contiguous tool messages directly after this assistant.
        // Anything past that block is unrelated (next user prompt, system
        // marker, etc.) and must survive the repair.
        let toolBlockEnd = lastAssistantIdx + 1;
        while (toolBlockEnd < msgs.length && msgs[toolBlockEnd]?.role === 'tool') {
            toolBlockEnd += 1;
        }
        const toolBlock = msgs.slice(lastAssistantIdx + 1, toolBlockEnd);
        const ids = msgs[lastAssistantIdx].toolCalls.map(c => c.id);
        const matched = ids.every(id => toolBlock.some(m => m.toolCallId === id));
        if (matched) break;
        const removed = toolBlockEnd - lastAssistantIdx;
        msgs.splice(lastAssistantIdx, removed);
        popped += removed;
    }
    // Second sweep — catch dangling tool results that survived the
    // contiguous-block splice. Anthropic strict spec requires every
    // tool result to sit in a contiguous block right after the
    // assistant whose toolCalls produced it; a `[..., assistant{a,b},
    // tool{a}, user, tool{b}]` shape leaves tool{b} orphaned even
    // after assistant + tool{a} are repaired by the loop above.
    // Walk back from each tool message to the nearest non-tool
    // ancestor; if it is not an assistant whose toolCalls include
    // this id, drop the orphan.
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role !== 'tool') continue;
        if (!m.toolCallId) {
            msgs.splice(i, 1);
            popped += 1;
            continue;
        }
        let prevIdx = i - 1;
        while (prevIdx >= 0 && msgs[prevIdx]?.role === 'tool') prevIdx--;
        const anchor = prevIdx >= 0 ? msgs[prevIdx] : null;
        const anchorOk = anchor?.role === 'assistant'
            && Array.isArray(anchor.toolCalls)
            && anchor.toolCalls.some(c => c.id === m.toolCallId);
        if (!anchorOk) {
            msgs.splice(i, 1);
            popped += 1;
        }
    }
    if (popped > 0 && sessionId) {
        try { process.stderr.write(`[transcript-repair] sess=${sessionId} popped=${popped} dangling assistant tool_use\n`); } catch {}
    }
}

/**
 * Pre-provider transcript repair for the agent loop. Reattach valid tool
 * results (non-destructive) before any destructive orphan pairing cleanup.
 * Mutates `messages` in place to preserve the session array reference.
 */
export function repairTranscriptBeforeProviderSend(messages, sessionId = null) {
    if (!Array.isArray(messages)) return messages;
    const sanitized = sanitizeToolPairs(messages);
    if (sanitized !== messages) {
        messages.length = 0;
        messages.push(...sanitized);
    }
    _ensureTranscriptPairing(messages, sessionId);
    // Pre-send invariant: no provider-visible assistant toolCall may carry a
    // compacted `[mixdog compacted …]` placeholder body that looks like
    // submittable patch input. Runs after pairing repair, still before send.
    scrubCompactedPlaceholderToolCalls(messages);
    return messages;
}
