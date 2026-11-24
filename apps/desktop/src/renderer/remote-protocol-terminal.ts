import type { ProtocolClient, SessionFold } from '../../../../packages/protocol-client/src/index.ts';
import {
  foldsCaseOn,
  hostPlatformOf,
  isAbsoluteOn,
  needsHostDevice,
  pathText,
  requiredString,
  resolveOn,
} from '../shared/remote-arguments';
import {
  compareTerminals as compare,
  createTerminalOutputDecoder,
  terminalActivityChanges,
  terminalActivityRows,
  terminalEnsureRequest,
  terminalOf,
  terminalReplayCut,
  terminalReply,
  terminalResizeRequest,
  terminalRunPush,
  terminalSizeOwnerChanges,
  type TerminalId,
  type TerminalReplayCut,
} from '../shared/terminal-protocol';
import type { TerminalSizeOwner } from '../shared/terminal-size-owner';
import type { PhoneProtocolAdapter, PhoneProtocolHost } from './remote-shim-protocol';

type Client = ProtocolClient<SessionFold>;
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
async function watchTarget(
  value: unknown,
  recursive: boolean,
  host: PhoneProtocolHost
): Promise<{ key: string; path: string }> {
  const text = pathText(value);
  const platform = hostPlatformOf(host.client().server.platformOs);
  if (!isAbsoluteOn(platform, text)) throw new TypeError('path must be absolute.');
  const path = resolveOn(platform, text, needsHostDevice(platform, text) ? await hostDeviceOf(host) : '');
  return { key: `${foldsCaseOn(platform) ? path.toLocaleLowerCase() : path}\0${recursive}`, path };
}
/** The folders this phone watches: Node counted them per directory and recursion, so one OS watch served every caller. */
const watches = new WeakMap<object, Map<string, { count: number; watchId: string; dir: string }>>();
let nextWatch = 1;

const sectionValue = (client: Client, section: 'terminalActivity' | 'terminalTabs'): unknown =>
  client.store.section(section, null)?.value;

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
  const offReset = host.onPairingReset?.(() => {
    unwire?.();
    unwire = undefined;
  });
  const started = ctx.phone.start();
  if (!off)
    void started.then(
      () => rewire(host.client()),
      () => undefined
    );
  else void started.catch(() => undefined);
  return () => {
    stopped = true;
    off?.();
    offReset?.();
    unwire?.();
  };
}

type QueuedOutput = { params: unknown } | { exit: unknown };
/** What the phone knows of one terminal of a held id. Another terminal of the id gets its own, never this one changed. */
type HeldTerminal = {
  /** None from a core that predates terminal names: no tab list judges the tab then, and any exit of the id ends it. */
  id?: TerminalId;
  /** A tab list no older than this terminal has named it: a later list without the id, or with it not running, is its end. */
  listed?: boolean;
  /** Where a gap recovery's replay cut this terminal's output. */
  cut?: TerminalReplayCut;
};
type HeldTab = {
  terminal: HeldTerminal;
  recovery?: { frames: QueuedOutput[] };
  retry?: ReturnType<typeof setTimeout>;
};
type ListedTab = { id?: unknown; tab?: unknown; terminal?: unknown; running?: unknown };
type TerminalOutput = { id: string; data: string; reset?: true };

/** The terminal a frame of the terminal lane names. */
const frameTerminal = (params: unknown): TerminalId | undefined =>
  terminalOf((params as { terminal?: unknown } | null)?.terminal);

