type RemoteConnectionState = 'connecting' | 'syncing' | 'connected' | 'reconnecting';

export const REMOTE_CONNECTION_STATE_EVENT = 'mixdog:remote-connection-state';
export const REMOTE_CONNECTION_INTERRUPTED_CODE = 'MIXDOG_REMOTE_CONNECTION_INTERRUPTED';

/** Manual retry from the connection chip. The shim reconnects on it exactly as
 *  it does on a foreground wake, so a user never has to wait out the backoff. */
export const REMOTE_WAKE_EVENT = 'mixdog:remote-wake';

export type RemoteConnectionPhase =
  | 'approval'
  | 'registration'
  | 'websocket'
  | 'encryption'
  | 'sync'
  | 'connected'
  | 'background';
export type RemoteConnectionIssue =
  | 'registration-failed'
  | 'websocket-timeout'
  | 'websocket-error'
  | 'websocket-closed'
  | 'encryption-timeout'
  | 'frame-failed'
  | 'sync-failed'
  | 'state-gap'
  | 'sessions-gap'
  | 'agents-gap'
  | 'transcript-gap'
  | 'heartbeat-timeout';

// Connection diagnostics recorded on <html> data attributes for inspection;
// never shown on screen. Never copy arbitrary error messages, URLs, close
// reasons, credentials, or transcript data into them.
const DIAGNOSTIC_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'OperationError',
  'InvalidStateError',
  'NotSupportedError',
  'DataError',
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'RemoteConnectionInterruptedError',
]);
const DIAGNOSTIC_ERROR_MESSAGES = new Set([
  'View synchronization request is invalid.',
  'View synchronization is unavailable.',
  'Remote view was replaced during synchronization.',
  'Invalid view baseline.',
  'Invalid view baseline key.',
  'Invalid view baseline frame.',
  'View baseline is no longer available.',
  'Unexpected view baseline event.',
  'Relay encryption handshake was not established.',
  'Relay sent data before encryption was ready.',
  'Duplicate relay encryption challenge.',
  'Expected an encrypted relay frame.',
  'Rejected replayed relay frame.',
  'Invalid relay frame nonce.',
]);

export function setRemoteConnectionPhase(phase: RemoteConnectionPhase): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const data = document.documentElement.dataset;
  if (data.mixdogRemotePhase === phase) return;
  data.mixdogRemotePhase = phase;
  window.dispatchEvent(new window.Event(REMOTE_CONNECTION_STATE_EVENT));
}

function diagnosticDetail(error: unknown): string {
  if (error === undefined) return '';
  const failure = error as { name?: unknown; message?: unknown } | null;
  const message = failure?.message;
  if (typeof message === 'string' && DIAGNOSTIC_ERROR_MESSAGES.has(message)) return message;
  const name = failure?.name;
  if (typeof name === 'string' && DIAGNOSTIC_ERROR_NAMES.has(name)) return name;
  return 'Error';
}

export function reportRemoteConnectionIssue(issue: RemoteConnectionIssue, error?: unknown, code?: number): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const detail = diagnosticDetail(error);
  const data = document.documentElement.dataset;
  data.mixdogRemoteError = [
    data.mixdogRemotePhase || 'approval',
    issue,
    ...(Number.isInteger(code) ? [`code=${code}`] : []),
    ...(detail ? [detail] : []),
  ].join(' / ');
  window.dispatchEvent(new window.Event(REMOTE_CONNECTION_STATE_EVENT));
}

export function remoteConnectionInterruptedError(): Error & { code: string } {
  const error = new Error('') as Error & { code: string };
  error.name = 'RemoteConnectionInterruptedError';
  error.code = REMOTE_CONNECTION_INTERRUPTED_CODE;
  return error;
}

export function shouldRunRemoteHeartbeat(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === 'visible';
}

function isRemoteConnectionState(value: unknown): value is RemoteConnectionState {
  return value === 'connecting' || value === 'syncing' || value === 'connected' || value === 'reconnecting';
}

export function currentRemoteConnectionState(): RemoteConnectionState | null {
  if (typeof document === 'undefined') return null;
  const value = document.documentElement.dataset.mixdogRemoteConnection;
  return isRemoteConnectionState(value) ? value : null;
}

export function setRemoteConnectionState(state: RemoteConnectionState): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (currentRemoteConnectionState() === state) return;
  document.documentElement.dataset.mixdogRemoteConnection = state;
  if (state === 'connected' && document.documentElement.dataset.mixdogRemotePhase) {
    document.documentElement.dataset.mixdogRemotePhase = 'connected';
    delete document.documentElement.dataset.mixdogRemoteError;
  }
  window.dispatchEvent(new window.Event(REMOTE_CONNECTION_STATE_EVENT));
}

export function clearRemoteConnectionState(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (currentRemoteConnectionState() === null && !document.documentElement.dataset.mixdogRemotePhase) return;
  delete document.documentElement.dataset.mixdogRemoteConnection;
  delete document.documentElement.dataset.mixdogRemotePhase;
  delete document.documentElement.dataset.mixdogRemoteError;
  window.dispatchEvent(new window.Event(REMOTE_CONNECTION_STATE_EVENT));
}

export function subscribeRemoteConnectionState(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(REMOTE_CONNECTION_STATE_EVENT, listener);
  return () => window.removeEventListener(REMOTE_CONNECTION_STATE_EVENT, listener);
}
