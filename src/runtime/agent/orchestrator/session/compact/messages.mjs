// Message classification, protected-context splitting, and summary-message
// construction helpers. Extracted verbatim from compact.mjs
// (behavior-preserving).
import { SUMMARY_PREFIX, SUMMARY_PREFIX_ANCHOR } from './constants.mjs';
import { sha16, roleCounts } from './text-utils.mjs';
import {
    isInternalRuntimeNotificationText,
    isModelVisibleToolCompletionWrapper,
} from '../../../../shared/tool-execution-contract.mjs';

export function compactHeader(oldHistory) {
    const encoded = JSON.stringify(oldHistory ?? []);
    return [
        SUMMARY_PREFIX,
        `messages=${oldHistory.length} sha256=${sha16(encoded)} roles=${roleCounts(oldHistory) || 'none'}`,
    ];
}

export function makeSummaryMessage(content) {
    return { role: 'user', content, meta: { source: 'compact-summary' } };
}

// A compact summary message is a synthetic role:'user' message carrying the
// SUMMARY_PREFIX anchor. It is NOT a real user turn: it must be excluded from
// real user-turn boundary calculations and treated as merge input, otherwise
// an old summary can sit in the preserved tail as a live user message,
// duplicate, or fail to merge across repeated compaction.
export function isSummaryMessage(m) {
    return m?.role === 'user'
        && (
            String(m?.meta?.source || '') === 'compact-summary'
            || (
                typeof m.content === 'string'
                && m.content.startsWith(SUMMARY_PREFIX_ANCHOR)
                && /\nmessages=\d+\s+(?:sha256=|compact_type=)/.test(m.content)
            )
        );
}

export function isProtectedContextUserMessage(m) {
    if (m?.role !== 'user' || typeof m.content !== 'string') return false;
    const content = m.content.trim();
    if (!content.toLowerCase().startsWith('<system-reminder>')) return false;
    const closingTag = '</system-reminder>';
    const closingIndex = content.toLowerCase().indexOf(closingTag);
    return closingIndex < 0
        || content.slice(closingIndex + closingTag.length).trim() === '';
}

// An injected Skill-body user message (the general newMessages channel carries
// the full SKILL.md body as a role:'user' message after the Skill tool_result).
// Like isSummaryMessage / isProtectedContextUserMessage, it is detected by
// content prefix (the `<skill>` envelope from buildSkillResultEnvelope) so the
// check survives even if the synthetic `meta` field is dropped during a tail
// rebuild. It is NOT the human's latest prompt and must be excluded from
// "latest human request" selection (deriveCurrentRequest). The `meta:'skill'`
// marker is also honoured.
export function isInjectedSkillBodyMessage(m) {
    if (m?.role !== 'user') return false;
    if (m.meta === 'skill') return true;
    return typeof m.content === 'string' && m.content.trimStart().startsWith('<skill>');
}

const SYNTHETIC_USER_SOURCES = new Set([
    'compact-active-turn-continuation',
    'max-output-recovery',
    'refusal-recovery',
]);
const SYNTHETIC_USER_CONTROL_RE =
    /^(?:\[mixdog-runtime\]|\[request interrupted(?: by user(?: for tool use)?| by process restart)?\])(?:\s|$)/i;

function userMessageText(message) {
    if (typeof message?.content === 'string') return message.content;
    if (!Array.isArray(message?.content)) return '';
    return message.content
        .map((block) => (typeof block === 'string' ? block : block?.text || ''))
        .join('');
}

export function isActualUserInstructionMessage(message) {
    if (message?.role !== 'user'
        || isSummaryMessage(message)
        || isProtectedContextUserMessage(message)
        || isInjectedSkillBodyMessage(message)) {
        return false;
    }
    const text = userMessageText(message);
    if (/^Reference files:\s*/i.test(text.trimStart())) return false;
    if (SYNTHETIC_USER_CONTROL_RE.test(text.trimStart())
        || isInternalRuntimeNotificationText(text)
        || isModelVisibleToolCompletionWrapper(text)
        || SYNTHETIC_USER_SOURCES.has(String(message?.meta?.source || ''))) {
        return false;
    }
    return text.trim().length > 0 || (Array.isArray(message.content) && message.content.length > 0);
}

export function latestActualUserInstructionIndex(messages) {
    for (let index = (Array.isArray(messages) ? messages.length : 0) - 1; index >= 0; index -= 1) {
        if (isActualUserInstructionMessage(messages[index])) return index;
    }
    return -1;
}

export function latestActualUserInstructionMessage(messages) {
    const index = latestActualUserInstructionIndex(messages);
    return index >= 0 ? { ...messages[index] } : null;
}

export function isProtectedContextAckMessage(m) {
    return m?.role === 'assistant'
        && typeof m.content === 'string'
        && m.content.trim() === '.'
        && !Array.isArray(m.toolCalls);
}

export function referenceFilesManifestMessage(message) {
    if (message?.role !== 'user' || typeof message.content !== 'string') return null;
    const text = message.content.trimStart();
    if (!/^Reference files:\s*/i.test(text)) return null;
    const paths = [...text.matchAll(/^###\s+(.+?)\s*$/gm)]
        .map((match) => String(match[1] || '').trim())
        .filter(Boolean);
    if (paths.length === 0) return null;
    const uniquePaths = [...new Set(paths)];
    return {
        role: 'user',
        content: [
            '<system-reminder>',
            '# Reference files',
            'These files were attached when the session started. Re-read a path when its current contents are needed; the original bodies are not re-injected after Compact.',
            ...uniquePaths.map((path) => `- ${path}`),
            '</system-reminder>',
        ].join('\n'),
    };
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
        if (prefixMode) {
            const manifest = referenceFilesManifestMessage(m);
            if (manifest) {
                protectedPrefix.push(manifest);
                previousWasProtectedContext = true;
                continue;
            }
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
