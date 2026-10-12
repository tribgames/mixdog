// Muse Code subscription credentials. A Meta device-authorization login yields
// an account access token; that token is only ever used to mint (once) the
// Model API key, and inference then runs on the key. Meta issues no expiry
// and rejects refresh grants, so there is no refresh path: a 401 means the
// user signs in again. Credentials live in Mixdog's own muse-code-oauth.json.
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { accountIdentityFields, scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';

export const CLIENT_ID = '1031625952748946';
export const DEVICE_AUTH_URL = 'https://auth.meta.com/oidc/device/authorization/';
export const DEVICE_TOKEN_URL = 'https://auth.meta.com/oidc/device/token/';
const KEY_URL = 'https://api.meta.ai/muse-code/key';
export const MODEL_API_BASE_URL = 'https://api.meta.ai/v1';
export const API_VERSION = '1.0.0';
export const REQUEST_TIMEOUT_MS = 20_000;

export function museHeaders(extra = {}) {
  return { Accept: 'application/json', 'x-api-version': API_VERSION, ...extra };
}

/** Redact field-shaped secrets plus every known secret value wherever it appears. */
export function scrubMuseSecrets(text, secretValues = []) {
  return scrubOAuthSecrets(text, secretValues).replace(/"api_key"\s*:\s*"[^"]+"/g, '"api_key":"[REDACTED]"');
}

export function getOwnTokenPath() {
  const bound = boundProviderAuthPath('muse-code-oauth');
  if (bound) return resolve(bound);
  const explicit = process.env.MUSE_CODE_OAUTH_CREDENTIALS_PATH;
  if (explicit) return resolve(explicit);
  const dir = getPluginData();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'muse-code-oauth.json');
}

const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

// Both halves are required: a document with only one of them is signed out.
export const isValidMuseCredentialDocument = (doc) => nonEmptyString(doc?.accessToken) && nonEmptyString(doc?.apiKey);

export function loadTokens() {
  const path = getOwnTokenPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isValidMuseCredentialDocument(raw)) return null;
    return {
      accessToken: raw.accessToken,
      apiKey: raw.apiKey,
      accountId: raw.accountId || '',
      email: raw.email || '',
    };
  } catch {
    return null;
  }
}

export function saveTokens(tokens) {
  writeJsonAtomicSync(
    getOwnTokenPath(),
    {
      accessToken: tokens.accessToken,
      apiKey: tokens.apiKey,
      accountId: tokens.accountId,
      ...(tokens.email ? { email: tokens.email } : {}),
    },
    { lock: true, fsyncDir: true, mode: 0o600, secret: true }
  );
}

export function hasMuseCodeOAuthCredentials() {
  try {
    return Boolean(loadTokens()?.apiKey);
  } catch {
    return false;
  }
}

export function describeMuseCodeOAuthCredentials() {
  try {
    const tokens = loadTokens();
    if (!tokens?.apiKey) {
      return {
        authenticated: false,
        usable: false,
        refreshable: false,
        reauthRequired: false,
        status: 'Not Set',
        detail: 'Mixdog token store',
      };
    }
    return {
      authenticated: true,
      usable: true,
      refreshable: false,
      reauthRequired: false,
      status: 'Valid',
      detail: 'Mixdog token store',
      expiresAt: 0,
      ...accountIdentityFields({ id: tokens.accountId, email: tokens.email }),
    };
  } catch (err) {
    return {
      authenticated: false,
      usable: false,
      refreshable: false,
      reauthRequired: false,
      status: 'Error',
      detail: String(err?.message || err).slice(0, 200),
    };
  }
}

export function forgetMuseCodeOAuthCredentials() {
  const path = getOwnTokenPath();
  if (!existsSync(path)) return { removed: false };
  unlinkSync(path);
  return { removed: true };
}

/**
 * POST the key endpoint with the Meta account token. `onboard` is sent only
 * on the login exchange; usage reads omit it. Never follows redirects.
 */
export async function requestMuseCodeKey(accessToken, { onboard = false, fetchFn = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetchFn(KEY_URL, {
    method: 'POST',
    headers: museHeaders({ Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }),
    body: JSON.stringify(onboard ? { onboard: true } : {}),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    dispatcher: getLlmDispatcher(),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = scrubMuseSecrets(text, [accessToken]).trim().slice(0, 500);
    throw Object.assign(new Error(`[muse-code-oauth] key request ${res.status}${detail ? `: ${detail}` : ''}`), {
      status: res.status,
      kind: 'token-exchange',
    });
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw museError('[muse-code-oauth] key response was not valid JSON', { kind: 'validation', status: res.status });
  }
  validateKeyPayload(payload);
  return payload;
}

export function museError(message, meta) {
  return Object.assign(new Error(message), meta);
}

const isUsageWindow = (w) => {
  if (w === undefined || w === null) return true;
  if (typeof w !== 'object' || Array.isArray(w)) return false;
  const numeric = (v) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  return (
    numeric(w.used_percent) &&
    numeric(w.window_duration_mins) &&
    (w.resets_at === undefined || typeof w.resets_at === 'string' || typeof w.resets_at === 'number')
  );
};

/** Reject a key response whose fields have the wrong types rather than stringifying them. */
function validateKeyPayload(payload) {
  const bad = (field) => museError(`[muse-code-oauth] key response has an invalid ${field}`, { kind: 'validation' });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw bad('body');
  const optional = (field, ...types) => {
    const v = payload[field];
    if (v !== undefined && !types.includes(v === null ? 'null' : typeof v)) throw bad(field);
  };
  optional('api_key', 'string');
  optional('user_id', 'string');
  optional('user_email', 'string');
  optional('is_subs_active', 'boolean');
  optional('require_payment', 'boolean');
  optional('action_url', 'string', 'null');
  optional('require_payment_action_url', 'string');
  optional('subs_tier_id', 'string', 'null');
  optional('subs_tier_name', 'string', 'null');
  const usage = payload.subs_usage;
  if (usage !== undefined && usage !== null) {
    if (typeof usage !== 'object' || Array.isArray(usage)) throw bad('subs_usage');
    if (!isUsageWindow(usage.window)) throw bad('subs_usage.window');
    if (!isUsageWindow(usage.weekly)) throw bad('subs_usage.weekly');
  }
}

/** Validate a key response and turn it into the stored credential record. */
export function credentialsFromKeyResponse(payload, accessToken) {
  validateKeyPayload(payload);
  if (payload.is_subs_active === false) {
    throw museError('[muse-code-oauth] invalid_grant: Muse Code subscription inactive', {
      kind: 'token-exchange',
      status: 403,
      reauthRequired: true,
    });
  }
  const apiKey = payload.api_key?.trim() || '';
  if (!apiKey) {
    const actionUrl = payload.action_url?.trim() || payload.require_payment_action_url?.trim() || '';
    if (payload.require_payment === true || actionUrl) {
      throw museError(`[muse-code-oauth] Muse Code subscription payment required${actionUrl ? `: ${actionUrl}` : ''}`, {
        kind: 'entitlement',
        ...(actionUrl ? { actionUrl } : {}),
      });
    }
    throw museError('[muse-code-oauth] key response is missing api_key', { kind: 'validation' });
  }
  const email = payload.user_email?.trim().toLowerCase() || '';
  const accountId = payload.user_id?.trim() || email;
  if (!accountId) {
    throw museError('[muse-code-oauth] key response is missing a stable account identity', { kind: 'validation' });
  }
  return { accessToken, apiKey, accountId, email };
}
