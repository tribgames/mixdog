// Host-level desktop state (Project, pinned remote session, chrome) is separate from
// established session panes, which read only their keyed session lanes.
import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionSnapshot } from "../shared/contract";
import { type Snapshot, EMPTY_SNAPSHOT } from "./desktop-types";
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
    const update = (next: SessionSnapshot | null) => {
      if (live) {
        applyReceivedSnapshot(next);
        setHydrated(true);
      }
    };
    Promise.resolve(host.getSnapshot()).then(update).catch((reason) => {
      if (live) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setHydrated(true);
      }
    });
    const unsubscribe = host.subscribeState(update);
    return () => {
      live = false;
      cancelLayoutFrame(snapshotStore);
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
