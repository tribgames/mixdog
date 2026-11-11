// Terminal tabs and folder watching, as the phone's `window.mixdogDesktop` asked for them (Node's `termEnsure`, `termAttach`, `termProfiles`,
// `termWrite`, `termResize`, `termDispose`, `termActivity`, `termFocus`, `folderWatch`, `folderUnwatch`) answered over the protocol, and the
// pushes the page listens to (`termData`, `termSizeOwner`, `terminal/activity/updated`, `folderChanged`, `terminalRunRequested`).
// Every answer, error text and event equals what Node's remote methods and relay pushes gave (b6f10295a: remote-methods.ts
// `terminalRemoteMethods`, remote-relay-push-lanes.ts, run-dispatch.ts); the replay in apps/mobile compares them with the recordings.
import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import { foldsCaseOn, hostPlatformOf, isAbsoluteOn, needsHostDevice, pathText, requiredString, resolveOn } from '../shared/remote-arguments';
import { terminalActivityRows, terminalEnsureRequest, terminalReply, terminalResizeRequest, terminalRunPush } from '../shared/terminal-protocol';
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
/** The terminal lane's feed: every tab's output as Node's relay pushed it, each frame naming its tab (`processHandle`). */
const LANE_FEED = 'process:relay';
const FILES_LANE = 'files';
/** How many request ids are remembered; the core re-delivers app-feed events after a reconnect. */
const REMEMBERED_RUNS = 256;


/** The device (`D:`, `\\server\share`) of the working directory of the host's Windows core: what a rooted path (`\dir`) resolves onto. The
 *  phone cannot know it; the host's own resolution of `\` says it (`projectFs/statLocal`). */
const hostDevices = new WeakMap<object, Promise<string>>();
const hostDeviceOf = (host: PhoneProtocolHost): Promise<string> => {
  let device = hostDevices.get(host.ctx);
  if (!device) {
    device = rpc(host.client(), 'projectFs/statLocal', { paths: ['\\'] }).then((entries) => {
      const root = String(entries?.[0]?.absolutePath ?? '');
      return /^[A-Za-z]:/.test(root) ? root.slice(0, 2) : root.replace(/\\+$/, '');
    });
    hostDevices.set(host.ctx, device);
    // A failed lookup is not remembered.
    device.catch(() => hostDevices.delete(host.ctx));
  }
  return device;
};

/** The registry key of Node's folder watches (`createFolderWatchRegistry`) for a path argument: checked and resolved with the rules of the
 *  host's platform (Node's `absoluteLocalPath`), folded to lower case on a Windows host. `path` is the resolved path the core is asked to watch. */
async function watchTarget(value: unknown, recursive: boolean, host: PhoneProtocolHost): Promise<{ key: string; path: string }> {
  const text = pathText(value);
  const platform = hostPlatformOf(host.client().server.platformOs);
  if (!isAbsoluteOn(platform, text)) throw new TypeError('path must be absolute.');
  const path = resolveOn(platform, text, needsHostDevice(platform, text) ? await hostDeviceOf(host) : '');
  return { key: `${foldsCaseOn(platform) ? path.toLocaleLowerCase() : path}\0${recursive}`, path };
}
/** The folders this phone watches: Node counted them per directory and recursion, so one OS watch served every caller. */
const watches = new WeakMap<object, Map<string, { count: number; watchId: string; dir: string }>>();
let nextWatch = 1;

const sectionValue = (client: Client, section: 'terminalActivity' | 'terminalTabs'): unknown => client.store.section(section, null)?.value;

/** Reads the terminal's events from the client that is up and moves to every client that replaces it: a re-pairing dials a new client in
 *  the same page, and Node's relay published to whichever connection was current (remote-relay-push-lanes.ts:64), never to a closed one. */
function install(host: PhoneProtocolHost): (() => void) | undefined {
  const { ctx } = host;
  let unwire: (() => void) | undefined;
  let stopped = false;
  const rewire = (client: Client): void => {
    if (stopped) return;
    unwire?.();
    // The core closed the replaced connection's watches with it, and a new pairing may be another host.
    watches.delete(ctx);
    hostDevices.delete(ctx);
    unwire = wire(host, client);
  };
  const off = host.onClient?.(rewire);
  const started = ctx.phone.start();
  if (!off) void started.then(() => rewire(host.client()), () => undefined);
  else void started.catch(() => undefined);
  return () => {
    stopped = true;
    off?.();
    unwire?.();
  };
}

