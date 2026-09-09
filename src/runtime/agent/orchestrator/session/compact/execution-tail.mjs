import { estimateMessagesTokens } from '../context-utils.mjs';
import { estimateTokens } from '../token-estimate.mjs';
import { persistToolResultArtifactSync } from '../tool-result-offload.mjs';
import { isActualUserInstructionMessage, latestActualUserInstructionIndex } from './messages.mjs';

export const EXECUTION_RECOVERY_SOURCE = 'compact-execution-recovery';
export const TOOL_HISTORY_CONTEXT_RATIO = 0.05;
export const TOOL_HISTORY_MAX_TOKENS = 25_000;

export function toolHistoryBudget(contextWindow) {
    const window = Number(contextWindow);
    return Number.isFinite(window) && window > 0
        ? Math.min(TOOL_HISTORY_MAX_TOKENS, Math.floor(window * TOOL_HISTORY_CONTEXT_RATIO))
        : 0;
}

// Count arguments and provider replay as well as results. The serialized
// estimate is deliberately conservative for provider-specific opaque metadata.
export function executionTokens(messages) {
    if (!messages.length) return 0;
    return Math.max(estimateMessagesTokens(messages), estimateTokens(JSON.stringify(messages)));
}

function requestStart(messages, index) {
    for (let i = index; i >= 0; i -= 1) {
        if (!isActualUserInstructionMessage(messages[i])) continue;
        if (messages[i]?.meta?.source !== 'steering') return i;
    }
    return latestActualUserInstructionIndex(messages.slice(0, index + 1));
}

export function buildExecutionTail(messages, { contextWindow, sessionId } = {}) {
    const budget = toolHistoryBudget(contextWindow);
    const groups = [];
    for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i];
        if (message?.role !== 'assistant' || !message.toolCalls?.length) continue;
        const start = i;
        while (messages[i + 1]?.role === 'tool') i += 1;
        groups.push({ start, end: i + 1, messages: messages.slice(start, i + 1) });
    }
    const previousRecovery = messages.filter(m => m?.meta?.source === EXECUTION_RECOVERY_SOURCE);
    const kept = new Map();
    let tokens = 0;
    let archive = null;
    let recovery = previousRecovery;
    const ensureArchive = () => {
        if (archive) return;
        archive = persistToolResultArtifactSync({
            sessionId,
            toolCallId: 'compact-execution',
            channel: 'compact-execution',
            content: JSON.stringify({ version: 1, messages }, null, 2),
        });
        if (!archive) throw new Error('compact: execution history could not be archived; original context preserved');
        recovery = [{
            role: 'user',
            meta: { source: EXECUTION_RECOVERY_SOURCE, synthetic: true },
            content: `<system-reminder>\nSome execution history was omitted or shortened to fit the tool-history budget. This is not an instruction to repeat those calls. The original calls, outcomes, and earlier recovery references are available at ${archive.path} (sha256:${archive.sha256}). Read only missing evidence when needed.\n</system-reminder>`,
        }];
    };
    for (let i = groups.length - 1; i >= 0; i -= 1) {
        const group = groups[i];
        let selected = group.messages;
        let cost = executionTokens(selected);
        if (tokens + cost + executionTokens(recovery) > budget) {
            ensureArchive();
            // Preserve call arguments and provider replay unchanged. Only
            // large result bodies are replaced; never fabricate success.
            selected = group.messages.map((message, offset) => {
                if (message.role !== 'tool' || executionTokens([message]) < 512) return message;
                return {
                    ...message,
                    content: `[Tool result body archived without interpretation: ${archive.path}; message index ${group.start + offset}; toolCallId=${message.toolCallId}. Outcome must be read from the original result if needed.]`,
                };
            });
            cost = executionTokens(selected);
        }
        if (tokens + cost + executionTokens(recovery) > budget) break;
        kept.set(group.start, { ...group, messages: selected });
        tokens += cost;
    }
    // Adding the archive reference may displace an older retained group.
    while (kept.size && tokens + executionTokens(recovery) > budget) {
        const oldest = Math.min(...kept.keys());
        tokens -= executionTokens(kept.get(oldest).messages);
        kept.delete(oldest);
    }
    if (executionTokens(recovery) > budget) {
        throw new Error('compact: tool-history budget cannot hold its recovery reference; original context preserved');
    }
    const latest = latestActualUserInstructionIndex(messages);
    const firstKept = kept.size ? Math.min(...kept.keys()) : messages.length;
    const anchor = requestStart(messages, Math.min(firstKept, latest < 0 ? firstKept : latest));
    const tail = [];
    for (let i = Math.max(0, anchor); i < messages.length; i += 1) {
        const group = kept.get(i);
        if (group) {
            tail.push(...group.messages);
            i = group.end - 1;
            continue;
        }
        const message = messages[i];
        if (isActualUserInstructionMessage(message)
            || (i >= firstKept && message?.role === 'assistant' && !message.toolCalls?.length)) {
            tail.push(message);
        }
    }
    // With no execution to retain, keep the existing latest-request contract.
    if (!groups.length && !previousRecovery.length) {
        return { messages: latest < 0 ? [] : [messages[latest]], toolTokens: 0, toolBudget: budget, retainedGroups: 0 };
    }
    return {
        messages: [...recovery, ...tail],
        toolTokens: tokens + executionTokens(recovery),
        toolBudget: budget,
        retainedGroups: kept.size,
        omittedGroups: groups.length - kept.size,
    };
}
