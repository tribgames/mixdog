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

export function authenticateLeg(store, registerLimiter, unauthorizedLimiter, request, deviceId, secret) {
  if (!isRoutingId(deviceId) || secret.length < 16) return 401;
  if (!store.isKnown(deviceId) && !registerLimiter.allow(clientIp(request))) return 429;
  if (store.authenticate(deviceId, secret)) return 0;
  return unauthorizedLimiter.allow(`auth:${clientIp(request)}`) ? 401 : 429;
}