/** Restores every held tab, including a parked view with no mounted pane. Its output listener survives the park. */
export function followTerminalOutput(
  read: (id: string) => Promise<unknown>,
  emit: (event: TerminalOutput) => void,
  ready: () => boolean
) {
  const tabs = new Map<string, HeldTab>();
  /** The `terminalTabs` section the store holds now, by id. None while it holds none (a core that has published no list since it
   *  started): that says nothing of any tab, and the list read before it is not kept in its place. */
  let list: Map<string, ListedTab> | undefined;
  const output = createTerminalOutputDecoder();
  const publish = (params: unknown, cut?: TerminalReplayCut) => {
    const event = output.text(params, cut);
    if (event.data) emit(event);
  };
  /** An exit ends the held terminal only when it names that one. A core without terminal names says which by the output stream of a
   *  recovered terminal, if any. */
  const ended = (id: string, tab: HeldTab | undefined, exit: unknown) => {
    if (!tab) return output.end(id);
    const { outputStream, terminal } = (exit ?? {}) as { outputStream?: unknown; terminal?: unknown };
    const named = terminalOf(terminal);
    const held = tab.terminal;
    const own =
      named || held.id
        ? named !== undefined && held.id !== undefined && compare(named, held.id) === 0
        : !held.cut || typeof outputStream !== 'string' || held.cut.stream === outputStream;
    if (own) forget(id);
  };
  const recover = (id: string, tab: HeldTab): void => {
    clearTimeout(tab.retry);
    const recovery = { frames: tab.recovery?.frames ?? [] };
    tab.recovery = recovery;
    if (!ready()) return;
    void read(id).then(
      (reply) => {
        if (tabs.get(id) !== tab || tab.recovery !== recovery) return;
        if (reply == null) return forget(id);
        // An answer of an earlier terminal than the one the id has now: neither its replay nor the frames queued since are known to
        // be this terminal's, and output of this one may be missing. Asked again, the core answers the terminal it has now, whose cut
        // passes only that terminal's frames.
        if (!follow(id, tab, terminalOf((reply as { terminal?: unknown }).terminal))) return recover(id, tab);
        if (tabs.get(id) !== tab) return;
        const cut = terminalReplayCut(reply);
        if (cut) {
          output.end(id);
          tab.terminal.cut = cut;
          emit({ id, data: terminalReply(reply).replay, reset: true });
        }
        for (const frame of recovery.frames) {
          if (!('params' in frame)) ended(id, tab, frame.exit);
          else if (follow(id, tab, frameTerminal(frame.params))) publish(frame.params, tab.terminal.cut);
        }
        delete tab.recovery;
      },
      (error) => {
        if (tabs.get(id) !== tab || tab.recovery !== recovery) return;
        if ((error as { permanent?: unknown } | null)?.permanent === true) return forget(id);
        if (!ready()) return;
        tab.retry = setTimeout(() => recover(id, tab), 1_000);
      }
    );
  };
  const forget = (id: string) => {
    clearTimeout(tabs.get(id)?.retry);
    tabs.delete(id);
    output.end(id);
  };
  /** The tab list against the terminal held. A row of an earlier terminal of the id, or of another run's, says nothing of it, and
   *  neither may a list without the id before any list named it (`terminal/ensure` answers before the core publishes the tab). A row
   *  of a later terminal of the id is the id's terminal now. */
  const judge = (id: string, tab: HeldTab): void => {
    const held = tab.terminal.id;
    if (!list || !held) return;
    const row = list.get(id);
    if (!row) {
      if (tab.terminal.listed) forget(id);
      return;
    }
    const named = terminalOf(row.terminal);
    const order = named ? compare(named, held) : undefined;
    if (!named || order === undefined || order < 0) return;
    if (row.running === false) return forget(id);
    if (order > 0) tab.terminal = { id: named };
    tab.terminal.listed = true;
  };
  /** The terminal an answer names for a held id: one of another run, or a later one of the same run, is the id's terminal now and
   *  nothing is known of it yet; an earlier one is no news. False for an earlier one. */
  const follow = (id: string, tab: HeldTab, named: TerminalId | undefined): boolean => {
    const held = tab.terminal.id;
    const order = named && held ? compare(named, held) : undefined;
    if (order !== undefined && order < 0) return false;
    if (named && order !== 0) tab.terminal = { id: named };
    judge(id, tab);
    return true;
  };
  return {
    hold(id: string, terminal?: unknown) {
      if (!id) return;
      let tab = tabs.get(id);
      if (!tab) tabs.set(id, (tab = { terminal: {} }));
      follow(id, tab, terminalOf(terminal));
    },
    forget,
    /** The `terminalTabs` section the store holds now; a row with `tab: false` is a size claim on an id with no tab. */
    listed(section: unknown) {
      list = Array.isArray(section)
        ? new Map((section as ListedTab[]).filter((row) => row.tab !== false).map((row) => [String(row.id), row] as const))
        : undefined;
      for (const [id, tab] of tabs) judge(id, tab);
    },
    gap() {
      for (const [id, tab] of tabs) {
        tab.recovery = { frames: [] };
        recover(id, tab);
      }
    },
    ready() {
      for (const [id, tab] of tabs) if (tab.recovery) recover(id, tab);
    },
    /** Output of the terminal lane: a frame of an earlier terminal of a held id (what it wrote as it was replaced) is dropped, and one of
     *  a later terminal makes that the id's terminal. */
    frame(id: string, params: unknown) {
      const tab = tabs.get(id);
      if (tab?.recovery) tab.recovery.frames.push({ params });
      else if (!tab || follow(id, tab, frameTerminal(params))) publish(params, tab?.terminal.cut);
    },
    /** A `process/exited` of the terminal lane, `exit` its params. */
    end(id: string, exit: unknown) {
      const tab = tabs.get(id);
      if (tab?.recovery) tab.recovery.frames.push({ exit });
      else ended(id, tab, exit);
    },
    stop() {
      for (const id of tabs.keys()) forget(id);
    },
  };
}

