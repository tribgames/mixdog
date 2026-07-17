const DEFAULT_SESSION_TITLE = 'Untitled session';

export function stripSessionEnvelope(value) {
  return String(value ?? '')
    .replace(/^# Session\r?\n(?:(?:Cwd|Model|Workflow):[^\r\n]*(?:\r?\n|$))+(?:\r?\n)?/i, '')
    .replace(/^#\s*Session\s+Cwd:\s+.*?\s+Model:\s+.*?\s+Workflow:\s+\S+\s*/i, '')
    // Truncated previews may cut the envelope mid-way: strip progressively.
    .replace(/^#\s*Session\s+Cwd:\s+\S+(?:\s+Model:\s+\S*)?(?:\s+Workflow:\s+\S*)?\s*/i, '');
}

/**
 * Produces the stable, user-facing label used by the desktop shell. The core
 * preview remains untouched because the TUI uses it as a recent-message
 * preview; desktop titles deliberately strip runtime envelopes and payloads.
 */
export function normalizeSessionTitle(value, fallback = DEFAULT_SESSION_TITLE, maxLength = 100) {
  let text = String(value ?? '');
  text = stripSessionEnvelope(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<file\b[^>]*>[\s\S]*?<\/file>/gi, ' ')
    .replace(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/gi, ' ')
    .replace(/\[(?:Pasted text|Image)\s*#?\d+(?:\s*(?::[^\]\r\n]*|\+\d+\s+lines))?\]/gi, ' ')
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

export function sessionSummaryTitle(session, fallback = DEFAULT_SESSION_TITLE) {
  return normalizeSessionTitle(session?.title || session?.preview || '', fallback);
}

export function promptTitle(prompt, displayText = '') {
  const imageFallback = Array.isArray(prompt) && prompt.some((part) => part?.type === 'image')
    ? '[Image]'
    : '';
  if (displayText) return normalizeSessionTitle(displayText, imageFallback);
  if (typeof prompt === 'string') return normalizeSessionTitle(prompt, '');
  if (!Array.isArray(prompt)) return '';
  const text = prompt
    .filter((part) => part?.type === 'text')
    .map((part) => String(part?.text || ''))
    .join(' ');
  return normalizeSessionTitle(text, imageFallback);
}
