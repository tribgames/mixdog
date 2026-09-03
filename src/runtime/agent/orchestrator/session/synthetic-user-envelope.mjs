// Wire-time envelope for synthetic role:'user' messages.
//
// The runtime persists compaction summaries, continuation nudges, recovery
// prompts, interruption markers, async task notifications, and injected
// context (Skill bodies, reference files) as ordinary role:'user' rows so the
// next model step can consume them. On the wire those rows are
// indistinguishable from the human's own words: every tool turn adds one or
// more English "user" messages, and language-sensitive models drift toward
// English for the pre-tool preamble even though the human writes Korean.
//
// This projection runs on the provider-bound copy only (never on the stored
// transcript) and wraps each synthetic user message in a fixed tag the system
// rules declare as runtime-authored. Real user instructions — including a
// human prompt that carries a <system-reminder> prefix — are left untouched,
// so the human's language signal stays the only unwrapped user voice.
import {
    isActualUserInstructionMessage,
    isInjectedSkillBodyMessage,
    isSummaryMessage,
} from './compact/messages.mjs';
import {
    ACTIVE_TURN_CONTINUATION_ANCHOR,
    ACTIVE_TURN_CONTINUATION_SOURCE,
} from './compact/continuation.mjs';

export const SYNTHETIC_USER_ENVELOPE_TAG = 'mixdog-runtime';

export const SYNTHETIC_USER_KINDS = Object.freeze({
    RUNTIME_CONTROL: 'runtime-control',
    COMPACT_STATE: 'compact-state',
    CONTEXT_ATTACHMENT: 'context-attachment',
});

const COMPACT_STATE_TEXT_RE =
    /^(?:A previous model worked on this task and produced the compacted handoff summary below\b|Re-attached after compaction\b)/i;
const CONTEXT_ATTACHMENT_TEXT_RE =
    /^(?:Reference files:\s|<(?:skill|memory-context|mcp-instructions|available-deferred-tools)\b)/i;
// Recovery rows that only carry their provenance in `meta`. Classification
// must survive a tail rebuild that drops meta, or the wire prefix (and the
// provider cache) would shift between two sends of the same transcript.
const RUNTIME_CONTROL_TEXT_RE =
    /^(?:Output token limit hit\.|\[mixdog-runtime\]|\[request interrupted\b|Async \S+ task \S+ \([^)]*\) finished\.)/i;
// `task-notification` is the structural mark a drained tool/agent completion
// carries (pending-messages mode → agent-loop / ask-session meta.source); the
// "Async … task … finished." text test below stays as the meta-less fallback.
const RUNTIME_CONTROL_SOURCES = new Set(['max-output-recovery', 'refusal-recovery', 'task-notification']);
const ENVELOPE_OPEN_RE = new RegExp(`^\\s*<${SYNTHETIC_USER_ENVELOPE_TAG}\\b`, 'i');

function messageText(message) {
    if (typeof message?.content === 'string') return message.content;
    if (!Array.isArray(message?.content)) return '';
    return message.content
        .map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? block.text || '' : ''))
        .join('');
}

function isAlreadyEnveloped(text) {
    return ENVELOPE_OPEN_RE.test(text);
}

// null => a real user instruction (or nothing to wrap); otherwise the kind.
export function classifySyntheticUserMessage(message) {
    if (message?.role !== 'user') return null;
    const text = messageText(message);
    if (!text.trim()) return null;
    if (isAlreadyEnveloped(text)) return null;
    const source = String(message?.meta?.source || '');
    const trimmed = text.trimStart();
    // Meta-only recovery rows read as plain prose once meta is gone; check
    // their text shape before the generic real-user test.
    if (RUNTIME_CONTROL_SOURCES.has(source) || RUNTIME_CONTROL_TEXT_RE.test(trimmed)) {
        return SYNTHETIC_USER_KINDS.RUNTIME_CONTROL;
    }
    if (isActualUserInstructionMessage(message)) return null;
    if (isSummaryMessage(message)
        || source === ACTIVE_TURN_CONTINUATION_SOURCE
        || text.includes(ACTIVE_TURN_CONTINUATION_ANCHOR)
        || COMPACT_STATE_TEXT_RE.test(trimmed)) {
        return SYNTHETIC_USER_KINDS.COMPACT_STATE;
    }
    if (isInjectedSkillBodyMessage(message) || CONTEXT_ATTACHMENT_TEXT_RE.test(trimmed)) {
        return SYNTHETIC_USER_KINDS.CONTEXT_ATTACHMENT;
    }
    return SYNTHETIC_USER_KINDS.RUNTIME_CONTROL;
}

function openTag(kind) {
    return `<${SYNTHETIC_USER_ENVELOPE_TAG} kind="${kind}">\n`;
}

function closeTag() {
    return `\n</${SYNTHETIC_USER_ENVELOPE_TAG}>`;
}

function envelopeContent(content, kind) {
    if (typeof content === 'string') return `${openTag(kind)}${content}${closeTag()}`;
    if (!Array.isArray(content)) return content;
    let first = -1;
    let last = -1;
    for (let index = 0; index < content.length; index += 1) {
        const block = content[index];
        const isText = typeof block === 'string' || block?.type === 'text';
        if (!isText) continue;
        if (first < 0) first = index;
        last = index;
    }
    if (first < 0) return content;
    return content.map((block, index) => {
        if (index !== first && index !== last) return block;
        const text = typeof block === 'string' ? block : block.text || '';
        const wrapped = `${index === first ? openTag(kind) : ''}${text}${index === last ? closeTag() : ''}`;
        return typeof block === 'string' ? wrapped : { ...block, text: wrapped };
    });
}

// Returns a new array; untouched messages keep their identity so downstream
// prefix guards and evidence projection see a stable transcript.
export function projectSyntheticUserEnvelopes(messages) {
    const stats = { wrapped: 0, byKind: {} };
    if (!Array.isArray(messages)) return { messages, stats };
    let changed = false;
    const projected = messages.map((message) => {
        const kind = classifySyntheticUserMessage(message);
        if (!kind) return message;
        const content = envelopeContent(message.content, kind);
        if (content === message.content) return message;
        changed = true;
        stats.wrapped += 1;
        stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
        return { ...message, content };
    });
    return { messages: changed ? projected : messages, stats };
}
