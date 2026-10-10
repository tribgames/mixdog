// Pure pre-turn extraction of the previous human request and the assistant
// text around it, from the session history as it stands BEFORE the current
// turn is committed (the boundary resolveTurnAutoEffort runs at). Nothing here
// reads the current prompt's outcome; nothing is mutated; no text is matched
// against word lists. Ownership comes only from typed provenance that the
// runtime already writes (meta.runtimeUserContext, meta.synthetic, meta.source,
// the compaction/skill/reminder predicates in compact/messages.mjs).
//
// Result of previousHumanContext(messages, { retryPrompt }):
//   {
//     version: 1,
//     boundary: number,          // messages[0..boundary) were considered
//     retryTrimmedIndex: number, // index of the unanswered resubmitted prompt
//                                // dropped from the view, or -1
//     prevHuman: { text, index, source, runtimeContext } | null,
//         // latest actual human message before the boundary. `text` is the
//         // runtime-context-stripped, trimmed text (untruncated). `source` is
//         // meta.source or null ('steering' = a human interjection).
//         // `runtimeContext` is 'stripped' | 'none'.
//     prevHumanMissing: 'empty-history' | 'no-human-request' | null,
//     canonicalReply: { text, index } | null,
//         // exactly what the shipped rp `prev` is: the latest non-empty
//         // assistant message before the boundary, whatever turn it is from.
//     pairedReply: { text, index } | null,
//         // latest non-empty assistant text inside prevHuman's own turn span
//         // (after prevHuman up to the next human message / boundary). Never
//         // falls back to another turn: a tool-only or unanswered turn gives
//         // null with pairedMissing set.
//     pairedMissing: 'no-human-request' | 'no-assistant-text-in-turn' | null,
//     replyIsPaired: boolean,    // canonicalReply and pairedReply are the same message
//     skipped: [{ index, role, reason }], // user messages passed over after
//         // prevHuman's search began (newest first); reasons: 'summary',
//         // 'protected-context', 'skill-body', 'synthetic-flag',
//         // 'typed-source', 'runtime-owned', 'empty'.
//   }
//
// Policy decisions (PREVIOUS_HUMAN_POLICY):
//   synthetic    meta.synthetic === true, or a source the runtime stores as
//                "not the user speaking" (task-notification, skill-context),
//                or anything isActualUserInstructionMessage rejects
//                (goal-continuation/closeout, compact-*, *-recovery, control
//                lines), is skipped, not treated as a request.
//   steering     meta.source === 'steering' is a human interjection (the
//                provider layer keeps it as its own user turn for that
//                reason) and counts as a human request.
//   retry        when retryPrompt repeats the trailing unanswered user prompt
//                (trailingUnansweredPromptIndex), that stale copy is excluded
//                so the prompt is never its own "previous request".
//   summary      compact summaries are skipped; nothing before them is
//                recovered, so history truncated by compaction yields
//                'no-human-request' rather than a guess.
// Limitation: user messages stored without meta (old transcripts) cannot be
// told apart from the human when a runtime wrapper was never recorded; they
// are accepted as human, and a wrapper with stale provenance stays unstripped.
import { stripRuntimeUserContext } from '../agent/orchestrator/session/runtime-user-context.mjs';
import {
  isActualUserInstructionMessage,
  isInjectedSkillBodyMessage,
  isProtectedContextUserMessage,
  isSummaryMessage,
} from '../agent/orchestrator/session/compact/messages.mjs';
import { trailingUnansweredPromptIndex } from '../agent/orchestrator/session/manager/failed-turn-rewind.mjs';
import { promptContentText } from '../agent/orchestrator/session/manager/prompt-utils.mjs';

export const PREVIOUS_HUMAN_POLICY = Object.freeze({
  synthetic: 'skip',
  steering: 'human',
  retry: 'exclude-trailing-unanswered-copy',
  summary: 'skip-no-recovery',
});

const TYPED_NON_HUMAN_SOURCES = new Set(['task-notification', 'skill-context']);

const textOf = (message) => promptContentText(message?.content).trim();

/** { human, reason?, message } for a user message; null for other roles. */
function classify(message) {
  if (message?.role !== 'user') return null;
  const stripped = stripRuntimeUserContext(message);
  const meta = stripped.meta && typeof stripped.meta === 'object' ? stripped.meta : {};
  const no = (reason) => ({ human: false, reason, message: stripped });
  if (isSummaryMessage(stripped)) return no('summary');
  if (isProtectedContextUserMessage(stripped)) return no('protected-context');
  if (isInjectedSkillBodyMessage(stripped)) return no('skill-body');
  if (meta.synthetic === true) return no('synthetic-flag');
  if (TYPED_NON_HUMAN_SOURCES.has(String(meta.source || ''))) return no('typed-source');
  if (!isActualUserInstructionMessage(stripped)) return no('runtime-owned');
  if (!textOf(stripped)) return no('empty');
  return { human: true, message: stripped, stripped: stripped !== message };
}

function latestAssistant(messages, from, to) {
  for (let index = to - 1; index >= from; index -= 1) {
    if (messages[index]?.role !== 'assistant') continue;
    const text = textOf(messages[index]);
    if (text) return { text, index };
  }
  return null;
}

export function previousHumanContext(messages, { retryPrompt } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const retryTrimmedIndex = retryPrompt == null ? -1 : trailingUnansweredPromptIndex(list, retryPrompt);
  const boundary = retryTrimmedIndex >= 0 ? retryTrimmedIndex : list.length;
  const verdicts = [];
  for (let index = 0; index < boundary; index += 1) verdicts.push(classify(list[index]));

  const skipped = [];
  let humanIndex = -1;
  for (let index = boundary - 1; index >= 0; index -= 1) {
    const verdict = verdicts[index];
    if (!verdict) continue;
    if (verdict.human) {
      humanIndex = index;
      break;
    }
    skipped.push({ index, role: 'user', reason: verdict.reason });
    // A summary replaces earlier conversational context; do not recover a
    // request from an older retained fragment behind that boundary.
    if (verdict.reason === 'summary') break;
  }

  const canonicalReply = latestAssistant(list, 0, boundary);
  let prevHuman = null;
  let pairedReply = null;
  let pairedMissing = 'no-human-request';
  if (humanIndex >= 0) {
    const verdict = verdicts[humanIndex];
    const source = verdict.message.meta?.source;
    prevHuman = {
      text: textOf(verdict.message),
      index: humanIndex,
      source: typeof source === 'string' && source ? source : null,
      runtimeContext: verdict.stripped ? 'stripped' : 'none',
    };
    let end = boundary;
    for (let index = humanIndex + 1; index < boundary; index += 1) {
      if (verdicts[index]?.human) {
        end = index;
        break;
      }
    }
    pairedReply = latestAssistant(list, humanIndex + 1, end);
    pairedMissing = pairedReply ? null : 'no-assistant-text-in-turn';
  }

  return {
    version: 1,
    boundary,
    retryTrimmedIndex,
    prevHuman,
    prevHumanMissing: prevHuman ? null : boundary === 0 ? 'empty-history' : 'no-human-request',
    canonicalReply,
    pairedReply,
    pairedMissing,
    replyIsPaired: Boolean(pairedReply && canonicalReply && pairedReply.index === canonicalReply.index),
    skipped,
  };
}
