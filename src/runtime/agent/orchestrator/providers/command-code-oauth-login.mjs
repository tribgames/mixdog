// Command Code browser sign-in. The Studio CLI auth page mints a Provider API
// key and POSTs it (with our one-shot state) as JSON to a loopback callback.
// A pasted key or pasted callback JSON completes the same login by hand. The
// first sign-in on a machine adopts an existing Command Code CLI login instead.
import { createServer } from 'node:http';
import { listenOn } from './lib/listen-on.mjs';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openLoginUrl } from './lib/open-login-url.mjs';
import { readProviderAccountPool } from '../../../shared/provider-accounts.mjs';
import { withProviderAccount } from '../../../shared/provider-auth-binding.mjs';
import {
  LOGIN_TIMEOUT_MS,
  PROVIDER_ID,
  STUDIO_ORIGIN,
  fetchCommandCodeIdentity,
  isWellFormedApiKey,
  loadTokens,
  saveTokens,
} from './command-code-oauth-tokens.mjs';

export const CALLBACK_PORT = 5959;
const CALLBACK_PATH = '/callback';
const MAX_CALLBACK_BYTES = 16 * 1024;
const CALLBACK_FIELDS = Object.freeze(['apiKey', 'userId', 'userName', 'keyName']);

const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': STUDIO_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // The Studio page is public and the callback is loopback: Chromium asks first.
  'Access-Control-Allow-Private-Network': 'true',
  Vary: 'Origin',
});

export const defaultLocalAuthPath = () => join(homedir(), '.commandcode', 'auth.json');

/** Validate the Studio callback body against this login's state. */
export function parseCallbackPayload(value, expectedState) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[command-code-oauth] callback body must be an object');
  }
  if (typeof value.state !== 'string' || !expectedState || value.state !== expectedState) {
    throw new Error('[command-code-oauth] callback state mismatch');
  }
  for (const field of CALLBACK_FIELDS) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`[command-code-oauth] callback is missing ${field}`);
    }
  }
  const apiKey = value.apiKey.trim();
  if (!isWellFormedApiKey(apiKey)) throw new Error('[command-code-oauth] callback carried a malformed API key');
  return { apiKey, userId: value.userId.trim(), userName: value.userName.trim(), keyName: value.keyName.trim() };
}

/** A paste is either the callback JSON (state-checked) or a bare API key. */
export function parsePastedInput(input, expectedState) {
  const pasted = String(input ?? '').trim();
  if (!pasted) throw new Error('[command-code-oauth] API key is required');
  if (pasted.startsWith('{')) {
    let doc;
    try {
      doc = JSON.parse(pasted);
    } catch {
      throw new Error('[command-code-oauth] pasted callback is not valid JSON');
    }
    return parseCallbackPayload(doc, expectedState);
  }
  if (!isWellFormedApiKey(pasted)) throw new Error('[command-code-oauth] pasted API key is malformed');
  return { apiKey: pasted, userId: '', userName: '', keyName: '' };
}

// No account of this provider is connected yet: no roster entry and no
// credential in the default slot. Adding a second account or reconnecting an
// existing one must pick a fresh browser identity, never the local CLI login.
function isFirstSignIn() {
  try {
    if (readProviderAccountPool(PROVIDER_ID).accounts.length) return false;
    return !withProviderAccount(PROVIDER_ID, 'default', () => loadTokens());
  } catch {
    // An unreadable roster cannot prove this is the first account.
    return false;
  }
}

