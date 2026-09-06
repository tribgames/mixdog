import { transportErrorText } from './transport-error-text.mjs';

const DETAILS_LIMIT = 12_000;
const SUMMARY_LIMIT = 180;

/** Diagnostic text must be safe before it reaches a view, copy button or log. */
export function safeErrorDetails(value) {
  let text = String(value ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\b((?:https?|ssh):\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/([?&](?:token|access_token|refresh_token|api_key|key|code|signature|sig)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|client_secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/data:[\w.+/-]+;base64,[A-Za-z0-9+/=\s]+/g, '[image data]')
    .replace(/(["']data["']\s*:\s*["'])[A-Za-z0-9+/=]{256,}(["'])/g, '$1[image data]$2')
    .trim();
  if (text.length > DETAILS_LIMIT) text = `${text.slice(0, DETAILS_LIMIT)}\n…`;
  return text;
}

function messageOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string') return value.message;
    if (typeof value.detail === 'string') return value.detail;
    try { return JSON.stringify(value); } catch { return 'Unknown error'; }
  }
  return value == null ? '' : String(value);
}

function unwrap(value) {
  const raw = messageOf(value).trim();
  const start = raw.indexOf('{');
  let parsed;
  if (start >= 0) {
    try { parsed = JSON.parse(raw.slice(start)); } catch { /* not a JSON envelope */ }
  }
  const envelope = parsed && typeof parsed === 'object' ? parsed : value;
  const nested = envelope?.error;
  const message = typeof nested === 'string' ? nested
    : typeof nested?.message === 'string' ? nested.message
      : typeof envelope?.message === 'string' ? envelope.message : raw;
  const status = Number(value?.httpStatus || value?.status || value?.response?.status
    || envelope?.status || /\b(?:API|HTTP(?: fallback)?)\s+([45]\d\d)\b/i.exec(raw)?.[1] || 0);
  const code = String(nested?.code || nested?.type || envelope?.code || '');
  return { raw, message, status, code };
}

/** Presentation only: never changes retry policy or the underlying failure. */
export function describeError(value) {
  const { raw, message, status, code } = unwrap(value);
  const details = safeErrorDetails(raw);
  const clean = safeErrorDetails(message)
    .replace(/^(?:Error invoking remote method ['"][^'"]+['"]:\s*)?(?:Error:\s*)?/i, '')
    .trim();
  let kind = 'unknown';
  let summary = '';
  let recovery = '';
  const transport = transportErrorText(value) || transportErrorText(raw);
  if (status === 401 || status === 403 || /\b(?:invalid|expired)\s+(?:api[ _-]?key|access token|credentials?)\b|Provider authentication failed/i.test(clean)) {
    kind = 'authentication';
    summary = 'Provider authentication failed';
    recovery = 'Check your sign-in or API key, then try again.';
  } else if (/image.*dimensions.*exceed|image.*(?:too large|maximum.*(?:size|dimension))|many-image requests|An attached image exceeds the provider limit/i.test(clean)) {
    kind = 'image-size';
    summary = 'An attached image exceeds the provider limit.';
    recovery = 'Reduce the image dimensions or number of images, then try again.';
  } else if (status === 413 || /payload too large|request (?:body )?too large|The request exceeds the size limit/i.test(clean)) {
    kind = 'payload-size';
    summary = 'The request exceeds the size limit.';
    recovery = 'Reduce the attachments or request size, then try again.';
  } else if (status === 429 || /rate[_ -]?limit|quota.*(?:hit|exceed)|too many requests|The provider usage limit was reached/i.test(clean)) {
    kind = 'rate-limit';
    summary = 'The provider usage limit was reached.';
    recovery = 'Wait for the limit to reset or choose another account.';
  } else if (transport) {
    kind = 'connection';
    summary = transport.replace(/\.$/, '');
    recovery = 'Check the connection, then try again.';
  } else if (status === 400 || status === 422 || code === 'invalid_request_error'
    || clean === 'The provider rejected this request.') {
    kind = 'request';
    summary = 'The provider rejected this request.';
    recovery = 'Review the request details before trying again.';
  } else {
    const lines = clean.split('\n').map((line) => line.trim()).filter(Boolean);
    const first = lines.find((line) => !/^at\s|^\{|^<!doctype|^<html/i.test(line)) || '';
    summary = first && !/^[{[]|^<|(?:API|HTTP)\s+[45]\d\d.*[<{]/i.test(first)
      ? first : 'Something went wrong.';
  }
  summary = summary.replace(/\s+/g, ' ').trim() || 'Something went wrong.';
  if (summary.length > SUMMARY_LIMIT) summary = `${summary.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`;
  return {
    kind, summary, recovery, details,
    // Known structured failures ignore volatile indexes; unknown failures
    // retain their diagnostic identity rather than merging unrelated work.
    fingerprint: kind === 'unknown' ? details : `${kind}:${status || ''}`,
  };
}
