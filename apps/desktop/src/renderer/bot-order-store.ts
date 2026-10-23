import { useEffect, useSyncExternalStore } from 'react';
import { MIXY_AGENT_ID } from '../shared/agent-contacts';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';

/** The one bot order, stored on the HOST (getBotOrder / setBotOrder) so the
 *  Bots page, the Sessions bot section and every paired phone show the same
 *  list; a change reaches the others through the settings-changed event.
 *  Agent ids only, Mixy excluded (it is pinned first and never moves).
 *  Missing → the list's own order; unknown ids are ignored where applied. */
const EMPTY: readonly string[] = Object.freeze([]);
const listeners = new Set<() => void>();
/** Bumped by every read and write: a stale read must not publish. */
let generation = 0;
let current: readonly string[] = EMPTY;

export const botOrder = (): readonly string[] => current;

/** Clean ids from a host answer or a draft: strings only, Mixy and repeats dropped. */
export function parseBotOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim());
  return [...new Set(ids)].filter((id) => id !== MIXY_AGENT_ID);
}

function publish(next: readonly string[]): void {
  if (next.length === current.length && next.every((id, index) => id === current[index])) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Tests: back to no stored order, as a fresh window. */
export function resetBotOrder(): void {
  generation += 1;
  loaded = false;
  loading = null;
  publish(EMPTY);
}

/** `contacts` in the stored order: Mixy first, then the stored ids in their
 *  order, then every bot the order does not know (new ones) in the list's own
 *  order. Ids of bots that no longer exist are simply never met. */
export function applyBotOrder<T extends { agentId: string; mixy: boolean }>(
  contacts: readonly T[],
  order: readonly string[] = current
): T[] {
  if (!order.length) return [...contacts].sort((left, right) => Number(right.mixy) - Number(left.mixy));
  const rank = new Map(order.map((id, index) => [id, index]));
  const place = (contact: T) => (contact.mixy ? -1 : (rank.get(contact.agentId) ?? Number.MAX_SAFE_INTEGER));
  return [...contacts].sort((left, right) => place(left) - place(right));
}

/** The order after moving `fromId` onto `toId`'s place among `shownIds` (the
 *  bots a list shows, in its order, Mixy excluded). Bots the list does not
 *  show keep their slots. Null when the move is no move. */
export function movedBotOrder(
  stored: readonly string[],
  shownIds: readonly string[],
  fromId: string,
  toId: string
): string[] | null {
  const from = shownIds.indexOf(fromId);
  const to = shownIds.indexOf(toId);
  if (fromId === MIXY_AGENT_ID || toId === MIXY_AGENT_ID || from < 0 || to < 0 || from === to) return null;
  const reordered = [...shownIds];
  reordered.splice(to, 0, ...reordered.splice(from, 1));
  const shown = new Set(shownIds);
  const full = [...new Set([...stored, ...shownIds])].filter((id) => id !== MIXY_AGENT_ID);
  // The shown bots take the shown slots in their new order; hidden ones stay put.
  const slots = full.flatMap((id, index) => (shown.has(id) ? [index] : []));
  const next = [...full];
  slots.forEach((slot, index) => {
    next[slot] = reordered[index];
  });
  return next;
}

type OrderApi = Pick<NonNullable<Window['mixdogDesktop']>, 'invokeCapability'>;

const hostApi = (): OrderApi | undefined => {
  const api = globalThis.window?.mixdogDesktop;
  return typeof api?.invokeCapability === 'function' ? (api as OrderApi) : undefined;
};

/** The host's order has been read and nothing since announced a change. */
let loaded = false;
/** The one read in flight, shared by every hook that mounts meanwhile. */
let loading: Promise<void> | null = null;

/** Read the host's order. An older host has none: keep what is shown. */
export async function readBotOrder(api: OrderApi): Promise<void> {
  generation += 1;
  const mine = generation;
  try {
    const reply = (await api.invokeCapability({ capability: 'getBotOrder', args: [] })) as
      | { value?: { order?: unknown } }
      | undefined;
    if (mine !== generation) return;
    publish(parseBotOrder(reply?.value?.order));
    loaded = true;
  } catch {
    // No such capability, or the link lapsed.
  }
}

/** The order for a hook that mounts: the cached read, or the one in flight,
 *  else a single new read. Every mounting list shares it (a phone paid one
 *  ~8 KB relay round trip per list). */
function loadBotOrder(api: OrderApi): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  const mine: Promise<void> = readBotOrder(api).finally(() => {
    if (loading === mine) loading = null;
  });
  loading = mine;
  return mine;
}

