// The link between a server (ssh) window and its daemon: what the window shows
// while the tunnel is up, recovering, lost or paused for sleep, and the notices
// main sends once the window is attached again.

export type DesktopConnectionLinkState =
  | { status: 'connected' }
  /** `nextRetryAt` (epoch ms) is null while an attempt is running. */
  | { status: 'reconnecting'; attempt: number; nextRetryAt: number | null }
  /** `terminal`: only a new connection can fix it (host key, login, server
   *  install). `settingsRequired`: it needs the user's confirmation, which only
   *  Settings → Connection in this PC's window can give. */
  | { status: 'lost'; terminal: boolean; code: string; message: string; settingsRequired?: boolean }
  /** This PC is asleep: not a failure. */
  | { status: 'paused' };

export interface DesktopConnectionLinkView {
  connectionId: string;
  state: DesktopConnectionLinkState;
  /** Last health round trip through the tunnel in ms; null before the first. */
  rttMs: number | null;
  /** False when the server cannot run terminals; everything else still works. */
  terminalsAvailable: boolean;
}

export type DesktopConnectionNotice =
  /** The window is attached again. Session titles whose turn finished or kept
   *  running on the server meanwhile, and model calls that broke off. */
  | { kind: 'reattached'; finished: string[]; continued: string[]; interruptedModelCalls: number }
  /** Tool calls whose result never arrived; they are not run again. */
  | { kind: 'outcome-unknown'; sessionId: string; toolIds: string[] }
  /** This PC's model sign-in was refused during the server's turn. */
  | { kind: 'model-sign-in'; provider: string };

/** Startup reopening of the server windows open at the last quit, shown in
 *  this PC's window. */
export interface DesktopServerRestoreProgress {
  id: string;
  name: string;
  phase: 'connect' | 'check' | 'install' | 'start' | 'ready' | 'failed';
  message?: string;
}
