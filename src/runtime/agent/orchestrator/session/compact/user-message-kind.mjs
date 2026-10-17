// Classification of role:'user' messages: the human's own instruction versus
// compact summaries and runtime-injected turns. Import-light on purpose (no
// context-utils graph) so the session store can count real human turns;
// compact/messages.mjs re-exports everything here.
import { SUMMARY_PREFIX_ANCHOR } from './summary-anchor.mjs';
import { isImportedMessage } from '../imported-message.mjs';
import {
  isInternalRuntimeNotificationText,
  isModelVisibleToolCompletionWrapper,
} from '../../../../shared/tool-execution-contract.mjs';

// A compact summary message is a synthetic role:'user' message carrying the
// SUMMARY_PREFIX anchor. It is NOT a real user turn: it must be excluded from
// real user-turn boundary calculations and treated as merge input, otherwise
// an old summary can sit in the preserved tail as a live user message,
// duplicate, or fail to merge across repeated compaction.
export function isSummaryMessage(m) {
  return (
    m?.role === 'user' &&
    !isImportedMessage(m) &&
    (String(m?.meta?.source || '') === 'compact-summary' ||
      (typeof m.content === 'string' &&
        m.content.startsWith(SUMMARY_PREFIX_ANCHOR) &&
        /\nmessages=\d+\s+(?:sha256=|compact_type=)/.test(m.content)))
  );
}

export function isProtectedContextUserMessage(m) {
  if (m?.role !== 'user' || typeof m.content !== 'string' || isImportedMessage(m)) return false;
  let content = m.content.trim();
  if (!content.toLowerCase().startsWith('<system-reminder>')) return false;
  const closingTag = '</system-reminder>';
  // A runtime turn may carry several reminders (Goal, clock, tool delta).
  // Only text outside those envelopes is a human instruction. Keep this
  // compatible with stored turns that predate explicit source metadata.
  while (content.toLowerCase().startsWith('<system-reminder>')) {
    const closingIndex = content.toLowerCase().indexOf(closingTag);
    if (closingIndex < 0) return true;
    content = content.slice(closingIndex + closingTag.length).trim();
  }
  return content === '';
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
  if (m?.role !== 'user' || isImportedMessage(m)) return false;
  if (m.meta === 'skill') return true;
  return typeof m.content === 'string' && m.content.trimStart().startsWith('<skill>');
}

const CONTEXT_ACK_SOURCE = 'context-ack';

/** The assistant `.` that closes an injected context turn (compact summary,
 *  reminder, reference files) so the next prompt stays its own message. It is
 *  model context only and never displayed. */
export function contextAckMessage() {
  return { role: 'assistant', content: '.', meta: { source: CONTEXT_ACK_SOURCE } };
}

/** Whether `message` is a context ack: marked, or (stored before the marker
 *  existed) a bare `.` right after injected context (`previous`). */
export function isContextAckMessage(message, previous = null) {
  if (
    message?.role !== 'assistant' ||
    typeof message.content !== 'string' ||
    message.content.trim() !== '.' ||
    Array.isArray(message.toolCalls)
  ) {
    return false;
  }
  if (message.meta?.source === CONTEXT_ACK_SOURCE) return true;
  return (
    isSummaryMessage(previous) ||
    isProtectedContextUserMessage(previous) ||
    (previous?.role === 'user' && /^Reference files:\s*/i.test(userMessageText(previous).trimStart()))
  );
}

const SYNTHETIC_USER_SOURCES = new Set([
  'goal-continuation',
  'goal-closeout',
  'compact-context',
  'compact-active-turn-continuation',
  'compact-execution-recovery',
  'max-output-recovery',
  'refusal-recovery',
  'stream-cut-recovery',
]);
const SYNTHETIC_USER_CONTROL_RE =
  /^(?:\[mixdog-runtime\]|\[request interrupted(?: by user(?: for tool use)?| by process restart)?\])(?:\s|$)/i;

function userMessageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((block) => (typeof block === 'string' ? block : block?.text || '')).join('');
}

export function isActualUserInstructionMessage(message) {
  if (
    message?.role !== 'user' ||
    isSummaryMessage(message) ||
    isProtectedContextUserMessage(message) ||
    isInjectedSkillBodyMessage(message)
  ) {
    return false;
  }
  const text = userMessageText(message);
  // Imported prose is the user's own words whatever it looks like.
  if (isImportedMessage(message)) return text.trim().length > 0;
  if (/^Reference files:\s*/i.test(text.trimStart())) return false;
  if (
    SYNTHETIC_USER_CONTROL_RE.test(text.trimStart()) ||
    isInternalRuntimeNotificationText(text) ||
    isModelVisibleToolCompletionWrapper(text) ||
    SYNTHETIC_USER_SOURCES.has(String(message?.meta?.source || ''))
  ) {
    return false;
  }
  return text.trim().length > 0 || (Array.isArray(message.content) && message.content.length > 0);
}

// Control rows the runtime writes as user turns when a turn is cut short.
// isActualUserInstructionMessage deliberately keeps treating "[truncated]" as
// an instruction (compaction tail selection depends on it), so the real-turn
// predicate below recognizes it on its own.
const CONTROL_MARKER_RE = /^\[(?:truncated|request interrupted(?: by user(?: for tool use)?| by process restart)?)\]$/i;

/** Whether a message stands for real human conversation: a compact summary
 *  (it replaced earlier human turns), imported prose, or the user's own
 *  instruction without runtime provenance (`meta.source`/`meta.synthetic`,
 *  `internal`/`synthetic` flags) or a recognized control marker. Used to tell
 *  a real conversation from a synthetic-only transcript in catalog rows. */
export function isRealTurnMessage(message) {
  if (isSummaryMessage(message)) return true;
  if (!isActualUserInstructionMessage(message)) return false;
  if (isImportedMessage(message)) return true;
  if (message.internal === true || message.synthetic === true) return false;
  const meta = message.meta;
  if (meta && typeof meta === 'object' && (meta.synthetic === true || meta.source)) return false;
  return !CONTROL_MARKER_RE.test(userMessageText(message).trim());
}
