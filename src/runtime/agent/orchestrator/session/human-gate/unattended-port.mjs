// session/human-gate/unattended-port.mjs
// The port unattended runs (schedule, webhook, room member) register
// (session-runtime/held-requests.mjs): `{ runOf(sessionId) → { kind, agentId,
// name } | null, hold(request, { signal }) → Promise<approval>,
// humanNeeded(sessionId, outcome, site) → Promise<boolean> }` — the last ends
// a schedule/webhook run that would need a takeover. gate.mjs re-exports it.
let unattendedPort = null;

export function setUnattendedApprovalPort(port) {
  unattendedPort = port || null;
}

export function unattendedApprovalPort() {
  return unattendedPort;
}
