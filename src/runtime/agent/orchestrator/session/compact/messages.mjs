// Message classification, protected-context splitting, and summary-message
// construction helpers.
import { SUMMARY_PREFIX } from './constants.mjs';
import { sha16, roleCounts } from './text-utils.mjs';
import { carryMessageId, withoutMessageIdsReplacer } from '../message-ids.mjs';
import {
  isActualUserInstructionMessage,
  isInjectedSkillBodyMessage,
  isProtectedContextUserMessage,
  isSummaryMessage,
} from './user-message-kind.mjs';

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

export function latestActualUserInstructionMessage(messages) {
  const index = latestActualUserInstructionIndex(messages);
  return index >= 0 ? { ...messages[index] } : null;
}

export function isProtectedContextAckMessage(m) {
  return (
    m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim() === '.' && !Array.isArray(m.toolCalls)
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
