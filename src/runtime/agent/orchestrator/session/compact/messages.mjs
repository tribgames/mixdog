// Message classification, protected-context splitting, and summary-message
// construction helpers. Extracted verbatim from compact.mjs
// (behavior-preserving).
import { SUMMARY_PREFIX } from './constants.mjs';
import { sha16, roleCounts } from './text-utils.mjs';

export function compactHeader(oldHistory) {
    const encoded = JSON.stringify(oldHistory ?? []);
    return [
        SUMMARY_PREFIX,
        `messages=${oldHistory.length} sha256=${sha16(encoded)} roles=${roleCounts(oldHistory) || 'none'}`,
    ];
}

export function makeSummaryMessage(content) {
    return { role: 'user', content };
}

// A compact summary message is a synthetic role:'user' message carrying the
// SUMMARY_PREFIX anchor. It is NOT a real user turn: it must be excluded from
// real user-turn boundary calculations and treated as merge input, otherwise
// an old summary can sit in the preserved tail as a live user message,
// duplicate, or fail to merge across repeated compaction.
export function isSummaryMessage(m) {
    return m?.role === 'user'
        && typeof m.content === 'string'
        && m.content.startsWith(SUMMARY_PREFIX);
}

export function isProtectedContextUserMessage(m) {
    if (m?.role !== 'user' || typeof m.content !== 'string') return false;
    return m.content.trimStart().startsWith('<system-reminder>');
}

// An injected Skill-body user message (the general newMessages channel carries
// the full SKILL.md body as a role:'user' message after the Skill tool_result).
// Like isSummaryMessage / isProtectedContextUserMessage, it is detected by
// content prefix (the `<skill>` envelope from buildSkillResultEnvelope) so the
// check survives even if the synthetic `meta` field is dropped during a tail
// rebuild. It is NOT the human's latest prompt and must be excluded from
// "latest human request" selection (deriveCurrentRequest /
// buildRecallFastTrackQuery). The `meta:'skill'` marker is also honoured.
export function isInjectedSkillBodyMessage(m) {
    if (m?.role !== 'user') return false;
    if (m.meta === 'skill') return true;
    return typeof m.content === 'string' && m.content.trimStart().startsWith('<skill>');
}

export function isProtectedContextAckMessage(m) {
    return m?.role === 'assistant'
        && typeof m.content === 'string'
        && m.content.trim() === '.'
        && !Array.isArray(m.toolCalls);
}

export function splitProtectedContext(messages) {
    const protectedPrefix = [];
    const conversation = [];
    let prefixMode = true;
    let previousWasProtectedContext = false;
    for (const m of messages || []) {
        if (m?.role === 'system') {
            protectedPrefix.push(m);
            previousWasProtectedContext = false;
            continue;
        }
        if (prefixMode && isProtectedContextUserMessage(m)) {
            protectedPrefix.push(m);
            previousWasProtectedContext = true;
            continue;
        }
        if (prefixMode && previousWasProtectedContext && isProtectedContextAckMessage(m)) {
            protectedPrefix.push(m);
            previousWasProtectedContext = false;
            continue;
        }
        prefixMode = false;
        previousWasProtectedContext = false;
        conversation.push(m);
    }
    return { protectedPrefix, conversation };
}
