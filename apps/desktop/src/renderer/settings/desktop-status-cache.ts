import type { DesktopApi, DesktopGitCliStatus, DesktopLibreOfficeStatus, DesktopSettings } from '../../shared/contract';

export type StatusApi = Partial<
  Pick<DesktopApi, 'readSettings' | 'getQuotaAutoResume' | 'gitCliStatus' | 'libreOfficeStatus'>
>;

export interface DesktopStatus {
  settings: DesktopSettings;
  quotaAutoResume: boolean;
  gitCli: DesktopGitCliStatus;
  libreOffice: DesktopLibreOfficeStatus;
}
export type StatusKey = keyof DesktopStatus;

// `refresh` asks the host to re-probe instead of answering from its cache; only
// the LibreOffice probe has one (an install done outside Mixdog).
const readers: { [K in StatusKey]: (api: StatusApi, refresh: boolean) => Promise<DesktopStatus[K]> | undefined } = {
  settings: (api) => api.readSettings?.(),
  quotaAutoResume: (api) => api.getQuotaAutoResume?.(),
  gitCli: (api) => api.gitCliStatus?.(),
  libreOffice: (api, refresh) => (refresh ? api.libreOfficeStatus?.(true) : api.libreOfficeStatus?.()),
};

/** A write's own change, shown until the write ends: the fields it sets of the settings object, or the whole value. */
type OptimisticChange<K extends WritableKey> = K extends 'settings' ? Partial<DesktopSettings> : DesktopStatus[K];
type WritableKey = 'settings' | 'quotaAutoResume';

// Per api and key, two things kept apart:
// - `confirmed`: the last value the core confirmed. Only read answers and successful write answers set it, and only
//   when newer by one order: a stamp from one counter, taken when the core produces the value as far as this window
//   can tell. A read or write is stamped when it is sent (the core answers a connection's calls in the order sent,
//   and announces every change, so anything a later-sent read missed is read again); an install's result when it
//   arrives (the core produces it when the install ends, after the reads sent meanwhile). Quota reads use the
//   local section snapshot, so reads started before a save acknowledgement are older than that acknowledgement.
// - `pending`: the optimistic changes of the writes still in flight, in send order. A write leaves it when it ends,
//   failed or not; nothing is ever restored, so a failed change can never come back.
// What consumers see (`visible`) is the confirmed value with the pending changes applied on top.
interface Held {
  confirmed: unknown;
  stamp: number;
  quotaWriteStamp: number;
  pending: Array<{ readonly change: unknown; readonly stamp: number }>;
  visible: unknown;
}
const held = new WeakMap<object, Map<StatusKey, Held>>();
let lastStamp = 0;
const nextStamp = (): number => ++lastStamp;

function entry(api: object, key: StatusKey): Held {
  const keys = held.get(api) ?? new Map<StatusKey, Held>();
  held.set(api, keys);
  const found = keys.get(key) ?? {
    confirmed: undefined,
    stamp: 0,
    quotaWriteStamp: 0,
    pending: [],
    visible: undefined,
  };
  keys.set(key, found);
  return found;
}

/** Sets the confirmed value if `stamp` is newer than the one it holds; true when it was taken. */
function confirm(held: Held, value: unknown, stamp: number): boolean {
  if (stamp <= held.stamp) return false;
  held.confirmed = value;
  held.stamp = stamp;
  return true;
}

function applyChange(key: StatusKey, base: unknown, change: unknown): unknown {
  // A settings change names some fields: it shows over a known object, and nothing is shown while none is known.
  if (key === 'settings') return base === undefined ? undefined : { ...(base as object), ...(change as object) };
  return change;
}

type StatusListener = (
  key: StatusKey,
  value: DesktopStatus[StatusKey] | undefined,
  previous: DesktopStatus[StatusKey] | undefined,
  api: object
) => void;
const statusListeners = new Set<StatusListener>();

