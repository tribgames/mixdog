// MiMo browser login. The platform encrypts the minted API key to a one-shot
// X25519 public key we send in the authorize URL; the reply (loopback redirect
// or a pasted code) carries `u` = ephemeralPub(32) | nonce(12) | ciphertext | tag(16).
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { openLoginUrl } from './lib/open-login-url.mjs';
import {
  authorizeEndpoint,
  manualRedirectUri,
  resultUrl,
  LOGIN_TIMEOUT_MS,
  ensureTokenPlanBaseUrl,
  getKeyName,
  normalizeMimoBaseUrl,
  saveTokens,
} from './mimo-oauth-tokens.mjs';

// Fixed SPKI prefix for a raw 32-byte X25519 public key.
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const EPHEMERAL_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MAX_API_KEY_LEN = 512;
const MAX_UID_LEN = 128;

export function generateLoginKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { privateKey, publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
}

// Decrypt the `u` payload into { apiKey, uid, baseUrl }.
export function decryptMimoPayload(u, privateKey) {
  const bytes = Buffer.from(String(u || '').trim(), 'base64url');
  if (bytes.length <= EPHEMERAL_LEN + NONCE_LEN + TAG_LEN) throw new Error('[mimo-oauth] payload too short');
  const ephemeral = bytes.subarray(0, EPHEMERAL_LEN);
  const nonce = bytes.subarray(EPHEMERAL_LEN, EPHEMERAL_LEN + NONCE_LEN);
  const sealed = bytes.subarray(EPHEMERAL_LEN + NONCE_LEN, bytes.length - TAG_LEN);
  const tag = bytes.subarray(bytes.length - TAG_LEN);
  const publicKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, ephemeral]),
    format: 'der',
    type: 'spki',
  });
  const key = createHash('sha256').update(diffieHellman({ privateKey, publicKey })).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  let doc;
  try {
    doc = JSON.parse(Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf-8'));
  } catch {
    throw new Error('[mimo-oauth] could not decrypt the authorization payload');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('[mimo-oauth] authorization payload is not an object');
  }
  const apiKey = typeof doc.sk === 'string' ? doc.sk.trim() : '';
  if (!apiKey) throw new Error('[mimo-oauth] authorization payload carried no API key');
  if (apiKey.length > MAX_API_KEY_LEN || !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('[mimo-oauth] authorization payload carried a malformed API key');
  }
  const uidPresent = doc.uid !== undefined && doc.uid !== null && doc.uid !== '';
  if (uidPresent && typeof doc.uid !== 'string' && !Number.isFinite(doc.uid)) {
    throw new Error('[mimo-oauth] authorization payload carried a malformed account id');
  }
  const uid = uidPresent ? String(doc.uid) : '';
  if (uid.length > MAX_UID_LEN || /[\x00-\x1f\x7f]/.test(uid)) {
    throw new Error('[mimo-oauth] authorization payload carried a malformed account id');
  }
  const baseUrl = doc.url === undefined || doc.url === null || doc.url === '' ? '' : normalizeMimoBaseUrl(doc.url);
  return { apiKey, uid, baseUrl };
}

// A pasted value may be the bare code or the full callback URL containing it.
function codeFromInput(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('[mimo-oauth] authorization code is required');
  if (/^https?:\/\//i.test(text)) {
    const u = new URL(text).searchParams.get('u');
    if (!u) throw new Error('[mimo-oauth] callback URL has no authorization code');
    return u;
  }
  return text;
}

function authorizeUrl(pk, redirectUri, keyName) {
  const url = new URL(authorizeEndpoint());
  url.searchParams.set('pk', pk);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('kn', 'mimocode');
  url.searchParams.set('key_name', keyName);
  return url.toString();
}

function resultRedirect(error) {
  const url = new URL(resultUrl());
  url.searchParams.set('status', error ? 'error' : 'success');
  if (error) url.searchParams.set('message', String(error.message || error).slice(0, 200));
  return url.toString();
}

