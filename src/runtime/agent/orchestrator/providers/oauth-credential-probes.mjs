import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { cursorTokenExpiry } from './cursor-auth.mjs';
import { describeDevinOAuthCredentials } from './devin-auth.mjs';
import { signedInTokenDocumentUntil } from './lib/oauth-token-utils.mjs';
import { isValidMuseCredentialDocument } from './muse-code-oauth-tokens.mjs';
import { isValidOpenCodeGoCredentialDocument } from './opencode-go-oauth-tokens.mjs';
import { developerOptionEnabled, developerOptionForProvider } from '../../../shared/developer-options.mjs';
import { modelProxyClientMode } from '../../../shared/model-proxy-mode.mjs';

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

// Resolve a probe to { state: 'present' | 'absent' | 'unreadable', until }.
// `evaluate` sees only the documents that parsed and answers until when they
// hold usable credentials: Infinity with no clock limit (a refresh token, a
// key), the access token's expiry when that alone carries them, 0 when they do
// not. If none is usable while at least one candidate file was unreadable, the
// answer is "cannot tell", never "absent". `until` is when a 'present' answer
// turns 'absent' by the clock alone.
function resolveProbeState(paths, evaluate) {
  let sawUnreadable = false;
  const docs = [];
  for (const path of paths) {
    if (!path) continue;
    const file = readCredentialFile(path);
    if (file.unreadable) {
      sawUnreadable = true;
      continue;
    }
    if (file.data) docs.push(file.data);
  }
  const until = evaluate(docs);
  if (until > Date.now()) return { state: 'present', until };
  return { state: sawUnreadable ? 'unreadable' : 'absent', until: NO_EXPIRY };
}

const NO_EXPIRY = Number.POSITIVE_INFINITY;
const usableWithoutExpiry = (usable) => (usable ? NO_EXPIRY : 0);

// The build observing probes (observeOAuthCredentialExpiry), or null.
let expiryObserver = null;

function noteExpiry(at) {
  if (expiryObserver && at < expiryObserver.at) expiryObserver.at = at;
}

/** Runs `run`; answers its value and the earliest moment a probe it ran turns
 *  'present' into 'absent' by the clock alone (an access token with no refresh
 *  token expiring), Infinity when none does. */
export function observeOAuthCredentialExpiry(run) {
  const outer = expiryObserver;
  const observer = { at: NO_EXPIRY };
  expiryObserver = observer;
  try {
    return { value: run(), expiresAt: observer.at };
  } finally {
    expiryObserver = outer;
    noteExpiry(observer.at);
  }
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
  // Remote mode: no credential file on this server is ever read.
  if (modelProxyClientMode()) return 'absent';
  const signature = credentialPathsSignature(paths, extraSignature);
  const hit = _probeCache.get(key);
  const now = Date.now();
  // A cached 'present' never outlives the expiry it was computed against.
  if (hit && hit.signature === signature && now - hit.ts < PROBE_TTL_MS && now < hit.until) {
    noteExpiry(hit.until);
    return hit.value;
  }
  const { state, until } = compute();
  _probeCache.set(key, { ts: now, signature, value: state, until });
  noteExpiry(until);
  return state;
}

// Each probe's credential file, matching its token store's account/path
// precedence: the selected (or bound) account, then the provider's explicit
// path variable, then the legacy file in the data dir. Credentials belonging
// to another account must never authenticate a missing or unreadable one.
const CREDENTIAL_FILES = new Map([
  ['anthropic-oauth', ['ANTHROPIC_OAUTH_CREDENTIALS_PATH', () => ANTHROPIC_DEFAULT_CREDENTIALS_PATH]],
  ['openai-oauth', ['OPENAI_OAUTH_CREDENTIALS_PATH', 'openai-oauth.json']],
  ['grok-oauth', ['GROK_OAUTH_CREDENTIALS_PATH', 'grok-oauth.json']],
  ['mimo-oauth', ['MIMO_OAUTH_CREDENTIALS_PATH', 'mimo-oauth.json']],
  ['command-code-oauth', ['COMMAND_CODE_OAUTH_CREDENTIALS_PATH', 'command-code-oauth.json']],
  ['muse-code-oauth', ['MUSE_CODE_OAUTH_CREDENTIALS_PATH', 'muse-code-oauth.json']],
  ['opencode-go-oauth', ['OPENCODE_GO_OAUTH_CREDENTIALS_PATH', 'opencode-go-oauth.json']],
  ['antigravity-oauth', ['ANTIGRAVITY_OAUTH_CREDENTIALS_PATH', 'antigravity-oauth.json']],
  ['cursor-oauth', ['CURSOR_OAUTH_CREDENTIALS_PATH', 'cursor-oauth.json']],
  ['devin-oauth', ['DEVIN_OAUTH_CREDENTIALS_PATH', 'devin-oauth.json']],
]);

