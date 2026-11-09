// Terminal tabs and folder watching, as the phone's `window.mixdogDesktop` asked for them (Node's `termEnsure`, `termAttach`, `termProfiles`,
// `termWrite`, `termResize`, `termDispose`, `termActivity`, `termFocus`, `folderWatch`, `folderUnwatch`) answered over the protocol, and the
// pushes the page listens to (`termData`, `termSizeOwner`, `terminal/activity/updated`, `folderChanged`, `terminalRunRequested`).
// Every answer, error text and event equals what Node's remote methods and relay pushes gave (b6f10295a: remote-methods.ts
// `terminalRemoteMethods`, remote-relay-push-lanes.ts, run-dispatch.ts); the replay in apps/mobile compares them with the recordings.
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { pathText, requiredString } from '../shared/remote-arguments';
import { terminalActivityRows, terminalEnsureRequest, terminalReply, terminalRunPush } from '../shared/terminal-protocol';
import { readTerminalActivityEvent } from '../shared/terminal-activity';
import type { TerminalSizeOwnerEvent } from '../shared/terminal-size-owner';
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;
/** The requests below are built by name from Node's argument lists; the typed table is the library's. */
/** A domain error says its text in `data.message` (the workspace's `ENOENT: ...`): that text is what Node's call threw. */
const rpc = async (client: Client, method: string, params: unknown): Promise<any> => {
  try {
    return await (client.call as (m: string, p: unknown) => Promise<unknown>)(method, params);
  } catch (error) {
    const text = (error as { detail?: { data?: { message?: unknown } } }).detail?.data?.message;
    throw typeof text === 'string' && text ? new Error(text) : error;
  }
};

const TERMINAL_LANE = 'terminal';
const FILES_LANE = 'files';
/** How many request ids are remembered; the core re-delivers app-feed events after a reconnect. */
const REMEMBERED_RUNS = 256;

/** Node ran the terminal methods of one connection one at a time, in arrival order (remote-call-queue.ts). */
const queues = new WeakMap<object, Promise<unknown>>();
function inTerminalLane<T>(host: PhoneProtocolHost, work: () => Promise<T>): Promise<T> {
  const last = queues.get(host.ctx) ?? Promise.resolve();
  const next = last.then(work, work);
  queues.set(host.ctx, next.catch(() => undefined));
  return next;
}

/** A path argument as Node's `absoluteLocalPath` checked it; the host resolves it. A Windows drive, a UNC share or a root is absolute. */
function absoluteHostPath(value: unknown): string {
  const text = pathText(value);
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(text)) throw new TypeError('path must be absolute.');
  return text;
}

/** The folders this phone watches: Node counted them per directory and recursion, so one OS watch served every caller. */
const watches = new WeakMap<object, Map<string, { count: number; watchId: string; dir: string }>>();
let nextWatch = 1;

const sectionValue = (client: Client, section: 'terminalActivity' | 'terminalTabs'): unknown => client.store.section(section, null)?.value;

