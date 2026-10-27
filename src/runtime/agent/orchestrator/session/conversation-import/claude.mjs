/**
 * Claude Code project transcript (`projects/<dir>/<session>.jsonl`) → raw
 * import turns. The active branch is followed from the last main-chain entry
 * back through `parentUuid` (and `logicalParentUuid` across a compaction), so
 * replayed or abandoned branches never duplicate. Kept: text blocks and
 * `tool_use` as `[ran tool: <name>]` notes; images become an omission marker;
 * a compaction summary only when the history it replaced is no longer linked.
 * Dropped: sidechains, meta entries, tool results, thinking, signatures and
 * Claude Code's own command/notification envelopes.
 */
import { IMAGE_OMITTED_TEXT, IMPORT_WARNING_IMAGE_OMITTED, isWholeElement, textPart, toolNote } from './turns.mjs';

const CLAUDE_ENVELOPE_TAGS = [
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'task-notification',
  'system-reminder',
  'user-prompt-submit-hook',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
];
const SLASH_COMMAND_RE = /^(?:\s*<(command-name|command-message|command-args)>[\s\S]*?<\/\1>)+\s*$/;
const INTERRUPTED_RE = /^\[Request interrupted by user[^\]\n]*\]$/;
// Claude Code's text annotation that accompanies a pasted image block.
const IMAGE_ANNOTATION_RE = /^\[Image\b[^\n]*\]$/;

export function isClaudeEnvelopeText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  return (
    isWholeElement(trimmed, CLAUDE_ENVELOPE_TAGS) ||
    SLASH_COMMAND_RE.test(trimmed) ||
    INTERRUPTED_RE.test(trimmed) ||
    IMAGE_ANNOTATION_RE.test(trimmed)
  );
}

const isMessageEntry = (record) => record?.type === 'user' || record?.type === 'assistant';
const stringOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const uuidOrNull = (value) => (typeof value === 'string' ? value : null);
const timestampOrNull = (value) => (typeof value === 'string' || typeof value === 'number' ? value : null);
// Rough fixed cost of one retained entry object, so tiny entries still count.
const ENTRY_OVERHEAD_BYTES = 64;
const metadataLength = (entry) =>
  (entry.uuid?.length || 0) +
  (entry.parentUuid?.length || 0) +
  (entry.logicalParentUuid?.length || 0) +
  (typeof entry.at === 'string' ? entry.at.length : 0);

/**
 * The active branch, root first: walked back from the last main-chain entry.
 * `crossedCompaction` tells whether a compaction boundary led back into the
 * history it replaced (Claude Code often no longer keeps that history).
 */
function activeChain(entries) {
  const main = entries.filter((entry) => entry.main);
  const leaf = main[main.length - 1];
  if (!leaf || leaf.uuid === null) return { chain: main, crossedCompaction: false };
  const byUuid = new Map();
  for (const entry of entries) {
    if (entry.uuid !== null) byUuid.set(entry.uuid, entry);
  }
  const chain = [];
  const seen = new Set();
  let crossedCompaction = false;
  let current = leaf;
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    const parent = current.parentUuid !== null ? byUuid.get(current.parentUuid) : null;
    const logical = !parent && current.logicalParentUuid !== null ? byUuid.get(current.logicalParentUuid) : null;
    if (logical) crossedCompaction = true;
    current = parent || logical;
  }
  return { chain: chain.reverse().filter((entry) => entry.main), crossedCompaction };
}

function entryParts(role, content, warnings) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) return [];
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (role === 'user' && isClaudeEnvelopeText(block.text)) continue;
      parts.push(textPart(block.text));
    } else if (block.type === 'image') {
      warnings.add(IMPORT_WARNING_IMAGE_OMITTED);
      parts.push(textPart(IMAGE_OMITTED_TEXT));
    } else if (block.type === 'tool_use' && role === 'assistant') {
      parts.push(toolNote(block.name));
    }
  }
  return parts;
}

function skippedEntry(record) {
  // Claude Code flags its compaction summary transcript-only as well.
  if (record.isCompactSummary === true) return false;
  return record.isMeta === true || record.isVisibleInTranscriptOnly === true || record.isApiErrorMessage === true;
}

/**
 * Incremental reducer: `push(record)` keeps a compact chain entry (uuid links
 * plus the plain-text parts of a main-chain message) and drops the record
 * itself, so tool results, thinking and image data are never retained.
 * `chars` is the kept text across every branch so far, `entries` the chain
 * entries retained and `metadataBytes` their link/timestamp bookkeeping.
 */
export function createClaudeReducer() {
  const entries = [];
  let recognized = false;
  let foreignSessionId = null;
  let cwd = null;
  let sidechainSeen = false;
  let mainSeen = false;
  let chars = 0;
  let metadataBytes = 0;
  return {
    get chars() {
      return chars;
    },
    get entries() {
      return entries.length;
    },
    get metadataBytes() {
      return metadataBytes;
    },
    /** Cheap running check: messages seen so far are all sidechain (a verdict only at the end of the file). */
    get sidechainOnly() {
      return sidechainSeen && !mainSeen;
    },
    push(record) {
      const message = isMessageEntry(record);
      if (message) recognized = true;
      const main = message && record.isSidechain !== true;
      if (message) {
        if (main) mainSeen = true;
        else sidechainSeen = true;
      }
      if (main) {
        foreignSessionId ||= stringOrNull(record.sessionId);
        cwd ||= stringOrNull(record.cwd);
      }
      const uuid = uuidOrNull(record?.uuid);
      if (!main && uuid === null) return;
      const entry = {
        uuid,
        parentUuid: uuidOrNull(record.parentUuid),
        logicalParentUuid: uuidOrNull(record.logicalParentUuid),
        main,
        role: null,
        parts: null,
        warnings: null,
        at: timestampOrNull(record.timestamp),
      };
      metadataBytes += ENTRY_OVERHEAD_BYTES + metadataLength(entry);
      if (main && !skippedEntry(record)) {
        const body = record.message && typeof record.message === 'object' ? record.message : null;
        entry.role = body?.role === 'user' || body?.role === 'assistant' ? body.role : record.type;
        const warnings = new Set();
        entry.parts = entryParts(entry.role, body ? body.content : null, warnings);
        if (record.isCompactSummary === true) {
          entry.summary = true;
          entry.parts = entry.parts.map((part) => ({ ...part, summary: true }));
        }
        if (warnings.size) entry.warnings = warnings;
        for (const part of entry.parts) chars += part.text.length;
      }
      entries.push(entry);
    },
    result() {
      const warnings = new Set();
      const rawTurns = [];
      const { chain, crossedCompaction } = activeChain(entries);
      for (const entry of chain) {
        if (!entry.parts?.length) continue;
        // The summary stands in for history only when that history is gone.
        if (entry.summary && crossedCompaction) continue;
        rawTurns.push({ role: entry.role, parts: entry.parts, at: entry.at });
        for (const code of entry.warnings || []) warnings.add(code);
      }
      // A transcript whose every message is a sidechain is a subagent's own, not a conversation.
      const internalKind = this.sidechainOnly ? 'subagent' : null;
      return { recognized, foreignSessionId, cwd, internalKind, rawTurns, warnings };
    },
  };
}
