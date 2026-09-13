// A read trace contains identifiers and timings, never transcript/tool content.
export const TRANSCRIPT_READ_STAGES = [
  'request-start', 'request-joined', 'request-result', 'request-failed',
  'wait-expired', 'frame-received', 'frame-rejected', 'frame-applied',
  'host-start', 'host-read-start', 'host-read-result', 'host-projected',
  'host-published', 'host-failed', 'service-send', 'service-unchanged',
  'service-hidden', 'service-syncing', 'main-received', 'main-resync',
  'ipc-send', 'ipc-unchanged', 'ipc-hidden',
] as const;

export interface TranscriptReadDiagnostic {
  kind: 'transcript-read';
  sessionId: string;
  traceId: string;
  stage: typeof TRANSCRIPT_READ_STAGES[number];
  atMs: number;
  elapsedMs?: number;
  durationMs?: number;
  itemCount?: number;
  attempt?: number;
  accepted?: boolean;
  hasLane?: boolean;
}

export function transcriptReadTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
    ? value : undefined;
}

export function normalizeTranscriptReadDiagnostic(value: unknown): TranscriptReadDiagnostic | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const sessionId = transcriptReadTraceId(input.sessionId);
  const traceId = transcriptReadTraceId(input.traceId);
  if (input.kind !== 'transcript-read' || !sessionId || !traceId
    || !TRANSCRIPT_READ_STAGES.includes(input.stage as TranscriptReadDiagnostic['stage'])
    || typeof input.atMs !== 'number' || !Number.isFinite(input.atMs) || input.atMs < 0) return null;
  const result: TranscriptReadDiagnostic = {
    kind: 'transcript-read', sessionId, traceId,
    stage: input.stage as TranscriptReadDiagnostic['stage'],
    atMs: Math.min(Number.MAX_SAFE_INTEGER, input.atMs),
  };
  for (const field of ['elapsedMs', 'durationMs', 'itemCount', 'attempt'] as const) {
    const number = input[field];
    if (typeof number === 'number' && Number.isFinite(number) && number >= 0) {
      result[field] = Math.min(Number.MAX_SAFE_INTEGER, Math.round(number * 10) / 10);
    }
  }
  for (const field of ['accepted', 'hasLane'] as const) {
    if (typeof input[field] === 'boolean') result[field] = input[field];
  }
  return result;
}

export type TranscriptReadDetails = Partial<Pick<TranscriptReadDiagnostic,
  'elapsedMs' | 'durationMs' | 'itemCount' | 'attempt' | 'accepted' | 'hasLane'>>;

let diagnosticSink = (diagnostic: TranscriptReadDiagnostic): void => {
  console.info(`[transcript-read] ${JSON.stringify(diagnostic)}`);
};

export function setTranscriptReadDiagnosticSink(
  sink: (diagnostic: TranscriptReadDiagnostic) => void,
): () => void {
  const previous = diagnosticSink;
  diagnosticSink = sink;
  return () => { if (diagnosticSink === sink) diagnosticSink = previous; };
}

export function reportTranscriptRead(
  sessionId: string,
  traceId: unknown,
  stage: TranscriptReadDiagnostic['stage'],
  details: TranscriptReadDetails = {},
  emit: (diagnostic: TranscriptReadDiagnostic) => void = diagnosticSink,
): void {
  try {
    const diagnostic = normalizeTranscriptReadDiagnostic({
      ...details, kind: 'transcript-read', sessionId, traceId, stage, atMs: Date.now(),
    });
    if (diagnostic) emit(diagnostic);
  } catch { /* Diagnostic sinks never change read or delivery outcomes. */ }
}
