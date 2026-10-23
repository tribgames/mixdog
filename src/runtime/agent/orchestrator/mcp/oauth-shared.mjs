export const REAUTHENTICATION_REQUIRED_MESSAGE = 'MCP OAuth reauthenticationRequired: sign in to connect';
export const reauthenticationRequired = () =>
  Object.assign(new Error(REAUTHENTICATION_REQUIRED_MESSAGE), {
    code: 'reauthenticationRequired',
  });
export const loginFailed = () => new Error('MCP OAuth login failed, cancelled, or timed out');

// A sign-in whose token response lacks a requested scope (a provider's
// granular consent let the user leave a box unchecked). The message names only
// the scopes, never token data; callers match on the marker, which survives
// the wrapping transports and connect paths apply to the message.
export const SCOPE_NOT_GRANTED_MARKER = 'MCP OAuth scopeNotGranted';
export const scopeNotGranted = (missing) =>
  Object.assign(new Error(`${SCOPE_NOT_GRANTED_MARKER}: access not granted for ${missing.join(' ')}`), {
    code: 'scopeNotGranted',
    missingScopes: [...missing],
  });

// The basic identity scopes are never checked: Google answers a requested
// `email` with its userinfo.email URL (likewise `profile`).
const BASIC_SCOPES = new Set(['openid', 'email', 'profile']);

/** The requested non-basic scopes a token response's `scope` leaves out. A
 *  response without a `scope` field grants what was requested (RFC 6749). */
export function missingScopes(requested, granted) {
  if (typeof granted !== 'string') return [];
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return (requested || []).filter((scope) => !BASIC_SCOPES.has(scope) && !have.has(scope));
}

// `signal`, also aborted by the caller's optional `other` signal.
export const anySignal = (signal, other) => AbortSignal.any(other ? [signal, other] : [signal]);
