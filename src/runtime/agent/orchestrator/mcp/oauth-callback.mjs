import { timingSafeEqual } from 'node:crypto';
import { OAUTH_PAGE_CONTENT_TYPE, oauthErrorHtml, oauthSuccessHtml } from '../providers/lib/oauth-page.mjs';

/** Upper bound of a pasted redirect URL (`completeMcpLogin`). */
export const MCP_OAUTH_CALLBACK_MAX_BYTES = 64 * 1024;
// Fixed messages: a pasted URL carries the authorization code and is never
// echoed into an error, a log or a status.
const INVALID_CALLBACK_PASTE =
  'The pasted sign-in URL is invalid. Paste the full address the browser was redirected to after signing in.';
export const MCP_OAUTH_CALLBACK_NOT_PENDING = 'MCP OAuth sign-in is not waiting for a callback';
const sameState = (supplied, expected) => {
  const a = Buffer.from(supplied || '');
  const b = Buffer.from(expected || '');
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The outcome of a redirect URL pasted from the browser for a pending login
 * whose redirect URI is `redirectUrl` and state `state`: `{ code }`, or
 * `{ denied: true }` for an authorization error. Throws a fixed message (never
 * the pasted text) for anything that is not exactly that login's callback.
 */
export function parsePastedMcpOAuthCallback(pasted, { redirectUrl, state }) {
  const invalid = () => new Error(INVALID_CALLBACK_PASTE);
  if (typeof pasted !== 'string' || Buffer.byteLength(pasted) > MCP_OAUTH_CALLBACK_MAX_BYTES) throw invalid();
  const raw = pasted.trim();
  let target;
  let expected;
  try {
    target = new URL(raw);
    expected = new URL(redirectUrl);
  } catch {
    throw invalid();
  }
  if (
    raw.includes('#') ||
    target.username ||
    target.password ||
    target.origin !== expected.origin ||
    target.pathname !== expected.pathname
  )
    throw invalid();
  const seen = new Set();
  for (const [key, value] of target.searchParams) {
    if (seen.has(key)) throw invalid();
    seen.add(key);
    // The redirect URI's own parameters come back unchanged; any others an
    // authorization server adds (e.g. Google's scope/authuser/prompt) are
    // ignored, as in Codex's parse_callback_url.
    if (expected.searchParams.has(key) && expected.searchParams.get(key) !== value) throw invalid();
  }
  for (const key of expected.searchParams.keys()) if (!seen.has(key)) throw invalid();
  if (!sameState(target.searchParams.get('state'), state)) throw invalid();
  if (seen.has('code') === seen.has('error')) throw invalid();
  if (seen.has('error')) return { denied: true };
  const code = target.searchParams.get('code');
  if (!code) throw invalid();
  return { code };
}

// Answers a request to the loopback redirect URI: only a GET of the exact
// callback path and host, carrying exactly the pending state (compared in
// constant time) and either one code or an error, finishes the login.
export function answerOAuthCallback(req, res, { redirectUrl, state, finish, serverName }) {
  const page = (status, html) => {
    res.writeHead(status, {
      'Content-Type': OAUTH_PAGE_CONTENT_TYPE,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  };
  const invalid = () => page(400, oauthErrorHtml('This sign-in link is invalid or has expired.'));
  let target;
  try {
    target = new URL(req.url || '/', redirectUrl);
  } catch {
    invalid();
    return;
  }
  // `finish` is absent once the login was answered (e.g. by a pasted URL).
  const valid =
    typeof finish === 'function' &&
    req.method === 'GET' &&
    req.headers.host === new URL(redirectUrl).host &&
    target.pathname === '/oauth/callback' &&
    target.searchParams.getAll('state').length === 1 &&
    sameState(target.searchParams.get('state'), state);
  if (!valid || (!target.searchParams.has('error') && target.searchParams.getAll('code').length !== 1)) {
    invalid();
    return;
  }
  const server = serverName || 'the MCP server';
  if (target.searchParams.has('error')) {
    // The authorization server's error text is never reflected.
    page(400, oauthErrorHtml(`Sign-in to ${server} was not completed.`));
    finish(undefined);
    return;
  }
  page(200, oauthSuccessHtml(server));
  finish(target.searchParams.get('code'));
}
