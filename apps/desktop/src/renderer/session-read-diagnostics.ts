import {
  reportTranscriptRead,
  type TranscriptReadDiagnostic,
  type TranscriptReadDetails,
} from '../shared/transcript-read-diagnostics';

// Only pending reads are observed. Streaming tokens do not generate records.
const reads = new Map<
  string,
  {
    traceId: string;
    startedAt: number;
    received: boolean;
    applied: boolean;
    settled: boolean;
    reported: Set<string>;
  }
>();
const MAX_READ_TRACES = 64;

function emit(diagnostic: TranscriptReadDiagnostic): void {
  window.mixdogDesktop?.rendererDiagnostic?.(diagnostic);
}

export function beginSessionReadTrace(sessionId: string): string {
  const traceId = crypto.randomUUID();
  reads.delete(sessionId);
  reads.set(sessionId, {
    traceId,
    startedAt: performance.now(),
    received: false,
    applied: false,
    settled: false,
    reported: new Set(),
  });
  while (reads.size > MAX_READ_TRACES) reads.delete(reads.keys().next().value!);
  reportTranscriptRead(sessionId, traceId, 'request-start', {}, emit);
  return traceId;
}

export function reportSessionRead(
  sessionId: string,
  stage: TranscriptReadDiagnostic['stage'],
  details: TranscriptReadDetails = {},
  traceId?: string
): void {
  const read = reads.get(sessionId);
  if (!read || (traceId && read.traceId !== traceId)) return;
  // A stuck read may be joined or receive a rejected replay repeatedly.
  const key = `${stage}:${details.attempt ?? ''}`;
  if (read.reported.has(key)) return;
  read.reported.add(key);
  reportTranscriptRead(
    sessionId,
    read.traceId,
    stage,
    {
      ...details,
      elapsedMs: performance.now() - read.startedAt,
    },
    emit
  );
}

export function settleSessionReadTrace(sessionId: string, traceId: string, hasLane: boolean): void {
  const read = reads.get(sessionId);
  if (!read || read.traceId !== traceId) return;
  read.settled = true;
  if (read.applied || hasLane) reads.delete(sessionId);
}

export function reportSessionReadFrame(
  update: { sessionId: string; snapshot: unknown; readTraceId?: string },
  phase: 'received' | 'applied' | 'rejected',
  durationMs = 0
): void {
  const read = reads.get(update.sessionId);
  if (!read || (update.readTraceId && update.readTraceId !== read.traceId)) return;
  if (phase === 'received' && read.received) return;
  if (phase === 'applied' && read.applied) return;
  const items = (update.snapshot as { items?: unknown } | null)?.items;
  reportSessionRead(update.sessionId, `frame-${phase}`, {
    durationMs,
    hasLane: update.snapshot !== null,
    itemCount: Array.isArray(items) ? items.length : 0,
  });
  if (phase === 'received') read.received = true;
  if (phase === 'applied' && update.snapshot) {
    read.applied = true;
    if (read.settled) reads.delete(update.sessionId);
  }
}
