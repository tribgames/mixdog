/**
 * src/tui/engine/queue-helpers.mjs - pure helpers for the prompt/notification
 * queue: priority ordering, entry visibility/editability, prompt content
 * flattening, session activity timestamps, and batch merging. Extracted from
 * engine.mjs.
 */
import {
  agentJobResultText,
  parseAgentJob,
  parseSyntheticAgentMessage,
} from './agent-envelope.mjs';

const QUEUE_PRIORITY = { now: 0, next: 1, later: 2 };

// Sentinel display text for a steering entry that is model-visible only: its
// immediate transcript ("Response …") card was already pushed at delivery time
// (live execution completion), so the mid-turn steering drain must NOT render a
// second card for it. drainPendingSteering emits this as the entry's display
// text; turn.mjs's onSteerMessage recognizes it and skips the push while the
// model still receives the entry's content.
export const STEERING_SUPPRESSED_DISPLAY = '\u0000mixdog:suppress-steer-display\u0000';

export function queuePriorityValue(value) {
  return QUEUE_PRIORITY[String(value || 'next')] ?? QUEUE_PRIORITY.next;
}

export function defaultQueuePriority(mode) {
  // Queue priority defaults:
  // - user/bashed prompt input defaults to `next`, so it can be attached at the
  //   next model-send boundary while a turn is active.
  // - task notifications default to `later`, unless the caller explicitly marks
  //   them urgent (e.g. interactive shell stall/completion).
  return mode === 'task-notification' ? 'later' : 'next';
}

export function isQueuedEntryEditable(entry) {
  const mode = entry?.mode || 'prompt';
  return mode !== 'task-notification' && mode !== 'pending-resume';
}

export function isQueuedEntryVisible(entry) {
  // state.queued drives the user-command wait list above the prompt. Background
  // task completions stay in the internal pending queue, but should never look
  // like commands typed by the user while they wait to be drained.
  const mode = entry?.mode || 'prompt';
  if (mode === 'pending-resume') return false;
  return isQueuedEntryEditable(entry);
}

export function isSlashQueuedEntry(entry) {
  if (entry?.skipSlashCommands) return false;
  const text = promptContentText(entry?.content ?? entry?.text ?? '');
  return text.trim().startsWith('/');
}

function firstQueueLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

export function shortTextFingerprint(text) {
  const value = String(text || '').trim();
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function notificationDisplayText(text) {
  const parsed = parseAgentJob(text);
  const result = agentJobResultText(text, parsed);
  const synthetic = parseSyntheticAgentMessage(text);
  return firstQueueLine(synthetic?.result || result || text) || 'agent notification';
}

export function promptContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text || '';
      if (part?.type === 'image') return '[Image]';
      if (part?.type === 'file') return '[File]';
      return part?.text || '';
    }).filter(Boolean).join('\n');
  }
  return String(content ?? '');
}

function timestampMs(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasModelVisibleConversation(session) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  return messages.some((message) => {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') return false;
    const text = promptContentText(message.content).trim();
    if (role === 'user' && text.startsWith('<system-reminder>')) return false;
    if (role === 'assistant' && text === '.' && !Array.isArray(message.toolCalls)) return false;
    return !!text || role === 'assistant' || role === 'tool';
  });
}

export function sessionActivityTimestamp(session, fallback = 0) {
  if (!hasModelVisibleConversation(session)) return 0;
  return timestampMs(session?.lastUsedAt)
    || timestampMs(session?.updatedAt)
    || timestampMs(fallback);
}

export function promptDisplayText(content, options = {}) {
  if (typeof options.displayText === 'string') return options.displayText;
  return promptContentText(content);
}

export function mergePromptContents(entries) {
  const batch = Array.isArray(entries) ? entries : [];
  if (batch.every((entry) => typeof entry?.content === 'string')) {
    return batch.map((entry) => entry.content).filter((text) => String(text || '').trim()).join('\n');
  }
  const parts = [];
  for (const entry of batch) {
    const content = entry?.content;
    if (typeof content === 'string') {
      if (content.trim()) parts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      parts.push(...content);
    }
    parts.push({ type: 'text', text: '\n' });
  }
  while (parts.length && parts[parts.length - 1]?.type === 'text' && parts[parts.length - 1]?.text === '\n') parts.pop();
  return parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts;
}

export function mergePastedImages(entries) {
  const out = {};
  for (const entry of entries || []) {
    const images = entry?.pastedImages;
    if (!images || typeof images !== 'object') continue;
    for (const [id, image] of Object.entries(images)) {
      if (image) out[id] = image;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Byte-free image metadata for the user transcript item. The prompt content
// keeps the full base64 payload for the provider send; transcript items (and
// therefore desktop snapshots published on every update) carry only
// name/mime/size so previews can render without bloating state.
export function promptContentImageMeta(content, pastedImages) {
  const parts = Array.isArray(content) ? content.filter((part) => part?.type === 'image') : [];
  if (parts.length === 0) return null;
  const named = pastedImages && typeof pastedImages === 'object' ? Object.values(pastedImages) : [];
  return parts.map((part, index) => {
    const meta = named[index] && typeof named[index] === 'object' ? named[index] : null;
    const data = typeof part.data === 'string'
      ? part.data
      : (typeof part.content === 'string' ? part.content : '');
    return {
      id: meta?.id ?? null,
      name: String(meta?.filename || `Image ${index + 1}`),
      mimeType: String(part.mimeType || part.mediaType || meta?.mediaType || 'image/png'),
      bytes: data.length,
    };
  });
}

export function mergePastedTexts(entries) {
  const out = {};
  for (const entry of entries || []) {
    const texts = entry?.pastedTexts;
    if (!texts || typeof texts !== 'object') continue;
    for (const [id, text] of Object.entries(texts)) {
      if (text) out[id] = text;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function callCommitCallbacks(entries) {
  for (const entry of entries || []) {
    try { entry?.onCommitted?.(); } catch {}
  }
}