function credentialFile(provider) {
  const [envKey, fallback] = CREDENTIAL_FILES.get(provider);
  return (
    boundProviderAuthPath(provider) ||
    process.env[envKey] ||
    (typeof fallback === 'function' ? fallback() : join(resolvePluginData(), fallback))
  );
}

/** Every credential file the probes read right now (one per OAuth provider).
 *  A path that cannot be resolved is left out, as its probe reads 'unreadable'. */
export function oauthCredentialFiles() {
  return [...CREDENTIAL_FILES.keys()]
    .map((provider) => {
      try {
        return credentialFile(provider);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function anthropicOAuthState() {
  const paths = [credentialFile('anthropic-oauth')];
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
      if (!candidates.length) return 0;
      candidates.sort((a, b) => (Number(b.expiresAt) || 0) - (Number(a.expiresAt) || 0));
      const chosen = candidates[0];
      const hasInferenceScope = Array.isArray(chosen.scopes) && chosen.scopes.includes('user:inference');
      if (!(chosen.accessToken && hasInferenceScope)) return 0;
      const expiresAt = Number(chosen.expiresAt) || 0;
      return expiresAt === 0 || chosen.refreshToken ? NO_EXPIRY : expiresAt;
    });
  });
}

function openAIOAuthState() {
  const paths = [credentialFile('openai-oauth')];
  return memoProbe('openai-oauth', paths, () =>
    resolveProbeState(paths, (docs) => Math.max(0, ...docs.map(signedInTokenDocumentUntil)))
  );
}

function grokOAuthState() {
  const paths = [credentialFile('grok-oauth')];
  return memoProbe('grok-oauth', paths, () =>
    resolveProbeState(paths, (docs) =>
      usableWithoutExpiry(docs.some((own) => !!(own?.access_token && own?.refresh_token)))
    )
  );
}

function mimoOAuthState() {
  const paths = [credentialFile('mimo-oauth')];
  return memoProbe('mimo-oauth', paths, () =>
    resolveProbeState(paths, (docs) => usableWithoutExpiry(docs.some((own) => !!own?.apiKey)))
  );
}

function commandCodeOAuthState() {
  const paths = [credentialFile('command-code-oauth')];
  return memoProbe('command-code-oauth', paths, () =>
    resolveProbeState(paths, (docs) =>
      usableWithoutExpiry(docs.some((own) => typeof own?.apiKey === 'string' && !!own.apiKey.trim()))
    )
  );
}

function museCodeOAuthState() {
  const paths = [credentialFile('muse-code-oauth')];
  return memoProbe('muse-code-oauth', paths, () =>
    resolveProbeState(paths, (docs) => usableWithoutExpiry(docs.some(isValidMuseCredentialDocument)))
  );
}

function openCodeGoOAuthState() {
  const paths = [credentialFile('opencode-go-oauth')];
  return memoProbe('opencode-go-oauth', paths, () =>
    resolveProbeState(paths, (docs) => usableWithoutExpiry(docs.some(isValidOpenCodeGoCredentialDocument)))
  );
}

