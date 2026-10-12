// Desktop-leg handlers for native push. A token is a delivery destination, not
// something one desktop owns: one phone paired with several PCs hands the same
// installation token to each of them. Every desktop therefore holds its OWN
// association (token -> {deviceId, clientId, platform}), made over its
// authenticated leg for one of ITS OWN paired clients and checked against the
// device store on every send. A desktop sends only through an association it
// holds, and unbind/revoke only ever removes that desktop's associations.
//
// Shape: Map<token, Map<associationKey, { deviceId, clientId, platform }>>.
// The single-binding shape (Map<token, { deviceId, clientId, platform }>) is
// still read: it is upgraded in place the first time its token is touched.
import { MAX_MX_CHARS, NATIVE_PUSH_REASONS, validNativeToken } from './native-push.mjs';

const MAX_NATIVE_BINDINGS_PER_DEVICE = 64;
const COLLAPSE_KEY = /^[A-Za-z0-9_-]{1,64}$/u;

export function nativePushPlatforms(leg) {
  return leg.nativePush?.platforms ?? [];
}

const associationKey = (deviceId, clientId) => `${deviceId}\n${clientId}`;

/** The associations held for one token, upgrading a single-binding entry. */
function associationsOf(bindings, token) {
  const entry = bindings.get(token);
  if (!entry || entry instanceof Map) return entry;
  const upgraded = new Map([[associationKey(entry.deviceId, entry.clientId), entry]]);
  bindings.set(token, upgraded);
  return upgraded;
}

/** Removes the associations of `deviceId` (optionally one client, optionally
 *  one token) and forgets tokens nobody is associated with any more. */
function dropAssociations(bindings, deviceId, { clientId = null, token = null } = {}) {
  for (const key of token === null ? [...bindings.keys()] : [token]) {
    const associations = associationsOf(bindings, key);
    if (!associations) continue;
    for (const [id, association] of associations) {
      if (association.deviceId === deviceId && (clientId === null || association.clientId === clientId)) {
        associations.delete(id);
      }
    }
    if (associations.size === 0) bindings.delete(key);
  }
}

/** Forgets every binding a revoked client (or device) could still send to. */
export function dropNativeBindings(bindings, deviceId, clientId = null) {
  if (!bindings) return;
  dropAssociations(bindings, deviceId, { clientId });
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
  const key = associationKey(deviceId, clientId);
  const associations = associationsOf(nativeBindings, token);
  if (!associations?.has(key)) {
    let mine = 0;
    for (const other of [...nativeBindings.keys()]) {
      for (const association of associationsOf(nativeBindings, other).values()) {
        if (association.deviceId === deviceId) mine += 1;
      }
    }
    if (mine >= MAX_NATIVE_BINDINGS_PER_DEVICE) return;
  }
  if (associations) associations.set(key, { deviceId, clientId, platform });
  else nativeBindings.set(token, new Map([[key, { deviceId, clientId, platform }]]));
}

// `clientId` is optional: without it (older desktops) every association THIS
// desktop holds for the token goes; another desktop's never does.
export function unbindNativeToken({ deviceId, nativeBindings }, message) {
  if (!nativeBindings || typeof message.token !== 'string') return;
  const clientId = typeof message.clientId === 'string' ? message.clientId : null;
  dropAssociations(nativeBindings, deviceId, { clientId, token: message.token });
}

export function sendNativePush(leg, message) {
  const { store, deviceId, socket, sendJson, nativeBindings, nativePush, nativeLimiter } = leg;
  if (!nativePush || !nativeBindings) return;
  const { platform, token, mx, reason, collapseKey } = message;
  const reply = (fields) => sendJson(socket, { type: 'native-push-result', platform, token, collapseKey, ...fields });
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
  const associations = associationsOf(nativeBindings, token);
  const bound = [...(associations?.values() ?? [])].some(
    (association) =>
      association.deviceId === deviceId &&
      association.platform === platform &&
      owns(store, deviceId, association.clientId)
  );
  if (!bound) {
    reply({ ok: false, error: 'unbound-token' });
    return;
  }
  if (nativeLimiter && !nativeLimiter.allow(deviceId)) {
    reply({ ok: false, error: 'rate-limited' });
    return;
  }
  void nativePush
    .send({
      platform,
      token,
      mx,
      reason,
      collapseKey,
      sandbox: typeof message.sandbox === 'boolean' ? message.sandbox : undefined,
    })
    .then((result) => {
      // Only the sender's associations go: every other desktop learns the
      // token is dead from its own send and cleans up its own store.
      if (result.invalid) dropAssociations(nativeBindings, deviceId, { token });
      reply({
        ok: result.ok,
        ...(result.status ? { status: result.status } : {}),
        ...(result.invalid ? { invalid: true } : {}),
        ...(result.error ? { error: String(result.error).slice(0, 80) } : {}),
      });
    });
}
