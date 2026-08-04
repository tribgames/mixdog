// Wire protocol between the main-process TerminalHost proxy and the terminal
// utility process (terminal-worker.ts). PTYs live in the worker so a flooding
// shell can never saturate the main process event loop (VS Code ptyHost
// parity); the main process keeps only this thin message surface.
/** Spawn spec for one detected shell profile (shell-profiles.ts). The
 *  renderer only ever names a profile ID; main resolves it to this spec. */
export interface TerminalSpawnProfile {
  path: string;
  args?: string[];
  env?: Record<string, string>;
}

export type TerminalWorkerInbound =
  | {
    kind: 'ensure';
    requestId: number;
    id: string | null;
    cwd: string | null;
    profile?: TerminalSpawnProfile | null;
  }
  | { kind: 'write'; id: string; data: string }
  | { kind: 'resize'; id: string; cols: number; rows: number }
  | { kind: 'pause'; id: string }
  | { kind: 'resume'; id: string }
  | { kind: 'dispose'; id: string }
  | { kind: 'dispose-all' };

export type TerminalWorkerOutbound =
  | { kind: 'ensure-result'; requestId: number; ok: true; value: { id: string; replay: string } }
  | { kind: 'ensure-result'; requestId: number; ok: false; error: string }
  | { kind: 'data'; id: string; data: string };

/** Electron utility-process events wrap payloads as `{ data }`; direct
 * transports (tests) post the value itself. Accept both — but a PROTOCOL
 * message is never unwrapped: `{ kind: 'data', id, data }` carries its PTY
 * text under `data`, and unwrapping it by key presence handed the bare text
 * string to handleMessage, which dropped it (terminal panes stayed empty
 * while ensure-result, which has no `data` key, kept working). */
export function terminalMessageData(event: { data?: unknown } | unknown): unknown {
  if (!event || typeof event !== 'object') return event;
  if ('kind' in (event as object)) return event;
  return 'data' in (event as object) ? (event as { data?: unknown }).data : event;
}
