// Devin request identity and the session-token -> user JWT exchange.
import { isIP } from 'node:net';
import { DEVIN_ENUMS } from './devin-wire-protobuf.mjs';
import { DevinWireError, devinUnary } from './devin-wire-transport.mjs';

export const DEVIN_DEFAULT_BASE_URL = 'https://server.codeium.com';
export const DEVIN_GET_USER_JWT_PATH = '/exa.auth_pb.AuthService/GetUserJwt';
// Unary; metadata is `devinRequestMetadata({ apiKey })` with the apiKey the
// JWT exchange accepted and no userJwt. See AssignModelRequest.
export const DEVIN_ASSIGN_MODEL_PATH = '/exa.api_server_pb.ApiServerService/AssignModel';
export const DEVIN_SESSION_TOKEN_PREFIX = 'devin-session-token$';

const DEVIN_OS = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';

// Released CLI identity used for auth and chat. The backend gates the CLI
// model surface and router assignment on this tuple.
const CLI_IDENTITY = Object.freeze({
  ideName: 'devin-cli',
  ideType: 'chisel',
  ideVersion: '3000.11.3',
  extensionName: 'chisel',
  extensionVersion: '3000.11.3',
});

// Dev-channel identity that unlocks the full native model config set.
const DISCOVERY_IDENTITY = Object.freeze({
  ideName: 'chisel',
  ideVersion: '0.0.0-dev',
  extensionName: 'chisel',
  extensionVersion: '0.0.0-dev',
});

// Editor identity under which legacy Windsurf Enterprise seats expose their
// full roster (with the raw, unprefixed key); sent without `os`.
const LEGACY_IDENTITY = Object.freeze({
  ideName: 'windsurf',
  ideVersion: '3.2.23',
  extensionName: 'windsurf',
  extensionVersion: '1.48.2',
});

// Display slots the native client advertises for discovery; UNSPECIFIED (0)
// is implicit. Asking for the internal slots returns the full catalog, which
// is then filtered client-side.
const { DisplayOption } = DEVIN_ENUMS;
export const DEVIN_SUPPORTED_MODEL_DISPLAYS = Object.freeze([
  DisplayOption.MODEL_ROUTER,
  DisplayOption.QUICK_REVIEW,
  DisplayOption.INTERNAL_DEFAULT,
  DisplayOption.UNCLASSIFIED,
  DisplayOption.NORMAL,
]);

// The session token as the wire carries it: the scheme prefix is required.
export function normalizeDevinSessionToken(token) {
  const value = String(token || '');
  if (!value) return '';
  return value.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? value : `${DEVIN_SESSION_TOKEN_PREFIX}${value}`;
}

// `Metadata` for every Devin call. `apiKey` is sent exactly as given (use
// normalizeDevinSessionToken for session tokens). client: 'cli' (auth, chat),
// 'discovery' (GetCliModelConfigs) or 'legacy' (legacy discovery fallback).
export function devinRequestMetadata({ apiKey = '', userJwt = '', client = 'cli' } = {}) {
  if (client === 'discovery') {
    return {
      apiKey,
      ...DISCOVERY_IDENTITY,
      locale: 'en',
      os: DEVIN_OS,
      supportedModelDisplays: [...DEVIN_SUPPORTED_MODEL_DISPLAYS],
    };
  }
  if (client === 'legacy') return { apiKey, ...LEGACY_IDENTITY, locale: 'en' };
  return { apiKey, userJwt, ...CLI_IDENTITY, locale: 'en', os: DEVIN_OS };
}

function isPrivateIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(address) {
  const value = address.toLowerCase();
  if (value === '::' || value === '::1') return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  // WHATWG URL serializes mapped IPv4 as hex groups (::ffff:7f00:1).
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value);
}

function rejectApiHost(reason) {
  return new DevinWireError(`Devin returned an unsafe API host: ${reason}`, {
    code: 'protocol',
    retryable: false,
  });
}

// Validates a server-supplied API host before any credential is sent to it.
// Only public https origins (optionally with a path) are accepted; returns
// the normalized base URL without a trailing slash.
export function validateDevinApiHost(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw rejectApiHost('not a URL');
  }
  if (url.protocol !== 'https:') throw rejectApiHost('https is required');
  if (url.username || url.password) throw rejectApiHost('embedded credentials');
  if (url.search || url.hash) throw rejectApiHost('query or fragment');
  const hostname = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!hostname) throw rejectApiHost('missing host');
  const family = isIP(hostname);
  if (family === 4 && isPrivateIPv4(hostname)) throw rejectApiHost('private address');
  if (family === 6 && isPrivateIPv6(hostname)) throw rejectApiHost('private address');
  if (!family) {
    if (!hostname.includes('.')) throw rejectApiHost('single-label host');
    if (/(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa)$/.test(hostname)) {
      throw rejectApiHost('local host name');
    }
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function requestUserJwt({ apiKey, baseUrl, fetchFn, signal }) {
  return devinUnary({
    baseUrl,
    path: DEVIN_GET_USER_JWT_PATH,
    requestType: 'GetUserJwtRequest',
    responseType: 'GetUserJwtResponse',
    message: { metadata: devinRequestMetadata({ apiKey }) },
    fetchFn,
    signal,
  });
}

// Exchanges a Devin session token for the user JWT chat calls carry.
// Returns { jwt, apiKey, apiHost? }: `apiKey` is the wire key that was
// accepted (the prefixed session token, or the raw token for legacy keys),
// to be reused in `Metadata.apiKey`; `apiHost` is the validated per-account
// API server when the server names one.
export async function exchangeDevinUserJwt({
  sessionToken,
  fetchFn = fetch,
  signal,
  baseUrl = DEVIN_DEFAULT_BASE_URL,
}) {
  const raw = String(sessionToken || '');
  if (!raw) {
    throw new DevinWireError('Devin session token is missing', { code: 'unauthenticated', status: 401 });
  }
  let apiKey = normalizeDevinSessionToken(raw);
  let response;
  try {
    response = await requestUserJwt({ apiKey, baseUrl, fetchFn, signal });
  } catch (error) {
    // Raw API keys are rejected (HTTP 401) with the session prefix; retry them as-is.
    if (!(error instanceof DevinWireError) || error.status !== 401 || raw === apiKey) throw error;
    apiKey = raw;
    response = await requestUserJwt({ apiKey, baseUrl, fetchFn, signal });
  }
  const jwt = String(response.userJwt || '');
  if (!jwt) throw new DevinWireError('Devin GetUserJwt returned no user JWT', { code: 'protocol' });
  const customHost = String(response.customApiServerUrl || '').trim();
  return {
    jwt,
    apiKey,
    ...(customHost ? { apiHost: validateDevinApiHost(customHost) } : {}),
  };
}
