/**
 * Shared shape of an imported conversation: plain-text user/assistant turns,
 * the markers that stand in for dropped content, and the title rule. Codex and
 * Claude Code parsers both emit raw turns `{ role, parts: [{ text, note }], at }`
 * and normalize them here. Pure, leaf, no IO.
 */

/** Language-neutral warning codes attached to an imported conversation. */
export const IMPORT_WARNING_IMAGE_OMITTED = 'imageOmitted';
export const IMPORT_WARNING_MALFORMED = 'malformed';
export const IMPORT_WARNING_CWD_MISSING = 'cwdMissing';
/** The conversation continues a history stored in another file that was not followed. */
export const IMPORT_WARNING_HISTORY_PARTIAL = 'historyPartial';
/** Earlier history was left out because following it would pass the import size limit. */
export const IMPORT_WARNING_HISTORY_SIZE_LIMIT = 'historySizeLimit';
/** Earlier history was left out because its file is missing or could not be read. */
export const IMPORT_WARNING_HISTORY_UNAVAILABLE = 'historyUnavailable';

/** A compressed rollout needs a Node.js runtime with zstd; used as the failure code and as the warning of an unreadable base. */
export const IMPORT_ERROR_NEEDS_NEWER_NODE = 'needsNewerNode';

/** Failure code of a record the source app writes for its own use (not a conversation). */
export const IMPORT_ERROR_INTERNAL = 'internalRecord';

/** Stands in for an image the importer does not carry over. */
export const IMAGE_OMITTED_TEXT = '[image omitted]';
/** Leads a conversation whose first kept turn is the assistant's. */
export const IMPORTED_USER_STUB_TEXT = '[Imported conversation continues from an earlier assistant reply.]';

const TITLE_MAX_CHARS = 100;

/** Note for a tool call: its name only, never its arguments. A run of notes
 *  becomes one compact line in the text and one structured entry in `toolRuns`. */
export function toolNote(name) {
  const clean =
    String(name || '')
      .replace(/\s+/g, ' ')
      .trim() || 'unknown';
  return { text: `[ran tool: ${clean}]`, note: true, tool: clean };
}

/** Longest model-facing run line, and the longest tool name shown in it. */
export const TOOL_RUN_LINE_MAX_CHARS = 400;
const TOOL_RUN_NAME_MAX_CHARS = 40;

/**
 * Model-facing line for one run of tool notes: `[ran tools: shell ×6, Read ×2]`.
 * Bounded: names are clipped, and tools that do not fit are counted as
 * `, +N more`. Deterministic in `tools`, so a stored line can be re-derived.
 */
export function toolRunLine(tools) {
  const entries = tools.map(({ name, count }) => {
    const chars = Array.from(String(name));
    const shown =
      chars.length > TOOL_RUN_NAME_MAX_CHARS ? `${chars.slice(0, TOOL_RUN_NAME_MAX_CHARS - 1).join('')}…` : name;
    return `${shown} ×${count}`;
  });
  const omittedSuffix = (omitted) => (omitted > 0 ? `, +${omitted} more` : '');
  let body = '';
  let shownCount = 0;
  for (const entry of entries) {
    const next = shownCount ? `${body}, ${entry}` : entry;
    const length = `[ran tools: ${next}${omittedSuffix(entries.length - shownCount - 1)}]`.length;
    if (shownCount && length > TOOL_RUN_LINE_MAX_CHARS) break;
    body = next;
    shownCount += 1;
  }
  return `[ran tools: ${body}${omittedSuffix(entries.length - shownCount)}]`;
}

function toolRunCounts(notes) {
  const counts = new Map();
  for (const note of notes) counts.set(note.tool, (counts.get(note.tool) || 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count }));
}

export function textPart(text) {
  return { text: String(text), note: false };
}

/** Whole-text match of one XML-style envelope element (`<tag>…</tag>`). */
export function isWholeElement(text, tags) {
  const trimmed = String(text || '').trim();
  return tags.some(
    (tag) => (trimmed.startsWith(`<${tag}>`) || trimmed.startsWith(`<${tag} `)) && trimmed.endsWith(`</${tag}>`)
  );
}

export function timestampMs(value) {
  const ms = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// Each run of consecutive tool notes collapses into one compact line; every
// boundary is a blank line. `toolRuns` locates those lines in `text`.
function joinParts(parts) {
  const blocks = [];
  for (const part of parts) {
    const piece = String(part.text || '').trim();
    if (!piece) continue;
    const last = blocks[blocks.length - 1];
    if (part.note && last?.notes) last.notes.push(part);
    else blocks.push(part.note ? { notes: [part] } : { text: piece });
  }
  let text = '';
  const toolRuns = [];
  for (const block of blocks) {
    if (text) text += '\n\n';
    if (block.notes) {
      const tools = toolRunCounts(block.notes);
      const line = toolRunLine(tools);
      toolRuns.push({ start: text.length, end: text.length + line.length, tools });
      text += line;
    } else {
      text += block.text;
    }
  }
  return { text, toolRuns };
}

/**
 * Raw turns → normalized turns `{ role, text, at, stub? }`: empty turns dropped,
 * consecutive same-role turns merged, and a short user stub inserted when the
 * conversation would otherwise begin with the assistant.
 */
export function normalizeTurns(rawTurns) {
  const merged = [];
  for (const raw of rawTurns) {
    if (raw?.role !== 'user' && raw?.role !== 'assistant') continue;
    const parts = (Array.isArray(raw.parts) ? raw.parts : []).filter((part) => String(part?.text || '').trim());
    if (!parts.length) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.role === raw.role) previous.parts.push(...parts);
    else merged.push({ role: raw.role, parts: [...parts], at: timestampMs(raw.at) });
  }
  const turns = merged.map(({ role, parts, at }) => {
    const joined = joinParts(parts);
    const turn = { role, text: joined.text, at };
    if (joined.toolRuns.length) turn.toolRuns = joined.toolRuns;
    // A carried-over compaction summary never names the conversation; a slash
    // command only when no typed prompt does.
    if (parts.some((part) => part.summary || part.command)) {
      turn.titleText = joinParts(parts.filter((part) => !part.summary && !part.command)).text;
    }
    if (parts.some((part) => part.command)) turn.commandText = joinParts(parts.filter((part) => part.command)).text;
    return turn;
  });
  if (turns[0]?.role === 'assistant') {
    turns.unshift({ role: 'user', text: IMPORTED_USER_STUB_TEXT, at: turns[0].at, stub: true });
  }
  return turns;
}

const textLines = (text) =>
  String(text ?? '')
    .split('\n')
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

const titleLines = (turn) => textLines(turn.titleText ?? turn.text);

/** First non-empty line of a title text, whitespace-normalized, ≤100 chars. */
export function titleFromText(text) {
  const line = textLines(text)[0];
  if (!line) return null;
  return Array.from(line).slice(0, TITLE_MAX_CHARS).join('').trim() || null;
}

/** First line of the first genuine user turn, whitespace-normalized, ≤100 chars
 *  (an image marker only when the turn has no text line), else the first slash command. */
export function conversationTitle(turns) {
  const first = turns.find((turn) => turn.role === 'user' && !turn.stub && titleLines(turn).length);
  if (!first) return titleFromText(turns.find((turn) => turn.role === 'user' && turn.commandText)?.commandText);
  const lines = titleLines(first);
  return titleFromText(lines.find((value) => value !== IMAGE_OMITTED_TEXT) || lines[0]);
}
