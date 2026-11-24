// The session panel's folds, remembered per session (which categories and
// to-do groups the user folded; all are open until then), and the order of
// its categories.
import { type MouseEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { OPEN_MODEL_PICKER_EVENT, requestOpenModelPicker } from './model-picker-event';

/** The panel's categories, in the order a panel nobody arranged shows them. */
export const SESSION_RAIL_CATEGORIES = [
  'info',
  'context',
  'goal',
  'todo',
  'agents',
  'shells',
  'outputs',
  'changes',
  'git',
] as const;
export type SessionRailCategory = (typeof SESSION_RAIL_CATEGORIES)[number];

export const SESSION_RAIL_ORDER_KEY = 'mixdog.desktop.session-rail-order.v1';

/** The stored arrangement, completed with the categories it does not name (a
 *  category added since it was written): each takes its default place, right
 *  above the first category after it by default that the arrangement holds
 *  (else right below the last one before it). */
export function sessionRailOrder(stored: unknown): SessionRailCategory[] {
  const known = Array.isArray(stored)
    ? stored.filter((id): id is SessionRailCategory => SESSION_RAIL_CATEGORIES.includes(id))
    : [];
  const order = [...new Set(known)];
  for (const [index, id] of SESSION_RAIL_CATEGORIES.entries()) {
    if (order.includes(id)) continue;
    const next = SESSION_RAIL_CATEGORIES.slice(index + 1).find((other) => order.includes(other));
    const previous = SESSION_RAIL_CATEGORIES.slice(0, index).findLast((other) => order.includes(other));
    let at = order.length;
    if (next) at = order.indexOf(next);
    else if (previous) at = order.indexOf(previous) + 1;
    order.splice(at, 0, id);
  }
  return order;
}

/** `moved` placed before or after `target`. */
export function movedSessionRailOrder(
  order: readonly SessionRailCategory[],
  moved: SessionRailCategory,
  target: SessionRailCategory,
  after: boolean
): SessionRailCategory[] {
  if (moved === target) return [...order];
  const rest = order.filter((id) => id !== moved);
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, moved);
  return rest;
}

// One arrangement for every pane's panel.
let railOrder: SessionRailCategory[] | null = null;
const orderListeners = new Set<() => void>();
function currentOrder(): SessionRailCategory[] {
  if (railOrder) return railOrder;
  let stored: unknown = null;
  try {
    stored = JSON.parse(window.localStorage.getItem(SESSION_RAIL_ORDER_KEY) || 'null');
  } catch {
    // An unreadable arrangement is the default one.
  }
  railOrder = sessionRailOrder(stored);
  return railOrder;
}

/** The arrangement now (what a cancelled drag puts back). */
export function sessionRailOrderNow(): readonly SessionRailCategory[] {
  return currentOrder();
}

export function moveSessionRailCategory(moved: SessionRailCategory, target: SessionRailCategory, after: boolean): void {
  setSessionRailOrder(movedSessionRailOrder(currentOrder(), moved, target, after));
}

export function setSessionRailOrder(order: readonly SessionRailCategory[]): void {
  const next = sessionRailOrder(order);
  if (next.every((id, index) => id === currentOrder()[index])) return;
  railOrder = next;
  try {
    window.localStorage.setItem(SESSION_RAIL_ORDER_KEY, JSON.stringify(next));
  } catch {
    // The arrangement holds for this renderer session.
  }
  for (const listener of orderListeners) listener();
}

export function useSessionRailOrder(): readonly SessionRailCategory[] {
  return useSyncExternalStore(
    (listener) => {
      orderListeners.add(listener);
      return () => orderListeners.delete(listener);
    },
    currentOrder,
    currentOrder
  );
}

export const SESSION_RAIL_FOLDS_KEY = 'mixdog.desktop.session-rail-folds.v2';
/** The folds every New Task draft's panel shares (no session id starts with a NUL). */
export const SESSION_RAIL_DRAFT_FOLDS = '\u0000new-task';
/** Sessions remembered, the most recently changed kept. */
const REMEMBERED_SESSIONS = 200;

/** A category is open until the user folds it (`closed`); a to-do fold is held once it was set (`groups`). */
type SessionFolds = { closed: SessionRailCategory[]; groups: Record<string, boolean> };

function storedFolds(): string {
  try {
    return window.localStorage.getItem(SESSION_RAIL_FOLDS_KEY) || '{}';
  } catch {
    return '{}';
  }
}

