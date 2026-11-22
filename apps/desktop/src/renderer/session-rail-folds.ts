// The session panel's folds, remembered per session (which categories and
// to-do groups the user folded; all are open until then), and the order of
// its categories.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { OPEN_MODEL_PICKER_EVENT, requestOpenModelPicker } from './model-picker-event';

/** The panel's categories, in the order a panel nobody arranged shows them. */
export const SESSION_RAIL_CATEGORIES = [
  'info',
  'context',
  'goal',
  'todo',
  'agents',
  'shells',
  'worktrees',
  'changes',
  'git',
] as const;
export type SessionRailCategory = (typeof SESSION_RAIL_CATEGORIES)[number];

export const SESSION_RAIL_ORDER_KEY = 'mixdog.desktop.session-rail-order.v1';

/** The stored arrangement, completed with the categories it does not name (a
 *  category added since it was written) at their default places' end. */
export function sessionRailOrder(stored: unknown): SessionRailCategory[] {
  const known = Array.isArray(stored)
    ? stored.filter((id): id is SessionRailCategory => SESSION_RAIL_CATEGORIES.includes(id))
    : [];
  const named = [...new Set(known)];
  return [...named, ...SESSION_RAIL_CATEGORIES.filter((id) => !named.includes(id))];
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
/** Sessions remembered, the most recently changed kept. */
const REMEMBERED_SESSIONS = 200;

/** A category is open until the user folds it (`closed`); a to-do fold is held once it was set (`groups`). */
type SessionFolds = { closed: SessionRailCategory[]; groups: Record<string, boolean> };

function readAll(): Record<string, SessionFolds> {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(SESSION_RAIL_FOLDS_KEY) || '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, SessionFolds>) : {};
  } catch {
    return {};
  }
}

function readFolds(sessionId: string): SessionFolds {
  const stored = readAll()[sessionId];
  return {
    closed: Array.isArray(stored?.closed) ? stored.closed : [],
    groups: stored?.groups && typeof stored.groups === 'object' ? stored.groups : {},
  };
}

function writeFolds(sessionId: string, folds: SessionFolds): void {
  const all = readAll();
  delete all[sessionId];
  all[sessionId] = folds;
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - REMEMBERED_SESSIONS))) delete all[id];
  try {
    window.localStorage.setItem(SESSION_RAIL_FOLDS_KEY, JSON.stringify(all));
  } catch {
    // The folds hold while the panel is mounted.
  }
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

export function useSessionRailFolds(sessionId: string) {
  const [folds, setFolds] = useState(() => readFolds(sessionId));
  useEffect(() => setFolds(readFolds(sessionId)), [sessionId]);
  const update = useCallback(
    (change: (current: SessionFolds) => SessionFolds) =>
      setFolds((current) => {
        const next = change(current);
        if (sessionId) writeFolds(sessionId, next);
        return next;
      }),
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
    (groups: Record<string, boolean>) => update((current) => ({ ...current, groups: { ...current.groups, ...groups } })),
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
