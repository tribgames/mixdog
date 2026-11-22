export * from './api.ts';
export { ClientFailure, connect, ladderDelay, setClientFailureText, uuidv7 } from './client.ts';
export { MockConn, MockNetwork } from './mock.ts';
export { DEFAULT_FIRST_CONNECT_DEADLINE_MS, DEFAULT_REQUEST_TIMEOUT_MS } from './request-limits.ts';
export { historyPositionOf, mergeToolRows, rowOf, rowsHeldFrom, rowsOf } from './rows.ts';
export {
  approvalSurface,
  desktopSessionState,
  sessionReducer,
  sessionStateOf,
  subscribeFramedSessionStates,
} from './session-state.ts';
export type { DesktopSessionState, SessionFold } from './session-state.ts';
export {
  moveTranscriptWindow,
  windowWant,
  WINDOW_PAGE_ROWS,
  WINDOW_TAIL_MAX_ROWS,
  WINDOW_VIEW_MAX_ROWS,
} from './transcript-window.ts';
export type { TranscriptMove, WindowWant } from './transcript-window.ts';
export { tailRun, viewRun, windowRuns } from './positioned.ts';
export type { HeldWindow, WindowRun } from './positioned.ts';
export { DEFAULT_HEALTH_INTERVAL_MS, DEFAULT_HEALTH_WINDOW_MS, SCHEDULING_GAP_MS } from './health.ts';
