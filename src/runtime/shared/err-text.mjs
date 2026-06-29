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

function compactDurationForStatus(value, { preferMinutes = false } = {}) {
  const ms = Math.max(0, Number(value) || 0);
  if (ms >= 1_000) {
    if (preferMinutes && ms >= 60_000 && ms % 60_000 === 0) return `${Math.round(ms / 60_000)}m`;
    if (ms < 600_000 && ms % 1_000 === 0) return `${Math.round(ms / 1_000)}s`;
    if (ms >= 60_000 && ms % 60_000 === 0) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 1_000)}s`;
  }
  return `${ms}ms`;
}

function parseDurationTokenToMs(token) {
  const t = String(token || '').trim().toLowerCase();
  const minutes = /^(\d+)m$/.exec(t);
  if (minutes) return Number(minutes[1]) * 60_000;
  const seconds = /^(\d+)s$/.exec(t);
  if (seconds) return Number(seconds[1]) * 1_000;
  const millis = /^(\d+)ms$/.exec(t);
  if (millis) return Number(millis[1]);
  return NaN;
}

function watchdogMsFromRawError(raw) {
  const value = String(raw || '');
  const timeout = /first response stale\s*\((\d+)ms\)/i.exec(value);
  if (timeout) return { kind: 'timeout', ms: Number(timeout[1]) };
  const stale = /(?:agent )?(?:task|tool running) stale\s*\((\d+)ms/i.exec(value);
  if (stale) return { kind: 'stale', ms: Number(stale[1]) };
  return null;
}

function compactReasonFromNormalizedTimeout(presented) {
  const match = /no first response from (?:the )?[\w\s]*within (\d+m|\d+s|\d+ms)/i.exec(String(presented || ''));
  if (!match) return '';
  const ms = parseDurationTokenToMs(match[1]);
  return Number.isFinite(ms)
    ? `No first response ${compactDurationForStatus(ms)}`
    : `No first response ${match[1]}`;
}

function compactReasonFromNormalizedStale(presented) {
  const match = /went stale after (\d+m|\d+s|\d+ms)/i.exec(String(presented || ''));
  if (!match) return '';
  const ms = parseDurationTokenToMs(match[1]);
  return Number.isFinite(ms)
    ? `No progress ${compactDurationForStatus(ms, { preferMinutes: true })}`
    : `No progress ${match[1]}`;
}

export function isBackgroundErrorOnlyBody(body, error = '') {
  const trimmed = String(body ?? '').trim();
  if (!trimmed) return false;
  const err = String(error ?? '').trim();
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return false;
  const line = lines[0];
  if (/^error:\s*/i.test(line)) return true;
  if (!err) return /^error:\s*/i.test(line);
  const stripped = stripErrorPrefix(line);
  const presented = presentErrorText(err, { max: 500 });
  return line === err
    || line === `Error: ${err}`
    || stripped === err
    || line === `Error: ${presented}`
    || stripped === presented;
}

function subjectForSurface(surface) {
  const value = String(surface || '').toLowerCase();
  if (value.includes('search') || value.includes('web')) return 'web search agent';
  if (value.includes('agent') || value.includes('task')) return 'agent';
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

  if (/\bAGENT_CONTEXT_OVERFLOW\b|agent context overflow|latest turn cannot fit|context budget|context window/i.test(text)) {
    return 'Context too large.';
  }
  if (/\bcompact(?:ion)?\b.*\b(?:failed|error|overflow)\b|\b(?:failed|error)\b.*\bcompact(?:ion)?\b/i.test(text)) {
    return 'Compact failed.';
  }

  const quotaRetry = /retryAfter=([^\s:]+)/i.exec(text);
  if (/\b429\b|rate[_ -]?limit|quota|too many requests|resource exhausted|insufficient_quota|quota_exceeded/i.test(text)) {
    const provider = /Anthropic OAuth/i.test(text) ? 'Anthropic' : 'Provider';
    return `${provider} quota/rate limit hit${quotaRetry?.[1] ? `; retry after ${quotaRetry[1]}` : ''}.`;
  }

  const firstResponse = /(?:agent\s+)?first response stale\s*\((\d+)ms\)/i.exec(text);
  if (firstResponse) {
    return `No first response from the ${subject} within ${formatDurationMs(firstResponse[1])}.`;
  }

  const stale = /agent (?:task|tool running) stale\s*\((\d+)ms[^)]*\)/i.exec(text)
    || /tool running stale\s*\((\d+)ms[^)]*\)/i.exec(text)
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

/**
 * Compact `Failed · reason` label for background task/agent failure cards.
 */
export function backgroundTaskFailureStatusLabel(status, error, options = {}) {
  const surface = options.surface || options.tool || '';
  const raw = String(error ?? '').trim();
  const statusNorm = String(status || '').trim().toLowerCase();
  const terminal = /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(statusNorm);
  if (!raw && !terminal) return '';

  const presented = presentErrorText(error, { surface, max: 160 });
  const watchdog = watchdogMsFromRawError(raw);

  let head = 'Failed';
  if (/^(cancelled|canceled)$/i.test(statusNorm)) head = 'Cancelled';
  else if (
    /^timeout$/i.test(statusNorm)
    || watchdog?.kind === 'timeout'
    || /first response stale/i.test(raw)
    || /no first response from/i.test(presented)
  ) head = 'Timeout';
  else if (
    watchdog?.kind === 'stale'
    || /(?:agent )?(?:task|tool running) stale|went stale without/i.test(raw)
    || /went stale after/i.test(presented)
  ) head = 'Stale';

  let reason = '';
  if (/\bcontext too large\b/i.test(presented)) {
    reason = 'Context too large';
  } else if (head === 'Timeout') {
    if (watchdog?.kind === 'timeout') {
      reason = `No first response ${compactDurationForStatus(watchdog.ms)}`;
    } else {
      reason = compactReasonFromNormalizedTimeout(presented) || presented.replace(/\.$/, '');
    }
  } else if (head === 'Stale') {
    if (watchdog?.kind === 'stale') {
      reason = `No progress ${compactDurationForStatus(watchdog.ms, { preferMinutes: true })}`;
    } else {
      reason = compactReasonFromNormalizedStale(presented) || presented.replace(/\.$/, '');
    }
  } else {
    reason = presented.replace(/\.$/, '');
  }
  if (!reason) return head;
  return `${head} · ${reason}`;
}

export function errorLine(error, options = {}) {
  const text = presentErrorText(error, options);
  return /^error\s*:/i.test(text) ? text : `Error: ${text}`;
}
