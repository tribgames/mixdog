import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

const ANTHROPIC_DEFAULT_CREDENTIALS_PATH = join(resolvePluginData(), 'anthropic-oauth-credentials.json');

function readJsonIfExists(path) {
    if (!path || !existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf-8')); }
    catch { return null; }
}

function pushUnique(list, value) {
    if (!value || typeof value !== 'string') return;
    if (!list.includes(value)) list.push(value);
}

// Short-TTL memo. Under simultaneous multi-agent launch, buildDefaultConfig
// and registry lazy-init call these probes in bursts; each probe does
// synchronous existsSync + readFileSync disk work. Cache the boolean per key
// for a brief window so one launch burst shares a single read instead of N.
// Kept short so the registry's "re-probe on each getProvider miss" self-heal
// (a credential file appearing/changing) is delayed by at most PROBE_TTL_MS.
const PROBE_TTL_MS = 3000;
const _probeCache = new Map();
function memoProbe(key, compute) {
    const hit = _probeCache.get(key);
    const now = Date.now();
    if (hit && now - hit.ts < PROBE_TTL_MS) return hit.value;
    const value = compute();
    _probeCache.set(key, { ts: now, value });
    return value;
}

export function hasAnthropicOAuthCredentials() {
  return memoProbe('anthropic-oauth', () => {
    const paths = [];
    const candidates = [];
    pushUnique(paths, process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH);
    pushUnique(paths, ANTHROPIC_DEFAULT_CREDENTIALS_PATH);
    for (const path of paths) {
        const raw = readJsonIfExists(path);
        const oauth = raw?.claudeAiOauth;
        if (oauth?.accessToken) {
            candidates.push({
                accessToken: oauth.accessToken,
                expiresAt: Number(oauth.expiresAt ?? oauth.expires_at) || 0,
                scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
            });
        }
    }
    if (!candidates.length) return false;
    candidates.sort((a, b) => (Number(b.expiresAt) || 0) - (Number(a.expiresAt) || 0));
    const chosen = candidates[0];
    return !!(chosen.accessToken && Array.isArray(chosen.scopes) && chosen.scopes.includes('user:inference'));
  });
}

export function hasOpenAIOAuthCredentials() {
  return memoProbe('openai-oauth', () => {
    const paths = [join(resolvePluginData(), 'openai-oauth.json')];
    for (const path of paths) {
        const raw = readJsonIfExists(path);
        if (raw?.access_token && raw?.refresh_token) return true;
    }
    return false;
  });
}

export function hasGrokOAuthCredentials() {
  return memoProbe('grok-oauth', () => {
    const own = readJsonIfExists(join(resolvePluginData(), 'grok-oauth.json'));
    return !!(own?.access_token && own?.refresh_token);
  });
}
