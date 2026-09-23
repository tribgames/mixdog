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
/** Consecutive timeouts double the wait up to this ceiling: a window that
 *  stalls the provider over and over should not cost a full timeout every
 *  half minute. An explicit mode="ax" read never consults this cache, so the
 *  caller keeps a way to ask the provider again immediately. */
const VISUAL_ONLY_TIMEOUT_MAX_TTL_MS = 120_000;
const VISUAL_ONLY_CACHE_MISS_THRESHOLD = 2;
const VISUAL_ONLY_CACHE_MAX_ENTRIES = 128;

export function visualOnlyCapabilityKey(sessionId: string, windowId: string) {
  return `${sessionId}\u0000${windowId}`;
}

/** Only a plain read of one window may be answered from the cache. An explicit
 *  mode="ax" capture always asks the provider again, but the observation that
 *  follows an action takes the cached answer instead of spending the whole
 *  timeout and returning nothing. */
export function visualOnlyEligible(command: ComputerCommand, mode: CaptureMode, windowId: string) {
  return Boolean(
    windowId &&
      (mode === 'state' || mode === 'som' || (mode === 'ax' && command.observation_after === true)) &&
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
      actionableElements = 0,
    }: { semanticAccessibilityAvailable: boolean; accessibilityError: string; actionableElements?: number }
  ): number {
    if (semanticAccessibilityAvailable) {
      store.delete(key);
      return resolved.retryAt;
    }
    const timedOutBefore = Boolean(resolved.capability?.error);
    if (computerErrorCode(accessibilityError) === 'computer_command_timeout') {
      // Do not restart the same stalled provider after every input. Keep
      // its error visible while fresh pixels/OCR remain available.
      const timeouts = (timedOutBefore ? resolved.capability?.misses || 0 : 0) + 1;
      const retryAt =
        Date.now() +
        Math.min(VISUAL_ONLY_TIMEOUT_MAX_TTL_MS, VISUAL_ONLY_CACHE_TTL_MS * 2 ** Math.min(timeouts - 1, 8));
      store.remember(key, { misses: timeouts, expiresAt: retryAt, error: accessibilityError });
      return retryAt;
    }
    if (shouldRecordVisualOnlyCapabilityMiss(semanticAccessibilityAvailable, accessibilityError, actionableElements)) {
      // A timeout count never becomes an empty-tree count.
      const misses = (timedOutBefore ? 0 : resolved.capability?.misses || 0) + 1;
      store.remember(key, {
        misses,
        expiresAt: misses >= VISUAL_ONLY_CACHE_MISS_THRESHOLD ? Date.now() + VISUAL_ONLY_CACHE_TTL_MS : 0,
      });
    }
    return resolved.retryAt;
  }

  return { resolve, record, releasePrefix: (prefix: string) => store.releasePrefix(prefix) };
}
