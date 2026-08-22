import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { cursorTokenExpiry } from './cursor-auth.mjs';

const ANTHROPIC_DEFAULT_CREDENTIALS_PATH = join(resolvePluginData(), 'anthropic-oauth-credentials.json');

/**
 * Read one credential file with THREE distinguishable outcomes:
 *   { present: false }                → the file is not there (logged out)
 *   { present: true, unreadable: true } → it exists but cannot be read/parsed
 *                                         right now (EACCES, lock contention,
 *                                         a torn write mid atomic-replace)
 *   { present: true, data }            → parsed content
 * Collapsing the middle case into "absent" is what let a momentary FS failure
 * be mistaken for a deliberate logout by every caller downstream.
 */
function readCredentialFile(path) {
    if (!path) return { present: false, data: null, unreadable: false };
    let raw;
    try {
        if (!existsSync(path)) return { present: false, data: null, unreadable: false };
        raw = readFileSync(path, 'utf-8');
    } catch {
        return { present: true, data: null, unreadable: true };
    }
    try {
        return { present: true, data: JSON.parse(raw), unreadable: false };
    } catch {
        return { present: true, data: null, unreadable: true };
    }
}

// Resolve a probe to 'present' | 'absent' | 'unreadable'. `evaluate` sees only
// the documents that parsed; if none of them yields usable credentials while at
// least one candidate file was unreadable, the answer is "cannot tell", never
// "absent".
function resolveProbeState(paths, evaluate) {
    let sawUnreadable = false;
    const docs = [];
    for (const path of paths) {
        if (!path) continue;
        const file = readCredentialFile(path);
        if (file.unreadable) { sawUnreadable = true; continue; }
        if (file.data) docs.push(file.data);
    }
    if (evaluate(docs) === true) return 'present';
    return sawUnreadable ? 'unreadable' : 'absent';
}

function pushUnique(list, value) {
    if (!value || typeof value !== 'string') return;
    if (!list.includes(value)) list.push(value);
}

// Short-TTL memo. Under simultaneous multi-agent launch, buildDefaultConfig
// and registry lazy-init call these probes in bursts; each probe does
// synchronous existsSync + readFileSync disk work. Cache the STATE per key
// for a brief window so one launch burst shares a single read instead of N.
// Kept short so the registry's "re-probe on each getProvider miss" self-heal
// (a credential file appearing/changing) is delayed by at most PROBE_TTL_MS.
const PROBE_TTL_MS = 3000;
const _probeCache = new Map();

// Cheap change-detector for the candidate credential files. statSync is orders
// of magnitude cheaper than the readFileSync + JSON.parse the memo exists to
// coalesce, so it runs on every call: the memo may only return a cached answer
// while the files it was computed from are byte-for-byte the same. Without it a
// logout stayed invisible for up to PROBE_TTL_MS — long enough for one
// immediate config reload to re-observe 'present' and keep a revoked provider
// registered. Removal, appearance and rewrite are all observed immediately.
//
// mtimeMs+size alone missed a same-length rewrite that preserved (or restored)
// the timestamp — exactly the shape of a token refresh written by another
// process, or of an atomic replace. ctimeMs is bumped by the write itself and
// cannot be back-dated through utimes, and ino changes on rename-replace, so
// both join the signature; neither costs an extra syscall.
function credentialPathsSignature(paths, extra = '') {
    const parts = [];
    for (const path of paths) {
        if (!path) continue;
        try {
            const st = statSync(path);
            parts.push(`${path}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`);
        } catch {
            // Missing (the logout case) or unstattable — both distinct from a
            // readable file, and both must invalidate a cached answer.
            parts.push(`${path}:-`);
        }
    }
    if (extra) parts.push(extra);
    return parts.join('|');
}

function memoProbe(key, paths, compute, extraSignature = '') {
    const signature = credentialPathsSignature(paths, extraSignature);
    const hit = _probeCache.get(key);
    const now = Date.now();
    if (hit && hit.signature === signature && now - hit.ts < PROBE_TTL_MS) return hit.value;
    const value = compute();
    _probeCache.set(key, { ts: now, signature, value });
    return value;
}

function anthropicOAuthState() {
  const paths = [];
  pushUnique(paths, process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH);
  pushUnique(paths, ANTHROPIC_DEFAULT_CREDENTIALS_PATH);
  return memoProbe('anthropic-oauth', paths, () => {
    return resolveProbeState(paths, (docs) => {
      const candidates = [];
      for (const raw of docs) {
        const oauth = raw?.claudeAiOauth;
        if (oauth?.accessToken) {
          candidates.push({
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken || null,
            expiresAt: Number(oauth.expiresAt ?? oauth.expires_at) || 0,
            scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
          });
        }
      }
      if (!candidates.length) return false;
      candidates.sort((a, b) => (Number(b.expiresAt) || 0) - (Number(a.expiresAt) || 0));
      const chosen = candidates[0];
      const hasInferenceScope = Array.isArray(chosen.scopes) && chosen.scopes.includes('user:inference');
      const expiresAt = Number(chosen.expiresAt) || 0;
      return !!(chosen.accessToken && hasInferenceScope
        && (expiresAt === 0 || expiresAt > Date.now() || chosen.refreshToken));
    });
  });
}

