/**
 * Secret detection and redaction for every string that leaves the browser
 * host: page text, URLs, network bodies, dialog messages, and errors. Nothing
 * here knows about pages or CDP — callers pass text in and get safe text out.
 */

function decodedUrlCandidates(raw: string): string[] {
  const values = [String(raw || '')];
  for (let index = 0; index < 2; index += 1) {
    try {
      const decoded = decodeURIComponent(values.at(-1)!.replace(/\+/g, '%20'));
      if (decoded === values.at(-1)) break;
      values.push(decoded);
    } catch {
      break;
    }
  }
  return values;
}

export function browserUrlContainsSecret(raw: string): boolean {
  const candidates = decodedUrlCandidates(raw);
  const tokenPatterns = [
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
    /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  ];
  if (candidates.some((candidate) => tokenPatterns.some((pattern) => pattern.test(candidate)))) {
    return true;
  }
  try {
    const parsed = new URL(raw);
    for (const [key, value] of parsed.searchParams) {
      if (value && (
        /^(?:access[_-]?token|api[_-]?key|apikey|authorization|id[_-]?token|password|passwd|refresh[_-]?token|secret|session[_-]?(?:id|token)|token)$/i.test(key)
        || (key.toLowerCase() === 'code' && value.length >= 8)
      )) {
        return true;
      }
    }
  } catch {
    // The caller owns URL syntax validation; raw token detection above still applies.
  }
  return false;
}

export function redactBrowserText(value: unknown): string {
  let text = String(value ?? '');
  text = text.replace(
    /\b(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    (_match, scheme: string, user: string) => `${scheme}${user}:***@`,
  );
  text = text.replace(
    /([?&](?:access[_-]?token|api[_-]?key|apikey|auth|authorization|code|id[_-]?token|key|password|passwd|refresh[_-]?token|secret|session[_-]?(?:id|token)|token)=)[^&#\s]*/gi,
    '$1[REDACTED]',
  );
  text = text.replace(
    /((?:"|')?(?:access[_-]?token|api[_-]?key|apikey|authorization|id[_-]?token|password|passwd|refresh[_-]?token|secret|session[_-]?(?:id|token)|token)(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,\s;&}\]\r\n]+)/gi,
    '$1[REDACTED]',
  );
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '[REDACTED_AUTH]');
  text = text.replace(/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]');
  text = text.replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]');
  text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]');
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    '[REDACTED_JWT]',
  );
  text = text.replace(/^((?:set-)?cookie\s*:\s*).+$/gim, '$1[REDACTED]');
  return text;
}

export function redactBrowserKnownSecrets(
  value: string,
  secrets: Iterable<string>,
): string {
  let redacted = value;
  const marker = '[REDACTED STORED CREDENTIAL]';
  for (const secret of secrets) {
    if (!secret) continue;
    const mask = '*'.repeat(secret.length);
    const replacement = secret.length >= marker.length && secret !== marker
      ? marker
      : mask === secret ? '•'.repeat(secret.length) : mask;
    redacted = redacted.replaceAll(secret, replacement);
  }
  return redacted;
}

export function redactBrowserUrl(value: unknown): string {
  const raw = String(value ?? '');
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = '[REDACTED]';
    if (parsed.password) parsed.password = '[REDACTED]';
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase() === 'code'
        || /(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|id[_-]?token|key|password|passwd|refresh[_-]?token|secret|session[_-]?(?:id|token)|token)/i.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]');
      }
    }
    return redactBrowserText(parsed.href);
  } catch {
    return redactBrowserText(raw);
  }
}