/** The Bots page's three sections. Their order rides in the SAME stored list
 *  as the bot order, as reserved `section:<id>` entries (no second setting, no
 *  second capability): bot ids never carry the prefix, and every bot reader
 *  already ignores ids it does not know. */
export const PANE_SECTION_IDS = ['bots', 'rooms', 'agents'] as const;
export type PaneSectionId = (typeof PANE_SECTION_IDS)[number];
const SECTION_PREFIX = 'section:';

/** The sections in the stored order; any the list lacks follow in the default
 *  order (Bots → Rooms → Agents). */
export function paneSectionOrder(order: readonly string[] = current): PaneSectionId[] {
  const stored = order
    .filter((id) => id.startsWith(SECTION_PREFIX))
    .map((id) => id.slice(SECTION_PREFIX.length))
    .filter((id): id is PaneSectionId => (PANE_SECTION_IDS as readonly string[]).includes(id));
  return [...new Set([...stored, ...PANE_SECTION_IDS])];
}

/** The page's four show/hide groups: the pinned representative bot plus the
 *  three sections. Hidden ones ride in the same stored list as reserved
 *  `hidden:<id>` entries (shown by default; synced like the section order). */
export const PANE_GROUP_IDS = ['representative', ...PANE_SECTION_IDS] as const;
export type PaneGroupId = (typeof PANE_GROUP_IDS)[number];
/** Every hideable part of the page: the four list groups plus the connector bar at the foot. */
export const PANE_TOGGLE_IDS = [...PANE_GROUP_IDS, 'connectors'] as const;
export type PaneToggleId = (typeof PANE_TOGGLE_IDS)[number];
const HIDDEN_PREFIX = 'hidden:';

/** The groups and panels the list marks hidden. */
export function hiddenPaneGroups(order: readonly string[] = current): ReadonlySet<PaneToggleId> {
  return new Set(
    order
      .filter((id) => id.startsWith(HIDDEN_PREFIX))
      .map((id) => id.slice(HIDDEN_PREFIX.length))
      .filter((id): id is PaneToggleId => (PANE_TOGGLE_IDS as readonly string[]).includes(id))
  );
}

/** The stored list with group `id` shown or hidden; null when already so. */
export function toggledGroupOrder(stored: readonly string[], id: PaneToggleId, hidden: boolean): string[] | null {
  if (hiddenPaneGroups(stored).has(id) === hidden) return null;
  const entry = `${HIDDEN_PREFIX}${id}`;
  return hidden ? [...stored, entry] : stored.filter((item) => item !== entry);
}

/** Pinned Leads ride in the same stored list as `pin:<sessionId>` entries: a
 *  pinned Lead row never expires from the Bots page (until unpinned, archived
 *  or deleted). */
const PIN_PREFIX = 'pin:';

export function pinnedLeadIds(order: readonly string[] = current): ReadonlySet<string> {
  return new Set(order.filter((id) => id.startsWith(PIN_PREFIX)).map((id) => id.slice(PIN_PREFIX.length)));
}

/** The stored list with Lead `sessionId` pinned or unpinned; null when already so. */
export function toggledPinOrder(stored: readonly string[], sessionId: string, pinned: boolean): string[] | null {
  if (pinnedLeadIds(stored).has(sessionId) === pinned) return null;
  const entry = `${PIN_PREFIX}${sessionId}`;
  return pinned ? [...stored, entry] : stored.filter((item) => item !== entry);
}

