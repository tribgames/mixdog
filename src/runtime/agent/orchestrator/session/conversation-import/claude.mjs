/**
 * Claude Code project transcript (`projects/<dir>/<session>.jsonl`) → raw
 * import turns. The active branch is followed from the last main-chain entry
 * back through `parentUuid` (and `logicalParentUuid` across a compaction), so
 * replayed or abandoned branches never duplicate. Kept: text blocks and
 * `tool_use` as tool notes; images become an omission marker; a compaction
 * summary (as an assistant recap) only when the history it replaced is gone;
 * a slash command as `/name args` unless the app answered it locally; pasted
 * text without the app's paste envelope. Dropped: sidechains, meta entries,
 * tool results, thinking, signatures and Claude Code's own
 * command-output/notification envelopes.
 */
import {
  IMAGE_OMITTED_TEXT,
  IMPORT_WARNING_IMAGE_OMITTED,
  isWholeElement,
  textPart,
  titleFromText,
  toolNote,
} from './turns.mjs';

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
  // The app's own instructions behind its "create PR" action.
  'create-pr-command',
];
const LOCAL_OUTPUT_TAGS = ['local-command-stdout', 'local-command-stderr'];
const SLASH_COMMAND_RE = /^(?:\s*<(command-name|command-message|command-args|skill-format)>[\s\S]*?<\/\1>)+\s*$/;
const INTERRUPTED_RE = /^\[Request interrupted by user[^\]\n]*\]$/;
// Claude Code's text annotation that accompanies a pasted image block.
const IMAGE_ANNOTATION_RE = /^\[Image\b[^\n]*\]$/;
// The desktop app's paste envelope: `<pasted_content id="hhhh">\n` body
// `\n</pasted_content id="hhhh">`, one four-hex id on both tags.
const PASTE_OPEN = '<pasted_content id="';
const PASTE_ID_RE = /^[0-9a-f]{4}$/;

/**
 * Text with the app's paste envelopes unwrapped the way the app displays it:
 * each paste body in place, the text around it trimmed toward it, pieces on
 * their own lines. Only a complete envelope with a matching id is unwrapped; any
 * other `<pasted_content…>` is the user's own text and stays as typed.
 */
export function unwrapClaudePastes(text) {
  const pieces = [];
  let cursor = 0;
  let search = 0;
  for (;;) {
    const open = text.indexOf(PASTE_OPEN, search);
    if (open < 0) break;
    const idStart = open + PASTE_OPEN.length;
    const id = text.slice(idStart, idStart + 4);
    const bodyStart = idStart + 7; // past `hhhh">\n`
    if (!PASTE_ID_RE.test(id) || text.slice(idStart + 4, bodyStart) !== '">\n') {
      search = idStart;
      continue;
    }
    const closeTag = `\n</pasted_content id="${id}">`;
    // The line feed ending the open tag may also start the close tag (an empty paste).
    const close = text.indexOf(closeTag, bodyStart - 1);
    if (close < 0) break;
    // Trimmed only toward a paste: the first fragment keeps its leading text.
    const before = text.slice(cursor, open);
    pieces.push(cursor ? before.trim() : before.trimEnd(), text.slice(bodyStart, Math.max(close, bodyStart)));
    cursor = close + closeTag.length;
    search = cursor;
  }
  if (!pieces.length) return text;
  pieces.push(text.slice(cursor).trimStart());
  const unwrapped = pieces.filter((piece, index) => index % 2 === 1 || piece).join('\n');
  return unwrapped.trim() ? unwrapped : text;
}

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

const tagValue = (text, tag) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1].trim() || '';

