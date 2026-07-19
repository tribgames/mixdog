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
  /^\[(?:truncated|request interrupted by user)\]$/i,
  /^a previous model worked on this task and produced the compacted handoff summary below\b/i,
  /^the async (?:agent|shell) task\b/i,
  /^#\s*permission\b/i,
  /^permission:\s*/i,
  /^cwd:\s*/i,
]);

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

/**
 * Produces the stable, user-facing label used by the desktop shell. The core
 * preview remains untouched because the TUI uses it as a recent-message
 * preview; desktop titles deliberately strip runtime envelopes and payloads.
 */
export function normalizeSessionTitle(value, fallback = DEFAULT_SESSION_TITLE, maxLength = 100) {
  let text = String(value ?? '');
  text = stripInjectedDisplayText(stripSessionEnvelope(text))
    .replace(/<file\b[^>]*>[\s\S]*?<\/file>/gi, ' ')
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

export function generatedSessionTitle(value, fallback = DEFAULT_SESSION_TITLE, maxLength = 50) {
  if (isGeneratedSessionTitleNoise(value)) return String(fallback);
  return normalizeSessionTitle(value, fallback, maxLength);
}

export function sessionSummaryTitle(session, fallback = DEFAULT_SESSION_TITLE) {
  if (session?.title) return normalizeSessionTitle(session.title, fallback);
  return generatedSessionTitle(session?.preview || '', fallback);
}

export function promptTitle(prompt, displayText = '') {
  const imageFallback = Array.isArray(prompt) && prompt.some((part) => part?.type === 'image')
    ? '[Image]'
    : '';
  if (displayText) return generatedSessionTitle(displayText, imageFallback);
  if (typeof prompt === 'string') return generatedSessionTitle(prompt, '');
  if (!Array.isArray(prompt)) return '';
  const text = prompt
    .filter((part) => part?.type === 'text')
    .map((part) => String(part?.text || ''))
    .join(' ');
  return generatedSessionTitle(text, imageFallback);
}
