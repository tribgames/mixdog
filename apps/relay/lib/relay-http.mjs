// Shared HTTP/WebSocket request helpers for the relay: origin checks, caller
// identity, phone-leg capacity, and the trust-on-first-use upgrade authenticator.
import { isRoutingId } from './ids.mjs';

export const MAX_PHONE_CONNECTIONS_PER_MINUTE = 120;
export const PHONE_CONNECT_RATE_WINDOW_MS = 60_000;
export const MAX_PHONE_CLIENTS_PER_DEVICE = 32;

export function phoneClientCapacityAvailable(clientCount) {
  return Number(clientCount) < MAX_PHONE_CLIENTS_PER_DEVICE;
}

export function browserSocketOriginAllowed(request) {
  const origin = typeof request?.headers?.origin === 'string' ? request.headers.origin : '';
  const host = typeof request?.headers?.host === 'string' ? request.headers.host : '';
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const protocol = request?.socket?.encrypted ? 'https:' : 'http:';
    return (
      parsed.protocol === protocol &&
      parsed.host.toLowerCase() === host.toLowerCase() &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function clientIp(request) {
  return request.socket?.remoteAddress || 'unknown';
}

/** Whether a desktop leg entry exists and its socket is still open. */
export function desktopLegOpen(entry) {
  return Boolean(entry) && entry.socket.readyState === entry.socket.OPEN;
}

/** `{ url, pathname }` for the request line, or null when it cannot be parsed
 *  (malformed URL or percent-encoding). */
export function decodedRequestPath(request) {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    return { url, pathname: decodeURIComponent(url.pathname) };
  } catch {
    return null;
  }
}

/** A status the desktop reported for an upstream answer, else 502. */
export function upstreamStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 502;
}

export function endText(response, status, text, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }).end(text);
}

/** Bounded probing: a caller past the unauthorized limiter is throttled (429)
 *  instead of buying unlimited token guesses and log noise; otherwise 401. */
export function rejectUnauthorizedText(unauthorizedLimiter, request, response) {
  if (!unauthorizedLimiter.allow(clientIp(request))) {
    endText(response, 429, 'Too many requests.', { 'Retry-After': '60' });
    return;
  }
  endText(response, 401, 'Unauthorized.');
}

export function authenticateLeg(store, registerLimiter, unauthorizedLimiter, request, deviceId, secret) {
  if (!isRoutingId(deviceId) || secret.length < 16) return 401;
  if (!store.isKnown(deviceId) && !registerLimiter.allow(clientIp(request))) return 429;
  if (store.authenticate(deviceId, secret)) return 0;
  return unauthorizedLimiter.allow(`auth:${clientIp(request)}`) ? 401 : 429;
}
