import { stripInjectedBlocks } from '../../../../src/runtime/shared/injected-display-text.mjs';

const DEFAULT_SESSION_TITLE = 'Untitled session';

const GENERATED_TITLE_NOISE = Object.freeze([
  /^\[mixdog-runtime\]/i,
  // Same control-row set as session-text: never title from cancel/restart markers.
  /^\[(?:truncated|request interrupted by (?:user(?: for tool use)?|process restart))\]$/i,
  /^a previous model worked on this task and produced the compacted handoff summary below\b/i,
  // Compact/auto-clear re-seed variants (mirror of the core
  // SYNTHETIC_SESSION_TEXT_PATTERNS): the file re-attach block leads the
  // post-compaction transcript, so titling from it painted
  // "Re-attached after compaction…" rows in the sidebar (user report).
  /^re-attached after compaction\b/i,
  /^reference files:\s/i,
  /^the async (?:agent|shell) task\b/i,
  /^#\s*permission\b/i,
  /^permission:\s*/i,
  /^cwd:\s*/i,
]);

// Provider/runtime media envelopes are transport metadata, never user-facing
// title text. Keep the match narrow enough that a literal prompt such as
// "[Image: artistic direction]" remains untouched.
const MEDIA_DISPLAY_BLOCK =
  /\[(Image|Video)(?:\s*#?\d+(?:\s*:[^\]\r\n]*)?|\s+source:\s*[^\]\r\n]+|:\s*(?=[^\]\r\n]*(?:source:|\d{1,6}\s*[x×]\s*\d{1,6}|displayed\s+at\b|duration\b))[^\]\r\n]+)\]/gi;
const LEGACY_MEDIA_PREFIX =
  /^\s*.+?\.(png|jpe?g|gif|webp|bmp|avif|mp4|mov|m4v|webm|mkv|avi)\s+\d{1,6}\s*[x×]\s*\d{1,6}(?:\s*,?\s*displayed\s+at\s+\d{1,6}\s*[x×]\s*\d{1,6})?\s*(?:…|\.\.\.)?\s*/i;
const COMPACTED_EVENT_LINE = /^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s+([a-z]+):\s*(.*)$/i;
// Reply/session-transition envelopes can lead the visible prompt after a
// restart. They are navigation metadata, not the task itself, and otherwise
// consume the entire 32-char generated title ("확인 [2026-…] …"). When the
// quoted excerpt has an ellipsis and real text follows it, discard the whole
// excerpt; a truncated metadata title with no trailing text only loses the
// timestamp prefix and is repaired later from the full durable preview.
const SESSION_REFERENCE_PREFIX = /^\s*(?:확인\s*)?\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/i;
const SESSION_REFERENCE_QUOTE =
  /^\s*(?:확인\s*)?\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*[\s\S]{0,160}?(?:…|\.\.\.)\s*(?=\S)/i;
const SESSION_REFERENCE_DEICTIC = /^(?:이거|이게|그거)\s*/;

function stripSessionReference(value) {
  const source = String(value ?? '');
  const quoted = source.match(SESSION_REFERENCE_QUOTE);
  if (quoted) return source.slice(quoted[0].length).replace(SESSION_REFERENCE_DEICTIC, '');
  return source.replace(SESSION_REFERENCE_PREFIX, '');
}

// The composer's file chips (`[PDF #n: name]`, `[File #n: name]`): an
// attachment, never title prose; a message of chips alone is titled by the
// first chip's file name.
const FILE_CHIP = /\[(?:PDF|File)\s*#\d+:\s*([^\]\r\n]+)\]/gi;

/** Title of a message with attachments and no words: the first attachment's
 *  file name, or the `[Image]`/`[Video]` placeholder (provisional — a later
 *  worded title replaces it, and the renderer shows it as the localized kind). */
function attachmentTitleFallback(value) {
  const source = String(value ?? '');
  MEDIA_DISPLAY_BLOCK.lastIndex = 0;
  const media = MEDIA_DISPLAY_BLOCK.exec(source);
  MEDIA_DISPLAY_BLOCK.lastIndex = 0;
  FILE_CHIP.lastIndex = 0;
  const file = FILE_CHIP.exec(source);
  FILE_CHIP.lastIndex = 0;
  if (file && (!media || file.index < media.index)) return file[1].trim();
  if (!media) return '';
  return String(media[1]).toLowerCase() === 'video' ? '[Video]' : '[Image]';
}

function attachmentTitle(value, fallback, maxLength) {
  const attachment = attachmentTitleFallback(value);
  return attachment ? normalizeSessionTitle(attachment, fallback, maxLength) : fallback;
}

function legacyMediaDisplay(value) {
  const source = String(value ?? '');
  const match = source.match(LEGACY_MEDIA_PREFIX);
  if (!match) return null;
  return {
    fallback: /^(?:mp4|mov|m4v|webm|mkv|avi)$/i.test(match[1]) ? '[Video]' : '[Image]',
    text: source.slice(match[0].length).trim(),
  };
}

const ENGLISH_PLACEHOLDER_LABELS = Object.freeze({ image: 'Image', video: 'Video', file: 'File' });

/** How a title is shown to people: a session titled by a message with
 *  attachments and no words keeps the provisional `[Image]` / `[Video]` /
 *  `[File]` placeholder (a later worded title replaces it), shown as its
 *  kind's label in the caller's language (English by default). */
export function sessionTitleLabel(title, labels = ENGLISH_PLACEHOLDER_LABELS) {
  const text = String(title ?? '');
  const kind = /^\[(Image|Video|File)\]$/i.exec(text.trim())?.[1]?.toLowerCase();
  return kind ? labels[kind] : text;
}

export function isMediaSessionTitlePlaceholder(value) {
  return /^\[(?:Image|Video)\]$/i.test(String(value ?? '').trim());
}

/**
 * A compact handoff can be the only durable copy of the prompt that originally
 * named a CLI session. Recover the earliest real user entry even when the
 * digest itself is newest-first. Media-only entries remain provisional.
 */
export function compactedSessionTitle(value, fallback = '') {
  const source = String(value ?? '');
  if (
    !/^a previous model worked on this task\b/i.test(source.trimStart()) &&
    !source.includes('<prior-compacted-context>')
  )
    return String(fallback);
  const lines = source.split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(COMPACTED_EVENT_LINE);
    if (match?.[2].toLowerCase() !== 'u') continue;
    const idMatch = match[3].match(/\s+#(\d+)\s*$/);
    const parts = [match[3].replace(/\s+#\d+\s*$/, '')];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (
        COMPACTED_EVENT_LINE.test(line) ||
        /^<\/?prior-compacted-context>/i.test(line) ||
        /^\[context compacted\b/i.test(line) ||
        /^session_id=/i.test(line)
      )
        break;
      parts.push(line);
    }
    const displayText = parts.join('\n').trim();
    const legacyMedia = legacyMediaDisplay(displayText);
    const titleSource = legacyMedia?.text
      ? legacyMedia.text.split(/\r?\n/).find((line) => line.trim()) || legacyMedia.text
      : displayText;
    const title = generatedSessionTitle(titleSource, legacyMedia?.fallback || '');
    if (!title) continue;
    entries.push({
      at: match[1],
      id: idMatch ? Number(idMatch[1]) : Number.MAX_SAFE_INTEGER,
      index,
      title,
    });
  }
  entries.sort((left, right) => left.at.localeCompare(right.at) || left.id - right.id || left.index - right.index);
  return (
    entries.find((entry) => !isMediaSessionTitlePlaceholder(entry.title))?.title ||
    entries[0]?.title ||
    String(fallback)
  );
}

export function stripSessionEnvelope(value) {
  return (
    String(value ?? '')
      .replace(/^# Session\r?\n(?:(?:Cwd|Model|Workflow):[^\r\n]*(?:\r?\n|$))+(?:\r?\n)?/i, '')
      .replace(/^#\s*Session\s+Cwd:\s+.*?\s+Model:\s+.*?\s+Workflow:\s+\S+\s*/i, '')
      // Truncated previews may cut the envelope mid-way: strip progressively.
      .replace(/^#\s*Session\s+Cwd:\s+\S+(?:\s+Model:\s+\S*)?(?:\s+Workflow:\s+\S*)?\s*/i, '')
  );
}

/** Display default: closed blocks only, so a user-typed tag name never eats
 *  the rest of their message. Truncated sources opt into `dropUnterminated`. */
export function stripInjectedDisplayText(value, options) {
  return stripInjectedBlocks(value, options);
}

export function isSyntheticSessionDisplayText(value) {
  const text = String(value ?? '').trim();
  return !text || GENERATED_TITLE_NOISE.some((pattern) => pattern.test(text));
}

export function hasMeaningfulSessionTitleText(value) {
  return /[\p{L}\p{N}]/u.test(normalizeSessionTitle(value, ''));
}

/**
 * Produces the stable, user-facing label used by the desktop shell. The core
 * preview remains untouched because the TUI uses it as a recent-message
 * preview; desktop titles deliberately strip runtime envelopes and payloads.
 */
// Bounded exact-input memo for the (pure) cleaning stage: the catalog build
// titles the same preview several times per row.
const CLEANED_MEMO_LIMIT = 256;
const cleanedMemo = new Map();
export const sessionTitleNormalizationStats = { cleaned: 0 };

function cleanSessionTitleText(source) {
  const hit = cleanedMemo.get(source);
  if (hit !== undefined) return hit;
  sessionTitleNormalizationStats.cleaned += 1;
  const text = stripSessionReference(stripInjectedDisplayText(stripSessionEnvelope(source), { dropUnterminated: true }))
    .replace(/<file\b[^>]*>[\s\S]*?<\/file>/gi, ' ')
    .replace(/\[Pasted text\s*#?\d+(?:\s*(?::[^\]\r\n]*|\+\d+\s+lines))?\]/gi, ' ')
    .replace(MEDIA_DISPLAY_BLOCK, ' ')
    .replace(FILE_CHIP, ' ')
    .replace(/^Reference files:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanedMemo.size >= CLEANED_MEMO_LIMIT) cleanedMemo.delete(cleanedMemo.keys().next().value);
  cleanedMemo.set(source, text);
  return text;
}

export function normalizeSessionTitle(value, fallback = DEFAULT_SESSION_TITLE, maxLength = 100) {
  const text = cleanSessionTitleText(String(value ?? ''));

  if (!text) return String(fallback);
  const limit = Math.max(16, Number(maxLength) || 100);
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit - 1);
  const boundary = clipped.lastIndexOf(' ');
  const head = boundary >= Math.floor(limit * 0.6) ? clipped.slice(0, boundary) : clipped;
  return `${head.trimEnd()}…`;
}

// 32 chars keeps auto-titles scannable in the sidebar/tabs/header (user:
// long first prompts produced paragraph-length titles). Word-boundary clip
// with an ellipsis comes from normalizeSessionTitle.
export function generatedSessionTitle(value, fallback = DEFAULT_SESSION_TITLE, maxLength = 32) {
  if (isSyntheticSessionDisplayText(value)) return String(fallback);
  const legacyMedia = legacyMediaDisplay(value);
  const title = legacyMedia
    ? normalizeSessionTitle(legacyMedia.text, legacyMedia.fallback || fallback, maxLength)
    : normalizeSessionTitle(value, attachmentTitle(value, fallback, maxLength), maxLength);
  return hasMeaningfulSessionTitleText(title) ? title : String(fallback);
}

export function sessionSummaryTitle(session, fallback = DEFAULT_SESSION_TITLE) {
  if (session?.title) {
    const legacyMedia = legacyMediaDisplay(session.title);
    if (legacyMedia) return normalizeSessionTitle(legacyMedia.text, legacyMedia.fallback || fallback);
    return normalizeSessionTitle(session.title, attachmentTitle(session.title, fallback));
  }
  return generatedSessionTitle(session?.preview || '', fallback);
}

export function promptTitle(prompt, displayText = '') {
  // No words: the first attachment titles it — a file by its name.
  const attachmentPart = Array.isArray(prompt)
    ? prompt.find((part) => part?.type === 'image' || part?.type === 'video' || part?.type === 'file')
    : null;
  let attachmentFallback = '';
  if (attachmentPart?.type === 'video') attachmentFallback = '[Video]';
  else if (attachmentPart?.type === 'image') attachmentFallback = '[Image]';
  else if (attachmentPart?.type === 'file')
    attachmentFallback = normalizeSessionTitle(String(attachmentPart.filename || ''), '[File]', 32);
  if (displayText) {
    const visibleTitle = generatedSessionTitle(displayText, '');
    if (visibleTitle) return visibleTitle;
  }
  if (typeof prompt === 'string') return generatedSessionTitle(prompt, '');
  if (!Array.isArray(prompt)) return '';
  const text = prompt
    .filter((part) => part?.type === 'text')
    .map((part) => String(part?.text || ''))
    .join(' ');
  return generatedSessionTitle(text, attachmentFallback);
}
