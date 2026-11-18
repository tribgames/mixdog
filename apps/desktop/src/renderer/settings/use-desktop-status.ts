// Settings a renderer surface shows, hides or defaults from. They are read from the core over a connection that can be
// late or fail at start, so a missing or failed read stays UNKNOWN (never the "off" or "absent" value) and every
// settings announcement reads again. Callers that also need to recover from a lost announcement can request a
// background reread while their surface is active.
import { useEffect, useRef, useState } from 'react';

import type { DesktopApi } from '../../shared/contract';
import { subscribeSetupChanges } from '../setup-change-refresh';
import { followSettingsReadConnection, startSettingsReadRecovery } from './read-recovery';
import {
  type DesktopStatus,
  type StatusApi,
  type StatusKey,
  getCachedDesktopStatus,
  readDesktopStatus,
  subscribeDesktopStatus,
} from './desktop-status-cache';

type AnnouncingApi = Partial<Pick<DesktopApi, 'subscribeSettingsChanged' | 'sections'>>;

/** Runs `read` now and again on every settings announcement (the core's, and a setup-tool change) while `enabled`;
 *  enabling it again reads at once. */
export function useSettingsReread(
  api: AnnouncingApi | undefined,
  read: (signal?: AbortSignal) => void | Promise<unknown>,
  enabled = true,
  recoveryMs?: number
): void {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    if (!enabled) return;
    const recovery = recoveryMs === undefined
      ? undefined
      : startSettingsReadRecovery((signal) => latest.current(signal), recoveryMs, true, true);
    const reread = recovery?.replace ?? (() => {
      void latest.current();
    });
    if (!recovery) reread();
    const stopLink = recovery ? followSettingsReadConnection(api, recovery) : undefined;
    if (recovery) window.addEventListener('focus', reread);
    const stops = [api?.subscribeSettingsChanged?.(reread), subscribeSetupChanges(reread)];
    return () => {
      for (const stop of stops) stop?.();
      stopLink?.();
      if (recovery) window.removeEventListener('focus', reread);
      recovery?.stop();
    };
  }, [api, enabled, recoveryMs]);
}

/** The value of a desktop status key (`null` while unknown), following its newest read or write: every mounted
 *  consumer of the same api and key shows the same answer. */
export function useDesktopStatus<K extends StatusKey>(
  api: (StatusApi & AnnouncingApi) | undefined,
  key: K,
  enabled = true,
  recoveryMs?: number
): DesktopStatus[K] | null {
  const [value, setValue] = useState<DesktopStatus[K] | null>(() => getCachedDesktopStatus(api, key) ?? null);
  useEffect(() => {
    if (!api || !enabled) return;
    const cached = getCachedDesktopStatus(api, key);
    if (cached !== undefined) setValue(cached);
    return subscribeDesktopStatus((changedKey, next, _previous, changedApi) => {
      if (changedApi === api && changedKey === key) setValue((next ?? null) as DesktopStatus[K] | null);
    });
  }, [api, key, enabled]);
  useSettingsReread(
    api,
    (signal) => readDesktopStatus(api, key, false, signal)?.catch(() => undefined),
    enabled && Boolean(api),
    recoveryMs
  );
  return value;
}
