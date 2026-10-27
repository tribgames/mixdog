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

/** Failure code of a record the source app writes for its own use (not a conversation). */
export const IMPORT_ERROR_INTERNAL = 'internalRecord';

/** Stands in for an image the importer does not carry over. */
export const IMAGE_OMITTED_TEXT = '[image omitted]';
/** Leads a conversation whose first kept turn is the assistant's. */
export const IMPORTED_USER_STUB_TEXT = '[Imported conversation continues from an earlier assistant reply.]';

const TITLE_MAX_CHARS = 100;

/** Plain-text note for a tool call: its name only, never its arguments. */
export function toolNote(name) {
  const clean = String(name || '')
    .replace(/\s+/g, ' ')
    .trim();
  return { text: `[ran tool: ${clean || 'unknown'}]`, note: true };
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

// Consecutive tool notes stay one per line; every other boundary is a blank line.
function joinParts(parts) {
  let text = '';
  let previous = null;
  for (const part of parts) {
    const piece = String(part.text || '').trim();
    if (!piece) continue;
    if (previous) text += previous.note && part.note ? '\n' : '\n\n';
    text += piece;
    previous = part;
  }
  return { text, last: previous };
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
    const turn = { role, text: joinParts(parts).text, at };
    // A carried-over compaction summary never names the conversation.
    if (parts.some((part) => part.summary)) turn.titleText = joinParts(parts.filter((part) => !part.summary)).text;
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
 *  (an image marker only when the turn has no text line). */
export function conversationTitle(turns) {
  const first = turns.find((turn) => turn.role === 'user' && !turn.stub && titleLines(turn).length);
  if (!first) return null;
  const lines = titleLines(first);
  return titleFromText(lines.find((value) => value !== IMAGE_OMITTED_TEXT) || lines[0]);
}
