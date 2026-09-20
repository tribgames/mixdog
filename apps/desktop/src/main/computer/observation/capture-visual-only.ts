/**
 * The visual-only capability cache: windows whose accessibility tree keeps
 * failing or timing out are served from pixels/OCR for a while instead of
 * restarting the same stalled provider after every input.
 */
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';
import { createVisualOnlyCapabilityStore, shouldRecordVisualOnlyCapabilityMiss } from '../input/capability-policy';
import type { ComputerCommand } from '../shared/types';
import type { CaptureMode } from './capture-target';

const VISUAL_ONLY_CACHE_TTL_MS = 30_000;
const VISUAL_ONLY_CACHE_MISS_THRESHOLD = 2;
const VISUAL_ONLY_CACHE_MAX_ENTRIES = 128;

export function visualOnlyCapabilityKey(sessionId: string, windowId: string) {
  return `${sessionId}\u0000${windowId}`;
}

/** Only a plain state/som read of one window may be answered from the cache. */
export function visualOnlyEligible(command: ComputerCommand, mode: CaptureMode, windowId: string) {
  return Boolean(
    windowId &&
      (mode === 'state' || mode === 'som') &&
      !command.query &&
      !command.role &&
      !command.continuation &&
      command.include_noninteractive !== true &&
      command.include_structure !== true
  );
}

export function createVisualOnlyCache() {
  const store = createVisualOnlyCapabilityStore(VISUAL_ONLY_CACHE_MAX_ENTRIES);

  function resolve(key: string, eligible: boolean) {
    const { capability, cacheHit } = eligible
      ? store.resolve(key, Date.now())
      : { capability: undefined, cacheHit: false };
    const cachedAccessibilityError = cacheHit ? capability?.error || '' : '';
    return {
      capability,
      cacheHit,
      cachedAccessibilityError,
      retryAt: cachedAccessibilityError ? capability?.expiresAt || 0 : 0,
    };
  }

  /** Learn from a fresh (uncached) read; returns the retry deadline a timed-out
   *  provider now carries, or the one already known. */
  function record(
    key: string,
    resolved: ReturnType<typeof resolve>,
    {
      semanticAccessibilityAvailable,
      accessibilityError,
    }: { semanticAccessibilityAvailable: boolean; accessibilityError: string }
  ): number {
    if (semanticAccessibilityAvailable) {
      store.delete(key);
      return resolved.retryAt;
    }
    if (computerErrorCode(accessibilityError) === 'computer_command_timeout') {
      // Do not restart the same stalled provider after every input. Keep
      // its error visible while fresh pixels/OCR remain available.
      const retryAt = Date.now() + VISUAL_ONLY_CACHE_TTL_MS;
      store.remember(key, { misses: 0, expiresAt: retryAt, error: accessibilityError });
      return retryAt;
    }
    if (shouldRecordVisualOnlyCapabilityMiss(semanticAccessibilityAvailable, accessibilityError)) {
      const misses = (resolved.capability?.misses || 0) + 1;
      store.remember(key, {
        misses,
        expiresAt: misses >= VISUAL_ONLY_CACHE_MISS_THRESHOLD ? Date.now() + VISUAL_ONLY_CACHE_TTL_MS : 0,
      });
    }
    return resolved.retryAt;
  }

  return { resolve, record, releasePrefix: (prefix: string) => store.releasePrefix(prefix) };
}
