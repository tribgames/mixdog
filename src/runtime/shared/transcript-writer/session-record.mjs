/**
 * transcript-writer/session-record.mjs — the `<mixdogHome>/sessions/<pid>.json`
 * record that names this session's transcript for discovery, plus the
 * first-occurrence failure logger every transcript writer shares.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Repeated-failure guard: log the first time each distinct message is seen,
// then stay quiet so a persistently-broken path does not flood stderr.
export function createFailureLog() {
  const seenErrors = new Set();
  return function logOnce(err) {
    const msg = err?.message ? err.message : String(err);
    if (seenErrors.has(msg)) return;
    seenErrors.add(msg);
    try {
      process.stderr.write(`mixdog: transcript-writer: ${msg}\n`);
    } catch {
      /* stderr broken */
    }
  };
}

export function createSessionRecord({ sessionRecordPath, sessionId, resolvedCwd, transcriptPath, logOnce }) {
  const startedAt = Date.now();

  function write() {
    try {
      mkdirSync(dirname(sessionRecordPath), { recursive: true });
      writeFileSync(
        sessionRecordPath,
        JSON.stringify({
          sessionId,
          cwd: resolvedCwd,
          transcriptPath,
          startedAt,
          updatedAt: Date.now(),
          kind: 'interactive',
          entrypoint: 'cli',
        })
      );
    } catch (err) {
      logOnce(err);
    }
  }

  return { write };
}
