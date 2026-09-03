import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { t } from './i18n';
import {
  writeStudioAssetReferences,
  type StudioReferenceStore,
} from './studio-draft-cache';
import {
  callCapability,
  errorText,
  mediaTransportIsLocal,
  mediaUrl,
  mediaVariantKey,
  probeMediaLane,
  type MediaAsset,
  type MediaJob,
  type MediaKind,
  type StudioApi,
} from './studio-support';

const ASSET_PAGE_SIZE = 60;
const POLL_INTERVAL_MS = 1_500;

interface MediaAssetPage {
  assets: MediaAsset[];
  total: number;
}

interface MediaAssetPaging {
  initialized: boolean;
  loadingMore: boolean;
  nextOffset: number;
  total: number;
}

export interface StudioReference {
  base64: string;
  mime: string;
  url: string;
}

export interface QueuedMediaRequest {
  lane: string;
  kind: MediaKind;
  model: string;
  prompt: string;
  options: Record<string, unknown>;
  references: StudioReference[];
}

export type StudioMediaJob = MediaJob & {
  request?: QueuedMediaRequest;
};

function initialMediaAssetPaging(): Record<MediaKind, MediaAssetPaging> {
  return {
    image: { initialized: false, loadingMore: false, nextOffset: 0, total: 0 },
    video: { initialized: false, loadingMore: false, nextOffset: 0, total: 0 },
  };
}

function mergeMediaAssets(current: MediaAsset[], incoming: MediaAsset[]): MediaAsset[] {
  const byId = new Map(current.map((asset) => [asset.id, asset]));
  for (const asset of incoming) byId.set(asset.id, asset);
  return Array.from(byId.values()).sort((left, right) =>
    Number(right.createdAt || 0) - Number(left.createdAt || 0));
}

export function useStudioAssetGallery(api: StudioApi, kind: MediaKind) {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const visibleAssets = useMemo(
    () => assets.filter((asset) => asset.kind === kind),
    [assets, kind],
  );
  const pagingRef = useRef<Record<MediaKind, MediaAssetPaging>>(initialMediaAssetPaging());
  const pageRequests = useRef<Map<string, Promise<MediaAssetPage>>>(new Map());

  const requestAssetPage = useCallback((
    assetKind: MediaKind,
    offset: number,
  ): Promise<MediaAssetPage> => {
    const key = `${assetKind}:${offset}`;
    const existing = pageRequests.current.get(key);
    if (existing) return existing;
    const request = (async () => {
      const result = await callCapability(api, 'listMediaAssets', [{
        kind: assetKind,
        limit: ASSET_PAGE_SIZE,
        offset,
      }]) as { assets?: MediaAsset[]; total?: number } | undefined;
      const rows = Array.isArray(result?.assets) ? result.assets : [];
      const reportedTotal = Number(result?.total);
      return {
        assets: rows,
        total: Number.isFinite(reportedTotal) && reportedTotal >= 0
          ? Math.max(offset + rows.length, Math.trunc(reportedTotal))
          : offset + rows.length,
      };
    })();
    pageRequests.current.set(key, request);
    const cleanup = () => {
      if (pageRequests.current.get(key) === request) {
        pageRequests.current.delete(key);
      }
    };
    void request.then(cleanup, cleanup);
    return request;
  }, [api]);

  const refreshAssetKind = useCallback(async (assetKind: MediaKind): Promise<MediaAsset[]> => {
    const page = await requestAssetPage(assetKind, 0);
    const paging = pagingRef.current[assetKind];
    setAssets((current) => mergeMediaAssets(
      !paging.initialized || page.total === 0
        ? current.filter((asset) => asset.kind !== assetKind)
        : current,
      page.assets,
    ));
    const nextOffset = paging.initialized
      ? Math.min(page.total, Math.max(paging.nextOffset, page.assets.length))
      : Math.min(page.total, page.assets.length);
    pagingRef.current = {
      ...pagingRef.current,
      [assetKind]: {
        initialized: true,
        loadingMore: false,
        nextOffset,
        total: page.total,
      },
    };
    return page.assets;
  }, [requestAssetPage]);

  const loadMoreAssets = useCallback(async (assetKind: MediaKind): Promise<MediaAsset[]> => {
    const paging = pagingRef.current[assetKind];
    if (!paging.initialized) return refreshAssetKind(assetKind);
    if (paging.loadingMore || paging.nextOffset >= paging.total) return [];
    const offset = paging.nextOffset;
    pagingRef.current = {
      ...pagingRef.current,
      [assetKind]: { ...paging, loadingMore: true },
    };
    try {
      const page = await requestAssetPage(assetKind, offset);
      setAssets((current) => mergeMediaAssets(current, page.assets));
      const latest = pagingRef.current[assetKind];
      const consumedOffset = page.assets.length ? offset + page.assets.length : page.total;
      pagingRef.current = {
        ...pagingRef.current,
        [assetKind]: {
          initialized: true,
          loadingMore: false,
          nextOffset: Math.min(page.total, Math.max(latest.nextOffset, consumedOffset)),
          total: page.total,
        },
      };
      return page.assets;
    } catch (reason) {
      pagingRef.current = {
        ...pagingRef.current,
        [assetKind]: {
          ...pagingRef.current[assetKind],
          loadingMore: false,
        },
      };
      throw reason;
    }
  }, [refreshAssetKind, requestAssetPage]);

  const removeAsset = useCallback((asset: MediaAsset): void => {
    setAssets((current) => current.filter((entry) => entry.id !== asset.id));
    const paging = pagingRef.current[asset.kind];
    pagingRef.current = {
      ...pagingRef.current,
      [asset.kind]: {
        ...paging,
        nextOffset: Math.max(0, paging.nextOffset - 1),
        total: Math.max(0, paging.total - 1),
      },
    };
  }, []);

  return {
    assets,
    loadMoreAssets,
    removeAsset,
    refreshAssetKind,
    visibleAssets,
  };
}

