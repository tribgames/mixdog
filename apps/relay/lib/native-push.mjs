// Native app push delivery: APNs (HTTP/2, token auth) and FCM (HTTP v1). The
// relay holds the credentials and carries the opaque `mx` string the desktop
// encrypted for the phone; it never sees notification content.
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApnsSender } from './native-push-apns.mjs';
import { createFcmSender } from './native-push-fcm.mjs';

const APNS_PRODUCTION = 'https://api.push.apple.com';
const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';
const FCM_ORIGIN = 'https://fcm.googleapis.com';
const DEFAULT_TOPIC = 'io.mixdog.app';
// Identifiers, not secrets: the .p8 (APNS_KEY_P8) and the FCM service account
// JSON (FCM_SERVICE_ACCOUNT_JSON; project `mixdog-app`, sender
// mixdog-relay-fcm@mixdog-app.iam.gserviceaccount.com) are provided at deploy
// time as inline content or as a file path, and never live in the repo.
const DEFAULT_APNS_KEY_ID = '6S9P5W53QC';
const DEFAULT_APNS_TEAM_ID = 'Q6C35DQU78';

export const NATIVE_PUSH_REASONS = new Set(['turn-finished', 'approval-pending', 'input-needed']);
export const MAX_MX_CHARS = 3500;
const TOKEN_PATTERNS = {
  apns: /^[0-9a-fA-F]{32,400}$/u,
  fcm: /^[A-Za-z0-9_:.-]{32,4096}$/u,
};

export function validNativeToken(platform, token) {
  return typeof token === 'string' && TOKEN_PATTERNS[platform]?.test(token) === true;
}

/** A secret that may be given inline or as a path to a file. */
function readInlineOrFile(value, inlinePrefix) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.startsWith(inlinePrefix) ? text : readFileSync(text, 'utf8');
}

function readApnsConfig(env) {
  const keyId = String(env.APNS_KEY_ID || '').trim() || DEFAULT_APNS_KEY_ID;
  const teamId = String(env.APNS_TEAM_ID || '').trim() || DEFAULT_APNS_TEAM_ID;
  const p8 = readInlineOrFile(env.APNS_KEY_P8, '-----BEGIN');
  if (!p8) return null;
  return {
    keyId,
    teamId,
    key: createPrivateKey(p8),
    topic: String(env.APNS_TOPIC || '').trim() || DEFAULT_TOPIC,
    sandboxDefault:
      String(env.APNS_ENVIRONMENT || '')
        .trim()
        .toLowerCase() === 'sandbox',
  };
}

function readFcmConfig(env) {
  const json = readInlineOrFile(env.FCM_SERVICE_ACCOUNT_JSON, '{');
  if (!json) return null;
  const account = JSON.parse(json);
  if (!account.project_id || !account.client_email || !account.private_key) return null;
  return {
    projectId: String(account.project_id),
    clientEmail: String(account.client_email),
    key: createPrivateKey(account.private_key),
    tokenUri: String(account.token_uri || 'https://oauth2.googleapis.com/token'),
  };
}

/** Credentials that do not parse disable that platform instead of crashing the
 *  relay: a push misconfiguration must never take pairing down with it. */
function tryRead(read, env, label, log) {
  try {
    return read(env);
  } catch (error) {
    log(`[relay] ${label} credentials unusable: ${error?.message || error}`);
    return null;
  }
}

/**
 * @param {object} options
 * @param {Record<string, string | undefined>} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {{ apnsProduction?: string, apnsSandbox?: string, fcm?: string }} [options.origins] test overrides
 * @param {(message: string) => void} [options.log]
 */
export function createNativePush({
  env = {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  origins = {},
  log = console.warn,
} = {}) {
  const apns = tryRead(readApnsConfig, env, 'APNs', log);
  const fcm = tryRead(readFcmConfig, env, 'FCM', log);
  const platforms = [...(apns ? ['apns'] : []), ...(fcm ? ['fcm'] : [])];
  const apnsSender = apns
    ? createApnsSender({
        config: apns,
        now,
        origins: {
          production: origins.apnsProduction || APNS_PRODUCTION,
          sandbox: origins.apnsSandbox || APNS_SANDBOX,
        },
      })
    : null;
  const fcmSender = fcm ? createFcmSender({ config: fcm, fetchImpl, now, origin: origins.fcm || FCM_ORIGIN }) : null;

  return {
    platforms,
    /** Resolves to `{ ok, status, invalid?, error? }`; never rejects. */
    async send(message) {
      try {
        if (message.platform === 'apns' && apnsSender) return await apnsSender.send(message);
        if (message.platform === 'fcm' && fcmSender) return await fcmSender.send(message);
        return { ok: false, status: 0, error: 'platform-unavailable' };
      } catch (error) {
        return { ok: false, status: 0, error: error?.message || 'send failed' };
      }
    },
    close() {
      apnsSender?.close();
    },
  };
}
