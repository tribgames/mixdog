// Message classification, protected-context splitting, and summary-message
// construction helpers.
import { SUMMARY_PREFIX } from './constants.mjs';
import { sha16, roleCounts } from './text-utils.mjs';
import { carryMessageId, withoutMessageIdsReplacer } from '../message-ids.mjs';
import {
  contextAckMessage,
  isActualUserInstructionMessage,
  isInjectedSkillBodyMessage,
  isProtectedContextUserMessage,
  isSummaryMessage,
} from './user-message-kind.mjs';
import { CONTROL_MARKER_RE } from '../../../../shared/tool-execution-contract.mjs';

export function compactHeader(oldHistory) {
  // Stable display ids are bookkeeping, not conversation: the header names
  // the same history whether or not its messages were stamped.
  const encoded = JSON.stringify(oldHistory ?? [], withoutMessageIdsReplacer);
  return [
    SUMMARY_PREFIX,
    `messages=${oldHistory.length} sha256=${sha16(encoded)} roles=${roleCounts(oldHistory) || 'none'}`,
  ];
}

export function makeSummaryMessage(content) {
  return { role: 'user', content, meta: { source: 'compact-summary' } };
}

// User-message classification lives in the import-light user-message-kind.mjs
// (the session store counts real turns with it); re-exported for callers.
export {
  contextAckMessage,
  isActualUserInstructionMessage,
  isInjectedSkillBodyMessage,
  isProtectedContextUserMessage,
  isSummaryMessage,
};

export function latestActualUserInstructionIndex(messages) {
  for (let index = (Array.isArray(messages) ? messages.length : 0) - 1; index >= 0; index -= 1) {
    if (isActualUserInstructionMessage(messages[index])) return index;
  }
  return -1;
}

// The user instruction that began the request `index` belongs to; a steering
// message continues the request instead of starting one.
export function requestStart(messages, index) {
  for (let i = index; i >= 0; i -= 1) {
    if (!isActualUserInstructionMessage(messages[i])) continue;
    if (messages[i]?.meta?.source !== 'steering') return i;
  }
  return latestActualUserInstructionIndex(messages.slice(0, index + 1));
}

// A tool call's arguments as an object, whether stored parsed or as JSON text.
export function callArguments(call) {
  let args = call?.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args && typeof args === 'object' ? args : {};
}

export function latestActualUserInstructionMessage(messages) {
  const index = latestActualUserInstructionIndex(messages);
  return index >= 0 ? { ...messages[index] } : null;
}

export function isProtectedContextAckMessage(m) {
  return (
    m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim() === '.' && !Array.isArray(m.toolCalls)
  );
}

// The text-only copy rule-only Compact keeps of an omitted tool-call turn.
// It is execution, not a final reply, though it no longer carries its calls.
export const EXECUTION_TEXT_SOURCE = 'compact-execution-text';

// Delivered task notifications (a background agent's or task's completion,
// stored as a role:'user' turn with source 'task-notification') the model has
// not answered yet: every one after the latest final assistant reply. They
// are turn input but neither a user instruction nor summarized conversation,
// so a Compact must carry them verbatim or the report is lost.
export function pendingTaskNotificationIndexes(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const pending = [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (
      message?.role === 'assistant' &&
      !message.toolCalls?.length &&
      !isProtectedContextAckMessage(message) &&
      message.meta?.source !== EXECUTION_TEXT_SOURCE
    ) {
      break;
    }
    if (message?.role === 'user' && message.meta?.source === 'task-notification') pending.unshift(index);
  }
  return pending;
}

// Runtime rows that are conversation, not instructions: task and channel
// notifications (answered or not), routine and task results posted into a
// home thread, and turn interruption markers. Rule-only Compact keeps them
// with the dialogue; the summary reads them as data.
const CONVERSATION_RUNTIME_SOURCES = new Set(['task-notification', 'schedule-result']);

export function isCompactConversationRow(message) {
  if (message?.role !== 'user') return false;
  if (CONVERSATION_RUNTIME_SOURCES.has(String(message.meta?.source || ''))) return true;
  return (
    typeof message.content === 'string' &&
    CONTROL_MARKER_RE.test(message.content.trim()) &&
    !isActualUserInstructionMessage(message)
  );
}

function referenceFilesManifestMessage(message) {
  if (message?.role !== 'user' || typeof message.content !== 'string') return null;
  const text = message.content.trimStart();
  if (!/^Reference files:\s*/i.test(text)) return null;
  const paths = [...text.matchAll(/^###\s+(.+?)\s*$/gm)].map((match) => String(match[1] || '').trim()).filter(Boolean);
  if (paths.length === 0) return null;
  const uniquePaths = [...new Set(paths)];
  // The manifest rewrites the reference-files message: it keeps that id.
  return carryMessageId(
    {
      role: 'user',
      content: [
        '<system-reminder>',
        '# Reference files',
        'These files were attached when the session started. Re-read a path when its current contents are needed; the original bodies are not re-injected after Compact.',
        ...uniquePaths.map((path) => `- ${path}`),
        '</system-reminder>',
      ].join('\n'),
    },
    message
  );
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
