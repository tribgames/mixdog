// The Studio pane's (StudioView.tsx) provider lanes: the lane catalog, the
// pane's load (gallery and catalog, each committing on arrival), and which
// kind, lane and model the composer runs on.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { reportStudioLoadStage } from './renderer-load-metrics';
import type { MediaAsset } from './studio-support';
import {
  errorText,
  laneSpec,
  listMediaLanes,
  MEDIA_CATALOG_POLL_MS,
  MEDIA_KINDS,
  type MediaKind,
  type MediaLane,
  resolveStudioModel,
  type StudioApi,
} from './studio-support';

/** The lanes' catalog failures as one pane error ('' when none failed). */
function catalogErrorsText(lanes: readonly MediaLane[]): string {
  return lanes
    .map((lane) => lane.catalogError)
    .filter(Boolean)
    .join('\n');
}

/** The provider lanes. Bounded listing: a gateway catalog that takes most of
 *  a minute (NanoGPT) answers `catalogPending` instead of holding the whole
 *  pane behind it, and a pending catalog is asked again until it lands or
 *  fails; each ask joins the runtime's in-flight request rather than starting
 *  a new one. `loadLanes` throws the catalogs' failures. */
export function useStudioLaneCatalog(api: StudioApi, active: boolean, setError: (error: string) => void) {
  const [lanes, setLanes] = useState<MediaLane[]>([]);
  const loadLanes = useCallback(async () => {
    const next = await listMediaLanes(api);
    setLanes(next);
    const errors = catalogErrorsText(next);
    if (errors) throw new Error(errors);
  }, [api]);
  const catalogPending = lanes.some((entry) => entry.catalogPending);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every new lane list re-arms the poll while a catalog is still pending
  useEffect(() => {
    if (!active || !catalogPending) return undefined;
    const timer = window.setTimeout(() => {
      void loadLanes().catch((reason) => setError(errorText(reason)));
    }, MEDIA_CATALOG_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [active, catalogPending, lanes, loadLanes]);
  return { lanes, loadLanes, catalogErrorText: catalogErrorsText(lanes) };
}

/** The pane's load on every entry (and Retry): the gallery must not wait on
 *  the lane catalog — provider auth checks are the slow leg of this pane, and
 *  the tiles used to paint only after they answered (user: 들어가면 섬네일이
 *  늦게 나온다) — so each half commits on arrival. */
export function useStudioLoad({
  active,
  refreshAssetKind,
  loadLanes,
  resetThumbnails,
  setError,
  ensureMetricToken,
}: {
  active: boolean;
  refreshAssetKind(kind: MediaKind): Promise<MediaAsset[]>;
  loadLanes(): Promise<void>;
  /** A thumbnail failure is terminal for one pass, not for the pane. */
  resetThumbnails(): void;
  setError(error: string): void;
  ensureMetricToken(): number;
}) {
  const [loading, setLoading] = useState(true);
  const [gallerySettled, setGallerySettled] = useState(false);
  const [catalogSettled, setCatalogSettled] = useState(false);
  const load = useCallback(
    async (metricToken?: number) => {
      resetThumbnails();
      const gallery = Promise.all(MEDIA_KINDS.map((assetKind) => refreshAssetKind(assetKind)))
        .then((pages) => {
          const count = pages.reduce((total, rows) => total + rows.length, 0);
          reportStudioLoadStage('assets', `count=${count}`, false, metricToken);
        })
        .finally(() => setGallerySettled(true));
      const catalog = loadLanes().finally(() => setCatalogSettled(true));
      const settled = await Promise.allSettled([gallery, catalog]);
      const failed = settled.find((result) => result.status === 'rejected');
      setError(failed ? errorText((failed as PromiseRejectedResult).reason) : '');
      setLoading(false);
    },
    [loadLanes, refreshAssetKind, resetThumbnails, setError]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the metric token is taken per entry, not a dependency
  useEffect(() => {
    if (active) {
      const metricToken = ensureMetricToken();
      void load(metricToken);
    }
  }, [active, load]);
  return {
    loading,
    gallerySettled,
    catalogSettled,
    retry() {
      setLoading(true);
      void load();
    },
  };
}

/** The lanes the active kind can use, the kinds any signed-in lane offers (a
 *  kind no lane offers falls back to one that is), the chosen lane, and the
 *  model resolved against that lane's contract now — kind changes render
 *  before the route sync runs, so the previous kind's label never paints. */
export function useStudioLaneChoice({
  lanes,
  kind,
  setKind,
  laneId,
  model,
}: {
  lanes: readonly MediaLane[];
  kind: MediaKind;
  setKind(kind: MediaKind): void;
  laneId: string;
  model: string;
}) {
  const available = useMemo(
    () => lanes.filter((lane) => lane.authenticated && lane.kinds.includes(kind)),
    [lanes, kind]
  );
  // Which kinds have ANY authenticated lane: the toggle only offers what the
  // signed-in providers can actually produce (and hides entirely for one).
  const kindsOffered = useMemo(
    () => MEDIA_KINDS.filter((entry) => lanes.some((lane) => lane.authenticated && lane.kinds.includes(entry))),
    [lanes]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: setKind is a state setter
  useEffect(() => {
    if (kindsOffered.length && !kindsOffered.includes(kind)) setKind(kindsOffered[0]);
  }, [kindsOffered, kind]);
  const lane = useMemo(
    () => available.find((entry) => entry.id === laneId) || available[0] || null,
    [available, laneId]
  );
  const spec = laneSpec(lane, kind);
  return { available, kindsOffered, lane, spec, activeModel: resolveStudioModel(spec, model) };
}
