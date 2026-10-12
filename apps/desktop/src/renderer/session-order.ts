/** Session sort preferences and per-list custom order for the session sidebar.
 *  Pure helpers; the sidebar owns the React state and localStorage writes. */

export type SessionOrderMode = 'recent' | 'custom';
export interface SessionOrderPrefs {
  /** Recent list and the sessions inside each project folder. */
  sessions: SessionOrderMode;
  favorites: SessionOrderMode;
}
/** List key (`favorites`, `recent`, `project:<key>`) -> session ids, top first. */
export type CustomSessionOrders = Readonly<Record<string, readonly string[]>>;

export const SESSION_ORDER_PREFS_KEY = 'mixdog:session-sidebar-session-order-mode';
export const SESSION_CUSTOM_ORDERS_KEY = 'mixdog:session-sidebar-session-custom-order';
export const DEFAULT_SESSION_ORDER_PREFS: SessionOrderPrefs = { sessions: 'recent', favorites: 'custom' };
const MAX_STORED_IDS_PER_LIST = 2000;
const LIST_ID_SEPARATOR = '\n';

const isMode = (value: unknown): value is SessionOrderMode => value === 'recent' || value === 'custom';

export function normalizeOrderPrefs(value: unknown): SessionOrderPrefs {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    sessions: isMode(record.sessions) ? record.sessions : DEFAULT_SESSION_ORDER_PREFS.sessions,
    favorites: isMode(record.favorites) ? record.favorites : DEFAULT_SESSION_ORDER_PREFS.favorites,
  };
}

export function normalizeCustomOrders(value: unknown): CustomSessionOrders {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const orders: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(value)) {
    if (Array.isArray(ids)) orders[key] = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  }
  return orders;
}

/** Stored ids first (in stored order, only those still present), sessions the
 *  stored order does not know yet on top in their incoming (activity) order. */
export function applySessionOrder<T extends { id: string }>(
  activityRows: readonly T[],
  mode: SessionOrderMode,
  stored: readonly string[] = []
): T[] {
  if (mode !== 'custom') return [...activityRows];
  const byId = new Map(activityRows.map((row) => [row.id, row]));
  const storedSet = new Set(stored);
  const known = stored.flatMap((id) => byId.get(id) ?? []);
  return [...activityRows.filter((row) => !storedSet.has(row.id)), ...known];
}

/** Persist sessions that appeared since the stored order was written, on top,
 *  so a custom list keeps its positions when activity later reorders. Returns
 *  the same object when nothing changed. */
export function syncCustomOrders(
  orders: CustomSessionOrders,
  lists: readonly { key: string; ids: readonly string[] }[]
): CustomSessionOrders {
  let next: Record<string, readonly string[]> | null = null;
  for (const { key, ids } of lists) {
    const stored = (next ?? orders)[key] ?? [];
    const storedSet = new Set(stored);
    const fresh = ids.filter((id) => !storedSet.has(id));
    if (fresh.length === 0) continue;
    next ??= { ...orders };
    next[key] = [...fresh, ...stored].slice(0, MAX_STORED_IDS_PER_LIST);
  }
  return next ?? orders;
}

/** The full list after the user reordered its visible head: hidden (paged-out)
 *  rows keep their place below it. */
export function commitVisibleOrder(
  fullOrderedIds: readonly string[],
  visibleCount: number,
  nextVisibleIds: readonly string[]
): string[] {
  return [...nextVisibleIds, ...fullOrderedIds.slice(visibleCount)];
}

export const listOrderId = (listKey: string, sessionId: string) => `${listKey}${LIST_ID_SEPARATOR}${sessionId}`;
export function splitListOrderId(id: string): { listKey: string; sessionId: string } {
  const index = id.indexOf(LIST_ID_SEPARATOR);
  return index < 0
    ? { listKey: '', sessionId: id }
    : { listKey: id.slice(0, index), sessionId: id.slice(index + LIST_ID_SEPARATOR.length) };
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sort preferences are a convenience only */
  }
}
export const readOrderPrefs = () => normalizeOrderPrefs(readJson(SESSION_ORDER_PREFS_KEY));
export const writeOrderPrefs = (prefs: SessionOrderPrefs) => writeJson(SESSION_ORDER_PREFS_KEY, prefs);
export const readCustomOrders = () => normalizeCustomOrders(readJson(SESSION_CUSTOM_ORDERS_KEY));
export const writeCustomOrders = (orders: CustomSessionOrders) => writeJson(SESSION_CUSTOM_ORDERS_KEY, orders);
