export function errText(e) {
  if (e == null) return String(e);
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.name || String(e);
  // ErrorEvent / event-like / plain object (NOT instanceof Error)
  if (typeof e.message === 'string' && e.message) return e.message;
  if (e.error != null && e.error !== e) return errText(e.error);
  if (e.reason != null && e.reason !== e) return errText(e.reason);
  if (typeof e.type === 'string' && e.type) return `${e.type} event`;
  try { const j = JSON.stringify(e); if (j && j !== '{}' && j !== 'null') return j; } catch {}
  return String(e);
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function stripErrorPrefix(value) {
  return String(value ?? '')
    .replace(/^\s*(?:\[[^\]]*error[^\]]*\]|error)\s*[:\-]\s*/i, '')
    .trim();
}

function extractJsonError(text) {
  const value = String(text ?? '').trim();
  if (!value.startsWith('{') && !value.startsWith('[')) return '';
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error;
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
      if (parsed.error != null) return errText(parsed.error);
    }
  } catch {}
  return '';
}

function extractEmbeddedError(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(?:error|failure|failed)\s*[:=]\s*(.+?)\s*$/i.exec(line);
    if (match?.[1]) return match[1];
  }
  return '';
}

function formatDurationMs(value) {
  const ms = Math.max(0, Number(value) || 0);
  if (ms >= 60_000 && ms % 60_000 === 0) return `${Math.round(ms / 60_000)}m`;
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${ms}ms`;
}

function subjectForSurface(surface) {
  const value = String(surface || '').toLowerCase();
  if (value.includes('search') || value.includes('web')) return 'web search agent';
  if (value.includes('bridge') || value.includes('agent') || value.includes('task')) return 'agent';
  return 'tool';
}

function capText(value, max) {
  const text = String(value ?? '').trim();
  const limit = Math.max(32, Number(max) || 240);
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 3))}...` : text;
}

export function presentErrorText(error, options = {}) {
  const surface = options.surface || options.tool || '';
  const subject = subjectForSurface(surface);
  const max = options.max ?? 240;
  let text = errText(error);
  const jsonError = extractJsonError(text);
  if (jsonError) text = jsonError;
  const embeddedError = extractEmbeddedError(text);
  if (embeddedError) text = embeddedError;
  text = oneLine(stripErrorPrefix(text));
  if (!text) return 'Unknown error';

  if (/\bBRIDGE_CONTEXT_OVERFLOW\b|bridge context overflow|latest turn cannot fit|context budget|context window/i.test(text)) {
    return 'Context too large.';
  }
  if (/\bcompact(?:ion)?\b.*\b(?:failed|error|overflow)\b|\b(?:failed|error)\b.*\bcompact(?:ion)?\b/i.test(text)) {
    return 'Compact failed.';
  }

  const firstResponse = /(?:bridge\s+)?first response stale\s*\((\d+)ms\)/i.exec(text);
  if (firstResponse) {
    return `No first response from the ${subject} within ${formatDurationMs(firstResponse[1])}.`;
  }

  const stale = /bridge task stale\s*\((\d+)ms[^)]*\)/i.exec(text)
    || /task stale\s*\((\d+)ms[^)]*\)/i.exec(text);
  if (stale) {
    return `The ${subject} went stale after ${formatDurationMs(stale[1])} without new stream/tool progress.`;
  }

  if (/Session\s+"sess_[^"]+"\s+closed:\s*aborted during call/i.test(text)) {
    return `${subject[0].toUpperCase()}${subject.slice(1)} stopped while waiting for a response.`;
  }

  if (/Session\s+"sess_[^"]+"\s+closed:\s*closed during call/i.test(text)) {
    return `${subject[0].toUpperCase()}${subject.slice(1)} stopped before the response completed.`;
  }

  if (/parent signal aborted/i.test(text)) {
    return `${subject[0].toUpperCase()}${subject.slice(1)} was cancelled by its caller.`;
  }

  text = text
    .replace(/Session\s+"sess_[^"]+"\s+closed:\s*/gi, 'Session closed: ')
    .replace(/\bsess_[A-Za-z0-9_-]+\b/g, 'session')
    .replace(/\brun_[A-Za-z0-9_-]{16,}\b/g, 'run')
    .replace(/\s+/g, ' ')
    .trim();

  return capText(text || 'Unknown error', max);
}

export function errorLine(error, options = {}) {
  const text = presentErrorText(error, options);
  return /^error\s*:/i.test(text) ? text : `Error: ${text}`;
}
