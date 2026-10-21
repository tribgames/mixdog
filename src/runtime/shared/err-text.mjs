import { transportErrorText } from './transport-error-text.mjs';
import { describeError, safeErrorDetails } from './error-presentation.mjs';
import { oneLine } from './clean.mjs';
import { TIMEOUT_PHASE, isFirstByteTimeout } from './provider-timeout-phase.mjs';

// HTTP status carried by a provider/transport error, or 0 when absent.
export function errorHttpStatus(err) {
  return Number(err?.httpStatus || err?.status || err?.response?.status || 0) || 0;
}

export function errText(e) {
  if (e == null) return String(e);
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || e.name || String(e);
  // ErrorEvent / event-like / plain object (NOT instanceof Error)
  if (typeof e.message === 'string' && e.message) return e.message;
  if (e.error != null && e.error !== e) return errText(e.error);
  if (e.reason != null && e.reason !== e) return errText(e.reason);
  if (typeof e.type === 'string' && e.type) return `${e.type} event`;
  try {
    const j = JSON.stringify(e);
    if (j && j !== '{}' && j !== 'null') return j;
  } catch {}
  return String(e);
}

function stripErrorPrefix(value) {
  return String(value ?? '')
    .replace(/^\s*(?:\[[^\]]*error[^\]]*\]|error)\s*[:-]\s*/i, '')
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
  const t = String(token || '')
    .trim()
    .toLowerCase();
  const minutes = /^(\d+)m$/.exec(t);
  if (minutes) return Number(minutes[1]) * 60_000;
  const seconds = /^(\d+)s$/.exec(t);
  if (seconds) return Number(seconds[1]) * 1_000;
  const millis = /^(\d+)ms$/.exec(t);
  if (millis) return Number(millis[1]);
  return NaN;
}

function humanizeRetryAfterToken(token) {
  const ms = parseDurationTokenToMs(token);
  if (!Number.isFinite(ms) || ms < 60_000) return String(token || '');
  const totalSeconds = Math.floor(ms / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!days && !hours && seconds) parts.push(`${seconds}s`);
  return parts.join(' ') || String(token || '');
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
  return Number.isFinite(ms) ? `No first response ${compactDurationForStatus(ms)}` : `No first response ${match[1]}`;
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
  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return false;
  const line = lines[0];
  if (/^error:\s*/i.test(line)) return true;
  if (!err) return false;
  const stripped = stripErrorPrefix(line);
  const presented = presentErrorText(err, { max: 500 });
  return (
    line === err ||
    line === `Error: ${err}` ||
    stripped === err ||
    line === `Error: ${presented}` ||
    stripped === presented
  );
}

function subjectForSurface(surface) {
  const value = String(surface || '').toLowerCase();
  if (value.includes('search') || value.includes('web')) return 'web search agent';
  if (value === 'turn' || value.includes('request')) return 'request';
  if (value.includes('agent') || value.includes('task')) return 'agent';
  return 'tool';
}

