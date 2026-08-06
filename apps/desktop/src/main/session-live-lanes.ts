// Per-session live snapshot lanes. The focused publication channel
// (EngineHost.publish → mixdog:state) only ever carries the ACTIVE engine;
// split panes need every pooled engine (active or parked) to stream its own
// session snapshot concurrently. Each attached engine owns one lane: its own
// engine subscription and its own publication throttle, with the sessionId
// read at emit time so a lane follows its engine through park/activate and
// in-place session switches untouched.
import type { DesktopSessionFrameSource, EngineSnapshot } from '../shared/contract';
import type { MixdogEngine } from './engine-host-support';

export type SessionStateUpdate = {
  sessionId: string;
  snapshot: EngineSnapshot;
  /** Provenance/content generation stamped by the host (see contract). */
  frameSource?: DesktopSessionFrameSource;
  contentRevision?: number;
};

type Lane = { unsubscribe: () => void; pending: boolean };

export function createSessionLiveLanes(options: {
  intervalMs: number;
  projectSnapshot(engine: MixdogEngine): EngineSnapshot;
  /** Stamps an OWNER publication with its provenance and content generation.
   *  Peeks/replays carry their own metadata through emitPeek instead. */
  describeLiveFrame?(sessionId: string, snapshot: EngineSnapshot, engine: MixdogEngine): {
    frameSource?: DesktopSessionFrameSource;
    contentRevision?: number;
  };
  /** Runs after the final projected frame reaches every current listener.
   *  EngineHost uses it to release a parked engine once its work settles. */
  onAfterEmit?(engine: MixdogEngine): void;
}) {
  const lanes = new Map<MixdogEngine, Lane>();
  const listeners = new Set<(update: SessionStateUpdate) => void>();
  // ONE frame clock for every lane (opencode packages/app server-sdk.tsx
  // flush/schedule). Per-lane timers let N streaming panes drift into N
  // independent publication hops per frame; a shared clock publishes every
  // lane that changed inside the frame together, so a consumer commits once.
  let frameTimer: NodeJS.Timeout | null = null;
  let lastFlushAt = 0;

  function laneUpdate(engine: MixdogEngine): SessionStateUpdate | null {
    let sessionId = '';
    try {
      sessionId = String(engine.getState()?.sessionId || '');
    } catch {
      return null; // a disposing engine simply skips this publication
    }
    // A blank desktop task has no persisted identity yet; the focused state
    // channel already covers it and a lane keyed by '' could collide.
    if (!sessionId) return null;
    const snapshot = options.projectSnapshot(engine);
    return {
      sessionId,
      snapshot,
      frameSource: 'live' as const,
      ...(options.describeLiveFrame?.(sessionId, snapshot, engine) ?? {}),
    };
  }

  function emit(engine: MixdogEngine): boolean {
    let emitted = false;
    if (listeners.size > 0) {
      const update = laneUpdate(engine);
      if (update) {
        for (const listener of [...listeners]) {
          try {
            listener(update);
          } catch {
            // One subscriber fault must not break the other lanes' consumers.
          }
        }
        emitted = true;
      }
    }
    try { options.onAfterEmit?.(engine); } catch { /* lifecycle cleanup is best-effort here */ }
    return emitted;
  }

  /** Publish every lane that changed during this frame, in attach order. */
  function flushFrame(): void {
    frameTimer = null;
    lastFlushAt = Date.now();
    for (const [engine, lane] of [...lanes]) {
      if (!lane.pending) continue;
      lane.pending = false;
      if (lanes.has(engine)) emit(engine);
    }
  }

  function schedule(engine: MixdogEngine): void {
    const lane = lanes.get(engine);
    if (!lane || (listeners.size === 0 && !options.onAfterEmit)) return;
    lane.pending = true;
    if (frameTimer) return;
    // opencode schedule(): a frame budget that ALREADY elapsed publishes on
    // the next tick; only a burst inside one frame waits out the remainder.
    // The previous fixed delay charged every event a full frame of latency
    // even when the lane had been quiet for seconds.
    const elapsed = Date.now() - lastFlushAt;
    frameTimer = setTimeout(flushFrame, Math.max(0, options.intervalMs - elapsed));
    frameTimer.unref?.();
  }

  function attach(engine: MixdogEngine): void {
    if (lanes.has(engine)) return;
    let unsubscribe: () => void;
    try {
      unsubscribe = engine.subscribe(() => schedule(engine));
    } catch {
      return; // an engine without eventing has no live lane
    }
    lanes.set(engine, { unsubscribe, pending: false });
    emit(engine);
  }

  function detach(engine: MixdogEngine): void {
    const lane = lanes.get(engine);
    if (!lane) return;
    lanes.delete(engine);
    lane.pending = false;
    try {
      lane.unsubscribe();
    } catch {
      // The engine is already torn down; the lane is gone either way.
    }
  }

  function detachAll(): void {
    for (const engine of [...lanes.keys()]) detach(engine);
    if (!frameTimer) return;
    clearTimeout(frameTimer);
    frameTimer = null;
  }

  /** Replay one attached engine immediately. Main subscribes before the
   * renderer preload listener exists, so its eager first frame can be lost at
   * startup; pane peek uses this handshake to deliver the current frame again. */
  function replay(engine: MixdogEngine): boolean {
    return lanes.has(engine) && emit(engine);
  }

  function subscribe(listener: (update: SessionStateUpdate) => void): () => void {
    listeners.add(listener);
    // A late subscriber immediately sees every live lane's current state, so
    // a pane opening onto a parked session never waits for its next event.
    for (const engine of [...lanes.keys()]) {
      const update = laneUpdate(engine);
      if (!update) continue;
      try {
        listener(update);
      } catch {
        // Same isolation as emit().
      }
      try { options.onAfterEmit?.(engine); } catch { /* lifecycle cleanup is best-effort here */ }
    }
    return () => {
      listeners.delete(listener);
    };
  }

  /** One-shot read-only frame for a session WITHOUT a pooled engine (pane
   *  peek). Live lanes are unaffected: their engines re-emit on every own
   *  event, so a peek can never permanently shadow a live stream. */
  function emitPeek(update: SessionStateUpdate): void {
    for (const listener of [...listeners]) {
      try {
        listener(update);
      } catch {
        // Same isolation as emit().
      }
    }
  }

  return { attach, detach, detachAll, replay, subscribe, emitPeek };
}