/** How long a finished Lead stays on the Bots page: a single `retain:<choice>`
 *  entry in the stored list (none = the 1-hour default). */
export const RETAIN_CHOICES = ['1h', '1d', '7d', 'forever'] as const;
export type RetainChoice = (typeof RETAIN_CHOICES)[number];
export const DEFAULT_RETAIN_CHOICE: RetainChoice = '1h';
const RETAIN_PREFIX = 'retain:';

export function retainChoice(order: readonly string[] = current): RetainChoice {
  const stored = order.find((id) => id.startsWith(RETAIN_PREFIX))?.slice(RETAIN_PREFIX.length);
  return RETAIN_CHOICES.find((choice) => choice === stored) ?? DEFAULT_RETAIN_CHOICE;
}

/** The stored list holding `choice`; null when it already does. */
export function retainedChoiceOrder(stored: readonly string[], choice: RetainChoice): string[] | null {
  if (retainChoice(stored) === choice) return null;
  const rest = stored.filter((id) => !id.startsWith(RETAIN_PREFIX));
  return choice === DEFAULT_RETAIN_CHOICE ? rest : [...rest, `${RETAIN_PREFIX}${choice}`];
}

/** Store `next` as the shared order: every list updates now; the host keeps it
 *  and tells the other devices (a refusal re-reads what the host holds). */
function commit(next: string[]): void {
  generation += 1;
  publish(next);
  const api = hostApi();
  if (api) {
    void Promise.resolve(api.invokeCapability({ capability: 'setBotOrder', args: [next] })).catch(() => {
      void readBotOrder(api); // the host refused: show what it holds
    });
  }
}

/** Move bot `fromId` onto `toId` among `shownIds`. Returns whether anything moved. */
export function moveBot(shownIds: readonly string[], fromId: string, toId: string): boolean {
  const next = movedBotOrder(current, shownIds, fromId, toId);
  if (!next) return false;
  commit(next);
  return true;
}

/** Show or hide a page group, stored at once like the section order. */
export function setGroupHidden(id: PaneToggleId, hidden: boolean): void {
  const next = toggledGroupOrder(current, id, hidden);
  if (next) commit(next);
}

/** Pin or unpin a Lead row, stored at once like the section order. */
export function setLeadPinned(sessionId: string, pinned: boolean): void {
  const next = toggledPinOrder(current, sessionId, pinned);
  if (next) commit(next);
}

/** Choose how long finished Leads stay listed, stored at once. */
export function setRetainChoice(choice: RetainChoice): void {
  const next = retainedChoiceOrder(current, choice);
  if (next) commit(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The shared bot order, live: re-read when the host announces a settings
 *  change and when a remote link comes back. */
export function useBotOrder(): readonly string[] {
  const order = useSyncExternalStore(subscribe, botOrder, botOrder);
  useEffect(() => {
    const api = hostApi();
    if (!api) return undefined;
    return watchBotOrder(api);
  }, []);
  return order;
}

// One shared watch for however many lists use the order: a change event or a
// returning link rereads once for all of them, and with no list left the cached
// read is dropped (changes would go unheard) so the next list reads afresh.
let watchers = 0;
let detachWatch: (() => void) | null = null;

function watchBotOrder(api: OrderApi): () => void {
  if (watchers++ === 0) {
    const reread = () => void readBotOrder(api);
    const unsubscribe = globalThis.window.mixdogDesktop?.subscribeSettingsChanged?.(reread);
    globalThis.window.addEventListener(REMOTE_CONNECTION_READY_EVENT, reread);
    detachWatch = () => {
      unsubscribe?.();
      globalThis.window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, reread);
    };
  }
  void loadBotOrder(api);
  return () => {
    if (--watchers > 0) return;
    detachWatch?.();
    detachWatch = null;
    // A read still pending is retired with the last list: its late answer must
    // neither publish nor mark the cache loaded, and a remount reads afresh.
    generation += 1;
    loaded = false;
    loading = null;
  };
}