export function useStudioMediaUrls(api: StudioApi, active: boolean) {
  const localTransport = useMemo(() => mediaTransportIsLocal(), []);
  const [laneReady, setLaneReady] = useState<boolean | null>(localTransport ? true : null);
  const [urlBroken, setUrlBroken] = useState<Record<string, boolean>>({});
  const urlBrokenRef = useRef<Record<string, boolean>>({});
  const failCounts = useRef<Record<string, number>>({});
  const probing = useRef(false);

  const assetUrl = useCallback((assetId: string, variant: string): string => (
    laneReady === true && !urlBroken[mediaVariantKey(assetId, variant)]
      ? mediaUrl(api, assetId, variant) : ''
  ), [api, laneReady, urlBroken]);

  const markUrlBroken = useCallback((assetId: string, variant: string): void => {
    const key = mediaVariantKey(assetId, variant);
    failCounts.current[key] = (failCounts.current[key] || 0) + 1;
    if (!urlBrokenRef.current[key]) {
      urlBrokenRef.current = { ...urlBrokenRef.current, [key]: true };
      setUrlBroken(urlBrokenRef.current);
    }
    if (localTransport || probing.current) return;
    probing.current = true;
    void probeMediaLane(api).then((ok) => {
      probing.current = false;
      if (!ok) {
        setLaneReady(false);
        return;
      }
      const retry = Object.keys(urlBrokenRef.current)
        .filter((failedKey) => (failCounts.current[failedKey] || 0) < 2);
      if (!retry.length) return;
      const next = { ...urlBrokenRef.current };
      for (const failedKey of retry) delete next[failedKey];
      urlBrokenRef.current = next;
      setUrlBroken(next);
    });
  }, [api, localTransport]);

  useEffect(() => {
    if (!active || localTransport) return undefined;
    let stopped = false;
    void probeMediaLane(api)
      .then((ok) => {
        if (stopped) return;
        setLaneReady(ok);
        if (!ok || !Object.keys(urlBrokenRef.current).length) return;
        failCounts.current = {};
        urlBrokenRef.current = {};
        setUrlBroken({});
      })
      .catch(() => {
        if (!stopped) setLaneReady(false);
      });
    return () => { stopped = true; };
  }, [active, api, localTransport]);

  return { assetUrl, laneReady, localTransport, markUrlBroken };
}

export function useStudioMediaJobs({
  active,
  api,
  assets,
  referenceStore,
  refreshAssetKind,
  setError,
}: {
  active: boolean;
  api: StudioApi;
  assets: MediaAsset[];
  referenceStore?: StudioReferenceStore;
  refreshAssetKind: (kind: MediaKind) => Promise<MediaAsset[]>;
  setError: Dispatch<SetStateAction<string>>;
}) {
  const [jobs, setJobs] = useState<StudioMediaJob[]>([]);
  const jobsRef = useRef<StudioMediaJob[]>([]);
  jobsRef.current = jobs;
  const runningKey = jobs.filter((entry) => entry.status === 'running').map((entry) => entry.id).join(',');

  useEffect(() => {
    if (!active || !runningKey) return undefined;
    const ids = runningKey.split(',');
    let stopped = false;
    const misses = new Map<string, number>();
    const poll = () => {
      void (async () => {
        try {
          const polled = await Promise.all(ids.map((id) =>
            callCapability(api, 'getMediaJob', [id]) as Promise<MediaJob | null>));
          if (stopped) return;
          const landed = polled.filter(Boolean) as MediaJob[];
          for (const entry of landed) misses.delete(entry.id);
          const lost = ids.filter((id, index) => {
            if (polled[index]) return false;
            const count = (misses.get(id) || 0) + 1;
            misses.set(id, count);
            return count >= 2;
          });
          if (!landed.length && !lost.length) return;
          const completed = landed.filter((entry) => entry.status === 'done');
          if (completed.length) {
            const landedKinds = Array.from(new Set(completed.map((entry) => entry.kind)));
            const referenceWrites = completed.map((entry) => {
              const queued = jobsRef.current.find((candidate) => candidate.id === entry.id);
              return entry.assetId
                ? writeStudioAssetReferences(
                  entry.assetId,
                  queued?.request?.references || [],
                  referenceStore,
                )
                : Promise.resolve();
            });
            await Promise.all([
              ...landedKinds.map((assetKind) => refreshAssetKind(assetKind)),
              ...referenceWrites,
            ]);
            if (stopped) return;
          }
          setJobs((current) => current.map((entry) => {
            const next = landed.find((candidate) => candidate.id === entry.id);
            if (next) return { ...entry, ...next };
            if (entry.status !== 'running' || !lost.includes(entry.id)) return entry;
            return {
              ...entry,
              status: 'failed' as const,
              error: t('Lost track of this run — the runtime restarted.'),
            };
          }));
        } catch (reason) {
          if (!stopped) setError(errorText(reason));
        }
      })();
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, api, referenceStore, refreshAssetKind, runningKey, setError]);

  useEffect(() => {
    setJobs((current) => {
      const next = current.filter((entry) => entry.status !== 'done'
        || Boolean(entry.assetId && !assets.some((asset) => asset.id === entry.assetId)));
      return next.length === current.length ? current : next;
    });
  }, [assets]);

  return { jobs, runningKey, setJobs };
}