function readLocalAuth(path) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf-8'));
    const apiKey = typeof doc?.apiKey === 'string' ? doc.apiKey.trim() : '';
    const userId = typeof doc?.userId === 'string' ? doc.userId.trim() : '';
    return apiKey && userId && isWellFormedApiKey(apiKey) ? { apiKey, userId } : null;
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_CALLBACK_BYTES) {
        reject(new Error('[command-code-oauth] callback body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function reply(res, status, body) {
  res.writeHead(status, { ...CORS_HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) });
  res.end(body ? JSON.stringify(body) : undefined);
}

function authorizeUrl(port, state) {
  const url = new URL('/studio/auth/cli', STUDIO_ORIGIN);
  url.searchParams.set('callback', `http://127.0.0.1:${port}${CALLBACK_PATH}`);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function beginOAuthLogin({
  openBrowser = true,
  timeoutMs = LOGIN_TIMEOUT_MS,
  fetchImpl = fetch,
  port: preferredPort = CALLBACK_PORT,
  importLocal = isFirstSignIn(),
  localAuthPath = defaultLocalAuthPath(),
  printUrl = false,
} = {}) {
  // Validate and store a key under its whoami identity.
  const store = async (candidate, signal) => {
    const identity = await fetchCommandCodeIdentity(candidate.apiKey, { fetchImpl, signal });
    return { apiKey: candidate.apiKey, userId: identity.userId, userName: identity.userName || candidate.userName };
  };

  if (importLocal) {
    const local = readLocalAuth(localAuthPath);
    if (local) {
      let tokens = null;
      try {
        tokens = saveTokens(await store(local));
      } catch {
        /* a stale or rejected CLI login falls through to the browser */
      }
      if (tokens) {
        return {
          provider: PROVIDER_ID,
          url: '',
          manualUrl: null,
          imported: true,
          waitForCallback: Promise.resolve(tokens),
          cancel: () => {},
        };
      }
    }
  }

  const state = randomBytes(32).toString('base64url');
  const servers = [];
  // Open client connections, and the ones still owed a reply by a request
  // that is completing the login.
  const sockets = new Set();
  const replying = new Set();
  const work = new AbortController();
  let timer = null;
  let finish = null;
  let settled = false;
  const waitForCallback = new Promise((resolve, reject) => {
    finish = (value, error = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      work.abort();
      for (const server of servers) {
        try {
          server.close();
        } catch {
          /* already closed */
        }
      }
      // close() only stops accepting: drop every connection (a stalled
      // partial POST included) except those about to get their reply.
      for (const socket of sockets) if (!replying.has(socket)) socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(
      () => finish(null, new Error(`[command-code-oauth] login timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
  });
  // A caller may only use the paste path; a later timeout/cancel must not be an unhandled rejection.
  waitForCallback.catch(() => {});

  // The credential is written only while the login is still open, and the
  // login completes in the same synchronous step.
  const settle = async (candidate) => {
    const tokens = await store(candidate, work.signal);
    if (settled) throw new Error('[command-code-oauth] login is no longer active');
    const saved = saveTokens(tokens);
    finish(saved);
    return saved;
  };

  const handleRequest = async (req, res) => {
    const origin = req.headers.origin;
    if (origin && origin !== STUDIO_ORIGIN) return reply(res, 403, { success: false, error: 'Forbidden origin' });
    if (req.method === 'OPTIONS') return reply(res, 204, null);
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      return reply(res, 400, { success: false, error: 'Bad request' });
    }
    if (pathname !== CALLBACK_PATH || settled) {
      return reply(res, 404, { success: false, error: 'Not found' });
    }
    if (req.method !== 'POST') return reply(res, 405, { success: false, error: 'Method not allowed' });
    // Anything that is not this login's well-formed callback is refused and
    // the login keeps waiting.
    let doc;
    try {
      doc = JSON.parse(await readBody(req));
    } catch {
      return reply(res, 400, { success: false, error: 'Invalid JSON body' });
    }
    let candidate;
    try {
      candidate = parseCallbackPayload(doc, state);
    } catch (err) {
      return reply(res, 400, { success: false, error: String(err.message).replace(/^\[command-code-oauth\]\s*/, '') });
    }
    replying.add(req.socket);
    try {
      await settle(candidate);
      reply(res, 200, { success: true });
    } catch (err) {
      reply(res, 400, { success: false, error: 'API key validation failed' });
      finish(null, err instanceof Error ? err : new Error(String(err)));
    }
  };

  // No request can fail outside this handler; once the login is over, a
  // connection closes as soon as its reply is flushed.
  const onRequest = (req, res) => {
    res.on('finish', () => {
      replying.delete(req.socket);
      if (settled) req.socket.destroy();
    });
    handleRequest(req, res).catch(() => {
      replying.delete(req.socket);
      if (res.headersSent) res.destroy();
      else reply(res, 400, { success: false, error: 'Bad request' });
    });
  };
  const trackSockets = (server) => {
    server.on('connection', (socket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
        replying.delete(socket);
      });
    });
    return server;
  };

  // The advertised callback is 127.0.0.1; ::1 is bound on the same port when
  // possible because `localhost` may resolve to it first.
  let primary = trackSockets(createServer(onRequest));
  try {
    try {
      await listenOn(primary, preferredPort, '127.0.0.1');
    } catch (err) {
      // The fixed port is taken (another login, another app): any free port.
      if (!preferredPort) throw err;
      primary = trackSockets(createServer(onRequest));
      await listenOn(primary, 0, '127.0.0.1');
    }
  } catch (err) {
    finish(null, err);
    throw err;
  }
  const port = primary.address().port;
  servers.push(primary);
  const secondary = trackSockets(createServer(onRequest));
  try {
    await listenOn(secondary, port, '::1');
    servers.push(secondary);
  } catch {
    /* no IPv6 loopback: the IPv4 listener is enough */
  }
  for (const server of servers) {
    server.on('error', (err) =>
      finish(null, new Error(`[command-code-oauth] callback server failed: ${err?.message || err}`))
    );
  }

  const url = authorizeUrl(port, state);
  if (printUrl) process.stderr.write(`\n[command-code-oauth] Open this URL to sign in:\n${url}\n\n`);
  if (openBrowser) await openLoginUrl(PROVIDER_ID, url);

  return {
    provider: PROVIDER_ID,
    url,
    manualUrl: null,
    port,
    waitForCallback,
    completeCode: async (input) => settle(parsePastedInput(input, state)),
    cancel: () => finish(null),
  };
}

export async function loginOAuth() {
  const login = await beginOAuthLogin({ printUrl: true });
  return await login.waitForCallback;
}
