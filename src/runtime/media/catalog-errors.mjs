/** Safe catalog diagnostics: never expose raw upstream bodies or account ids. */
const MESSAGES = Object.freeze({
  MEDIA_BILLING_BLOCKED: 'API credits exhausted or spending limit reached. Check provider billing.',
  MEDIA_AUTH_REJECTED: 'Authentication failed. Check the API key or reconnect the account.',
  MEDIA_ACCESS_DENIED: 'Model catalog access denied. Check account permissions.',
  MEDIA_RATE_LIMITED: 'Too many requests. Wait a moment and retry.',
  MEDIA_CATALOG_TIMEOUT: 'Model catalog request timed out. Retry after checking the connection.',
  MEDIA_CATALOG_UNAVAILABLE: 'Model catalog unavailable. Retry after checking the provider connection.',
});

export function catalogHttpError(status, text = '') {
  let code = 'MEDIA_CATALOG_UNAVAILABLE';
  if (/credit|spending limit|billing|insufficient_quota|payment required/i.test(text)) code = 'MEDIA_BILLING_BLOCKED';
  else if (status === 401) code = 'MEDIA_AUTH_REJECTED';
  else if (status === 403) code = 'MEDIA_ACCESS_DENIED';
  else if (status === 429) code = 'MEDIA_RATE_LIMITED';
  else if (status === 408 || status === 504) code = 'MEDIA_CATALOG_TIMEOUT';
  return Object.assign(new Error(MESSAGES[code]), { code, status });
}

export function catalogDiagnostic(error) {
  const code = Object.hasOwn(MESSAGES, error?.code) ? error.code
    : error?.name === 'TimeoutError' ? 'MEDIA_CATALOG_TIMEOUT' : 'MEDIA_CATALOG_UNAVAILABLE';
  return { code, message: MESSAGES[code] };
}

/** Preserve the array contract while passing transient status to lane views. */
export function staleCatalog(rows, error) {
  return Object.defineProperty([...rows], 'catalogWarning', {
    value: `Using the last successful model catalog. ${catalogDiagnostic(error).message}`,
  });
}
