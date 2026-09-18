/**
 * Opt-in transcript scroll diagnostics.
 *
 * Every offset the transcript writes comes from one of three authorities: the
 * end pin, a virtual-core offset write, or a measured-row size change that the
 * core compensates. Attributing a visible jump means seeing which of them ran,
 * with what delta, in the frame the viewport actually moved — so each is
 * reported on one line against a shared frame clock.
 *
 * Off by default and free while off. Enable for the current window from
 * DevTools:
 *   window.__mixdogTranscriptScroll = true
 * A cold-entry jump happens before any console is open, so the flag can also be
 * persisted and is then live from the first measured row:
 *   localStorage.setItem('mixdog.transcript-scroll-diagnostics', '1')
 */
type DiagnosticsHost = typeof globalThis & { __mixdogTranscriptScroll?: boolean };

const STORAGE_KEY = 'mixdog.transcript-scroll-diagnostics';

function diagnosticsHost(): DiagnosticsHost {
  return globalThis as DiagnosticsHost;
}

// Resolved once at module load: the persisted flag has to be readable before
// the first row measures. An explicit runtime flag always wins over storage.
if (typeof window !== 'undefined' && diagnosticsHost().__mixdogTranscriptScroll === undefined) {
  try {
    if (window.localStorage.getItem(STORAGE_KEY) === '1') diagnosticsHost().__mixdogTranscriptScroll = true;
  } catch {
    /* storage unavailable: diagnostics stay off */
  }
}

export function transcriptScrollDiagnosticsEnabled(): boolean {
  return diagnosticsHost().__mixdogTranscriptScroll === true;
}

/** One line per scroll-relevant event, ordered by the frame clock. */
export function logTranscriptScroll(event: string, fields: Record<string, number | string | boolean>): void {
  if (!transcriptScrollDiagnosticsEnabled()) return;
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : value}`)
    .join(' ');
  console.debug(`[transcript-scroll] t=${Math.round(performance.now())} ${event} ${detail}`);
}