// Antigravity needs a resolved Cloud project alongside the tokens: without it
// every request 400s, so a half-finished login must not enable the provider.
function antigravityOAuthState() {
  const paths = [credentialFile('antigravity-oauth')];
  return memoProbe('antigravity-oauth', paths, () =>
    resolveProbeState(paths, (docs) =>
      usableWithoutExpiry(docs.some((own) => !!(own?.access_token && own?.refresh_token && own?.project_id)))
    )
  );
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
  // An environment token must not authenticate a different selected account.
  const bound = boundProviderAuthPath('cursor-oauth');
  const paths = [credentialFile('cursor-oauth')];
  // The env token is the whole answer on this branch and has no file metadata
  // behind it, so its VALUE is what the memo signature has to track: a length
  // (or a bare present/absent flag) let a swap to an equal-length expired token
  // keep serving the stale 'present' for up to PROBE_TTL_MS. Hashed rather than
  // embedded so the memo never holds a second copy of the raw credential.
  const envSignature = `env:${cursorEnvTokenFingerprint()}`;
  return memoProbe(
    'cursor-oauth',
    paths,
    () => {
      // An env-provided token needs no file read, so it is never "unreadable".
      // Expiry is read by the one shared JWT reader (cursor-auth.cursorTokenExpiry),
      // which answers 0 for a non-JWT or unparseable token — exactly the "assume
      // usable" outcome this branch already took for those shapes.
      if (process.env.CURSOR_ACCESS_TOKEN && !bound) {
        const expiresAt = cursorTokenExpiry(process.env.CURSOR_ACCESS_TOKEN);
        if (expiresAt !== 0 && expiresAt <= Date.now()) return { state: 'absent', until: NO_EXPIRY };
        return { state: 'present', until: expiresAt || NO_EXPIRY };
      }
      return resolveProbeState(paths, (docs) =>
        Math.max(
          0,
          ...docs.map((own) => {
            if (!own?.access_token) return 0;
            // Cursor permanently rejected the refresh token: signed out until a new login.
            if (own.reauth_required === true) return 0;
            const expiresAt = Number(own.expires_at) || 0;
            return expiresAt === 0 || own.refresh_token ? NO_EXPIRY : expiresAt;
          })
        )
      );
    },
    envSignature
  );
}

// Account-scoped like the token store: the selected account's file wins. Expiry
// comes from describeDevinOAuthCredentials (no refresh is attempted here); an
// expired access token still counts when a refresh token can renew it.
function devinOAuthState() {
  const paths = [credentialFile('devin-oauth')];
  return memoProbe('devin-oauth', paths, () => {
    const info = describeDevinOAuthCredentials();
    if (!(info?.authenticated && (info.usable || info.refreshable))) return { state: 'absent', until: NO_EXPIRY };
    return { state: 'present', until: info.refreshable || !info.expiresAt ? NO_EXPIRY : info.expiresAt };
  });
}

const OAUTH_PROBE_STATES = new Map([
  ['anthropic-oauth', anthropicOAuthState],
  ['openai-oauth', openAIOAuthState],
  ['grok-oauth', grokOAuthState],
  ['muse-code-oauth', museCodeOAuthState],
  ['command-code-oauth', commandCodeOAuthState],
  ['mimo-oauth', mimoOAuthState],
  ['cursor-oauth', cursorOAuthState],
  ['devin-oauth', devinOAuthState],
  ['antigravity-oauth', antigravityOAuthState],
  ['opencode-go-oauth', openCodeGoOAuthState],
]);

// Dev-only OAuth providers (Antigravity, Cursor). Each is hidden and treated as
// "no credentials" unless its own Developer → Providers option (the stored
// `developer.<optionId>` setting) is on. Default OFF. Read per call, so a
// settings toggle takes effect without a restart.

/** False only for a dev-only OAuth provider while its Developer option is off. */
export function isOAuthProviderAvailable(name) {
  const option = developerOptionForProvider(String(name || ''));
  return !option || developerOptionEnabled(option.id);
}

/**
 * Tri-state credential probe: 'present' | 'absent' | 'unreadable'.
 *
 * Callers that must tell a deliberate logout ('absent') from a momentary FS
 * failure ('unreadable') use this; `has*OAuthCredentials()` remains the plain
 * "can we use it right now" boolean and is exactly `state === 'present'`.
 * A dev-only provider while its Developer option is off always reads
 * 'absent', so the registry never enables or self-heals it.
 */
export function oauthCredentialProbeState(name) {
  const id = String(name || '');
  if (!isOAuthProviderAvailable(id)) return 'absent';
  const probe = OAUTH_PROBE_STATES.get(id);
  if (!probe) return 'absent';
  try {
    return probe();
  } catch {
    return 'unreadable';
  }
}

export function hasAnthropicOAuthCredentials() {
  return anthropicOAuthState() === 'present';
}
export function hasOpenAIOAuthCredentials() {
  return openAIOAuthState() === 'present';
}
export function hasGrokOAuthCredentials() {
  return grokOAuthState() === 'present';
}
export function hasAntigravityOAuthCredentials() {
  return oauthCredentialProbeState('antigravity-oauth') === 'present';
}
export function hasCursorOAuthCredentials() {
  return oauthCredentialProbeState('cursor-oauth') === 'present';
}