function install(host: PhoneProtocolHost): (() => void) | undefined {
  const { ctx } = host;
  let stop: (() => void) | undefined;
  let stopped = false;
  void ctx.phone.start().then(() => {
    if (stopped) return;
    const client = host.client();
    const laneInUse = (): boolean => ctx.activeLanes.has(TERMINAL_LANE);

    // Activity and size owner are read from the held sections; the baselines follow every change, and an event goes out only
    // while the page reads the terminal lane, so the first event after the lane resumes is the one change.
    let activity = new Map<string, unknown>();
    let owners = new Map<string, { cols: number; rows: number; owner: string }>();
    const readActivity = (): void => {
      const next = new Map(terminalActivityRows(sectionValue(client, 'terminalActivity')).map((row) => [row.id, row.state] as const));
      const events = [
        ...[...next].filter(([id, state]) => activity.get(id) !== state).map(([id, state]) => ({ id, state })),
        ...[...activity.keys()].filter((id) => !next.has(id)).map((id) => ({ id, state: null })),
      ];
      activity = next;
      if (!laneInUse()) return;
      for (const event of events) {
        const checked = readTerminalActivityEvent(event);
        if (checked) ctx.fanOut(ctx.termActivityListeners, checked);
      }
    };
    const readTabs = (): void => {
      const tabs = Array.isArray(sectionValue(client, 'terminalTabs')) ? (sectionValue(client, 'terminalTabs') as Record<string, any>[]) : [];
      const next = new Map<string, { cols: number; rows: number; owner: string }>();
      for (const tab of tabs) if (tab.sizeOwner) next.set(String(tab.id), tab.sizeOwner);
      const events: TerminalSizeOwnerEvent[] = [
        ...[...next]
          .filter(([id, owner]) => {
            const before = owners.get(id);
            return !before || before.cols !== owner.cols || before.rows !== owner.rows || before.owner !== owner.owner;
          })
          .map(([id, owner]) => ({ id, cols: owner.cols, rows: owner.rows, own: owner.owner !== '' && owner.owner === connection })),
        ...[...owners.keys()].filter((id) => !next.has(id)).map((id) => ({ id, cols: 0, rows: 0, own: false })),
      ];
      owners = next;
      // The output of every running terminal rides the terminal lane (Node pushed `termData` for all of them).
      host.declareLane(
        TERMINAL_LANE,
        tabs.filter((tab) => tab.running !== false).map((tab) => `process:${String(tab.id)}`)
      );
      if (!laneInUse()) return;
      for (const event of events) ctx.fanOut(ctx.termSizeOwnerListeners, event);
    };
    let connection = '';
    const remember = (reply: unknown): void => {
      const client = (reply as { client?: unknown } | null)?.client;
      if (typeof client === 'string') connection = client;
    };
    remembered.set(ctx, remember);
    readActivity();
    readTabs();

    const decoders = new Map<string, TextDecoder>();
    const watchDirs = (): Map<string, string> => new Map([...(watches.get(ctx) ?? [])].map(([, watch]) => [watch.watchId, watch.dir]));
    const ranRequests = new Set<string>();
    const offEvents = client.on((event) => {
      if (event.type !== 'notification') return;
      const { method, params, feed } = event.notification as { method: string; params?: any; feed?: { id: string } };
      if (method === 'process/outputDelta' && feed?.id.startsWith('process:')) {
        const id = feed.id.slice('process:'.length);
        let decoder = decoders.get(id);
        if (!decoder) decoders.set(id, (decoder = new TextDecoder()));
        const data = decoder.decode(Uint8Array.from(atob(String(params?.bytesB64 ?? '')), (c) => c.charCodeAt(0)), { stream: true });
        if (data && laneInUse()) ctx.fanOut(ctx.termListeners, { id, data });
      } else if (method === 'process/exited' && feed?.id.startsWith('process:')) {
        decoders.delete(feed.id.slice('process:'.length));
      } else if (method === 'fs/changed' && feed?.id.startsWith('fs:')) {
        const dir = watchDirs().get(feed.id.slice('fs:'.length));
        if (dir !== undefined && ctx.activeLanes.has(FILES_LANE)) ctx.fanOut(ctx.folderChangeListeners, dir);
      } else if (method === 'ui/openRequested' && params?.kind === 'terminal') {
        // The core re-delivers app-feed events after a reconnect: a request is handed over once.
        const requestId = params.requestId;        if (typeof requestId === 'string' && requestId) {
          if (ranRequests.has(requestId)) return;
          ranRequests.add(requestId);
          if (ranRequests.size > REMEMBERED_RUNS) ranRequests.delete(ranRequests.values().next().value as string);
        }
        const run = terminalRunPush(params);
        if (run) ctx.fanOut(ctx.terminalRunListeners, run);
      }
    });
    const offStore = client.store.subscribe((change) => {
      if (change.type === 'appSnapshot') {
        readActivity();
        readTabs();
      } else if (change.type === 'section' && change.section === 'terminalActivity') readActivity();
      else if (change.type === 'section' && change.section === 'terminalTabs') readTabs();
    });
    stop = () => {
      offEvents();
      offStore();
    };
  });
  return () => {
    stopped = true;
    stop?.();
  };
}

