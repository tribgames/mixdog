import { MAX_MX_CHARS, NATIVE_PUSH_REASONS, validNativeToken } from './native-push.mjs';

const MAX_NATIVE_BINDINGS_PER_DEVICE = 64;
const COLLAPSE_KEY = /^[A-Za-z0-9_-]{1,64}$/u;

export function nativePushPlatforms(leg) {
  return leg.nativePush?.platforms ?? [];
}

const associationKey = (deviceId, clientId) => `${deviceId}\n${clientId}`;

// Per table: the tokens each desktop holds an association for, so a desktop's
// bindings are found without a scan of every token.
const tokensByDevice = new WeakMap();

function heldTokens(bindings, deviceId) {
  let byDevice = tokensByDevice.get(bindings);
  if (!byDevice) tokensByDevice.set(bindings, (byDevice = new Map()));
  let tokens = byDevice.get(deviceId);
  if (!tokens) byDevice.set(deviceId, (tokens = new Set()));
  return tokens;
}

function forgetToken(bindings, deviceId, token) {
  const byDevice = tokensByDevice.get(bindings);
  const tokens = byDevice?.get(deviceId);
  if (!tokens) return;
  tokens.delete(token);
  if (tokens.size === 0) byDevice.delete(deviceId);
}

/** The associations held for one token, upgrading a single-binding entry. */
function associationsOf(bindings, token) {
  const entry = bindings.get(token);
  if (!entry || entry instanceof Map) return entry;
  const upgraded = new Map([[associationKey(entry.deviceId, entry.clientId), entry]]);
  bindings.set(token, upgraded);
  heldTokens(bindings, entry.deviceId).add(token);
  return upgraded;
}

/** Removes the associations of `deviceId` (optionally one client, optionally
 *  one token) and forgets tokens nobody is associated with any more. */
function dropAssociations(bindings, deviceId, { clientId = null, token = null } = {}) {
  for (const key of token === null ? [...(tokensByDevice.get(bindings)?.get(deviceId) ?? [])] : [token]) {
    const associations = associationsOf(bindings, key);
    if (!associations) continue;
    let deviceHolds = false;
    for (const [id, association] of associations) {
      if (association.deviceId !== deviceId) continue;
      if (clientId === null || association.clientId === clientId) associations.delete(id);
      else deviceHolds = true;
    }
    if (associations.size === 0) bindings.delete(key);
    if (!deviceHolds) forgetToken(bindings, deviceId, key);
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
    for (const other of [...(tokensByDevice.get(nativeBindings)?.get(deviceId) ?? [])]) {
      for (const association of associationsOf(nativeBindings, other).values()) {
        if (association.deviceId === deviceId) mine += 1;
      }
    }
    if (mine >= MAX_NATIVE_BINDINGS_PER_DEVICE) return;
  }
  if (associations) associations.set(key, { deviceId, clientId, platform });
  else nativeBindings.set(token, new Map([[key, { deviceId, clientId, platform }]]));
  heldTokens(nativeBindings, deviceId).add(token);
}

// `clientId` is optional: without it (older desktops) every association THIS
// desktop holds for the token goes; another desktop's never does.
export function unbindNativeToken({ deviceId, nativeBindings }, message) {
  if (!nativeBindings || typeof message.token !== 'string') return;
  const clientId = typeof message.clientId === 'string' ? message.clientId : null;
  dropAssociations(nativeBindings, deviceId, { clientId, token: message.token });
}

function validPushMessage(leg, { platform, token, mx, reason, collapseKey }) {
  return (
    nativePushPlatforms(leg).includes(platform) &&
    validNativeToken(platform, token) &&
    typeof mx === 'string' &&
    mx.length > 0 &&
    mx.length <= MAX_MX_CHARS &&
    NATIVE_PUSH_REASONS.has(reason) &&
    typeof collapseKey === 'string' &&
    COLLAPSE_KEY.test(collapseKey)
  );
}

function holdsBinding({ store, deviceId, nativeBindings }, platform, token) {
  const associations = associationsOf(nativeBindings, token);
  return [...(associations?.values() ?? [])].some(
    (association) =>
      association.deviceId === deviceId &&
      association.platform === platform &&
      owns(store, deviceId, association.clientId)
  );
}

export function sendNativePush(leg, message) {
  const { deviceId, socket, sendJson, nativeBindings, nativePush, nativeLimiter } = leg;
  if (!nativePush || !nativeBindings) return;
  const { platform, token, mx, reason, collapseKey } = message;
  const reply = (fields) => sendJson(socket, { type: 'native-push-result', platform, token, collapseKey, ...fields });
  if (!validPushMessage(leg, message)) {
    reply({ ok: false, error: 'invalid-message' });
    return;
  }
  if (!holdsBinding(leg, platform, token)) {
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
