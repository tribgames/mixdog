// Desktop-leg handlers for native push. A token is an address the relay will
// deliver to, so it is only ever sent to by the desktop that bound it to one of
// ITS OWN paired clients: the binding (token -> deviceId/clientId) is made over
// the authenticated leg and checked against the device store on every send.
import { MAX_MX_CHARS, NATIVE_PUSH_REASONS, validNativeToken } from './native-push.mjs';

export const MAX_NATIVE_BINDINGS_PER_DEVICE = 64;
const COLLAPSE_KEY = /^[A-Za-z0-9_-]{1,64}$/u;

export function nativePushPlatforms(leg) {
  return leg.nativePush?.platforms ?? [];
}

/** Forgets every binding a revoked client (or device) could still send to. */
export function dropNativeBindings(bindings, deviceId, clientId = null) {
  if (!bindings) return;
  for (const [token, binding] of bindings) {
    if (binding.deviceId === deviceId && (clientId === null || binding.clientId === clientId)) bindings.delete(token);
  }
}

function owns(store, deviceId, clientId) {
  return typeof clientId === 'string' && store.hasClient?.(deviceId, clientId) === true;
}

export function bindNativeToken(leg, message) {
  const { store, deviceId, nativeBindings } = leg;
  if (!nativeBindings) return;
  const { platform, token, clientId } = message;
  if (!nativePushPlatforms(leg).includes(platform) || !validNativeToken(platform, token)) return;
  if (!owns(store, deviceId, clientId)) return;
  const existing = nativeBindings.get(token);
  // First owner wins while its client is still paired; a stale binding (its
  // client was unpaired) may be taken over by whoever the phone paired with next.
  if (existing && existing.deviceId !== deviceId && owns(store, existing.deviceId, existing.clientId)) return;
  if (!existing || existing.deviceId !== deviceId) {
    let mine = 0;
    for (const binding of nativeBindings.values()) if (binding.deviceId === deviceId) mine += 1;
    if (mine >= MAX_NATIVE_BINDINGS_PER_DEVICE) return;
  }
  nativeBindings.set(token, { deviceId, clientId, platform });
}

export function unbindNativeToken({ deviceId, nativeBindings }, message) {
  if (nativeBindings?.get(message.token)?.deviceId === deviceId) nativeBindings.delete(message.token);
}

export function sendNativePush(leg, message) {
  const { store, deviceId, socket, sendJson, nativeBindings, nativePush, nativeLimiter } = leg;
  if (!nativePush || !nativeBindings) return;
  const { platform, token, mx, reason, collapseKey } = message;
  const reply = (fields) =>
    sendJson(socket, { type: 'native-push-result', platform, token, collapseKey, ...fields });
  if (
    !nativePushPlatforms(leg).includes(platform) ||
    !validNativeToken(platform, token) ||
    typeof mx !== 'string' ||
    mx.length === 0 ||
    mx.length > MAX_MX_CHARS ||
    !NATIVE_PUSH_REASONS.has(reason) ||
    typeof collapseKey !== 'string' ||
    !COLLAPSE_KEY.test(collapseKey)
  ) {
    reply({ ok: false, error: 'invalid-message' });
    return;
  }
  const binding = nativeBindings.get(token);
  if (
    !binding ||
    binding.deviceId !== deviceId ||
    binding.platform !== platform ||
    !owns(store, deviceId, binding.clientId)
  ) {
    reply({ ok: false, error: 'unbound-token' });
    return;
  }
  if (nativeLimiter && !nativeLimiter.allow(deviceId)) {
    reply({ ok: false, error: 'rate-limited' });
    return;
  }
  void nativePush
    .send({ platform, token, mx, reason, collapseKey, sandbox: typeof message.sandbox === 'boolean' ? message.sandbox : undefined })
    .then((result) => {
      if (result.invalid) nativeBindings.delete(token);
      reply({
        ok: result.ok,
        ...(result.status ? { status: result.status } : {}),
        ...(result.invalid ? { invalid: true } : {}),
        ...(result.error ? { error: String(result.error).slice(0, 80) } : {}),
      });
    });
}