// Every loopback address `localhost` can resolve to (IPv4 and IPv6), so the
// browser reaches the callback whichever family it picks.
async function loopbackAddresses() {
  try {
    const found = await lookup('localhost', { all: true });
    const addresses = [...new Set(found.map((entry) => entry.address))];
    if (addresses.length) return addresses;
  } catch {
    /* fall back below */
  }
  return ['127.0.0.1'];
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export async function beginOAuthLogin({
  openBrowser = true,
  timeoutMs = LOGIN_TIMEOUT_MS,
  fetchImpl = undefined,
  addresses = null,
  printUrl = false,
} = {}) {
  const { privateKey, publicKeyB64 } = generateLoginKeyPair();
  const keyName = getKeyName();

  const servers = [];
  const work = new AbortController();
  let timer = null;
  let finish = null;
  let settled = false;
  let url = '';
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
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(
      () => finish(null, new Error(`[mimo-oauth] login timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs
    );
  });
  // The caller may only use the pasted-code path; a later timeout/cancel must not be an unhandled rejection.
  waitForCallback.catch(() => {});

  // A Token Plan key without a gateway URL is routed to its region first. The
  // credential is written only while the login is still open, then the login
  // is completed in the same synchronous step.
  const settle = async (decrypted) => {
    const resolved = await ensureTokenPlanBaseUrl(decrypted, { fetchImpl, signal: work.signal, persist: false });
    if (settled) throw new Error('[mimo-oauth] login is no longer active');
    const tokens = saveTokens(resolved);
    finish(tokens);
    return tokens;
  };

  const onRequest = async (req, res) => {
    const target = new URL(req.url || '/', 'http://localhost');
    const u = target.pathname === '/' ? target.searchParams.get('u') : null;
    if (!u || settled) {
      res.writeHead(404);
      res.end();
      return;
    }
    // Only a payload sealed to this login's key settles it; anything else is
    // answered with an error and the login keeps waiting.
    let decrypted;
    try {
      decrypted = decryptMimoPayload(u, privateKey);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid authorization payload');
      return;
    }
    try {
      await settle(decrypted);
      res.writeHead(302, { Location: resultRedirect(null) });
      res.end();
    } catch (err) {
      res.writeHead(302, { Location: resultRedirect(err) });
      res.end();
      finish(null, err instanceof Error ? err : new Error(String(err)));
    }
  };

  let port = 0;
  let bindError = null;
  for (const address of addresses || (await loopbackAddresses())) {
    const server = createServer(onRequest);
    try {
      await listenOn(server, port, address);
    } catch (err) {
      // A failed address only matters when no other listener comes up.
      bindError = err;
      continue;
    }
    // Once bound, a runtime fault on this listener ends the login.
    server.on('error', (err) => finish(null, new Error(`[mimo-oauth] callback server failed: ${err?.message || err}`)));
    servers.push(server);
    port = server.address().port;
  }
  if (!servers.length) {
    const err = bindError || new Error('[mimo-oauth] no loopback address to listen on');
    finish(null, err);
    throw err;
  }
  url = authorizeUrl(publicKeyB64, `http://localhost:${port}/`, keyName);
  const manualUrl = authorizeUrl(publicKeyB64, manualRedirectUri(), keyName);
  // The URL carries the one-shot login public key. The interactive surfaces
  // (TUI, desktop) receive it in the returned handle and show it to the user
  // only; it is printed to the terminal solely for the headless loginOAuth().
  if (printUrl) {
    process.stderr.write(
      `\n[mimo-oauth] Open this URL to log in:\n${url}\n\nOr, if the browser is on another machine:\n${manualUrl}\n\n`
    );
  }
  if (openBrowser) await openLoginUrl('mimo-oauth', url);

  return {
    provider: 'mimo-oauth',
    url,
    manualUrl,
    port,
    waitForCallback,
    completeCode: async (input) => settle(decryptMimoPayload(codeFromInput(input), privateKey)),
    cancel: () => {
      finish?.(null);
    },
  };
}

export async function loginOAuth() {
  const login = await beginOAuthLogin({ printUrl: true });
  return await login.waitForCallback;
}
