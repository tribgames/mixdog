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
