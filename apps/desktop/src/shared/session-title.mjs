const DEFAULT_SESSION_TITLE = 'Untitled session';

const INJECTED_DISPLAY_BLOCK_TAGS = Object.freeze([
  'system-reminder',
  'available-deferred-tools',
  'mcp-instructions',
  'memory-context',
  'skill',
  'event',
]);

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
const MEDIA_DISPLAY_BLOCK = /\[(Image|Video)(?:\s*#?\d+(?:\s*:[^\]\r\n]*)?|\s+source:\s*[^\]\r\n]+|:\s*(?=[^\]\r\n]*(?:source:|\d{1,6}\s*[x×]\s*\d{1,6}|displayed\s+at\b|duration\b))[^\]\r\n]+)\]/gi;
const LEGACY_MEDIA_PREFIX = /^\s*.+?\.(png|jpe?g|gif|webp|bmp|avif|mp4|mov|m4v|webm|mkv|avi)\s+\d{1,6}\s*[x×]\s*\d{1,6}(?:\s*,?\s*displayed\s+at\s+\d{1,6}\s*[x×]\s*\d{1,6})?\s*(?:…|\.\.\.)?\s*/i;
const COMPACTED_EVENT_LINE = /^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s+([a-z]+):\s*(.*)$/i;
// Reply/session-transition envelopes can lead the visible prompt after a
// restart. They are navigation metadata, not the task itself, and otherwise
// consume the entire 32-char generated title ("확인 [2026-…] …"). When the
// quoted excerpt has an ellipsis and real text follows it, discard the whole
// excerpt; a truncated metadata title with no trailing text only loses the
// timestamp prefix and is repaired later from the full durable preview.
const SESSION_REFERENCE_PREFIX = /^\s*(?:확인\s*)?\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/i;
const SESSION_REFERENCE_QUOTE = /^\s*(?:확인\s*)?\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*[\s\S]{0,160}?(?:…|\.\.\.)\s*(?=\S)/i;
const SESSION_REFERENCE_DEICTIC = /^(?:이거|이게|그거)\s*/;

function stripSessionReference(value) {
  const source = String(value ?? '');
  const quoted = source.match(SESSION_REFERENCE_QUOTE);
  if (quoted) return source.slice(quoted[0].length).replace(SESSION_REFERENCE_DEICTIC, '');
  return source.replace(SESSION_REFERENCE_PREFIX, '');
}

function mediaTitleFallback(value) {
  MEDIA_DISPLAY_BLOCK.lastIndex = 0;
  const match = MEDIA_DISPLAY_BLOCK.exec(String(value ?? ''));
  MEDIA_DISPLAY_BLOCK.lastIndex = 0;
  if (!match) return '';
  return String(match[1]).toLowerCase() === 'video' ? '[Video]' : '[Image]';
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
  if (!/^a previous model worked on this task\b/i.test(source.trimStart())
    && !source.includes('<prior-compacted-context>')) return String(fallback);
  const lines = source.split(/\r?\n/);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(COMPACTED_EVENT_LINE);
    if (!match || match[2].toLowerCase() !== 'u') continue;
    const idMatch = match[3].match(/\s+#(\d+)\s*$/);
    const parts = [match[3].replace(/\s+#\d+\s*$/, '')];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (COMPACTED_EVENT_LINE.test(line)
        || /^<\/?prior-compacted-context>/i.test(line)
        || /^\[context compacted\b/i.test(line)
        || /^session_id=/i.test(line)) break;
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
  entries.sort((left, right) => left.at.localeCompare(right.at)
    || left.id - right.id || left.index - right.index);
  return entries.find((entry) => !isMediaSessionTitlePlaceholder(entry.title))?.title
    || entries[0]?.title
    || String(fallback);
}

export function stripSessionEnvelope(value) {
  return String(value ?? '')
    .replace(/^# Session\r?\n(?:(?:Cwd|Model|Workflow):[^\r\n]*(?:\r?\n|$))+(?:\r?\n)?/i, '')
    .replace(/^#\s*Session\s+Cwd:\s+.*?\s+Model:\s+.*?\s+Workflow:\s+\S+\s*/i, '')
    // Truncated previews may cut the envelope mid-way: strip progressively.
    .replace(/^#\s*Session\s+Cwd:\s+\S+(?:\s+Model:\s+\S*)?(?:\s+Workflow:\s+\S*)?\s*/i, '');
}

export function stripInjectedDisplayText(value) {
  let text = String(value ?? '');
  for (const tag of INJECTED_DISPLAY_BLOCK_TAGS) {
    const block = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi');
    const closing = new RegExp(`<\\/${tag}\\s*>`, 'gi');
    text = text.replace(block, ' ').replace(closing, ' ');
  }
  return text;
}

export function isSyntheticSessionDisplayText(value) {
  const text = String(value ?? '').trim();
  return !text || GENERATED_TITLE_NOISE.some((pattern) => pattern.test(text));
}

export function isGeneratedSessionTitleNoise(value) {
  return isSyntheticSessionDisplayText(value);
}

export function hasMeaningfulSessionTitleText(value) {
  return /[\p{L}\p{N}]/u.test(normalizeSessionTitle(value, ''));
}

/**
 * Produces the stable, user-facing label used by the desktop shell. The core
 * preview remains untouched because the TUI uses it as a recent-message
 * preview; desktop titles deliberately strip runtime envelopes and payloads.
 */
export function normalizeSessionTitle(value, fallback = DEFAULT_SESSION_TITLE, maxLength = 100) {
  let text = String(value ?? '');
  text = stripSessionReference(stripInjectedDisplayText(stripSessionEnvelope(text)))
    .replace(/<file\b[^>]*>[\s\S]*?<\/file>/gi, ' ')
    .replace(/\[Pasted text\s*#?\d+(?:\s*(?::[^\]\r\n]*|\+\d+\s+lines))?\]/gi, ' ')
    .replace(MEDIA_DISPLAY_BLOCK, ' ')
    .replace(/^Reference files:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

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
  if (isGeneratedSessionTitleNoise(value)) return String(fallback);
  const legacyMedia = legacyMediaDisplay(value);
  const title = legacyMedia
    ? normalizeSessionTitle(legacyMedia.text, legacyMedia.fallback || fallback, maxLength)
    : normalizeSessionTitle(value, mediaTitleFallback(value) || fallback, maxLength);
  return hasMeaningfulSessionTitleText(title) ? title : String(fallback);
}

export function sessionSummaryTitle(session, fallback = DEFAULT_SESSION_TITLE) {
  if (session?.title) {
    const legacyMedia = legacyMediaDisplay(session.title);
    if (legacyMedia) return normalizeSessionTitle(legacyMedia.text, legacyMedia.fallback || fallback);
    return normalizeSessionTitle(session.title, mediaTitleFallback(session.title) || fallback);
  }
  return generatedSessionTitle(session?.preview || '', fallback);
}

export function promptTitle(prompt, displayText = '') {
  const mediaPart = Array.isArray(prompt)
    ? prompt.find((part) => part?.type === 'image' || part?.type === 'video')
    : null;
  const attachmentFallback = mediaPart?.type === 'video'
    ? '[Video]'
    : mediaPart?.type === 'image'
      ? '[Image]'
    : Array.isArray(prompt) && prompt.some((part) => part?.type === 'file')
      ? '[File]'
      : '';
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
