import { estimateMessagesTokens } from '../context-utils.mjs';
import { estimateTokens } from '../token-estimate.mjs';
import { persistToolResultArtifactSync } from '../tool-result-offload.mjs';
import {
  isActualUserInstructionMessage,
  isProtectedContextAckMessage,
  latestActualUserInstructionIndex,
} from './messages.mjs';

export const EXECUTION_RECOVERY_SOURCE = 'compact-execution-recovery';
const TOOL_HISTORY_CONTEXT_RATIO = 0.05;
const ARCHIVE_THRESHOLD_TOKENS = 512;

export function toolHistoryBudget(contextWindow) {
  const window = Number(contextWindow);
  return Number.isFinite(window) && window > 0 ? Math.floor(window * TOOL_HISTORY_CONTEXT_RATIO) : 0;
}

// Count arguments and provider replay as well as results. The serialized
// estimate is deliberately conservative for provider-specific opaque metadata.
// UI diffs never reach the model and must not displace execution evidence.
export function executionTokens(messages) {
  if (!messages.length) return 0;
  const budgetMessages = messages.map(({ uiDiff: _uiDiff, ...message }) => message);
  return Math.max(estimateMessagesTokens(budgetMessages), estimateTokens(JSON.stringify(budgetMessages)));
}

function requestStart(messages, index) {
  for (let i = index; i >= 0; i -= 1) {
    if (!isActualUserInstructionMessage(messages[i])) continue;
    if (messages[i]?.meta?.source !== 'steering') return i;
  }
  return latestActualUserInstructionIndex(messages.slice(0, index + 1));
}

// Each assistant tool-call turn with the tool results that directly follow it.
function executionGroups(messages) {
  const groups = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role !== 'assistant' || !message.toolCalls?.length) continue;
    const start = i;
    while (messages[i + 1]?.role === 'tool') i += 1;
    groups.push({ start, end: i + 1, messages: messages.slice(start, i + 1) });
  }
  return groups;
}

// Shrink levels, least evidence lost first. 1: large result bodies. 2: also
// the assistant's opaque replay: providerReplay (reasoning plus a duplicate of
// its calls) and legacy encrypted reasoningItems; every provider lowers
// content/toolCalls without them. 3: also large call arguments. Call ids,
// names, per-call metadata and small results stay verbatim, so every retained
// call keeps its paired result.
function shrinkGroup(group, archive, level) {
  const reference = (offset, what, id) =>
    `[${what} archived without interpretation: ${archive.path}; message index ${group.start + offset}; toolCallId=${id}.`;
  return group.messages.map((message, offset) => {
    if (message.role === 'tool') {
      if (executionTokens([message]) < ARCHIVE_THRESHOLD_TOKENS) return message;
      return {
        ...message,
        content: `${reference(offset, 'Tool result body', message.toolCallId)} Outcome must be read from the original result if needed.]`,
      };
    }
    if (level < 2) return message;
    const { providerReplay: _providerReplay, reasoningItems: _reasoningItems, ...rest } = message;
    if (level < 3) return rest;
    return {
      ...rest,
      toolCalls: message.toolCalls.map((call) =>
        estimateTokens(JSON.stringify(call.arguments ?? null)) < ARCHIVE_THRESHOLD_TOKENS
          ? call
          : { ...call, arguments: { archived: `${reference(offset, 'Tool call arguments', call.id)}]` } }
      ),
    };
  });
}

// Walk from the anchor: kept groups verbatim, user instructions, and the
// conversational assistant text the mode allows.
function assembleTail(messages, kept, { anchor, firstKept, preserveConversation }) {
  const tail = [];
  for (let i = Math.max(0, anchor); i < messages.length; i += 1) {
    const group = kept.get(i);
    if (group) {
      tail.push(...group.messages);
      i = group.end - 1;
      continue;
    }
    const message = messages[i];
    if (preserveConversation && message?.role === 'assistant' && !isProtectedContextAckMessage(message)) {
      // Omitted execution stays in the archive; its conversational text
      // remains verbatim without replaying an orphaned call or reasoning.
      if (message.toolCalls?.length) {
        if (message.content) tail.push({ role: 'assistant', content: message.content });
      } else {
        tail.push(message);
      }
      continue;
    }
    if (
      isActualUserInstructionMessage(message) ||
      (i >= firstKept && message?.role === 'assistant' && !message.toolCalls?.length)
    ) {
      tail.push(message);
    }
  }
  return tail;
}

export function buildExecutionTail(messages, { contextWindow, sessionId, preserveConversation = false } = {}) {
  const budget = toolHistoryBudget(contextWindow);
  const groups = executionGroups(messages);
  const previousRecovery = messages.filter((m) => m?.meta?.source === EXECUTION_RECOVERY_SOURCE);
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
    recovery = [
      {
        role: 'user',
        meta: { source: EXECUTION_RECOVERY_SOURCE, synthetic: true },
        content: `<system-reminder>\nSome execution history was omitted or shortened to fit the tool-history budget. This is not an instruction to repeat those calls. The original calls, outcomes, and earlier recovery references are available at ${archive.path} (sha256:${archive.sha256}). Read only missing evidence when needed.\n</system-reminder>`,
      },
    ];
  };
  const latestGroup = groups.at(-1);
  // Older groups only shed result bodies and are otherwise omitted. The
  // latest group is the state the session continues from, so it also sheds
  // replay and large arguments rather than refusing compaction forever.
  const keep = (group) => {
    const fits = (selected) => tokens + executionTokens(selected) + executionTokens(recovery) <= budget;
    let selected = group.messages;
    if (!fits(selected)) {
      ensureArchive();
      const levels = group === latestGroup ? [1, 2, 3] : [1];
      selected = null;
      for (const level of levels) {
        const shrunk = shrinkGroup(group, archive, level);
        if (fits(shrunk)) {
          selected = shrunk;
          break;
        }
      }
      if (!selected) return false;
    }
    kept.set(group.start, { ...group, messages: selected });
    tokens += executionTokens(selected);
    return true;
  };
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    if (!keep(groups[i])) break;
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
  // A displaced latest group is refit against the final reference.
  if (latestGroup && !kept.size) keep(latestGroup);
  if (groups.length && !kept.size) {
    throw new Error('compact: latest execution group cannot fit the tool-history budget; original context preserved');
  }
  const latest = latestActualUserInstructionIndex(messages);
  const firstKept = kept.size ? Math.min(...kept.keys()) : messages.length;
  const latestKept = latest < 0 ? firstKept : latest;
  const anchor = preserveConversation ? 0 : requestStart(messages, Math.min(firstKept, latestKept));
  const tail = assembleTail(messages, kept, { anchor, firstKept, preserveConversation });
  // With no execution to retain, keep the existing latest-request contract.
  if (!preserveConversation && !groups.length && !previousRecovery.length) {
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
