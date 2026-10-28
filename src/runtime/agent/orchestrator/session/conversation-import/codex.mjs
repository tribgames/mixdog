/**
 * Codex CLI rollout (`rollout-*.jsonl`) → raw import turns. Kept: the first
 * `session_meta` (foreign id, cwd), user/assistant `message` items as text and
 * tool calls as tool notes. Dropped: developer/system
 * messages, Codex's own wrapper user messages, tool outputs, reasoning,
 * event_msg, token counts and turn_context.
 */
import {
  IMAGE_OMITTED_TEXT,
  IMPORT_WARNING_IMAGE_OMITTED,
  isWholeElement,
  stringOrNull,
  textPart,
  toolNote,
} from './turns.mjs';

// User-role envelopes Codex injects itself (environment, instructions, abort
// notices, plugin hints, shell-command echoes, image wrappers).
const CODEX_ENVELOPE_TAGS = [
  'environment_context',
  'user_instructions',
  'turn_aborted',
  'recommended_plugins',
  'user_shell_command',
  'subagent_notification',
  'skills_instructions',
  'external_codex_apps_open_page',
];
const TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

export function isCodexEnvelopeText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  if (/^# AGENTS\.md instructions\b/.test(trimmed) && trimmed.includes('<INSTRUCTIONS>')) return true;
  if (isWholeElement(trimmed, CODEX_ENVELOPE_TAGS)) return true;
  // The `<image name=…>` / `</image>` text parts that wrap an input_image.
  return /^<image\b[^>]*>$/.test(trimmed) || trimmed === '</image>';
}

// Codex shows a user message after the last of these headings: what precedes it
// is context the app adds for the model (IDE state, mentioned files, response
// annotations, an earlier request it already carries).
const USER_REQUEST_HEADING = '## My request for Codex:';

/** A user text part as Codex displays it. */
function codexUserDisplayText(text) {
  const at = text.lastIndexOf(USER_REQUEST_HEADING);
  return at < 0 ? text : text.slice(at + USER_REQUEST_HEADING.length).trim();
}

function messageParts(payload, warnings) {
  const content = typeof payload.content === 'string' ? [{ type: 'text', text: payload.content }] : payload.content;
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'input_image' || item.type === 'image') {
      warnings.add(IMPORT_WARNING_IMAGE_OMITTED);
      parts.push(textPart(IMAGE_OMITTED_TEXT));
      continue;
    }
    if (typeof item.text !== 'string') continue;
    if (payload.role !== 'user') parts.push(textPart(item.text));
    else if (!isCodexEnvelopeText(item.text)) parts.push(textPart(codexUserDisplayText(item.text)));
  }
  return parts;
}

function toolName(payload) {
  if (typeof payload.name === 'string' && payload.name.trim()) return payload.name;
  return payload.type === 'local_shell_call' ? 'local_shell' : '';
}

// `session_meta.thread_source` values Codex gives threads it runs for itself.
const INTERNAL_THREAD_SOURCES = {
  subagent: 'subagent',
  guardian_review: 'guardianReview',
  memory_consolidation: 'internal',
};

/**
 * What kind of Codex-internal record a `session_meta` payload marks, else null
 * for a conversation the user had. Markers are Codex's own: `thread_source`
 * (`subagent`, `guardian_review`, `memory_consolidation`) and a `source` of the
 * form `{ subagent: … }` (spawned agent, review, compact; `{ other: "guardian" }`
 * is the approval reviewer) or `{ internal: … }`. Other sources (cli, vscode,
 * exec, mcp, custom) and features (automation, voice chat) are the user's.
 */
function codexInternalKind(payload) {
  const byThread = INTERNAL_THREAD_SOURCES[payload?.thread_source];
  if (byThread) return byThread;
  const source = payload?.source;
  if (!source || typeof source !== 'object') return null;
  if ('subagent' in source) return source.subagent?.other === 'guardian' ? 'guardianReview' : 'subagent';
  if ('internal' in source) return source.internal === 'guardian' ? 'guardianReview' : 'internal';
  return null;
}
// Rough fixed cost of one retained turn object, so tiny turns still count.
const ENTRY_OVERHEAD_BYTES = 64;

/**
 * Incremental reducer: `push(record)` keeps only the plain-text parts of one
 * record (the record itself is not retained), `chars` is the kept text so far,
 * `entries` the raw turns kept and `metadataBytes` their timestamp bookkeeping.
 */