/** The terminal's events of one client, until the returned teardown. */
function wire(host: PhoneProtocolHost, client: Client): () => void {
  const { ctx } = host;
  {
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
    // The lane carries every tab's output framed as Node's relay lane sent it (first output at once, then 16 ms), the tabs the desktop or
    // another phone opens included, from their first output (remote-relay-push-lanes.ts:85-100).
    host.declareLane(TERMINAL_LANE, [LANE_FEED]);
    const readTabs = (): void => {
      const tabs = Array.isArray(sectionValue(client, 'terminalTabs')) ? (sectionValue(client, 'terminalTabs') as Record<string, any>[]) : [];
      const next = new Map<string, { cols: number; rows: number; owner: string }>();
      for (const tab of tabs) if (tab.sizeOwner) next.set(String(tab.id), tab.sizeOwner);
      const listed = new Set(tabs.map((tab) => String(tab.id)));
      // A released claim on a tab that is still there pushes a zero size; a disposed tab pushes nothing, as Node's dispose clears its
      // claims and leases without a `termSizeOwner` (forgetSizeClaims).
      const events: TerminalSizeOwnerEvent[] = [
        ...[...next]
          .filter(([id, owner]) => {
            const before = owners.get(id);
            return !before || before.cols !== owner.cols || before.rows !== owner.rows || before.owner !== owner.owner;
          })
          .map(([id, owner]) => ({ id, cols: owner.cols, rows: owner.rows, own: owner.owner !== '' && owner.owner === connection })),
        ...[...owners.keys()].filter((id) => !next.has(id) && listed.has(id)).map((id) => ({ id, cols: 0, rows: 0, own: false })),
      ];
      owners = next;
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
      if (method === 'process/outputDelta' && feed?.id === LANE_FEED) {
        const id = String(params?.processHandle ?? '');
        let decoder = decoders.get(id);
        if (!decoder) decoders.set(id, (decoder = new TextDecoder()));
        // A frame Node cut inside a surrogate pair carries the lone units at its edges (the core's bytes cannot hold half a character).
        const unit = (value: unknown): string => (typeof value === 'number' ? String.fromCharCode(value) : '');
        const data =
          unit(params?.leadUnit) +
          decoder.decode(Uint8Array.from(atob(String(params?.bytesB64 ?? '')), (c) => c.charCodeAt(0)), { stream: true }) +
          unit(params?.tailUnit);
        if (data && laneInUse()) ctx.fanOut(ctx.termListeners, { id, data });
      } else if (method === 'process/exited' && feed?.id === LANE_FEED) {
        decoders.delete(String(params?.processHandle ?? ''));
      } else if (method === 'fs/changed' && feed?.id.startsWith('fs:')) {
        const dir = watchDirs().get(feed.id.slice('fs:'.length));
        if (dir !== undefined && ctx.activeLanes.has(FILES_LANE)) ctx.fanOut(ctx.folderChangeListeners, dir);
      } else if (method === 'ui/openRequested' && params?.kind === 'terminal') {
        // The core re-delivers app-feed events after a reconnect: a request is handed over once.
        const requestId = params.requestId;
        if (typeof requestId === 'string' && requestId) {
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
    return () => {
      offEvents();
      offStore();
    };
  }
}

/** The ensure/attach replies name the asking connection; the size-owner events say whose claim it is by that name. */
const remembered = new WeakMap<object, (reply: unknown) => void>();

export const adapter: PhoneProtocolAdapter = {
  group: 'terminal',
  install,
  calls: {
    // The six terminal-lane methods (termEnsure, termAttach, termProfiles, termWrite, termResize, termDispose) are ordered by the
    // connection's one call queue (remote-protocol-queue.ts), which the router enters for every call; the adapter has no lane of its own.
    termEnsure: async ([id, cwd, shell], host) => {
      const { method, params } = terminalEnsureRequest(id, cwd, shell);
      const reply = await rpc(host.client(), method, params);
      remembered.get(host.ctx)?.(reply);
      return terminalReply(reply);
    },
    termAttach: async ([id], host) => {
      const reply = await rpc(host.client(), 'terminal/attach', { tabId: requiredString(id, 'terminal id', 128) });
      if (reply == null) return null;
      remembered.get(host.ctx)?.(reply);
      // The output subscription is the adapter's own: Node's answer carries none.
      const { subscription: _subscription, ...answer } = reply;
      return terminalReply(answer);
    },
    termProfiles: (_params, host) => rpc(host.client(), 'terminal/profiles', {}),
    termDispose: async ([id], host) => {
      await rpc(host.client(), 'terminal/dispose', { tabId: requiredString(id, 'terminal id', 128) });
      return null;
    },
    termActivity: async (_params, host) => terminalActivityRows(sectionValue(host.client(), 'terminalActivity')),
    termFocus: async ([id, focused], host) => {
      await rpc(host.client(), 'terminal/focus', { tabId: requiredString(id, 'terminal id', 128), focused: focused === true });
      return null;
    },
    folderWatch: async ([dir, recursive], host) => {
      const { key, path } = await watchTarget(dir, recursive === true, host);
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
      const { key } = await watchTarget(dir, recursive === true, host);
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
    // Keystrokes and size wait for the connection only, as the phone's fire did (`ctx.connect()`, no view sync); the router queues them in the terminal lane, behind
    // a `termEnsure` still spawning, and drops a lost one. The returned promise is what holds the lane until they are sent.
    termWrite: async ([id, data], host) => {
      await host.ctx.phone.start();
      host.client().notify('terminal/input', { tabId: String(id || ''), data: String(data ?? '') });
    },
    termResize: async ([id, cols, rows, phoneOwner], host) => {
      await host.ctx.phone.start();
      host.client().notify('terminal/resize', terminalResizeRequest(id, cols, rows, phoneOwner));
    },
  },
};