function capitalize(value) {
  const text = String(value ?? '');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function capText(value, max) {
  const text = String(value ?? '').trim();
  const limit = Math.max(32, Number(max) || 240);
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 3))}...` : text;
}

export function isCancelLikeError(error) {
  if (error == null) return false;
  if (typeof error === 'object') {
    if (error.cancelled === true) return true;
    const name = String(error.name || '');
    if (name === 'SessionClosedError' || name === 'AbortError' || name === 'APIUserAbortError') return true;
  }
  const text = errText(error);
  return (
    /aborted by session close/i.test(text) ||
    /withRetry:\s*(?:sleep )?aborted/i.test(text) ||
    /^sleep aborted$/i.test(text)
  );
}

// One-line reason per provider kind. Fixed sentences (optionally with a
// parenthesised value) are the renderer's translation keys.
const KIND_LINES = {
  overloaded: 'Provider is busy at capacity.',
  rate_limited: ({ retryAfterMs }) =>
    retryAfterMs
      ? `Provider is rate-limited (retry in ${formatDurationMs(retryAfterMs)}).`
      : 'Provider is rate-limited.',
  quota_exhausted: 'Provider usage limit reached.',
  entitlement: 'Not included in your plan.',
  billing: 'Out of credits or at spend limit.',
  permission: 'Access denied by the provider.',
  policy: 'Refused by the provider safety policy.',
  auth: 'Provider authentication failed.',
};

// Typed evidence: a persisted descriptor or structured status/code fields.
// A bare message carries none, so its wording keeps the legacy text path.
function hasTypedEvidence(error) {
  if (!error || typeof error !== 'object') return false;
  return (
    Boolean(error.errorKind?.kind) || errorHttpStatus(error) > 0 || Boolean(error.code) || Boolean(error.retryAfterMs)
  );
}

// The window a provider timeout names (providerTimeoutError's message), or 0.
const timedOutMs = (text) => Number(/timed out after (\d+)ms/i.exec(text)?.[1]) || 0;

// A provider timeout before the model produced anything (isFirstByteTimeout):
// the model is slow, not the connection.
function stillThinkingText(error, text) {
  const ms = Number(error.waitedMs) || timedOutMs(text);
  const provider =
    typeof error.providerLabel === 'string' && error.providerLabel ? error.providerLabel : 'the provider';
  const attempts = Number(error.attempts) > 0 ? `; attempts: ${Math.floor(Number(error.attempts))}` : '';
  return `Model still thinking: no output in ${formatDurationMs(ms)}; ${provider} sent nothing yet${attempts}.`;
}

// Stamped provider timeout phases and stream cuts. Null when the error names
// neither, so the text rules below decide.
function typedStreamFailureText(error, text) {
  if (!error || typeof error !== 'object') return null;
  if (isFirstByteTimeout(error)) return stillThinkingText(error, text);
  if (error.timeoutPhase === TIMEOUT_PHASE.IDLE) {
    const ms = timedOutMs(text);
    return ms > 0 ? `No progress ${formatDurationMs(ms)}.` : 'No progress.';
  }
  // A stream that ended before its finish marker lost its connection.
  if (error.code === 'TRUNCATED_STREAM' && error.streamCorruption !== true) {
    return 'Connection to the provider was lost (TRUNCATED_STREAM).';
  }
  return null;
}

export function presentErrorText(error, options = {}) {
  const presentation = describeError(error);
  if (['image-size', 'payload-size', 'request', 'model-unavailable', 'tool-schema'].includes(presentation.kind)) {
    return presentation.summary;
  }
  const kindLine = hasTypedEvidence(error) ? KIND_LINES[presentation.providerKind] : null;
  if (kindLine && presentation.kind !== 'unknown') {
    return typeof kindLine === 'function' ? kindLine(presentation) : kindLine;
  }
  const surface = options.surface || options.tool || '';
  const subject = subjectForSurface(surface);
  const max = options.max ?? 240;
  let text = errText(error);
  const name = error && typeof error === 'object' ? String(error.name || '') : '';
  const code = error && typeof error === 'object' ? String(error.code || '') : '';
  const status = errorHttpStatus(error);
  // The fixed request overhead error is actionable as written (sizes,
  // contributors, remedy): keep its lines instead of a generic "Context too
  // large." that would suggest compacting.
  if (code === 'TOOL_SURFACE_EXCEEDS_CONTEXT' || /\(TOOL_SURFACE_EXCEEDS_CONTEXT\)/.test(text)) {
    return stripErrorPrefix(text);
  }
  // Likewise a latest message that cannot fit names its size and what would
  // help; a wrapper's prefix ("agent compact failed (...): ") is dropped.
  const latestTurn = /The latest message cannot fit this model \(LATEST_TURN_EXCEEDS_CONTEXT\)[\s\S]*$/.exec(text);
  if (latestTurn) return latestTurn[0].replace(' (LATEST_TURN_EXCEEDS_CONTEXT)', '');
  const jsonError = extractJsonError(text);
  if (jsonError) text = jsonError;
  const embeddedError = extractEmbeddedError(text);
  if (embeddedError) text = embeddedError;
  text = oneLine(stripErrorPrefix(text));
  if (!text) return 'Unknown error';
  const streamFailure = typedStreamFailureText(error, text);
  if (streamFailure) return streamFailure;

  if (code === 'PROVIDER_PREFIX_MUTATION' || name === 'ProviderPrefixMutationError') {
    return 'Session state changed unexpectedly.';
  }
  if (/currently at capacity|at capacity due to high demand|provider overloaded|server overloaded/i.test(text)) {
    return 'Provider is busy at capacity.';
  }
  if (
    status === 401 ||
    status === 403 ||
    /\b(?:invalid|expired)\s+(?:api[ _-]?key|access token|credentials?)\b/i.test(text)
  ) {
    return 'Provider authentication failed.';
  }
  // Connection-level failures (errno / undici cause chain / bare fetch
  // messages / gateway 5xx) collapse to one sentence with the code kept.
  const transport = transportErrorText(error);
  if (transport) return transport;
  if (
    /\bAGENT_CONTEXT_OVERFLOW\b|agent context overflow|latest turn cannot fit|context budget|context window/i.test(text)
  ) {
    return 'Context too large.';
  }
  if (/\bcompact(?:ion)?\b.*\b(?:failed|error|overflow)\b|\b(?:failed|error)\b.*\bcompact(?:ion)?\b/i.test(text)) {
    if (String(surface).toLowerCase().includes('compact')) return capText(text, max);
    return 'Compact failed.';
  }

  const quotaRetry = /retryAfter=([^\s:]+)/i.exec(text);
  if (
    /\b429\b|rate[_ -]?limit|quota|too many requests|resource exhausted|insufficient_quota|quota_exceeded/i.test(text)
  ) {
    const provider = /Anthropic OAuth/i.test(text) ? 'Anthropic' : 'Provider';
    // Cooldown refusals are recoverable right now by switching accounts —
    // surface that path instead of leaving only the wait option.
    const hint = /cooldown/i.test(text) ? ' Re-login or switch the provider account to continue now.' : '';
    return `${provider} quota/rate limit hit${quotaRetry?.[1] ? `; retry after ${humanizeRetryAfterToken(quotaRetry[1])}` : ''}.${hint}`;
  }

  if (isCancelLikeError(error) || name === 'SessionClosedError') {
    return subject === 'request' ? 'Cancelled' : `${capitalize(subject)} was cancelled.`;
  }

  const inactivity = /timed out after (\d+)ms of inactivity/i.exec(text);
  if (name === 'StreamStalledError' || name === 'StreamStalledAbortError' || code === 'ESTREAMSTALL' || inactivity) {
    const ms = inactivity ? Number(inactivity[1]) : 0;
    return Number.isFinite(ms) && ms > 0 ? `No progress ${formatDurationMs(ms)}.` : 'No progress.';
  }

  const firstByte = /first byte timed out after (\d+)ms/i.exec(text);
  if (name === 'ProviderTimeoutError' || code === 'EPROVIDERTIMEOUT' || firstByte) {
    const ms = firstByte ? Number(firstByte[1]) : 0;
    return Number.isFinite(ms) && ms > 0 ? `No first response ${formatDurationMs(ms)}.` : 'No first response.';
  }

  // The agent's own watchdog, worded apart from any provider timeout.
  const firstTransport = /first (?:transport|semantic response) stale\s*\((\d+)ms\)/i.exec(text);
  if (firstTransport) {
    return `Agent watchdog stopped the run: no model response in ${formatDurationMs(firstTransport[1])}.`;
  }

  const firstResponse = /(?:agent\s+)?first response stale\s*\((\d+)ms\)/i.exec(text);
  if (firstResponse) {
    return `No first response from the ${subject} within ${formatDurationMs(firstResponse[1])}.`;
  }

  const stale =
    /agent (?:task|tool running) stale\s*\((\d+)ms[^)]*\)/i.exec(text) ||
    /tool running stale\s*\((\d+)ms[^)]*\)/i.exec(text) ||
    /task stale\s*\((\d+)ms[^)]*\)/i.exec(text);
  if (stale) {
    return `The ${subject} went stale after ${formatDurationMs(stale[1])} without new stream/tool progress.`;
  }

  if (/Session\s+"sess_[^"]+"\s+closed:\s*aborted during call/i.test(text)) {
    return `${capitalize(subject)} stopped while waiting for a response.`;
  }

  if (/Session\s+"sess_[^"]+"\s+closed:\s*closed during call/i.test(text)) {
    return `${capitalize(subject)} stopped before the response completed.`;
  }

  if (/^Session closed:\s*(?:closeSession|closed|aborted)\b/i.test(text)) {
    return `${capitalize(subject)} stopped.`;
  }

  if (/parent signal aborted/i.test(text)) {
    return `${capitalize(subject)} was cancelled by its caller.`;
  }

  text = text
    .replace(/Session\s+"sess_[^"]+"\s+closed:\s*/gi, 'Session closed: ')
    .replace(/\bsess_[A-Za-z0-9_-]+\b/g, 'session')
    .replace(/\brun_[A-Za-z0-9_-]{16,}\b/g, 'run')
    .replace(/\s+/g, ' ')
    .trim();

  return capText(safeErrorDetails(text) || 'Unknown error', max);
}

/** Why a provider request is being retried, as one short status phrase. */
export function retryReasonText(error, options = {}) {
  return presentErrorText(error, {
    surface: options.surface || 'request',
    max: options.max ?? 120,
  }).replace(/\.$/, '');
}

/** The one retry status line every surface shows: `reason · retry n/max in 15s`. */
export function retryStatusLine({ reason, attempt, maxAttempts, delayMs }) {
  const count = Math.max(1, Number(attempt) || 1);
  const max = Math.max(count, Number(maxAttempts) || count);
  const wait = Math.max(0, Number(delayMs) || 0);
  return `${reason} · retry ${count}/${max}${wait > 0 ? ` in ${formatDurationMs(wait)}` : ''}`;
}

/**
 * Compact `Failed · reason` label for background task/agent failure cards.
 */
export function backgroundTaskFailureStatusLabel(status, error, options = {}) {
  const surface = options.surface || options.tool || '';
  const raw = String(error ?? '').trim();
  const statusNorm = String(status || '')
    .trim()
    .toLowerCase();
  const terminal = /^(failed|error|timeout|cancelled|canceled|killed)$/i.test(statusNorm);
  if (!raw && !terminal) return '';

  const presented = presentErrorText(error, { surface, max: 160 });
  const watchdog = watchdogMsFromRawError(raw);

  let head = 'Failed';
  if (/^(cancelled|canceled)$/i.test(statusNorm)) head = 'Cancelled';
  else if (
    /^timeout$/i.test(statusNorm) ||
    watchdog?.kind === 'timeout' ||
    /first response stale/i.test(raw) ||
    /no first response from/i.test(presented) ||
    /^(?:Model still thinking|Agent watchdog stopped the run):/.test(presented)
  )
    head = 'Timeout';
  else if (
    watchdog?.kind === 'stale' ||
    /(?:agent )?(?:task|tool running) stale|went stale without/i.test(raw) ||
    /went stale after/i.test(presented)
  )
    head = 'Stale';

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
