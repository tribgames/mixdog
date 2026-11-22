// The session panel's folds, remembered per session: which categories are
// open and which of the to-do groups.
import { useCallback, useEffect, useRef, useState } from 'react';
import { OPEN_MODEL_PICKER_EVENT, requestOpenModelPicker } from './model-picker-event';

export type SessionRailCategory = 'info' | 'goal' | 'todo' | 'agents' | 'shells' | 'worktrees' | 'changes';

/** A session the panel has not shown yet opens these. */
export const SESSION_RAIL_FIRST_OPEN: readonly SessionRailCategory[] = ['goal', 'todo', 'agents', 'shells', 'changes'];

export const SESSION_RAIL_FOLDS_KEY = 'mixdog.desktop.session-rail-folds.v1';
/** Sessions remembered, the most recently changed kept. */
const REMEMBERED_SESSIONS = 200;

type SessionFolds = { open: SessionRailCategory[]; groups: Record<string, boolean> };

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
    open: Array.isArray(stored?.open) ? stored.open : [...SESSION_RAIL_FIRST_OPEN],
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
        open: current.open.includes(category)
          ? current.open.filter((id) => id !== category)
          : [...current.open, category],
      })),
    [update]
  );
  const setGroups = useCallback(
    (groups: Record<string, boolean>) => update((current) => ({ ...current, groups: { ...current.groups, ...groups } })),
    [update]
  );
  return {
    isOpen: (category: SessionRailCategory) => folds.open.includes(category),
    toggle,
    /** A to-do group's fold; `fallback` before the user folded it. */
    groupOpen: (key: string, fallback: boolean) => folds.groups[key] ?? fallback,
    setGroups,
  };
}
