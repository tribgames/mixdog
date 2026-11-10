// The order of the desktop's boot diagnostics: lines written before the log exists wait for it; the core's report of a failed defaults
// separation is written the way Node's app-ready catch wrote it (b6f10295a apps/desktop/src/main/index.ts:2821-2825): `{ message }`
// alone, from outside the synchronous boot sequence, so after `desktop-start` (written at :2829), and never awaited by it or by the
// window that opens right after (:3062). The core's handshake may answer before the log exists; that line then waits for `desktop-start`.
import type { DesktopDiagnostics } from './desktop-diagnostics';

type Details = Record<string, unknown>;

export interface BootTimeline {
  /** A boot line: written at once when the log is open, else kept (with when it happened) until `open`. */
  write(event: string, entry: Details): void;
  /** The defaults-separation failure: after `desktop-start`, `{ message }` only. */
  defaultsSeparationFailed(details: { message: string }): void;
  /** The log exists: writes the kept lines, then `writeStart` (the `desktop-start` line), then any failure reported meanwhile. */
  open(log: DesktopDiagnostics, writeStart: () => void): void;
}

export function createBootTimeline(): BootTimeline {
  let log: DesktopDiagnostics | null = null;
  let started = false;
  const early: Array<{ event: string; entry: Details; at: string }> = [];
  const failures: Array<{ message: string }> = [];
  return {
    write(event, entry) {
      if (log) log.write(event, entry);
      else early.push({ event, entry, at: new Date().toISOString() });
    },
    defaultsSeparationFailed(details) {
      if (log && started) log.write('defaults-separation-failed', details);
      else failures.push(details);
    },
    open(opened, writeStart) {
      log = opened;
      for (const { event, entry, at } of early.splice(0)) opened.write(event, { ...entry, occurredAt: at });
      writeStart();
      started = true;
      for (const details of failures.splice(0)) opened.write('defaults-separation-failed', details);
    },
  };
}
