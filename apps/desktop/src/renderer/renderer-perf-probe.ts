// The opt-in renderer performance probe (shared/renderer-probe.ts). Off, it is
// one flag read through main at start and every 30 s; on, it observes long
// frames and writes a summary every 10 s.
import type { DesktopApi } from '../shared/contract';
import type { DesktopRendererProbeApi, DesktopRendererProbeScript } from '../shared/renderer-probe';

const FLAG_RECHECK_MS = 30_000;
const SUMMARY_MS = 10_000;
const LONG_FRAME_MS = 50;

/** The Long Animation Frames fields read here (not yet in TypeScript's DOM lib). */
interface LongFrameEntry extends PerformanceEntry {
  blockingDuration?: number;
  styleAndLayoutStart?: number;
  scripts?: ReadonlyArray<Partial<DesktopRendererProbeScript>>;
}

function recordLongFrames(probe: DesktopRendererProbeApi): () => void {
  const entryType = PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')
    ? 'long-animation-frame'
    : 'longtask';
  let frames = 0;
  let longFrames = 0;
  let blockedMs = 0;
  let windowStart = performance.now();
  probe.countIpc(true);
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as LongFrameEntry[]) {
      if (entry.duration <= LONG_FRAME_MS) continue;
      const blockingDuration = entry.blockingDuration ?? entry.duration - LONG_FRAME_MS;
      longFrames += 1;
      blockedMs += blockingDuration;
      probe.write({
        kind: 'frame',
        entryType,
        duration: entry.duration,
        blockingDuration,
        styleAndLayoutDuration: entry.styleAndLayoutStart
          ? entry.startTime + entry.duration - entry.styleAndLayoutStart
          : 0,
        scripts: (entry.scripts ?? []).map((script) => ({
          invoker: String(script.invoker ?? ''),
          invokerType: String(script.invokerType ?? ''),
          sourceURL: String(script.sourceURL ?? ''),
          sourceFunctionName: String(script.sourceFunctionName ?? ''),
          sourceCharPosition: Number(script.sourceCharPosition ?? -1),
          duration: Number(script.duration ?? 0),
          forcedStyleAndLayoutDuration: Number(script.forcedStyleAndLayoutDuration ?? 0),
        })),
      });
    }
  });
  observer.observe({ type: entryType });
  // Asking for every frame makes `frames` the delivered frame rate; it costs a
  // callback per frame only while the probe is on.
  let frameRequest = 0;
  const countFrame = (): void => {
    frames += 1;
    frameRequest = window.requestAnimationFrame(countFrame);
  };
  frameRequest = window.requestAnimationFrame(countFrame);
  const summaryTimer = window.setInterval(() => {
    const now = performance.now();
    probe.write({
      kind: 'summary',
      windowMs: now - windowStart,
      frames,
      longFrames,
      blockedMs,
      ipc: probe.takeIpcCounts(),
    });
    windowStart = now;
    frames = 0;
    longFrames = 0;
    blockedMs = 0;
  }, SUMMARY_MS);
  return () => {
    observer.disconnect();
    window.cancelAnimationFrame(frameRequest);
    window.clearInterval(summaryTimer);
    probe.countIpc(false);
  };
}

/** Starts or stops recording as the flag file comes and goes; returns the teardown. */
export function installRendererPerfProbe(host: DesktopApi | undefined = window.mixdogDesktop): () => void {
  const probe = host?.rendererProbe;
  if (!probe || typeof PerformanceObserver !== 'function') return () => {};
  let stopRecording: (() => void) | null = null;
  let removed = false;
  const check = (): void => {
    void probe.enabled().then((on) => {
      if (removed || on === (stopRecording !== null)) return;
      if (on) stopRecording = recordLongFrames(probe);
      else {
        stopRecording?.();
        stopRecording = null;
      }
    });
  };
  check();
  const flagTimer = window.setInterval(check, FLAG_RECHECK_MS);
  return () => {
    removed = true;
    window.clearInterval(flagTimer);
    stopRecording?.();
    stopRecording = null;
  };
}
