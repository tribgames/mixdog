import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi } from '../shared/contract';
import {
  DEFAULT_ACTIVITY_RAIL_PINS,
  normalizeActivityRailPins,
  readActivityRailPinsState,
  type ActivityRailPinsState,
} from '../shared/activity-rail-pins';
import { showDesktopToast } from './desktop-toasts';
import { isRemoteConnectionInterruptedError } from './remote-connection-state';
import { t } from './i18n';

const STORAGE_KEY = 'mixdog.desktop.activity-rail-pins.v1';
type PinsApi = Pick<DesktopApi, 'readActivityRailPins' | 'updateActivityRailPins' | 'subscribeActivityRailPins'>;

function readLocalPins(): string[] {
  try {
    return (
      normalizeActivityRailPins(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')) ??
      DEFAULT_ACTIVITY_RAIL_PINS
    );
  } catch {
    return DEFAULT_ACTIVITY_RAIL_PINS;
  }
}

function cachePins(pins: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch (error) {
    console.warn('Could not cache activity rail pins', error);
  }
}

function reportSyncError(error: unknown): void {
  console.warn('Activity rail pin synchronization failed', error);
  // An interrupted relay call carries no message; the change may not have reached the host.
  const detail = isRemoteConnectionInterruptedError(error)
    ? t('Check the connection, then try again.')
    : error instanceof Error
      ? error.message
      : String(error);
  showDesktopToast(`${t('Sidebar')}: ${detail}`, 'error', {
    scope: 'activity-rail-pins',
  });
}

/** The host owns the order; localStorage only seeds Electron and paints boot. */
export function useActivityRailPins(api: PinsApi | undefined = window.mixdogDesktop) {
  const [pins, setPins] = useState(readLocalPins);
  const initialPins = useRef(pins);
  const currentPins = useRef(pins);
  const confirmed = useRef<ActivityRailPinsState | null>(null);
  const pending = useRef(0);
  // Bumped by every local save and every received update; an absent read that
  // began before either is stale.
  const saves = useRef(0);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  const publishConfirmed = useCallback(() => {
    if (!mounted.current || pending.current > 0) return;
    const next = confirmed.current?.pins ?? initialPins.current;
    currentPins.current = next;
    setPins(next);
    cachePins(next);
  }, []);
  const receive = useCallback(
    (value: unknown) => {
      const state = readActivityRailPinsState(value);
      if (!state) return;
      saves.current += 1;
      if (state.revision <= (confirmed.current?.revision ?? 0)) return;
      confirmed.current = state;
      publishConfirmed();
    },
    [publishConfirmed]
  );

  useEffect(() => {
    mounted.current = true;
    if (!api) {
      // Standalone component previews have no host. Keep their local behavior.
      const stored = (event: StorageEvent) => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        const next = readLocalPins();
        currentPins.current = next;
        setPins(next);
      };
      window.addEventListener('storage', stored);
      return () => {
        mounted.current = false;
        window.removeEventListener('storage', stored);
      };
    }
    let live = true;
    let readId = 0;
    const refresh = async () => {
      const id = ++readId;
      const startedAt = saves.current;
      try {
        const state = await api.readActivityRailPins();
        if (!live || id !== readId) return;
        // An absent answer cannot be ordered by revision, so a read that began
        // before a local save or a received update never overrides it.
        if (!state && pending.current === 0 && saves.current === startedAt) {
          // Nothing stored means the default list: never written back, so a
          // later change of the default reaches this user.
          // The baseline resets too: rollbacks land on the default and any
          // later host revision (even a lower one after a restart) is accepted.
          confirmed.current = { pins: DEFAULT_ACTIVITY_RAIL_PINS, revision: 0 };
          publishConfirmed();
        }
        if (live && id === readId && state) receive(state);
      } catch (error) {
        // An interrupted read repeats on the next connection-ready event.
        if (live && id === readId && !isRemoteConnectionInterruptedError(error)) reportSyncError(error);
      }
    };
    const unsubscribe = api.subscribeActivityRailPins(receive);
    window.addEventListener('mixdog:remote-connection-ready', refresh);
    void refresh();
    return () => {
      live = false;
      mounted.current = false;
      unsubscribe();
      window.removeEventListener('mixdog:remote-connection-ready', refresh);
    };
  }, [api, receive, publishConfirmed]);

  const savePins = useCallback(
    (next: string[]) => {
      currentPins.current = next;
      setPins(next);
      cachePins(next);
      if (!api) return;
      pending.current += 1;
      saves.current += 1;
      // Serialize this client's writes; server revisions order all clients.
      writes.current = writes.current.then(async () => {
        try {
          const saved = await api.updateActivityRailPins(next);
          if (mounted.current) receive(saved);
        } catch (error) {
          if (mounted.current) reportSyncError(error);
        } finally {
          pending.current -= 1;
          publishConfirmed();
        }
      });
    },
    [api, receive, publishConfirmed]
  );
  return { pins, savePins };
}