function parseAll(raw: string): Record<string, SessionFolds> {
  try {
    const stored: unknown = JSON.parse(raw);
    return stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, SessionFolds>)
      : {};
  } catch {
    return {};
  }
}

// One record per session for every panel and island that shows it: each read
// is the stored one (parsed once per stored text, so a snapshot keeps its
// identity), each write starts from it, and every reader hears every write.
let parsedRaw = '';
let parsed: Record<string, SessionFolds> = {};
const snapshots = new Map<string, SessionFolds>();
/** A session that is not stored (none yet): its folds hold in memory. */
const unstored = new Map<string, SessionFolds>();
const foldListeners = new Set<() => void>();
const EMPTY_FOLDS: SessionFolds = { closed: [], groups: {} };

function foldsOf(sessionId: string): SessionFolds {
  if (!sessionId) return unstored.get(sessionId) ?? EMPTY_FOLDS;
  const raw = storedFolds();
  if (raw !== parsedRaw) {
    parsedRaw = raw;
    parsed = parseAll(raw);
    snapshots.clear();
  }
  let folds = snapshots.get(sessionId);
  if (!folds) {
    const stored = parsed[sessionId];
    folds = {
      closed: Array.isArray(stored?.closed) ? stored.closed : [],
      groups: stored?.groups && typeof stored.groups === 'object' ? stored.groups : {},
    };
    snapshots.set(sessionId, folds);
  }
  return folds;
}

function changeFolds(sessionId: string, change: (current: SessionFolds) => SessionFolds): void {
  const next = change(foldsOf(sessionId));
  if (!sessionId) {
    unstored.set(sessionId, next);
  } else {
    const all = parseAll(storedFolds());
    delete all[sessionId];
    all[sessionId] = next;
    const ids = Object.keys(all);
    for (const id of ids.slice(0, Math.max(0, ids.length - REMEMBERED_SESSIONS))) delete all[id];
    try {
      window.localStorage.setItem(SESSION_RAIL_FOLDS_KEY, JSON.stringify(all));
    } catch {
      // Unstorable: the folds hold in memory for this renderer.
      unstored.set(sessionId, next);
    }
    snapshots.set(sessionId, next);
  }
  for (const listener of foldListeners) listener();
}

function subscribeFolds(listener: () => void): () => void {
  foldListeners.add(listener);
  return () => foldListeners.delete(listener);
}

/** A model picker request while Info is folded: the panel takes it, unfolds
 *  Info and asks again once Info's Model row is mounted and listening (a
 *  child's effects run before this one's). */
export function useFoldedModelPickerRequest(answers: boolean, infoOpen: boolean, openInfo: () => void): void {
  const [requested, setRequested] = useState(false);
  const open = useRef(openInfo);
  open.current = openInfo;
  useEffect(() => {
    if (!answers || infoOpen) return undefined;
    const onRequest = (event: Event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      setRequested(true);
      open.current();
    };
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
  }, [answers, infoOpen]);
  useEffect(() => {
    if (!requested || !infoOpen) return;
    setRequested(false);
    requestOpenModelPicker();
  }, [requested, infoOpen]);
}

/** A fold's head pressed with the pointer gives its focus up: kept, the next key pressed anywhere would ring it as
 *  keyboard focus. A head reached by keyboard (a click of no pointer) keeps it. */
export function releasePointerFocus(event: MouseEvent<HTMLElement>): void {
  if (event.detail > 0) event.currentTarget.blur();
}

export function useSessionRailFolds(sessionId: string) {
  const folds = useSyncExternalStore(
    subscribeFolds,
    () => foldsOf(sessionId),
    () => foldsOf(sessionId)
  );
  const update = useCallback(
    (change: (current: SessionFolds) => SessionFolds) => changeFolds(sessionId, change),
    [sessionId]
  );
  const toggle = useCallback(
    (category: SessionRailCategory) =>
      update((current) => ({
        ...current,
        closed: current.closed.includes(category)
          ? current.closed.filter((id) => id !== category)
          : [...current.closed, category],
      })),
    [update]
  );
  const setGroups = useCallback(
    (groups: Record<string, boolean>) =>
      update((current) => ({ ...current, groups: { ...current.groups, ...groups } })),
    [update]
  );
  return {
    isOpen: (category: SessionRailCategory) => !folds.closed.includes(category),
    toggle,
    /** A to-do fold as the user left it, `byDefault` until they set it. */
    groupOpen: (key: string, byDefault: boolean) => folds.groups[key] ?? byDefault,
    setGroups,
  };
}
