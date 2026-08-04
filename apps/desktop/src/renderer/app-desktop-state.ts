// Desktop snapshot subscription: owns the store, folds turn-failure state into
// each published snapshot, and keeps the connected/error flags. Extracted from
// App.tsx so the component consumes one hook instead of the wiring.
import { useCallback, useEffect, useRef, useState } from "react";

import type { EngineSnapshot } from "../shared/contract";
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
import {
  sharedTranscriptSnapshotDecorator,
  type TranscriptSnapshotDecorator,
} from "./snapshot-transcript-decoration";
import { applyFocusedSnapshotToSessionLane, defaultSessionLaneStore } from "./session-lane-store";

export function useDesktopState() {
  const snapshotStoreRef = useRef<DesktopSnapshotStore | null>(null);
  snapshotStoreRef.current ||= createDesktopSnapshotStore();
  const snapshotStore = snapshotStoreRef.current;
  const snapshotRef = useRef<Snapshot>(EMPTY_SNAPSHOT);
  const [connected, setConnected] = useState(Boolean(window.mixdogDesktop));
  const [hydrated, setHydrated] = useState(!window.mixdogDesktop);
  const [error, setError] = useState("");
  const transcriptDecorator = useRef<TranscriptSnapshotDecorator | null>(null);
  // Shared with the session lanes: one identity baseline per session across
  // every snapshot source. Separate per-pipeline decorator instances each
  // converged on their own first-seen row ids, so a pane focus swap still
  // crossed id namespaces — rows remounted, the virtualizer dropped measured
  // heights, and the transcript/TurnReviewBar visibly jumped on every focus
  // move (user report, CDP-attributed).
  transcriptDecorator.current ||= sharedTranscriptSnapshotDecorator;
  // Timestamp of the last RENDERER-initiated apply (submit/capability results
  // such as /clear). Host pushes never touch it, so the session-scoped frame
  // gate can tell a user-driven session move from a background publication.
  const lastRendererApplyAt = useRef(0);
  const applyReceivedSnapshot = useCallback((
    next: EngineSnapshot | null,
    immediate = false,
  ) => {
    const decorated = transcriptDecorator.current!.decorate(next);
    // Native desktop session panes have ONE source: mixdog:session-state.
    // Focused mixdog:state remains App/chrome state only and must never rewrite
    // a pane merely because focus moved. Legacy/remote bridges without native
    // session lanes retain the compatibility mirror.
    if (typeof window.mixdogDesktop?.subscribeSessionState !== "function") {
      applyFocusedSnapshotToSessionLane(decorated, defaultSessionLaneStore, {
        source: immediate ? "renderer-result" : "focused-state",
      });
    }
    snapshotRef.current = decorated;
    if (immediate || desktopSnapshotUpdateIsUrgent(snapshotStore.getSnapshot(), decorated)) {
      cancelLayoutFrame(snapshotStore);
      snapshotStore.publish(decorated);
      return;
    }
    scheduleLayoutFrame(snapshotStore, () => snapshotStore.publish(snapshotRef.current));
  }, [snapshotStore]);
  const applySnapshot = useCallback((next: EngineSnapshot | null) => {
    lastRendererApplyAt.current = Date.now();
    applyReceivedSnapshot(next, true);
  }, [applyReceivedSnapshot]);
  /** A renderer-initiated RESULT for a session the focused store already
   *  publishes (the resume RPC answer). Publishing it again would re-apply
   *  the same long transcript to the focused store, but its SESSION lane must
   *  still receive the renderer's authoritative answer — otherwise a
   *  legitimate older-branch, cleared or rewritten transcript would only ever
   *  reach the cache as a host push and be reconciled against stale rows. */
  const applySessionResult = useCallback((next: EngineSnapshot | Snapshot | null) => {
    lastRendererApplyAt.current = Date.now();
    const decorated = transcriptDecorator.current!.decorate(next as EngineSnapshot);
    // Native session lanes still need this renderer-result boundary. The
    // focused state publication can resolve before the target pane's lane
    // replay, and exposing the cached pane first makes its Markdown/script DOM
    // change again when that replay eventually arrives.
    applyFocusedSnapshotToSessionLane(decorated, defaultSessionLaneStore, {
      source: "renderer-result",
    });
  }, []);

  useEffect(() => {
    const host = window.mixdogDesktop;
    if (!host) {
      setConnected(false);
      setHydrated(true);
      return;
    }
    let live = true;
    const update = (next: EngineSnapshot | null) => {
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
    snapshotRef,
    connected,
    hydrated,
    error,
    setError,
    applySnapshot,
    applySessionResult,
    lastRendererApplyAt,
  };
}
