// How Node's terminal calls read on the protocol, shared by the desktop's operation route (main) and the phone's terminal
// adapter (renderer): the request a call becomes and what a reply is made into, so both answer as Node's remote methods did.
import { readRemoteTerminalRun, remoteTerminalRun, type DesktopTerminalRunRequest } from './terminal-command';

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** Node's `termEnsure(id, cwd, shell)`: each value counts only as a non-empty string; with no id the core makes one. */
export function terminalEnsureRequest(tabId: unknown, cwd: unknown, profile: unknown): { method: 'terminal/ensure'; params: Record<string, unknown> } {
  const options: Record<string, unknown> = {};
  if (text(cwd)) options.cwd = cwd;
  if (text(profile)) options.profile = profile;
  return { method: 'terminal/ensure', params: { ...(text(tabId) ? { tabId } : {}), options } };
}

/** Node's `termResize(id, cols, rows, phoneOwner)` as the `terminal/resize` notification. The phone's call reached Node as a JSON frame
 *  (NaN, Infinity and undefined arrive as null), the remote method took `Number` of each size (remote-methods.ts:1163) and the manager
 *  released a claim that is not positive in both, or floored and clamped the size to 2..500 x 2..200, 0 and NaN standing for 80 x 24
 *  (terminal-manager.ts:429-436). The same is done here, so every size the phone sends is one the core takes, a release included
 *  (a claim of 0 x 0). Recorded: apps/mobile/fixtures/terminal-resize/golden.json. */
export function terminalResizeRequest(tabId: unknown, cols: unknown, rows: unknown, phoneOwner: unknown): { tabId: string; cols: number; rows: number; claim?: true } {
  const sent = JSON.parse(JSON.stringify([tabId ?? null, cols ?? null, rows ?? null])) as unknown[];
  const id = String(sent[0] || '');
  const [width, height] = [Number(sent[1]), Number(sent[2])];
  if (phoneOwner === true && !(width > 0 && height > 0)) return { tabId: id, cols: 0, rows: 0, claim: true };
  const size = (value: number, fallback: number, max: number): number => Math.max(2, Math.min(max, Math.floor(value) || fallback));
  return { tabId: id, cols: size(width, 80, 500), rows: size(height, 24, 200), ...(phoneOwner === true ? { claim: true as const } : {}) };
}

/** Node answered `{id, replay, sizeOwner?}` and left `sizeOwner` out when no phone owns the size, where the core writes null.
 *  `client` is the asking connection's key in the core's size-owner events; it is not part of Node's answer. */
export function terminalReply(reply: unknown): { id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } } {
  const { client: _client, sizeOwner, ...rest } = (reply ?? {}) as Record<string, unknown>;
  return { ...rest, ...(sizeOwner == null ? {} : { sizeOwner }) } as { id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } };
}

/** `termActivity`: Node answered `[{id, state}]` of the tabs with a known state, in creation order; the section is `{<tabId>: state}`. */
export function terminalActivityRows(section: unknown): { id: string; state: unknown }[] {
  const value = section && typeof section === 'object' ? (section as Record<string, unknown>) : {};
  return Object.entries(value).map(([id, state]) => ({ id, state }));
}

/** What a paired client is told of `ui/openRequested{kind: 'terminal'}`: no ack id and no path (Node's relay push), or null
 *  when the payload is not a reveal. */
export function terminalRunPush(open: unknown): DesktopTerminalRunRequest | null {
  const { kind: _kind, ...request } = (open ?? {}) as Record<string, unknown>;
  return readRemoteTerminalRun(remoteTerminalRun(request as unknown as DesktopTerminalRunRequest));
}
