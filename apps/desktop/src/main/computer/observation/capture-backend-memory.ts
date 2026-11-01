/**
 * Which backend last produced an accepted frame of a window in a session. The
 * next capture of that window tries it first; it still faces every frame
 * check, and any failure forgets it so the full order runs again. A window
 * handle can be reused by a new window, so an entry also expires.
 */
import { evictOldest } from '../shared/common';
import type { CaptureBackend } from '../shared/capture-attempts';

export const CAPTURE_BACKEND_MEMORY_TTL_MS = 120_000;

export function captureBackendKey(sessionId: string, windowId: string): string {
  return windowId ? `${sessionId}\u0000${windowId}` : '';
}

export function createCaptureBackendMemory(maxEntries = 64, ttlMs = CAPTURE_BACKEND_MEMORY_TTL_MS, now = Date.now) {
  const winners = new Map<string, { backend: CaptureBackend; at: number }>();
  return {
    recall(key: string): CaptureBackend | undefined {
      const winner = winners.get(key);
      if (!winner) return undefined;
      if (now() - winner.at > ttlMs) {
        winners.delete(key);
        return undefined;
      }
      return winner.backend;
    },
    remember(key: string, backend: CaptureBackend): void {
      if (!key) return;
      winners.delete(key);
      winners.set(key, { backend, at: now() });
      evictOldest(winners, maxEntries);
    },
    forget(key: string): void {
      winners.delete(key);
    },
    releasePrefix(prefix: string): void {
      for (const key of winners.keys()) {
        if (key.startsWith(prefix)) winners.delete(key);
      }
    },
  };
}

export type CaptureBackendMemory = ReturnType<typeof createCaptureBackendMemory>;
