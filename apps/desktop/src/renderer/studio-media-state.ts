import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { t } from './i18n';
import { sectionStoreFor } from './section-store';
import { writeStudioAssetReferences, type StudioReferenceStore } from './studio-draft-cache';
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
/** Pages an external-change sync reads looking for the loaded set. */
const SYNC_PAGE_LIMIT = 5;
/** Node's job-status cadence: the gap between a first null read and the second that marks a job lost. */
const MEDIA_RECHECK_MS = 1_500;
const MEDIA_KIND_LIST: readonly MediaKind[] = ['image', 'video'];

interface MediaAssetPage {
  /** The board the page was read for ('' = all). */
  board: string;
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
  /** The board the result joins ('' = none); unset takes the open board. */
  boardId?: string;
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
  return Array.from(byId.values()).sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
}

/** The gallery's pages: every result, or only board `boardId`'s ('' = all).
 *  Switching boards drops what was loaded; a page still in flight for the
 *  previous board is discarded when it lands. */
export function useStudioAssetGallery(api: StudioApi, kind: MediaKind, boardId = '') {
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const visibleAssets = useMemo(() => assets.filter((asset) => asset.kind === kind), [assets, kind]);
  const pagingRef = useRef<Record<MediaKind, MediaAssetPaging>>(initialMediaAssetPaging());
  const pageRequests = useRef<Map<string, Promise<MediaAssetPage>>>(new Map());
  const boardRef = useRef(boardId);
  if (boardRef.current !== boardId) {
    boardRef.current = boardId;
    pagingRef.current = initialMediaAssetPaging();
    pageRequests.current = new Map();
  }
  const [shownBoard, setShownBoard] = useState(boardId);
  if (shownBoard !== boardId) {
    setShownBoard(boardId);
    setAssets([]);
  }

  const requestAssetPage = useCallback(
    (assetKind: MediaKind, offset: number): Promise<MediaAssetPage> => {
      const board = boardRef.current;
      const key = `${board}:${assetKind}:${offset}`;
      const existing = pageRequests.current.get(key);
      if (existing) return existing;
      const requests = pageRequests.current;
      const request = (async () => {
        const result = (await callCapability(api, 'listMediaAssets', [
          {
            kind: assetKind,
            limit: ASSET_PAGE_SIZE,
            offset,
            ...(board ? { boardId: board } : {}),
          },
        ])) as { assets?: MediaAsset[]; total?: number } | undefined;
        const rows = Array.isArray(result?.assets) ? result.assets : [];
        const reportedTotal = Number(result?.total);
        return {
          board,
          assets: rows,
          total:
            Number.isFinite(reportedTotal) && reportedTotal >= 0
              ? Math.max(offset + rows.length, Math.trunc(reportedTotal))
              : offset + rows.length,
        };
      })();
      requests.set(key, request);
      const cleanup = () => {
        if (requests.get(key) === request) {
          requests.delete(key);
        }
      };
      void request.then(cleanup, cleanup);
      return request;
    },
    [api]
  );

  const refreshAssetKind = useCallback(
    async (assetKind: MediaKind): Promise<MediaAsset[]> => {
      const page = await requestAssetPage(assetKind, 0);
      if (page.board !== boardRef.current) return [];
      const paging = pagingRef.current[assetKind];
      setAssets((current) =>
        mergeMediaAssets(
          !paging.initialized || page.total === 0 ? current.filter((asset) => asset.kind !== assetKind) : current,
          page.assets
        )
      );
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
    },
    [requestAssetPage]
  );

  const loadMoreAssets = useCallback(
    async (assetKind: MediaKind): Promise<MediaAsset[]> => {
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
        if (page.board !== boardRef.current) return [];
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
    },
    [refreshAssetKind, requestAssetPage]
  );

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

  /** After a bulk delete the loaded pages no longer line up with the store's
   *  offsets, so the kind restarts from its first page. */
  const reloadAssetKind = useCallback(
    (assetKind: MediaKind, removedIds: readonly string[]): Promise<MediaAsset[]> => {
      const gone = new Set(removedIds);
      setAssets((current) => current.filter((asset) => !gone.has(asset.id)));
      pagingRef.current = { ...pagingRef.current, [assetKind]: initialMediaAssetPaging()[assetKind] };
      for (const key of pageRequests.current.keys()) {
        if (key.startsWith(`${boardRef.current}:${assetKind}:`)) pageRequests.current.delete(key);
      }
      return refreshAssetKind(assetKind);
    },
    [refreshAssetKind]
  );

  /** Results moved to `boardId`: a board view drops the ones that left it
   *  (and reloads to pick up arrivals); "전체" just records the new board. */
  const moveAssets = useCallback(
    (ids: readonly string[], boardId: string): void => {
      const board = boardRef.current;
      const moved = new Set(ids);
      if (!board) {
        setAssets((current) =>
          current.map((asset) => (moved.has(asset.id) ? { ...asset, boardId: boardId || undefined } : asset))
        );
        return;
      }
      if (boardId === board) {
        for (const assetKind of MEDIA_KIND_LIST) void reloadAssetKind(assetKind, []).catch(() => {});
        return;
      }
      for (const asset of assetsRef.current) if (moved.has(asset.id)) removeAsset(asset);
    },
    [reloadAssetKind, removeAsset]
  );

  /** Another writer changed the store: fold its newest results in and drop
   *  the ones gone from the span read, keeping every loaded page (and so the
   *  scroll and the open asset). Pages are read from the top until one
   *  overlaps what is loaded; with nothing to anchor on after a few pages the
   *  loaded set is stale anyway and the kind restarts from its first page.
   *  Single-flight per kind (see syncAssetKind): a run's additions are
   *  counted against the rows loaded when it starts. */
  // Set on unmount: syncs then drop their queued follow-up and late results.
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);
  const runAssetSync = useCallback(
    async (assetKind: MediaKind): Promise<void> => {
      const board = boardRef.current;
      const known = new Set(assetsRef.current.filter((asset) => asset.kind === assetKind).map((asset) => asset.id));
      if (!pagingRef.current[assetKind].initialized || !known.size) {
        await refreshAssetKind(assetKind);
        return;
      }
      const fetched: MediaAsset[] = [];
      let total = 0;
      let reachedEnd = false;
      let anchored = false;
      for (let offset = 0; offset < ASSET_PAGE_SIZE * SYNC_PAGE_LIMIT; offset += ASSET_PAGE_SIZE) {
        const page = await requestAssetPage(assetKind, offset);
        if (disposedRef.current || page.board !== boardRef.current) return;
        fetched.push(...page.assets);
        total = page.total;
        reachedEnd = !page.assets.length || offset + page.assets.length >= page.total;
        anchored = page.assets.some((asset) => known.has(asset.id));
        if (anchored || reachedEnd) break;
      }
      if (board !== boardRef.current) return;
      if (!anchored && !reachedEnd) {
        await reloadAssetKind(assetKind, []);
        return;
      }
      const fetchedIds = new Set(fetched.map((asset) => asset.id));
      const floor = fetched.length ? Number(fetched[fetched.length - 1].createdAt || 0) : Number.POSITIVE_INFINITY;
      const gone = new Set(
        assetsRef.current
          .filter(
            (asset) =>
              asset.kind === assetKind &&
              !fetchedIds.has(asset.id) &&
              (reachedEnd || Number(asset.createdAt || 0) > floor)
          )
          .map((asset) => asset.id)
      );
      const added = fetched.filter((asset) => !known.has(asset.id)).length;
      const merge = (current: MediaAsset[]) =>
        mergeMediaAssets(
          current.filter((asset) => !gone.has(asset.id)),
          fetched
        );
      // The next run snapshots the loaded rows before React re-renders.
      assetsRef.current = merge(assetsRef.current);
      setAssets(merge);
      const latest = pagingRef.current[assetKind];
      pagingRef.current = {
        ...pagingRef.current,
        [assetKind]: {
          ...latest,
          initialized: true,
          total,
          nextOffset: reachedEnd ? total : Math.min(total, Math.max(0, latest.nextOffset + added - gone.size)),
        },
      };
    },
    [refreshAssetKind, reloadAssetKind, requestAssetPage]
  );

  /** One sync per kind at a time: overlapping runs would each count the same
   *  additions and push the paging offset past rows never loaded. A change
   *  during a run queues one follow-up that reads again once it ends. */
  const syncFlights = useRef(new Map<MediaKind, { running: Promise<void>; queued: Promise<void> | null }>());
  const syncAssetKind = useCallback(
    (assetKind: MediaKind): Promise<void> => {
      // An unmounted gallery starts no read; a queued follow-up is dropped.
      if (disposedRef.current) return Promise.resolve();
      const flights = syncFlights.current;
      const flight = flights.get(assetKind);
      if (flight) {
        flight.queued ??= flight.running.catch(() => {}).then(() => syncAssetKind(assetKind));
        return flight.queued;
      }
      const running: Promise<void> = runAssetSync(assetKind).finally(() => {
        if (flights.get(assetKind)?.running === running) flights.delete(assetKind);
      });
      flights.set(assetKind, { running, queued: null });
      return running;
    },
    [runAssetSync]
  );

  /** The store's count behind the loaded pages (every kind), or null until
   *  each kind has its first page. */
  const loadedTotal = useCallback((): number | null => {
    let sum = 0;
    for (const assetKind of MEDIA_KIND_LIST) {
      const paging = pagingRef.current[assetKind];
      if (!paging.initialized) return null;
      sum += paging.total;
    }
    return sum;
  }, []);

  return {
    assets,
    loadedTotal,
    moveAssets,
    loadMoreAssets,
    reloadAssetKind,
    removeAsset,
    refreshAssetKind,
    syncAssetKind,
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

  const assetUrl = useCallback(
    (assetId: string, variant: string): string =>
      laneReady === true && !urlBroken[mediaVariantKey(assetId, variant)] ? mediaUrl(api, assetId, variant) : '',
    [api, laneReady, urlBroken]
  );

  const markUrlBroken = useCallback(
    (assetId: string, variant: string): void => {
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
        const retry = Object.keys(urlBrokenRef.current).filter((failedKey) => (failCounts.current[failedKey] || 0) < 2);
        if (!retry.length) return;
        const next = { ...urlBrokenRef.current };
        for (const failedKey of retry) delete next[failedKey];
        urlBrokenRef.current = next;
        setUrlBroken(next);
      });
    },
    [api, localTransport]
  );

  useEffect(() => {
    if (!active) return undefined;
    // A broken byte-lane URL is one failed attempt, not a permanent verdict.
    // Local IPC has no lane to probe, so re-entering Studio simply clears the
    // record and lets those tiles request their rendition again.
    if (localTransport) {
      if (Object.keys(urlBrokenRef.current).length) {
        failCounts.current = {};
        urlBrokenRef.current = {};
        setUrlBroken({});
      }
      return undefined;
    }
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
    return () => {
      stopped = true;
    };
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
  // What the window has seen of each job across the effect's re-runs: announced ones, and the first null read of the rest.
  const trackRef = useRef({ announced: new Set<string>(), misses: new Map<string, 'absent' | 'removed'>() });
  const runningKey = jobs
    .filter((entry) => entry.status === 'running')
    .map((entry) => entry.id)
    .join(',');

  useEffect(() => {
    if (!active || !runningKey) return undefined;
    const ids = runningKey.split(',');
    // Jobs are pushed (section `mediaJobs`, key = job id) on their scoped feed `media:<jobId>`, which main folds into the
    // mirror while this window watches it (SPEC R14). Node read a job's status every 1.5 s, kept it running with the
    // progress it had through the first null read and marked it lost on the second. A push has no poll to count, so the
    // first observation of nothing (the core answering that the job's feed is not there, or the removal of a job it
    // announced without a result) starts one re-check timer at that same cadence, and only the observation that still
    // finds nothing then is the second null read. An entry in between resets the count. A request that fails is a
    // status error: the job stays as it was.
    const sections = sectionStoreFor(api);
    if (!sections) return undefined;
    let stopped = false;
    const { announced, misses } = trackRef.current;
    // One re-check per job, armed by its own first null read: another job's timer is never reused for it.
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const clearMiss = (id: string) => {
      misses.delete(id);
      clearTimeout(timers.get(id));
      timers.delete(id);
    };
    const settle = (landed: MediaJob[], lost: string[]) => {
      void (async () => {
        try {
          if (stopped) return;
          if (!landed.length && !lost.length) return;
          const completed = landed.filter((entry) => entry.status === 'done');
          if (completed.length) {
            const landedKinds = Array.from(new Set(completed.map((entry) => entry.kind)));
            const referenceWrites = completed.map((entry) => {
              const queued = jobsRef.current.find((candidate) => candidate.id === entry.id);
              return entry.assetId
                ? writeStudioAssetReferences(entry.assetId, queued?.request?.references || [], referenceStore)
                : Promise.resolve();
            });
            await Promise.all([...landedKinds.map((assetKind) => refreshAssetKind(assetKind)), ...referenceWrites]);
            if (stopped) return;
          }
          setJobs((current) =>
            current.map((entry) => {
              const next = landed.find((candidate) => candidate.id === entry.id);
              if (next) return { ...entry, ...next };
              if (entry.status !== 'running' || !lost.includes(entry.id)) return entry;
              return {
                ...entry,
                status: 'failed' as const,
                error: t('Lost track of this run — the runtime restarted.'),
              };
            })
          );
        } catch (reason) {
          if (!stopped) setError(errorText(reason));
        }
      })();
    };
    const lose = (id: string) => {
      clearMiss(id);
      announced.delete(id);
      settle([], [id]);
    };
    const subscribeFeed = (id: string, second: boolean) => {
      void Promise.resolve(api.sections?.call('feed/subscribe', { feedId: `media:${id}` })).then(
        (answer) => {
          if (stopped) return;
          if (!(answer as { absent?: boolean } | undefined)?.absent) clearMiss(id);
          else if (second) lose(id);
          else miss(id, 'absent');
        },
        (reason: unknown) => {
          if (!stopped) setError(errorText(reason));
        }
      );
    };
    const recheck = (id: string) => {
      timers.delete(id);
      const how = misses.get(id);
      if (how === undefined) return;
      if (sections.get('mediaJobs', id)) clearMiss(id);
      else if (how === 'absent') subscribeFeed(id, true);
      else lose(id);
    };
    const arm = (id: string) => void timers.set(id, setTimeout(() => recheck(id), MEDIA_RECHECK_MS));
    const miss = (id: string, how: 'absent' | 'removed') => {
      if (misses.has(id)) return;
      misses.set(id, how);
      arm(id);
    };
    const follow = () => {
      const landed: MediaJob[] = [];
      for (const id of ids) {
        const entry = sections.get('mediaJobs', id);
        if (entry) {
          announced.add(id);
          clearMiss(id);
          landed.push(entry.value as MediaJob);
        } else if (announced.has(id)) miss(id, 'removed');
      }
      settle(landed, []);
    };
    for (const id of ids) subscribeFeed(id, false);
    for (const id of ids) if (misses.has(id)) arm(id);
    const unsubscribe = sections.subscribe('mediaJobs', follow);
    const unsubscribeFeedErrors = sections.onFeedError((feedId, message) => {
      if (!stopped && ids.some((id) => `media:${id}` === feedId)) setError(message);
    });
    void sections.ready().then(follow, (reason: unknown) => {
      if (!stopped) setError(errorText(reason));
    });
    return () => {
      stopped = true;
      for (const timeout of timers.values()) clearTimeout(timeout);
      unsubscribe();
      unsubscribeFeedErrors();
      // Leaving the feed removes its sections from this window's mirror: a job that has ended is not kept there.
      for (const id of ids) void Promise.resolve(api.sections?.call('feed/unsubscribe', { feedId: `media:${id}` })).catch(() => undefined);
    };
  }, [active, api, referenceStore, refreshAssetKind, runningKey, setError]);

  useEffect(() => {
    setJobs((current) => {
      const next = current.filter(
        (entry) =>
          entry.status !== 'done' || Boolean(entry.assetId && !assets.some((asset) => asset.id === entry.assetId))
      );
      return next.length === current.length ? current : next;
    });
  }, [assets]);

  return { jobs, runningKey, setJobs };
}
