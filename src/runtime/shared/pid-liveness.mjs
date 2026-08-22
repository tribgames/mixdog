// Canonical process-liveness probe.
//
// Discovery files, singleton claims, transports, spawn guardians and the pg
// supervisor each used to carry their own byte-identical copy of this pair.
// The rule they all agreed on: a pid is only usable when it is a positive
// integer, and `process.kill(pid, 0)` failing with EPERM means the process
// EXISTS but belongs to another user (alive); ESRCH — and any other failure —
// means it is not addressable.
//
// Callers that must fail SAFE on an unknown error (treat anything but ESRCH as
// alive) keep their own probe on purpose; this is the fail-closed variant.

export function parsePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isPidAlive(value) {
  const pid = parsePid(value);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