/** Every change of what consumers see (undefined: unknown again), with the value it replaced. */
export function subscribeDesktopStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/** Recomputes what consumers see and tells the listeners. */
function publish(api: object, key: StatusKey, held: Held): void {
  let next = held.confirmed;
  for (const { change, stamp } of held.pending) {
    if (key !== 'quotaAutoResume' || stamp > held.quotaWriteStamp) next = applyChange(key, next, change);
  }
  const previous = held.visible;
  held.visible = next;
  for (const listener of [...statusListeners]) {
    listener(key, next as DesktopStatus[StatusKey] | undefined, previous as DesktopStatus[StatusKey] | undefined, api);
  }
}

/** What consumers see: the confirmed value with the pending writes' changes on top. */
export function getCachedDesktopStatus<K extends StatusKey>(
  api: StatusApi | undefined,
  key: K
): DesktopStatus[K] | undefined {
  return api ? (held.get(api)?.get(key)?.visible as DesktopStatus[K] | undefined) : undefined;
}

/** Sends a write whose answer is the key's new value. `optimistic` (the write's own change) shows over the confirmed
 *  value while the write is in flight. When the write ends it leaves; a successful answer becomes the confirmed value
 *  if newer. A quota acknowledgement outranks reads started before it, but cannot undo a later acknowledged write.
 *  Resolves with the write's own answer (undefined where the host lacks the call). */
export function writeDesktopStatus<K extends WritableKey>(
  api: StatusApi,
  key: K,
  write: () => Promise<DesktopStatus[K] | undefined> | undefined,
  optimistic?: OptimisticChange<K>
): Promise<DesktopStatus[K] | undefined> {
  const state = entry(api, key);
  const stamp = nextStamp();
  const overlay = optimistic === undefined ? null : { change: optimistic, stamp };
  if (overlay) {
    state.pending.push(overlay);
    publish(api, key, state);
  }
  let pending: Promise<DesktopStatus[K] | undefined> | undefined;
  try {
    pending = write();
  } catch (error) {
    pending = Promise.reject(error);
  }
  const leave = (): boolean => {
    if (!overlay) return false;
    state.pending = state.pending.filter((item) => item !== overlay);
    return true;
  };
  return Promise.resolve(pending).then(
    (answer) => {
      const left = leave();
      let taken = false;
      if (answer != null) {
        if (key !== 'quotaAutoResume') {
          taken = confirm(state, answer, stamp);
        } else if (stamp > state.quotaWriteStamp) {
          state.quotaWriteStamp = stamp;
          taken = confirm(state, answer, nextStamp());
        }
      }
      if (left || taken) publish(api, key, state);
      return answer;
    },
    (error: unknown) => {
      if (leave()) publish(api, key, state);
      throw error;
    }
  );
}

/** Records a probe's result that the core produced as it arrived (an install that just finished). */
export function recordDesktopStatus<K extends 'gitCli' | 'libreOffice'>(
  api: StatusApi | undefined,
  key: K,
  value: DesktopStatus[K]
): DesktopStatus[K] {
  if (api) {
    const state = entry(api, key);
    if (confirm(state, value, nextStamp())) publish(api, key, state);
  }
  return value;
}

/** Fresh read that also refreshes the cache; undefined where the host lacks the call.
 *  Resolves with the newest value held, which is the read's own answer unless a newer one arrived first.
 *  A read that answers nothing (the core's connection not up yet) rejects: the value stays unknown, never cached as
 *  an absent one, and the next settings announcement reads again (use-desktop-status.ts). */
export function readDesktopStatus<K extends StatusKey>(
  api: StatusApi | undefined,
  key: K,
  refresh = false,
  signal?: AbortSignal
): Promise<DesktopStatus[K]> | undefined {
  if (!api) return undefined;
  const stamp = nextStamp();
  const pending = readers[key](api, refresh);
  if (!pending) return undefined;
  return pending.then((value) => {
    signal?.throwIfAborted();
    if (value == null) throw new Error(`The ${key} read answered nothing.`);
    const state = entry(api, key);
    if (confirm(state, value, stamp)) publish(api, key, state);
    return getCachedDesktopStatus(api, key) ?? value;
  });
}

/** Warm every value when the settings dialog opens. */
export function preloadDesktopStatus(api: StatusApi | undefined): Promise<unknown> {
  return Promise.all(
    (Object.keys(readers) as StatusKey[]).map((key) => readDesktopStatus(api, key)?.catch(() => undefined))
  );
}