/** The ensure/attach replies name the asking connection; the size-owner events say whose claim it is by that name. */
const remembered = new WeakMap<object, (reply: unknown) => void>();

export const adapter: PhoneProtocolAdapter = {
  group: 'terminal',
  install,
  calls: {
    termEnsure: ([id, cwd, shell], host) =>
      inTerminalLane(host, async () => {
        const { method, params } = terminalEnsureRequest(id, cwd, shell);
        const reply = await rpc(host.client(), method, params);
        remembered.get(host.ctx)?.(reply);
        return terminalReply(reply);
      }),
    termAttach: ([id], host) =>
      inTerminalLane(host, async () => {
        const reply = await rpc(host.client(), 'terminal/attach', { tabId: requiredString(id, 'terminal id', 128) });
        if (reply == null) return null;
        remembered.get(host.ctx)?.(reply);
        // The output subscription is the adapter's own: Node's answer carries none.
        const { subscription: _subscription, ...answer } = reply;
        return terminalReply(answer);
      }),
    termProfiles: (_params, host) => inTerminalLane(host, () => rpc(host.client(), 'terminal/profiles', {})),
    termDispose: ([id], host) =>
      inTerminalLane(host, async () => {
        await rpc(host.client(), 'terminal/dispose', { tabId: requiredString(id, 'terminal id', 128) });
        return null;
      }),
    termActivity: async (_params, host) => terminalActivityRows(sectionValue(host.client(), 'terminalActivity')),
    termFocus: async ([id, focused], host) => {
      await rpc(host.client(), 'terminal/focus', { tabId: requiredString(id, 'terminal id', 128), focused: focused === true });
      return null;
    },
    folderWatch: async ([dir, recursive], host) => {
      const path = absoluteHostPath(dir);
      const key = `${path}\0${recursive === true}`;
      const held = watches.get(host.ctx) ?? new Map();
      watches.set(host.ctx, held);
      const watch = held.get(key);
      if (watch) {
        watch.count += 1;
        return null;
      }
      const entry = { count: 1, watchId: `phone-folder-${nextWatch++}`, dir: path };
      held.set(key, entry);
      try {
        await rpc(host.client(), 'fs/watch', { watchId: entry.watchId, path, recursive: recursive === true });
      } catch (error) {
        held.delete(key);
        throw error;
      }
      return null;
    },
    folderUnwatch: async ([dir, recursive], host) => {
      const key = `${absoluteHostPath(dir)}\0${recursive === true}`;
      const held = watches.get(host.ctx);
      const watch = held?.get(key);
      if (!held || !watch) return null;
      if (--watch.count <= 0) {
        held.delete(key);
        await rpc(host.client(), 'fs/unwatch', { watchId: watch.watchId });
      }
      return null;
    },
  },
  fires: {
    // Keystrokes and size go in the terminal lane, behind a `termEnsure` still spawning, and wait for the synced connection as the
    // phone's fire did; a lost one is dropped.
    termWrite: ([id, data], host) => {
      void inTerminalLane(host, async () => {
        await host.ctx.phone.synced();
        host.client().notify('terminal/input', { tabId: String(id || ''), data: String(data ?? '') });
      }).catch(() => undefined);
    },
    termResize: ([id, cols, rows, phoneOwner], host) => {
      void inTerminalLane(host, async () => {
        await host.ctx.phone.synced();
        host.client().notify('terminal/resize', {
          tabId: String(id || ''),
          cols: Number(cols),
          rows: Number(rows),
          ...(phoneOwner === true ? { claim: true } : {}),
        });
      }).catch(() => undefined);
    },
  },
};
