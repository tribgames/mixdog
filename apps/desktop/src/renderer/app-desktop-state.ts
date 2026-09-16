// Host-level desktop state (Project, pinned remote session, chrome) is separate from
// established session panes, which read only their keyed session lanes.
import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionSnapshot } from "../shared/contract";
import { type Snapshot, EMPTY_SNAPSHOT } from "./desktop-types";
import { currentRemoteConnectionState, subscribeRemoteConnectionState } from "./remote-connection-state";
import { remoteSurface } from "./shell-viewport";
import { holdStatsDataCache } from "./command-surface-cache";
import {
  createDesktopSnapshotStore,
  desktopSnapshotUpdateIsUrgent,
  type DesktopSnapshotStore,
} from "./desktop-snapshot-store";
import {
  cancelLayoutFrame,
  scheduleLayoutFrame,
} from "./interaction-frame-scheduler";
export function useDesktopState() {
  const snapshotStoreRef = useRef<DesktopSnapshotStore | null>(null);
  snapshotStoreRef.current ||= createDesktopSnapshotStore();
  const snapshotStore = snapshotStoreRef.current;
  const latestSnapshot = useRef<Snapshot>(EMPTY_SNAPSHOT);
  const [connected, setConnected] = useState(Boolean(window.mixdogDesktop));
  const [hydrated, setHydrated] = useState(!window.mixdogDesktop);
  const [error, setError] = useState("");
  const applyReceivedSnapshot = useCallback((
    next: SessionSnapshot | null,
    immediate = false,
  ) => {
    const snapshot = next && typeof next === "object" ? next as Snapshot : EMPTY_SNAPSHOT;
    latestSnapshot.current = snapshot;
    if (immediate || desktopSnapshotUpdateIsUrgent(snapshotStore.getSnapshot(), snapshot)) {
      cancelLayoutFrame(snapshotStore);
      snapshotStore.publish(snapshot);
      return;
    }
    scheduleLayoutFrame(snapshotStore, () => snapshotStore.publish(latestSnapshot.current));
  }, [snapshotStore]);
  const applySnapshot = useCallback((next: SessionSnapshot | null) => {
    applyReceivedSnapshot(next, true);
  }, [applyReceivedSnapshot]);
  useEffect(() => {
    const host = window.mixdogDesktop;
    if (!host) {
      setConnected(false);
      setHydrated(true);
      return;
    }
    let live = true;
    const releaseStats = holdStatsDataCache(host);
    const update = (next: SessionSnapshot | null) => {
      if (live) {
        applyReceivedSnapshot(next);
        setHydrated(true);
        const previousReadError = initialReadError;
        initialReadError = "";
        setError((current) => current === previousReadError ? "" : current);
      }
    };
    let initialReadError = "";
    let readPending = false;
    const readInitialSnapshot = () => {
      if (!live || readPending) return;
      readPending = true;
      Promise.resolve().then(() => host.getSnapshot()).then(update).catch((reason) => {
        if (live) {
          initialReadError = reason instanceof Error ? reason.message : String(reason);
          setError(initialReadError);
          // Native boot retains its bounded recovery. A remote boot needs a
          // real host snapshot, not merely a completed (failed) attempt.
          if (!remoteSurface()) setHydrated(true);
        }
      }).finally(() => { readPending = false; });
    };
    readInitialSnapshot();
    const unsubscribeConnection = subscribeRemoteConnectionState(() => {
      if (initialReadError && currentRemoteConnectionState() === "connected") {
        readInitialSnapshot();
      }
    });
    const unsubscribe = host.subscribeState(update);
    return () => {
      live = false;
      releaseStats();
      cancelLayoutFrame(snapshotStore);
      unsubscribeConnection();
      unsubscribe?.();
    };
  }, [applyReceivedSnapshot, snapshotStore]);

  return {
    snapshotStore,
    connected,
    hydrated,
    error,
    setError,
    applySnapshot,
  };
}