/** A slash-command envelope as Claude Code shows it (`/name args`), else null. */
export function claudeCommandText(text) {
  const trimmed = String(text || '').trim();
  if (!SLASH_COMMAND_RE.test(trimmed)) return null;
  const name = (tagValue(trimmed, 'command-name') || tagValue(trimmed, 'command-message')).replace(/^\//, '');
  if (!name) return null;
  return [`/${name}`, tagValue(trimmed, 'command-args')].filter(Boolean).join(' ');
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

// The main-chain message written last before file position `seq`: the leaf of
// the history a compaction boundary replaced.
function precedingMain(entries, seq) {
  for (let index = seq - 1; index >= 0; index--) {
    if (entries[index].main && entries[index].uuid !== null) return entries[index];
  }
  return null;
}

/**
 * The active branch, root first: walked back from the last main-chain entry.
 * A compaction boundary links back to the history it replaced through its
 * logical parent, or, when Claude Code never wrote that message, to the last
 * message before the boundary. `replaced` holds the compaction summaries whose
 * history the walk crossed into (that history is imported instead).
 */
function activeChain(entries) {
  const main = entries.filter((entry) => entry.main);
  const leaf = main[main.length - 1];
  if (!leaf || leaf.uuid === null) return { chain: main, replaced: new Set() };
  const byUuid = new Map();
  for (const entry of entries) {
    if (entry.uuid !== null) byUuid.set(entry.uuid, entry);
  }
  const chain = [];
  const seen = new Set();
  const replaced = new Set();
  let summary = null;
  let current = leaf;
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    if (current.summary) summary = current;
    const parent = current.parentUuid !== null ? byUuid.get(current.parentUuid) : null;
    const logical =
      !parent && current.logicalParentUuid !== null
        ? byUuid.get(current.logicalParentUuid) || precedingMain(entries, current.seq)
        : null;
    if (logical && summary) {
      replaced.add(summary);
      summary = null;
    }
    current = parent || logical;
  }
  return { chain: chain.reverse().filter((entry) => entry.main), replaced };
}

/** Kept parts of a message; a slash command is a `command` part, a local command's output marks `localOutput`. */
function entryParts(role, content, warnings, marks) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  if (!Array.isArray(blocks)) return [];
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      if (role === 'user') {
        const command = claudeCommandText(block.text);
        if (command) parts.push({ ...textPart(command), command: true });
        if (isWholeElement(block.text, LOCAL_OUTPUT_TAGS)) marks.localOutput = true;
        if (isClaudeEnvelopeText(block.text)) continue;
        parts.push(textPart(unwrapClaudePastes(block.text)));
        continue;
      }
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

/**
 * The title Claude Code's resume list shows from the records it appends to a
 * transcript: the last `custom-title` (a `/rename`), else the last `ai-title`,
 * then the last `summary`, then the last `last-prompt`. A blank custom title
 * (a cleared rename) ends the name tier without falling back to the AI title.
 * Other record types, such as `task-summary` or `agent-name`, never name it.
 */
export function createClaudeTitleScan() {
  let custom;
  let ai;
  let summary;
  let lastPrompt;
  return {
    push(record) {
      if (record.type === 'custom-title' && typeof record.customTitle === 'string') custom = record.customTitle;
      else if (record.type === 'ai-title' && typeof record.aiTitle === 'string') ai = record.aiTitle;
      else if (record.type === 'summary' && typeof record.summary === 'string') summary = record.summary;
      else if (record.type === 'last-prompt' && typeof record.lastPrompt === 'string') lastPrompt = record.lastPrompt;
    },
    title() {
      return titleFromText(custom ?? ai) || titleFromText(summary) || titleFromText(lastPrompt);
    },
  };
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
  const titleScan = createClaudeTitleScan();
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
    /** Feed a record for its stored title only (a transcript's tail window). */
    pushTitle(record) {
      titleScan.push(record);
    },
    push(record) {
      titleScan.push(record);
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
        seq: entries.length,
      };
      metadataBytes += ENTRY_OVERHEAD_BYTES + metadataLength(entry);
      if (main && !skippedEntry(record)) {
        const body = record.message && typeof record.message === 'object' ? record.message : null;
        entry.role = body?.role === 'user' || body?.role === 'assistant' ? body.role : record.type;
        const warnings = new Set();
        entry.parts = entryParts(entry.role, body ? body.content : null, warnings, entry);
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
      const { chain, replaced } = activeChain(entries);
      for (const [index, entry] of chain.entries()) {
        if (!entry.parts?.length) continue;
        // The summary stands in for history only when that history is gone,
        // and then as the model's recap, never as something the user wrote.
        if (entry.summary && replaced.has(entry)) continue;
        const role = entry.summary ? 'assistant' : entry.role;
        // A local command (`/model`, `/rename`…) answered by the app itself is not part of the conversation.
        const local =
          entry.parts.some((part) => part.command) &&
          chain.slice(index + 1).find((next) => next.parts?.length || next.localOutput)?.localOutput;
        const parts = local ? entry.parts.filter((part) => !part.command) : entry.parts;
        rawTurns.push({ role, parts, at: entry.at });
        for (const code of entry.warnings || []) warnings.add(code);
      }
      // A transcript whose every message is a sidechain is a subagent's own, not a conversation.
      const internalKind = this.sidechainOnly ? 'subagent' : null;
      return { recognized, foreignSessionId, cwd, internalKind, rawTurns, warnings, storedTitle: titleScan.title() };
    },
  };
}
