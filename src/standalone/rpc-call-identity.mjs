import { hashStructuredValue } from '../runtime/shared/json-metrics.mjs';

// Scheduling may belong to an addressed session, but retry identity belongs to
// the calling process and survives that process reconnecting with a new token.
export function clientCallOwner(client, token) {
  return client.leadPid ? `pid:${client.leadPid}` : `client:${token}`;
}

export function callSignature(name, args) {
  try {
    return hashStructuredValue({ name, args: args ?? {} });
  } catch {
    // An unhashable payload must never authorize a cached mutation replay.
    return null;
  }
}

export function callIdConflict(callId) {
  return Object.assign(
    new Error(`callId '${callId}' was reused with a different payload`),
    { code: 'ECALLIDCONFLICT' },
  );
}
