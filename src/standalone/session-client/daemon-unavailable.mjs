// The error ensureDaemon throws when no session endpoint appeared before its
// deadline. The first line is the stable message callers and tests match; the
// lines below carry what the last pass observed — an unanswered discovery, an
// owner that never published, the newest candidate's exit and first stderr
// error — so the desktop error card's details name the cause, not only the
// symptom.
export const DAEMON_UNAVAILABLE_MESSAGE = 'daemon session endpoint is unavailable';

function exitCodeText(code) {
  // Windows reports NTSTATUS crash codes as large unsigned values.
  // 0xE0000008 is Chromium's kOomExceptionCode; 134 is a V8 fatal error (abort).
  if (code === 0xe0000008 || code === -536870904) return `${code === -536870904 ? code : '0xE0000008'} (out of memory)`;
  if (code === 134) return '134 (V8 fatal error (JavaScript heap out of memory))';
  return Number.isSafeInteger(code) && code > 0x7fffffff ? `0x${code.toString(16).toUpperCase()}` : String(code);
}

function candidateLines(candidate, { attempt, maxAttempts, now }) {
  const head = `last daemon candidate (attempt ${attempt} of ${maxAttempts})`;
  if (!candidate.pid) return [`${head} failed to spawn: ${candidate.error || 'unknown error'}`];
  let state;
  if (candidate.exitedAt) {
    state =
      `exited code=${candidate.exitCode === null ? '-' : exitCodeText(candidate.exitCode)}` +
      ` signal=${candidate.exitSignal || '-'} after ${candidate.uptimeMs ?? '?'}ms` +
      (candidate.exitReason ? ` (${candidate.exitReason})` : '');
  } else if (candidate.ready) {
    state = 'reported ready but its endpoint never answered';
  } else {
    const spawnedAt = Date.parse(candidate.spawnedAt || '');
    state = `still running, not ready ${Number.isFinite(spawnedAt) ? now - spawnedAt : '?'}ms after spawn`;
  }
  const lines = [`${head}: pid=${candidate.pid} ${state}`];
  if (candidate.stderrErrorLine) lines.push(`first stderr error: ${candidate.stderrErrorLine}`);
  else if (candidate.stderrLastLine) lines.push(`last stderr line: ${candidate.stderrLastLine}`);
  if (candidate.stderrPath) lines.push(`stderr capture: ${candidate.stderrPath}`);
  return lines;
}

export function daemonUnavailableError({
  discovery = null,
  owner = null,
  candidate = null,
  spawnAttempts = 0,
  maxSpawnAttempts = 0,
  captureDir,
  now = Date.now(),
}) {
  const lines = [DAEMON_UNAVAILABLE_MESSAGE];
  if (discovery) lines.push(`discovery: pid=${discovery.pid} port=${discovery.port} did not answer its health check`);
  if (owner) {
    lines.push(
      `daemon owner: pid=${owner.pid} (claimed ${owner.claimedAt || 'at an unknown time'}) held the lock` +
        ' but never published an endpoint'
    );
  }
  if (candidate) {
    lines.push(...candidateLines(candidate, { attempt: spawnAttempts, maxAttempts: maxSpawnAttempts, now }));
  } else {
    lines.push(`no daemon candidate was spawned (spawn attempts allowed: ${maxSpawnAttempts})`);
  }
  lines.push(`daemon crash captures: ${captureDir}`);
  const error = new Error(lines.join('\n'));
  error.daemonUnavailable = { discovery, owner, candidate, spawnAttempts, captureDir };
  return error;
}
