// How Node's terminal calls read on the protocol, shared by the desktop's operation route and terminal host (main) and the phone's
// terminal adapter (renderer): the request a call becomes, what a reply is made into, and the pushes (output, activity, size owner)
// read from the core's feeds and sections, so both answer and push as Node did.
import { readRemoteTerminalRun, remoteTerminalRun, type DesktopTerminalRunRequest } from './terminal-command';
import { readTerminalActivityEvent, type TerminalActivityEvent } from './terminal-activity';
import type { TerminalSizeOwner, TerminalSizeOwnerEvent } from './terminal-size-owner';

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
 *  `client` is the asking connection's key in the core's size-owner events; it is not part of Node's answer. `replayLeadUnit` is the lone
 *  low surrogate Node's replay starts with when its window cut a non-BMP character (the core's JSON cannot hold it): it goes back in front. */
export function terminalReply(reply: unknown): { id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } } {
  const { client: _client, sizeOwner, replayLeadUnit, ...rest } = (reply ?? {}) as Record<string, unknown>;
  if (typeof replayLeadUnit === 'number' && typeof rest.replay === 'string') rest.replay = String.fromCharCode(replayLeadUnit) + rest.replay;
  return { ...rest, ...(sizeOwner == null ? {} : { sizeOwner }) } as { id: string; replay: string; sizeOwner?: { cols: number; rows: number; own: boolean } };
}

/** `termActivity`: Node answered `[{id, state}]` of the tabs with a known state, in creation order; the section is `{<tabId>: state}`. */
export function terminalActivityRows(section: unknown): { id: string; state: unknown }[] {
  const value = section && typeof section === 'object' ? (section as Record<string, unknown>) : {};
  return Object.entries(value).map(([id, state]) => ({ id, state }));
}

/** Node's per-change `terminal-activity` events, from a change of the `terminalActivity` section: each tab whose state differs from
 *  `held` (the section as last read, which becomes this read) and `state: null` for a tab no longer listed. */
export function terminalActivityChanges(held: Map<string, unknown>, section: unknown): TerminalActivityEvent[] {
  const next = new Map(terminalActivityRows(section).map((row) => [row.id, row.state] as const));
  const events = [
    ...[...next].filter(([id, state]) => held.get(id) !== state).map(([id, state]) => ({ id, state })),
    ...[...held.keys()].filter((id) => !next.has(id)).map((id) => ({ id, state: null })),
  ];
  held.clear();
  for (const [id, state] of next) held.set(id, state);
  return events.map(readTerminalActivityEvent).filter((event): event is TerminalActivityEvent => event !== null);
}

/** Node's `termSizeOwner` events, from a change of the `terminalTabs` section against `held` (each tab's owner as last read, which
 *  becomes this read): a tab whose owner changed, and a zero size for a released claim on a tab still listed. A disposed tab pushes
 *  nothing, as Node's dispose cleared its claims without an event (forgetSizeClaims). `own`: the claim is `client`'s, the connection
 *  key the core's replies name (a desktop window never claims, and passes ''). */
export function terminalSizeOwnerChanges(
  held: Map<string, TerminalSizeOwner>,
  section: unknown,
  client: string
): TerminalSizeOwnerEvent[] {
  const tabs = Array.isArray(section) ? (section as { id?: unknown; sizeOwner?: TerminalSizeOwner | null }[]) : [];
  const next = new Map<string, TerminalSizeOwner>();
  for (const tab of tabs) if (tab.sizeOwner) next.set(String(tab.id), tab.sizeOwner);
  const listed = new Set(tabs.map((tab) => String(tab.id)));
  const events: TerminalSizeOwnerEvent[] = [
    ...[...next]
      .filter(([id, owner]) => {
        const before = held.get(id);
        return !before || before.cols !== owner.cols || before.rows !== owner.rows || before.owner !== owner.owner;
      })
      .map(([id, owner]) => ({ id, cols: owner.cols, rows: owner.rows, own: owner.owner !== '' && owner.owner === client })),
    ...[...held.keys()].filter((id) => !next.has(id) && listed.has(id)).map((id) => ({ id, cols: 0, rows: 0, own: false })),
  ];
  held.clear();
  for (const [id, owner] of next) held.set(id, owner);
  return events;
}

/** A terminal's output as Node's `termData` text, per tab (`processHandle`): each `process/outputDelta` through its tab's streaming
 *  decoder, with the lone units at the edges of a frame Node cut inside a surrogate pair (the core's bytes cannot hold half a
 *  character). `end` drops a tab's decoder once its shell has exited. */
export function createTerminalOutputDecoder(): {
  text(params: unknown): { id: string; data: string };
  end(id: string): void;
} {
  const decoders = new Map<string, TextDecoder>();
  const unit = (value: unknown): string => (typeof value === 'number' ? String.fromCharCode(value) : '');
  return {
    text(params) {
      const { processHandle, bytesB64, leadUnit, tailUnit } = (params ?? {}) as Record<string, unknown>;
      const id = String(processHandle ?? '');
      let decoder = decoders.get(id);
      if (!decoder) decoders.set(id, (decoder = new TextDecoder()));
      const bytes = Uint8Array.from(atob(String(bytesB64 ?? '')), (c) => c.charCodeAt(0));
      return { id, data: unit(leadUnit) + decoder.decode(bytes, { stream: true }) + unit(tailUnit) };
    },
    end: (id) => void decoders.delete(id),
  };
}

/** What a paired client is told of `ui/openRequested{kind: 'terminal'}`: no ack id and no path (Node's relay push), or null
 *  when the payload is not a reveal. */
export function terminalRunPush(open: unknown): DesktopTerminalRunRequest | null {
  const { kind: _kind, ...request } = (open ?? {}) as Record<string, unknown>;
  return readRemoteTerminalRun(remoteTerminalRun(request as unknown as DesktopTerminalRunRequest));
}