export function createCodexReducer() {
  const warnings = new Set();
  const rawTurns = [];
  let recognized = false;
  let foreignSessionId = null;
  let cwd = null;
  let internalKind = null;
  let historyBase = null;
  let metaSeen = false;
  let chars = 0;
  let metadataBytes = 0;
  const keep = (role, parts, at) => {
    for (const part of parts) chars += part.text.length;
    const stamp = typeof at === 'string' || typeof at === 'number' ? at : null;
    metadataBytes += ENTRY_OVERHEAD_BYTES + (typeof stamp === 'string' ? stamp.length : 0);
    rawTurns.push({ role, parts, at: stamp });
  };
  return {
    get chars() {
      return chars;
    },
    get entries() {
      return rawTurns.length;
    },
    get metadataBytes() {
      return metadataBytes;
    },
    /** `inherited` records come from a history base: its session metadata is not this thread's. */
    push(record, inherited = false) {
      const payload = record?.payload && typeof record.payload === 'object' ? record.payload : null;
      if (!payload) return;
      if (record.type === 'session_meta') {
        if (inherited) return;
        recognized = true;
        if (!metaSeen) {
          metaSeen = true;
          foreignSessionId = stringOrNull(payload.id) || stringOrNull(payload.session_id);
          cwd = stringOrNull(payload.cwd);
          internalKind = codexInternalKind(payload);
          if (payload.history_base && typeof payload.history_base === 'object') historyBase = payload.history_base;
        }
        return;
      }
      if (record.type !== 'response_item') return;
      recognized = true;
      if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
        const parts = messageParts(payload, warnings);
        if (parts.length) keep(payload.role, parts, record.timestamp);
      } else if (TOOL_CALL_TYPES.has(payload.type)) {
        keep('assistant', [toolNote(toolName(payload))], record.timestamp);
      }
    },
    result() {
      return { recognized, foreignSessionId, cwd, internalKind, historyBase, rawTurns, warnings };
    },
  };
}

// ── bounded-prefix `session_meta` scan ───────────────────────────────────────
// Index after the string starting at `i`, or -1 when the text ends inside it.
function scanString(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === '"') return j + 1;
  }
  return -1;
}

// Index after the JSON value starting at `i`, or -1 when the text ends inside it.
function scanValue(text, i) {
  if (text[i] === '"') return scanString(text, i);
  if (text[i] === '{' || text[i] === '[') {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '"') {
        j = scanString(text, j) - 1;
        if (j < 0) return -1;
      } else if (text[j] === '{' || text[j] === '[') depth++;
      else if ((text[j] === '}' || text[j] === ']') && --depth === 0) return j + 1;
    }
    return -1;
  }
  const literal = /[^,}\]\s]+/y;
  literal.lastIndex = i;
  literal.exec(text);
  return literal.lastIndex < text.length ? literal.lastIndex : -1;
}

/**
 * Complete top-level values (raw JSON text) of the record object and of its
 * `payload` object in a possibly cut-off line. Nested values are never
 * inspected, so a key inside custom metadata is not mistaken for a payload field.
 */
function recordFields(text) {
  const top = {};
  const payload = {};
  const walk = (start, target, descend) => {
    let j = start + 1;
    for (;;) {
      while (/[\s,]/.test(text[j] ?? '')) j++;
      if (text[j] !== '"') return;
      const keyEnd = scanString(text, j);
      if (keyEnd < 0) return;
      const key = JSON.parse(text.slice(j, keyEnd));
      j = keyEnd;
      while (/\s/.test(text[j] ?? '')) j++;
      if (text[j] !== ':') return;
      j++;
      while (/\s/.test(text[j] ?? '')) j++;
      if (descend && key === 'payload' && text[j] === '{') return walk(j, payload, false);
      const end = scanValue(text, j);
      if (end < 0) return;
      target[key] = text.slice(j, end);
      j = end;
    }
  };
  const open = text.indexOf('{');
  if (open >= 0) walk(open, top, true);
  return { top, payload };
}

const jsonOrNull = (raw) => {
  try {
    return raw === undefined ? null : JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * id/cwd/internal kind of a `session_meta` first line cut off by a bounded
 * prefix read, from the payload fields that arrived whole. A marker that did
 * not arrive whole leaves the record unclassified (`internalKind: null`).
 */
export function codexMetaFromTruncatedLine(line) {
  const { top, payload } = recordFields(String(line || ''));
  if (jsonOrNull(top.type) !== 'session_meta') return null;
  const field = (name) => stringOrNull(jsonOrNull(payload[name]));
  const meta = { thread_source: field('thread_source'), source: jsonOrNull(payload.source) };
  return {
    foreignSessionId: field('id') || field('session_id'),
    cwd: field('cwd'),
    internalKind: codexInternalKind(meta),
  };
}
