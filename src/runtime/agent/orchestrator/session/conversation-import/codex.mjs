/**
 * Codex CLI rollout (`rollout-*.jsonl`) → raw import turns. Kept: the first
 * `session_meta` (foreign id, cwd), user/assistant `message` items as text and
 * tool calls as `[ran tool: <name>]` notes. Dropped: developer/system
 * messages, Codex's own wrapper user messages, tool outputs, reasoning,
 * event_msg, token counts and turn_context.
 */
import { IMAGE_OMITTED_TEXT, IMPORT_WARNING_IMAGE_OMITTED, isWholeElement, textPart, toolNote } from './turns.mjs';

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
    if (payload.role === 'user' && isCodexEnvelopeText(item.text)) continue;
    parts.push(textPart(item.text));
  }
  return parts;
}

function toolName(payload) {
  if (typeof payload.name === 'string' && payload.name.trim()) return payload.name;
  return payload.type === 'local_shell_call' ? 'local_shell' : '';
}

const stringOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
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
    push(record) {
      const payload = record?.payload && typeof record.payload === 'object' ? record.payload : null;
      if (!payload) return;
      if (record.type === 'session_meta') {
        recognized = true;
        if (!metaSeen) {
          metaSeen = true;
          foreignSessionId = stringOrNull(payload.id) || stringOrNull(payload.session_id);
          cwd = stringOrNull(payload.cwd);
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
      return { recognized, foreignSessionId, cwd, rawTurns, warnings };
    },
  };
}

/** id/cwd of a `session_meta` first line cut off by a bounded prefix read. */
export function codexMetaFromTruncatedLine(line) {
  const text = String(line || '');
  if (!/"type"\s*:\s*"session_meta"/.test(text)) return null;
  const field = (name) => {
    const match = new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(text);
    if (!match) return null;
    try {
      return stringOrNull(JSON.parse(match[1]));
    } catch {
      return null;
    }
  };
  return { foreignSessionId: field('id') || field('session_id'), cwd: field('cwd') };
}
