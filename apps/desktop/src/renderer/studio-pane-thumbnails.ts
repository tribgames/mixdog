// The Studio gallery's thumbnails (StudioView.tsx): the landed thumbnails,
// failures, renderer fallbacks, video durations and frame ratios, and the
// hydration loop that fills them for the visible tiles.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { useStudioMediaUrls } from './studio-media-state';
import { useStudioThumbRatios } from './studio-pane-persisted';
import { startStudioThumbnailHydration } from './studio-pane-support';
import type { MediaAsset, posterFromVideo, StudioApi } from './studio-support';

type StudioMediaUrls = ReturnType<typeof useStudioMediaUrls>;

export function useStudioThumbnailState() {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [failedThumbs, setFailedThumbs] = useState<Record<string, boolean>>({});
  const failedThumbsRef = useRef<Record<string, boolean>>({});
  // A cold local rendition may take longer than the tile's stall threshold.
  // Start the renderer fallback without invalidating the still-live direct
  // request: dropping that URL produced an empty frame until fallback landed.
  const [thumbFallbacks, setThumbFallbacks] = useState<Record<string, true>>({});
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [ratios, rememberRatio] = useStudioThumbRatios();
  // Mirror of the thumbnail cache: the hydration loop reads it without taking
  // a state dependency, so a landed thumbnail never restarts the loop.
  const thumbsRef = useRef<Record<string, string>>({});
  const loadedThumbsRef = useRef<Record<string, boolean>>({});
  /** A thumbnail failure is terminal for ONE pass, not for the pane: a cold
   *  rendition that timed out once otherwise left a permanent glyph until the
   *  whole app restarted (user: 섬네일이 안 나온다). Entering Studio again, or
   *  pressing Retry, starts those tiles over. */
  const reset = useCallback(() => {
    failedThumbsRef.current = {};
    setFailedThumbs({});
    setThumbFallbacks({});
  }, []);
  return {
    thumbs,
    failedThumbs,
    durations,
    ratios,
    reset,
    /** A tile's thumbnail decoded: its frame ratio is now known. */
    onLoad(asset: MediaAsset) {
      loadedThumbsRef.current[asset.id] = true;
      rememberRatio(asset);
    },
    /** A tile's direct thumbnail stalled: start the renderer fallback beside it. */
    onStall(assetId: string) {
      setThumbFallbacks((current) => (current[assetId] ? current : { ...current, [assetId]: true }));
    },
    hydration: {
      failedThumbsRef,
      loadedThumbsRef,
      thumbsRef,
      thumbFallbacks,
      setDurations,
      setFailedThumbs,
      setThumbs,
    },
  };
}

/** The hydration loop over the visible tiles, once the media lane is known.
 *  Reading the cache through a ref keeps it from restarting on every landed
 *  thumbnail (each restart re-rendered the whole grid). */
export function useStudioThumbnailHydration({
  state,
  active,
  api,
  assetUrl,
  captureVideoPoster,
  laneReady,
  localTransport,
  visibleAssets,
}: {
  state: ReturnType<typeof useStudioThumbnailState>['hydration'];
  active: boolean;
  api: StudioApi;
  assetUrl: StudioMediaUrls['assetUrl'];
  captureVideoPoster: typeof posterFromVideo;
  laneReady: StudioMediaUrls['laneReady'];
  localTransport: StudioMediaUrls['localTransport'];
  visibleAssets: MediaAsset[];
}): void {
  const { thumbFallbacks } = state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs and setters in `state` are stable; the fallbacks restart the loop
  useEffect(() => {
    if (!active || laneReady === null) return undefined;
    return startStudioThumbnailHydration({
      api,
      assetUrl,
      captureVideoPoster,
      localTransport,
      visibleAssets,
      ...state,
    });
  }, [active, api, assetUrl, captureVideoPoster, laneReady, localTransport, thumbFallbacks, visibleAssets]);
}
