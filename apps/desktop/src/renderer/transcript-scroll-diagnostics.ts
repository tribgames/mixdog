/**
 * Opt-in transcript scroll diagnostics, off by default. Enable from DevTools:
 *   window.__mixdogTranscriptScroll = true
 * or persist the flag:
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

let eventSink: ((event: string) => void) | null = null;

/** The streamed-text metrics count scroll events per frame while a run is open. */
export function setTranscriptScrollEventSink(sink: ((event: string) => void) | null): void {
  eventSink = sink;
}

/** One line per scroll-relevant event, ordered by the frame clock. */
export function logTranscriptScroll(event: string, fields: Record<string, number | string | boolean>): void {
  if (!transcriptScrollDiagnosticsEnabled()) return;
  eventSink?.(event);
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === 'number' ? Math.round(value) : value}`)
    .join(' ');
  console.debug(`[transcript-scroll] t=${Math.round(performance.now())} ${event} ${detail}`);
}
