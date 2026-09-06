// Per-session snapshot cache: switching back to a recently viewed session shows
// its last transcript immediately instead of an empty frame while the session
// re-attaches. Bounded by BOTH count and estimated retained JS bytes so six
// unusually large transcripts cannot pin the renderer heap indefinitely.
import { useCallback, useEffect, useRef } from "react";

import type { SessionSnapshot } from "../shared/contract";
import type { Snapshot } from "./desktop-types";
import type { DesktopSnapshotStore } from "./desktop-snapshot-store";
import { RendererLruCache } from "./renderer-lru-cache";

const SESSION_SNAPSHOT_CACHE_LIMIT = 6;
const SESSION_SNAPSHOT_CACHE_BYTE_LIMIT = 16 * 1024 * 1024;
const SNAPSHOT_BASE_BYTES = 1_024;
const MAX_ESTIMATE_DEPTH = 16;
const MAX_ESTIMATED_VALUE_BYTES = SESSION_SNAPSHOT_CACHE_BYTE_LIMIT + 1;
const valueByteEstimates = new WeakMap<object, number>();

function estimateValueBytes(value: unknown, seen: Set<object>, depth = 0): number {
  if (typeof value === "string") return value.length * 2 + 16;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "boolean") return 4;
  if (value == null || typeof value !== "object") return 0;
  const cached = valueByteEstimates.get(value);
  if (cached !== undefined) return cached;
  if (seen.has(value)) return 0;
  if (depth >= MAX_ESTIMATE_DEPTH) return 256;
  seen.add(value);
  let bytes = Array.isArray(value) ? 32 : 64;
  if (Array.isArray(value)) {
    for (const entry of value) {
      bytes += 8 + estimateValueBytes(entry, seen, depth + 1);
      if (bytes > MAX_ESTIMATED_VALUE_BYTES) break;
    }
  } else {
    for (const [key, entry] of Object.entries(value)) {
      bytes += key.length * 2 + 16 + estimateValueBytes(entry, seen, depth + 1);
      if (bytes > MAX_ESTIMATED_VALUE_BYTES) break;
    }
  }
  seen.delete(value);
  const bounded = Math.min(MAX_ESTIMATED_VALUE_BYTES, bytes);
  valueByteEstimates.set(value, bounded);
  return bounded;
}

export function estimateSessionSnapshotBytes(snapshot: Snapshot): number {
  return Math.min(
    MAX_ESTIMATED_VALUE_BYTES,
    SNAPSHOT_BASE_BYTES + estimateValueBytes(snapshot, new Set()),
  );
}

let snapshotCacheSequence = 0;

export interface SessionSnapshotCache {
  remember(snapshot: SessionSnapshot | Snapshot | null | undefined): void;
  get(sessionId: string): Snapshot | null;
  forget(sessionId: string): void;
  registerBudget(): void;
  dispose(): void;
}

export function createSessionSnapshotCache({
  maxEntries = SESSION_SNAPSHOT_CACHE_LIMIT,
  maxBytes = SESSION_SNAPSHOT_CACHE_BYTE_LIMIT,
  registerBudget = true,
}: {
  maxEntries?: number;
  maxBytes?: number;
  registerBudget?: boolean;
} = {}): SessionSnapshotCache {
  const entries = new RendererLruCache<string, Snapshot>({
    name: `session-snapshots-${++snapshotCacheSequence}`,
    maxEntries,
    maxChars: maxBytes / 2,
    measure: (snapshot) => estimateSessionSnapshotBytes(snapshot) / 2,
    register: registerBudget,
  });
  return {
    remember(next) {
      const value = next && typeof next === "object" ? next as Snapshot : null;
      if (!value) return;
      const sessionId = String(value.sessionId || "");
      if (!sessionId) return;
      // The live snapshot store already owns the current frame. Keeping a
      // second reference to an individually oversized transcript buys no safe
      // instant-resume benefit, so leave it uncached.
      entries.set(sessionId, value);
    },
    get(sessionId) {
      return entries.get(sessionId) || null;
    },
    forget(sessionId) {
      entries.delete(sessionId);
    },
    registerBudget() { entries.register(); },
    dispose() { entries.dispose(); },
  };
}

export function useSessionSnapshotCache(snapshotStore: DesktopSnapshotStore) {
  const cacheRef = useRef<SessionSnapshotCache | null>(null);
  cacheRef.current ||= createSessionSnapshotCache({ registerBudget: false });

  const rememberSessionSnapshot = useCallback((next: SessionSnapshot | Snapshot | null | undefined) => {
    cacheRef.current?.remember(next);
  }, []);

  const cachedSessionSnapshot = useCallback((sessionId: string): Snapshot | null => {
    return cacheRef.current?.get(sessionId) || null;
  }, []);

  // Every published snapshot updates the entry for its own session.
  useEffect(() => {
    const cache = cacheRef.current!;
    cache.registerBudget();
    const rememberCurrent = () => rememberSessionSnapshot(snapshotStore.getSnapshot());
    rememberCurrent();
    const unsubscribe = snapshotStore.subscribe(rememberCurrent);
    return () => {
      unsubscribe();
      cache.dispose();
    };
  }, [rememberSessionSnapshot, snapshotStore]);

  /** Deleting a session drops its cached frame so a reused id cannot resurrect
   *  the old transcript. */
  const forgetSessionSnapshot = useCallback((sessionId: string) => {
    cacheRef.current?.forget(sessionId);
  }, []);

  return { rememberSessionSnapshot, cachedSessionSnapshot, forgetSessionSnapshot };
}
