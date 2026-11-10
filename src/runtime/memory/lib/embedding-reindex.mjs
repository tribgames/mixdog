import { throwIfAborted } from './memory-cycle-shared.mjs';

const DEFAULT_PASS_PAUSE_MS = 1_000;

function waitForNextPass(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function drainEmbeddingReindex({
  flushEntries,
  signal,
  pauseMs = DEFAULT_PASS_PAUSE_MS,
  wait = waitForNextPass,
} = {}) {
  if (typeof flushEntries !== 'function') {
    throw new TypeError('drainEmbeddingReindex: flushEntries required');
  }
  let passes = 0;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  while (true) {
    throwIfAborted(signal);
    const result = await flushEntries({ signal });
    throwIfAborted(signal);
    passes += 1;
    attempted += Number(result?.attempted ?? 0);
    succeeded += Number(result?.succeeded ?? 0);
    failed += Array.isArray(result?.failed) ? result.failed.length : 0;
    if (result?.timedOut !== true || Number(result?.succeeded ?? 0) <= 0) break;
    await wait(pauseMs, signal);
  }

  return { passes, attempted, succeeded, failed };
}

// The root-text sweep replaces vectors that still work, so it has no urgency:
// small steps with long rests keep a ~62k-root backfill in the background of a
// working session instead of competing with it.
const ROOT_SWEEP_PAUSE_MS = 4_000;

export async function runRootEmbedSweep({
  sweepStep,
  signal,
  pauseMs = ROOT_SWEEP_PAUSE_MS,
  wait = waitForNextPass,
} = {}) {
  if (typeof sweepStep !== 'function') {
    throw new TypeError('runRootEmbedSweep: sweepStep required');
  }
  let steps = 0;
  let replaced = 0;
  while (true) {
    throwIfAborted(signal);
    const result = await sweepStep({ signal });
    steps += 1;
    replaced += Number(result?.replaced ?? 0);
    if (result?.done) break;
    await wait(pauseMs, signal);
  }
  return { steps, replaced };
}