/** The terminal's events of one client, until the returned teardown. */
function wire(host: PhoneProtocolHost, client: Client): () => void {
  const { ctx } = host;
  {
    const laneInUse = (): boolean => ctx.activeLanes.has(TERMINAL_LANE);

    // Activity and size owner are read from the held sections; the baselines follow every change, and an event goes out only
    // while the page reads the terminal lane, so the first event after the lane resumes is the one change.
    const activity = new Map<string, unknown>();
    const owners = new Map<string, TerminalSizeOwner>();
    const readActivity = (): void => {
      const events = terminalActivityChanges(activity, sectionValue(client, 'terminalActivity'));
      if (!laneInUse()) return;
      for (const event of events) ctx.fanOut(ctx.termActivityListeners, event);
    };
    // The lane carries every tab's output framed as Node's relay lane sent it (first output at once, then 16 ms), the tabs the desktop or
    // another phone opens included, from their first output (remote-relay-push-lanes.ts:85-100).
    host.declareLane(TERMINAL_LANE, [LANE_FEED]);
    const readTabs = (): void => {
      const listed = sectionValue(client, 'terminalTabs');
      output.listed(listed);
      const events = terminalSizeOwnerChanges(owners, listed, connection);
      if (!laneInUse()) return;
      for (const event of events) ctx.fanOut(ctx.termSizeOwnerListeners, event);
    };
    let connection = '';
    const output = followTerminalOutput(
      async (id) => {
        try {
          return await (client.call as (m: string, p: unknown) => Promise<unknown>)('terminal/attach', { tabId: id });
        } catch (error) {
          // The core answered and refused: asking again gets the same answer. A lost link or a timeout is retried.
          if ((error as { detail?: { kind?: unknown } }).detail?.kind === 'rpc')
            throw Object.assign(new Error('terminal tab is gone'), { permanent: true });
          throw error;
        }
      },
      (event) => {
        if (laneInUse()) ctx.fanOut(ctx.termListeners, event);
      },
      () => client.status.state === 'ready'
    );
    const remember = (reply: unknown): void => {
      const info = reply as { client?: unknown; id?: unknown; terminal?: unknown } | null;
      const client = info?.client;
      if (typeof client === 'string') connection = client;
      if (typeof info?.id === 'string') output.hold(info.id, info.terminal);
    };
    remembered.set(ctx, { remember, forget: output.forget });
    readActivity();
    readTabs();

    const onGap = () => output.gap();
    window.addEventListener('mixdog:remote-terminal-gap', onGap);
    const watchDirs = (): Map<string, string> =>
      new Map([...(watches.get(ctx) ?? [])].map(([, watch]) => [watch.watchId, watch.dir]));
    const ranRequests = new Set<string>();
    const offEvents = client.on((event) => {
      if (event.type === 'status' && event.status.state === 'ready') output.ready();
      if (event.type !== 'notification') return;
      const { method, params, feed } = event.notification as { method: string; params?: any; feed?: { id: string } };
      if (method === 'process/outputDelta' && feed?.id === LANE_FEED) {
        output.frame(String(params?.processHandle ?? ''), params);
      } else if (method === 'process/exited' && feed?.id === LANE_FEED) {
        output.end(String(params?.processHandle ?? ''), params);
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
      window.removeEventListener('mixdog:remote-terminal-gap', onGap);
      remembered.delete(ctx);
      output.stop();
    };
  }
}

/** The ensure/attach replies name the asking connection; the size-owner events say whose claim it is by that name. */
const remembered = new WeakMap<object, { remember(reply: unknown): void; forget(id: string): void }>();

export const adapter: PhoneProtocolAdapter = {
  group: 'terminal',
  install,
  calls: {
    // The six terminal-lane methods (termEnsure, termAttach, termProfiles, termWrite, termResize, termDispose) are ordered by the
    // connection's one call queue (remote-protocol-queue.ts), which the router enters for every call; the adapter has no lane of its own.
    termEnsure: async ([id, cwd, shell], host) => {
      const { method, params } = terminalEnsureRequest(id, cwd, shell);
      const held = remembered.get(host.ctx);
      const reply = await rpc(host.client(), method, params);
      if (held === remembered.get(host.ctx)) held?.remember(reply);
      // Which terminal it is, is the adapter's own: Node's answer carries none.
      const { terminal: _terminal, ...answer } = reply;
      return terminalReply(answer);
    },
    termAttach: async ([id], host) => {
      const held = remembered.get(host.ctx);
      const reply = await rpc(host.client(), 'terminal/attach', { tabId: requiredString(id, 'terminal id', 128) });
      if (reply == null) return null;
      if (held === remembered.get(host.ctx)) held?.remember(reply);
      // The output subscription and which terminal it is are the adapter's own: Node's answer carries neither.
      const { subscription: _subscription, replayCut: _replayCut, terminal: _terminal, ...answer } = reply;
      return terminalReply(answer);
    },
    termProfiles: (_params, host) => rpc(host.client(), 'terminal/profiles', {}),
    termDispose: async ([id], host) => {
      const tabId = requiredString(id, 'terminal id', 128);
      const held = remembered.get(host.ctx);
      await rpc(host.client(), 'terminal/dispose', { tabId });
      held?.forget(tabId);
      return null;
    },
    termActivity: async (_params, host) => terminalActivityRows(sectionValue(host.client(), 'terminalActivity')),
    termFocus: async ([id, focused], host) => {
      await rpc(host.client(), 'terminal/focus', {
        tabId: requiredString(id, 'terminal id', 128),
        focused: focused === true,
      });
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
