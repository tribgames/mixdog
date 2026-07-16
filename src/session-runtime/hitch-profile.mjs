import { monitorEventLoopDelay } from 'node:perf_hooks';
import { envFlag } from './env.mjs';

const HITCH_PROFILE_ENABLED = envFlag('MIXDOG_HITCH_PROFILE');

function positiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// The histogram and sampling timer are never constructed unless explicitly
// enabled, leaving the normal runtime with no event-loop profiling work.
export function installHitchProfiler() {
  if (!HITCH_PROFILE_ENABLED) return null;

  const thresholdMs = positiveNumberEnv('MIXDOG_HITCH_THRESHOLD_MS', 100);
  const resolutionMs = Math.max(1, Math.min(100, positiveNumberEnv('MIXDOG_HITCH_RESOLUTION_MS', 20)));
  const sampleMs = Math.max(resolutionMs * 2, positiveNumberEnv('MIXDOG_HITCH_SAMPLE_MS', 100));
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  let lastSampleAt = performance.now();

  const timer = setInterval(() => {
    const now = performance.now();
    // Histogram max is the primary signal. Timer drift covers a stall ending
    // in the same timers phase before the histogram's internal sampler runs.
    const delayMs = Math.max(histogram.max / 1e6, now - lastSampleAt - sampleMs);
    lastSampleAt = now;
    histogram.reset();
    if (delayMs < thresholdMs) return;
    try {
      process.stderr.write(
        `[mixdog-hitch] timestamp=${new Date().toISOString()} delayMs=${delayMs.toFixed(1)} thresholdMs=${thresholdMs}\n`,
      );
    } catch {}
  }, sampleMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}

installHitchProfiler();
