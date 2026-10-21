// The Studio pane's status over time (StudioView.tsx): the heartbeat while a
// job runs, and the one ready report once its surface is settled.
import { useEffect, useState } from 'react';
import { reportStudioLoadStage } from './renderer-load-metrics';
import type { MediaKind, MediaLane, modelControls, StudioOptions } from './studio-support';

/** The pending tiles print an elapsed clock, so the pane needs a heartbeat
 *  while a job runs (polling alone updates it only every 1.5s, which read as
 *  a stalled timer). */
export function useStudioJobClock(active: boolean, generating: boolean): void {
  const [, setProgressTick] = useState(0);
  useEffect(() => {
    if (!active || !generating) return undefined;
    const timer = window.setInterval(() => setProgressTick((value) => value + 1), 500);
    return () => window.clearInterval(timer);
  }, [active, generating]);
}

/** The pane reports ready once its surface is settled: the grid geometry, the
 *  gallery and catalog answers, and the kind, route and options the composer
 *  paints. Thumbnail bytes are tile-local decoration: a cold, large, or broken
 *  first asset must not hold the opaque Studio cover over a usable pane. */
export function useStudioReadyReport({
  active,
  gridMotionReady,
  gallerySettled,
  catalogSettled,
  kindsOffered,
  kind,
  lane,
  laneId,
  model,
  activeModel,
  controls,
  options,
  bootMetricToken,
  onReady,
}: {
  active: boolean;
  gridMotionReady: boolean;
  gallerySettled: boolean;
  catalogSettled: boolean;
  kindsOffered: readonly MediaKind[];
  kind: MediaKind;
  lane: MediaLane | null;
  laneId: string;
  model: string;
  activeModel: string;
  controls: ReturnType<typeof modelControls>;
  options: StudioOptions;
  bootMetricToken: number;
  /** Read when ready (a ref: the caller's callback changes every render). */
  onReady: { current?: () => void };
}): void {
  const kindSettled = kindsOffered.length === 0 || kindsOffered.includes(kind);
  const routeSettled = !lane || (lane.id === laneId && model === activeModel);
  const optionsSettled =
    (!controls.resolution?.length || controls.resolution.includes(options.resolution)) &&
    (!controls.aspectRatio?.length || controls.aspectRatio.includes(options.aspectRatio));
  const studioSurfaceReady =
    active && gridMotionReady && gallerySettled && catalogSettled && kindSettled && routeSettled && optionsSettled;
  // biome-ignore lint/correctness/useExhaustiveDependencies: onReady is a ref
  useEffect(() => {
    if (!studioSurfaceReady) return;
    reportStudioLoadStage('shell', '', false, bootMetricToken);
    reportStudioLoadStage('interactive', '', true, bootMetricToken);
    onReady.current?.();
  }, [bootMetricToken, studioSurfaceReady]);
}