function openAIOAuthState() {
  const paths = [
    process.env.OPENAI_OAUTH_CREDENTIALS_PATH,
    join(resolvePluginData(), 'openai-oauth.json'),
  ];
  return memoProbe('openai-oauth', paths, () => resolveProbeState(
    paths,
    (docs) => docs.some((raw) => !!(raw?.access_token && raw?.refresh_token)),
  ));
}

function grokOAuthState() {
  const paths = [
    process.env.GROK_OAUTH_CREDENTIALS_PATH,
    join(resolvePluginData(), 'grok-oauth.json'),
  ];
  return memoProbe('grok-oauth', paths, () => resolveProbeState(
    paths,
    (docs) => docs.some((own) => !!(own?.access_token && own?.refresh_token)),
  ));
}

// Antigravity needs a resolved Cloud project alongside the tokens: without it
// every request 400s, so a half-finished login must not enable the provider.
function antigravityOAuthState() {
  const paths = [
    process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH,
    join(resolvePluginData(), 'antigravity-oauth.json'),
  ];
  return memoProbe('antigravity-oauth', paths, () => resolveProbeState(
    paths,
    (docs) => docs.some((own) => !!(own?.access_token && own?.refresh_token && own?.project_id)),
  ));
}

// Content fingerprint of CURSOR_ACCESS_TOKEN (never the token itself).
// '-' means unset, which must stay distinguishable from any hash so that
// deleting the variable invalidates the memo immediately.
function cursorEnvTokenFingerprint() {
  const token = process.env.CURSOR_ACCESS_TOKEN;
  if (!token) return '-';
  return createHash('sha256').update(String(token)).digest('base64url').slice(0, 22);
}

function cursorOAuthState() {
  const paths = [
    process.env.CURSOR_OAUTH_CREDENTIALS_PATH,
    join(resolvePluginData(), 'cursor-oauth.json'),
  ];
  // The env token is the whole answer on this branch and has no file metadata
  // behind it, so its VALUE is what the memo signature has to track: a length
  // (or a bare present/absent flag) let a swap to an equal-length expired token
  // keep serving the stale 'present' for up to PROBE_TTL_MS. Hashed rather than
  // embedded so the memo never holds a second copy of the raw credential.
  const envSignature = `env:${cursorEnvTokenFingerprint()}`;
  return memoProbe('cursor-oauth', paths, () => {
    // An env-provided token needs no file read, so it is never "unreadable".
    // Expiry is read by the one shared JWT reader (cursor-auth.cursorTokenExpiry),
    // which answers 0 for a non-JWT or unparseable token — exactly the "assume
    // usable" outcome this branch already took for those shapes.
    if (process.env.CURSOR_ACCESS_TOKEN) {
      const expiresAt = cursorTokenExpiry(process.env.CURSOR_ACCESS_TOKEN);
      return (expiresAt === 0 || expiresAt > Date.now()) ? 'present' : 'absent';
    }
    return resolveProbeState(paths, (docs) => docs.some((own) => {
      if (!own?.access_token) return false;
      const expiresAt = Number(own.expires_at) || 0;
      return expiresAt === 0 || expiresAt > Date.now() || Boolean(own.refresh_token);
    }));
  }, envSignature);
}

const OAUTH_PROBE_STATES = new Map([
  ['anthropic-oauth', anthropicOAuthState],
  ['openai-oauth', openAIOAuthState],
  ['grok-oauth', grokOAuthState],
  ['cursor-oauth', cursorOAuthState],
  ['antigravity-oauth', antigravityOAuthState],
]);

/**
 * Tri-state credential probe: 'present' | 'absent' | 'unreadable'.
 *
 * Callers that must tell a deliberate logout ('absent') from a momentary FS
 * failure ('unreadable') use this; `has*OAuthCredentials()` remains the plain
 * "can we use it right now" boolean and is exactly `state === 'present'`.
 */
export function oauthCredentialProbeState(name) {
  const probe = OAUTH_PROBE_STATES.get(String(name || ''));
  if (!probe) return 'absent';
  try { return probe(); } catch { return 'unreadable'; }
}

export function hasAnthropicOAuthCredentials() { return anthropicOAuthState() === 'present'; }
export function hasOpenAIOAuthCredentials() { return openAIOAuthState() === 'present'; }
export function hasGrokOAuthCredentials() { return grokOAuthState() === 'present'; }
export function hasAntigravityOAuthCredentials() { return antigravityOAuthState() === 'present'; }
export function hasCursorOAuthCredentials() { return cursorOAuthState() === 'present'; }
