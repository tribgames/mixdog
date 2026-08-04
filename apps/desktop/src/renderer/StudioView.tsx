import {
  Ban,
  Copy,
  FolderOpen,
  Image as ImageIcon,
  PanelLeft,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { OpenSelect } from './OpenSelect';
import { ProgressSpinner } from './ProgressSpinner';
import { t } from './i18n';
import { StudioModelMenu, type StudioModelEntry } from './StudioModelMenu';
import { BrandTile } from './WorkspaceEmptyState';
import { cancelLayoutFrame, scheduleLayoutFrame } from './interaction-frame-scheduler';
import { useForegroundMedia } from './media-lifecycle';
import { InlineErrors } from './notifications';
import {
  ensureStudioLoad,
  reportStudioLoadStage,
} from './renderer-load-metrics';
import {
  assetLabel,
  callCapability,
  DEFAULT_STUDIO_OPTIONS,
  errorText,
  formatBytes,
  type JustifiedTile,
  justifiedRows,
  laneSpec,
  MEDIA_KINDS,
  mediaFrameRatio,
  mediaTransportIsLocal,
  mediaUrl,
  mediaVariantKey,
  modelControls,
  posterFromVideo,
  probeMediaLane,
  requestOptions,
  resolveStudioModel,
  shouldKeepMediaJobSlot,
  STUDIO_GRID_GAP,
  STUDIO_GRID_MAX_WIDTH,
  studioTargetRowHeight,
  thumbFromImage,
  type MediaAsset,
  type MediaAssetRead,
  type MediaJob,
  type MediaKind,
  type MediaLane,
  type StudioApi,
  type StudioOptions
} from './studio-support';
import { shouldFocusSurfaceInput } from './surface-input-focus';

const POLL_INTERVAL_MS = 1_500;
const ASSET_PAGE_SIZE = 60;
// Thumbnails are round-trip bound, not byte bound: a strictly sequential loop
// paid one full relay round trip per tile.
const THUMB_CONCURRENCY = 4;
const EAGER_THUMB_COUNT = 12;
// onStall is wired only for local Electron tiles. Give a cached protocol
// response one frame to win, then start the bounded Chromium fallback instead
// of leaving a cold cache miss behind native/custom-protocol scheduling.
const THUMB_STALL_MS = 120;
const STUDIO_DETAIL_STACK_MAX_WIDTH = 700;
// Gallery density steps: columns per row. The slider presents these in reverse
// so moving right follows the familiar smaller → larger thumbnail direction.
const TILE_SIZES = [3, 4, 5, 6] as const;
const TILE_SIZE_KEY = 'mixdog.studio-tile-size';
const RATIO_CACHE_KEY = 'mixdog.studio-tile-ratios';
let videoPosterFallbackTail: Promise<void> = Promise.resolve();

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

function scheduleVideoPosterFallback<T>(task: () => Promise<T>): Promise<T> {
  const result = videoPosterFallbackTail.then(task, task);
  videoPosterFallbackTail = result.then(() => undefined, () => undefined);
  return result;
}

function thumbnailPayload(dataUrl: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  return match ? { mime: match[1], base64: match[2] } : null;
}

function StudioThumbnail({
  src,
  kind,
  eager,
  pending = false,
  onLoad,
  onError,
  onStall,
}: {
  src: string;
  kind: MediaKind;
  eager: boolean;
  pending?: boolean;
  onLoad: () => void;
  onError?: () => void;
  onStall?: () => void;
}) {
  const [loadedSource, setLoadedSource] = useState('');
  const [failedSource, setFailedSource] = useState('');
  const settledRef = useRef(false);
  const onStallRef = useRef(onStall);
  onStallRef.current = onStall;
  useEffect(() => {
    settledRef.current = false;
    if (!src || !onStallRef.current) return undefined;
    const timer = window.setTimeout(() => {
      if (!settledRef.current) onStallRef.current?.();
    }, THUMB_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [src]);
  const ready = Boolean(src && loadedSource === src);
  const failed = Boolean(src && failedSource === src);
  if (!src && pending) {
    return <span className="studio-thumbnail-loading" aria-hidden="true">
      <ProgressSpinner size={18} className="studio-spinner" />
    </span>;
  }
  if (!src || failed) {
    return <span className="studio-tile-glyph">
      {kind === 'video' ? <Play size={22} aria-hidden="true" /> : <ImageIcon size={22} aria-hidden="true" />}
    </span>;
  }
  return <>
    {!ready && <span className="studio-thumbnail-loading" aria-hidden="true">
      <ProgressSpinner size={18} className="studio-spinner" />
    </span>}
    <img src={src} alt="" className="studio-thumbnail-image"
      data-ready={ready ? 'true' : 'false'}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : 'auto'}
      onError={() => {
        settledRef.current = true;
        setFailedSource(src);
        onError?.();
      }}
      onLoad={() => {
        settledRef.current = true;
        setFailedSource((current) => current === src ? '' : current);
        setLoadedSource(src);
        onLoad();
      }} />
  </>;
}

/** Display casing for lane vocabulary: auto → Auto, 1k → 1K, 480p → 480p. */
function pillLabel(value: string): string {
  if (/^\d+k$/i.test(value)) return value.toUpperCase();
  if (/^[a-z]/.test(value)) return value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

// Media studio page (sidebar -> Studio): pick image or video, pick one of the
// authenticated provider lanes, generate, and keep the result in a local
// gallery. Generation runs as a runtime job; this pane only polls snapshots.
export function StudioPane({
  api = window.mixdogDesktop,
  active = true,
  sidebarOpen = false,
  onToggleSidebar,
  onReady,
  captureVideoPoster = posterFromVideo,
}: {
  api?: StudioApi;
  active?: boolean;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onReady?: () => void;
  captureVideoPoster?: typeof posterFromVideo;
}) {
  const bootMetricToken = ensureStudioLoad();
  reportStudioLoadStage('module', '', false, bootMetricToken);
  const [lanes, setLanes] = useState<MediaLane[]>([]);
  const [kind, setKind] = useState<MediaKind>('image');
  const [laneId, setLaneId] = useState('');
  const [model, setModel] = useState('');
  const [options, setOptions] = useState<StudioOptions>(DEFAULT_STUDIO_OPTIONS);
  const [prompt, setPrompt] = useState('');
  // Generation is a QUEUE (user): starting a run never blocks the composer, so
  // several jobs can be in flight and each keeps its own tile.
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const visibleAssets = useMemo(
    () => assets.filter((asset) => asset.kind === kind),
    [assets, kind],
  );
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  // A cold local rendition may take longer than the tile's stall threshold.
  // Start the renderer fallback without invalidating the still-live direct
  // request: dropping that URL produced an empty frame until fallback landed.
  const [thumbFallbacks, setThumbFallbacks] = useState<Record<string, true>>({});
  const [copied, setCopied] = useState(false);
  // Phone detail sheet: the prompt is clamped to two lines and expands on tap.
  const [promptOpen, setPromptOpen] = useState(false);
  // The phone detail viewer is a different composition, not a squeezed card.
  // A narrow viewport OR a coarse pointer opens it, so a WebView that
  // misreports pointer coarseness still gets the stacked layout.
  const [phoneViewer, setPhoneViewer] = useState(() => (
    document.documentElement.dataset.mixdogMobile === '1'
      || window.matchMedia?.('(max-width: 700px), (pointer: coarse)').matches === true
  ));
  // Split panes resize independently of the Electron window. Keep desktop
  // tile interactions, but stack the detail viewer when this Studio surface
  // itself becomes phone-width.
  const [narrowDetailViewer, setNarrowDetailViewer] = useState(false);
  const [dropping, setDropping] = useState(false);
  // Hover preview: exactly one <video> is mounted at a time (a grid full of
  // live decoders is what took the window down before).
  const [hoverId, setHoverId] = useState('');
  const [fullUrls, setFullUrls] = useState<Record<string, string>>({});
  // Aspect ratios drive the justified rows; measured from the rendered thumb
  // so no extra decode is needed.
  // Ratios persist: without them the first paint lays every tile out square
  // and then snaps once each thumbnail decodes (user: 처음 들어갈 때 튄다).
  const [ratios, setRatios] = useState<Record<string, number>>(() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(RATIO_CACHE_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw as Record<string, number> : {};
    } catch {
      return {};
    }
  });
  const [gridWidth, setGridWidth] = useState(STUDIO_GRID_MAX_WIDTH);
  const gridMotionFrame = useRef<number | null>(null);
  const [gridMotionReady, setGridMotionReady] = useState(false);
  const [durations, setDurations] = useState<Record<string, number>>({});
  // Gallery density (top-right control), remembered across sessions.
  const [tileSize, setTileSize] = useState<number>(() => {
    const stored = Number(window.localStorage.getItem(TILE_SIZE_KEY));
    return TILE_SIZES.includes(stored as typeof TILE_SIZES[number]) ? stored : TILE_SIZES[1];
  });
  // Reference images for the next generation (edit / image-to-video).
  const [refs, setRefs] = useState<Array<{ base64: string; mime: string; url: string }>>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [gallerySettled, setGallerySettled] = useState(false);
  const [catalogSettled, setCatalogSettled] = useState(false);
  const [firstThumbnailReady, setFirstThumbnailReady] = useState(false);
  const previewToken = useRef(0);
  // Media bytes ride local IPC on the desktop and the LAN bridge / relay in
  // the web app. Only a local host may fall back to shrinking a full-size
  // asset here; remotely that transfer is exactly the cost being removed.
  const localTransport = useMemo(() => mediaTransportIsLocal(), []);
  // Does this host serve the byte lane? One probe answers it for the whole
  // gallery (null while it is in flight), so a host without the lane never
  // pays a doomed request per tile.
  const [laneReady, setLaneReady] = useState<boolean | null>(localTransport ? true : null);
  // Byte-lane failures are variant-scoped. A missing thumb must never disable
  // the same video's working range-able original stream.
  const [urlBroken, setUrlBroken] = useState<Record<string, boolean>>({});
  const urlBrokenRef = useRef<Record<string, boolean>>({});
  const failCounts = useRef<Record<string, number>>({});
  const probing = useRef(false);
  const mediaForeground = useForegroundMedia(active);
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
    // One failure usually means the HOST hiccuped (desktop mid-reconnect),
    // not that the lane is missing: re-probe once. A lane that is really
    // gone switches every tile over at once; a lane that answers hands each
    // asset exactly one retry before the fallback sticks.
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
  const gridRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const studioRootRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => () => {
    if (gridMotionFrame.current !== null) window.cancelAnimationFrame(gridMotionFrame.current);
  }, []);
  // Latest queue, readable from the re-entry reset without making that effect
  // depend on (and re-run for) every poll snapshot.
  const jobsRef = useRef<MediaJob[]>([]);
  jobsRef.current = jobs;
  // Mirror of the thumbnail cache: the hydration loop reads it without taking
  // a state dependency, so a landed thumbnail never restarts the loop.
  const thumbsRef = useRef<Record<string, string>>({});
  const loadedThumbsRef = useRef<Record<string, boolean>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const assetPagingRef = useRef<Record<MediaKind, MediaAssetPaging>>(initialMediaAssetPaging());
  const assetPageRequests = useRef<Map<string, Promise<MediaAssetPage>>>(new Map());

  const requestAssetPage = useCallback((
    assetKind: MediaKind,
    offset: number,
  ): Promise<MediaAssetPage> => {
    const key = `${assetKind}:${offset}`;
    const existing = assetPageRequests.current.get(key);
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
    assetPageRequests.current.set(key, request);
    const cleanup = () => {
      if (assetPageRequests.current.get(key) === request) {
        assetPageRequests.current.delete(key);
      }
    };
    void request.then(cleanup, cleanup);
    return request;
  }, [api]);

  const refreshAssetKind = useCallback(async (assetKind: MediaKind): Promise<MediaAsset[]> => {
    const page = await requestAssetPage(assetKind, 0);
    const paging = assetPagingRef.current[assetKind];
    setAssets((current) => mergeMediaAssets(
      !paging.initialized || page.total === 0
        ? current.filter((asset) => asset.kind !== assetKind)
        : current,
      page.assets,
    ));
    const nextOffset = paging.initialized
      ? Math.min(page.total, Math.max(paging.nextOffset, page.assets.length))
      : Math.min(page.total, page.assets.length);
    assetPagingRef.current = {
      ...assetPagingRef.current,
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
    const paging = assetPagingRef.current[assetKind];
    if (!paging.initialized) return refreshAssetKind(assetKind);
    if (paging.loadingMore || paging.nextOffset >= paging.total) return [];
    const offset = paging.nextOffset;
    assetPagingRef.current = {
      ...assetPagingRef.current,
      [assetKind]: { ...paging, loadingMore: true },
    };
    try {
      const page = await requestAssetPage(assetKind, offset);
      setAssets((current) => mergeMediaAssets(current, page.assets));
      const latest = assetPagingRef.current[assetKind];
      const consumedOffset = page.assets.length ? offset + page.assets.length : page.total;
      assetPagingRef.current = {
        ...assetPagingRef.current,
        [assetKind]: {
          initialized: true,
          loadingMore: false,
          nextOffset: Math.min(page.total, Math.max(latest.nextOffset, consumedOffset)),
          total: page.total,
        },
      };
      return page.assets;
    } catch (reason) {
      assetPagingRef.current = {
        ...assetPagingRef.current,
        [assetKind]: {
          ...assetPagingRef.current[assetKind],
          loadingMore: false,
        },
      };
      throw reason;
    }
  }, [refreshAssetKind, requestAssetPage]);

  const load = useCallback(async (metricToken?: number) => {
    // The gallery must not wait on the lane catalog: provider auth checks are
    // the slow leg of this pane, and the tiles used to paint only after they
    // answered (user: 들어가면 섬네일이 늦게 나온다). Each half commits on
    // arrival instead.
    const gallery = Promise.all(MEDIA_KINDS.map((assetKind) => refreshAssetKind(assetKind)))
      .then((pages) => {
        const count = pages.reduce((total, rows) => total + rows.length, 0);
        reportStudioLoadStage('assets', `count=${count}`, false, metricToken);
      })
      .finally(() => setGallerySettled(true));
    const catalog = (callCapability(api, 'listMediaLanes') as Promise<MediaLane[] | undefined>)
      .then((rows) => setLanes(Array.isArray(rows) ? rows : []))
      .finally(() => setCatalogSettled(true));
    const settled = await Promise.allSettled([gallery, catalog]);
    const failed = settled.find((result) => result.status === 'rejected');
    setError(failed ? errorText((failed as PromiseRejectedResult).reason) : '');
    setLoading(false);
  }, [api, refreshAssetKind]);

  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 700px), (pointer: coarse)');
    if (!query) return undefined;
    const apply = () => setPhoneViewer(
      document.documentElement.dataset.mixdogMobile === '1' || query.matches,
    );
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  useLayoutEffect(() => {
    const element = studioRootRef.current;
    if (!element) return undefined;
    const apply = (width: number) => {
      if (width > 0) setNarrowDetailViewer(width <= STUDIO_DETAIL_STACK_MAX_WIDTH);
    };
    apply(element.getBoundingClientRect().width);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === element);
      apply(entry?.contentRect.width || element.getBoundingClientRect().width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (active) {
      const metricToken = ensureStudioLoad();
      void load(metricToken);
    }
  }, [active, load]);

  // Re-entering the pane re-probes: a host that came back online serves the
  // byte lane again instead of staying downgraded for the session.
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

  // A Studio tab is a persistent workspace surface: switching tabs must keep
  // its prompt, mode, references, selected asset, queue, and scroll position.
  useLayoutEffect(() => {
    if (!active) {
      // The next Studio entry must paint directly at its settled geometry.
      setGridMotionReady(false);
      return;
    }
    // No unfold on entry (user): display:none → visible restarts CSS
    // animations. The entry frame renders animation-free.
    // Chat-composer parity (user): entering Studio lands the caret in the
    // prompt so typing starts immediately, like the session composer.
    promptRef.current?.focus();
  }, [active]);
  useEffect(() => {
    if (!mediaForeground) setHoverId('');
  }, [mediaForeground]);
  const available = useMemo(
    () => lanes.filter((lane) => lane.authenticated && lane.kinds.includes(kind)),
    [lanes, kind],
  );
  // Which kinds have ANY authenticated lane: the toggle only offers what the
  // signed-in providers can actually produce (and hides entirely for one).
  const kindsOffered = useMemo(() => MEDIA_KINDS.filter((entry) =>
    lanes.some((lane) => lane.authenticated && lane.kinds.includes(entry))), [lanes]);
  useEffect(() => {
    if (kindsOffered.length && !kindsOffered.includes(kind)) setKind(kindsOffered[0]);
  }, [kindsOffered, kind]);
  const lane = useMemo(
    () => available.find((entry) => entry.id === laneId) || available[0] || null,
    [available, laneId],
  );
  const spec = laneSpec(lane, kind);
  // Kind changes render before the synchronization effect runs. Resolve the
  // model against the active contract now so the previous kind's label never
  // reaches a paint.
  const activeModel = resolveStudioModel(spec, model);

  // Keep lane/model selection valid whenever the kind or catalog changes.
  useEffect(() => {
    if (!lane) return;
    if (lane.id !== laneId) setLaneId(lane.id);
    if (model !== activeModel) setModel(activeModel);
  }, [activeModel, lane, laneId, model]);

  // Snap options onto the selected model's contract: a value carried over from
  // another model (1k resolution, a 12s clip on Veo) must never reach the API.
  useEffect(() => {
    const next = modelControls(spec, activeModel);
    setOptions((current) => {
      const patch: Partial<StudioOptions> = {};
      if (next.resolution?.length && !next.resolution.includes(current.resolution)) {
        patch.resolution = next.resolution[0];
      }
      if (next.aspectRatio?.length && !next.aspectRatio.includes(current.aspectRatio)) {
        patch.aspectRatio = next.aspectRatio[0];
      }
      // Duration is NOT snapped here: a patch that fed back into this effect
      // could re-enter on every render. The request clamps it instead.
      return Object.keys(patch).length ? { ...current, ...patch } : current;
    });
  }, [activeModel, spec]);

  // Poll every running job until it reaches a terminal state. The key is the
  // id list, so a progress snapshot never restarts the timer.
  const runningKey = jobs.filter((entry) => entry.status === 'running').map((entry) => entry.id).join(',');
  useEffect(() => {
    if (!active || !runningKey) return undefined;
    const ids = runningKey.split(',');
    let stopped = false;
    const poll = () => {
      void (async () => {
        try {
          const polled = await Promise.all(ids.map((id) =>
            callCapability(api, 'getMediaJob', [id]) as Promise<MediaJob | null>));
          if (stopped) return;
          const landed = polled.filter(Boolean) as MediaJob[];
          if (!landed.length) return;
          if (landed.some((entry) => entry.status === 'done')) {
            // Fetch first, then commit both snapshots together. The pending
            // frame stays mounted until its indexed asset can replace it with
            // the same requested ratio (image and video).
            const landedKinds = Array.from(new Set(
              landed.filter((entry) => entry.status === 'done').map((entry) => entry.kind),
            ));
            await Promise.all(landedKinds.map((assetKind) => refreshAssetKind(assetKind)));
            if (stopped) return;
          }
          setJobs((current) => current.map((entry) =>
            landed.find((next) => next.id === entry.id) || entry));
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
  }, [active, api, refreshAssetKind, runningKey]);

  // Selected asset preview. With a byte-lane URL the DOM loads it directly;
  // this RPC payload is only the fallback for a host without that lane.
  useEffect(() => {
    setPromptOpen(false);
    // While the lane probe is in flight the RPC fallback would race it and
    // pull a payload the DOM is about to fetch itself.
    if (!selected || laneReady === null
      || assetUrl(selected.id, selected.kind === 'video' ? 'original' : 'display')) {
      setPreviewUrl('');
      return;
    }
    const token = ++previewToken.current;
    void (async () => {
      try {
        const result = await callCapability(api, 'readMediaAsset', [selected.id, {
          variant: selected.kind === 'video' ? 'original' : 'display',
          allowOriginal: true,
        }]) as MediaAssetRead | null;
        if (token !== previewToken.current) return;
        setPreviewUrl(result?.base64 ? `data:${result.mime || 'image/png'};base64,${result.base64}` : '');
      } catch (reason) {
        if (token === previewToken.current) setError(errorText(reason));
      }
    })();
  }, [api, assetUrl, laneReady, selected]);

  // A newly opened asset starts with its prompt collapsed again.
  useEffect(() => { setPromptOpen(false); }, [selected?.id]);

  // Fallback hydration ONLY: tiles normally load their rendition straight from
  // the byte lane. This path exists for hosts without that lane, and pulls the
  // server-side rendition through the RPC surface instead. Local image misses
  // read ONE original at a time through direct IPC and shrink it here: using a
  // second mixdog-media:// URL merely joined the same delayed custom-protocol
  // queue. Remote hosts keep the glyph rather than pulling a full-size asset
  // across the link.
  useEffect(() => {
    if (!active || laneReady === null) return undefined;
    let stopped = false;
    // The active mode owns this queue. The old global first-24 cutoff stranded
    // older clips whenever newer images occupied those slots.
    const queue = visibleAssets.filter((asset, assetIndex) =>
      !loadedThumbsRef.current[asset.id]
      && !thumbsRef.current[asset.id]
      && (
        thumbFallbacks[asset.id]
        || !assetUrl(asset.id, 'thumb')
        // Hidden/unfocused Electron windows throttle short timers, so waiting
        // for onStall recreated a multi-second spinner. Hydrate only the eager
        // local image window immediately; one worker bounds original decoding.
        || (localTransport && asset.kind === 'image' && assetIndex < EAGER_THUMB_COUNT)
      ));
    const rememberDuration = (id: string, seconds: number) => {
      if (!seconds) return;
      setDurations((current) => (current[id] ? current : { ...current, [id]: seconds }));
    };
    const rememberThumb = (
      asset: MediaAsset,
      url: string,
      durationSeconds = 0,
    ): void => {
      // The direct request can win while fallback is decoding. In that case
      // keep the already-painted image instead of swapping sources and briefly
      // showing a second loader.
      if (!url || stopped || loadedThumbsRef.current[asset.id]) return;
      thumbsRef.current = { ...thumbsRef.current, [asset.id]: url };
      setThumbs(thumbsRef.current);
      const payload = thumbnailPayload(url);
      if (!payload || !localTransport) return;
      void callCapability(api, 'cacheMediaThumbnail', [asset.id, {
        ...payload,
        durationSeconds,
      }]).catch(() => undefined);
    };
    const hydrate = async (asset: MediaAsset): Promise<void> => {
      if (localTransport && asset.kind === 'image') {
        const result = await callCapability(api, 'readMediaAsset', [asset.id, {
          variant: 'thumb',
          allowOriginal: true,
          generate: false,
        }]) as MediaAssetRead | null;
        if (stopped || !result?.base64) return;
        const raw = `data:${result.mime || asset.mime || 'image/png'};base64,${result.base64}`;
        const thumbnail = result.variant === 'thumb'
          ? raw
          : await thumbFromImage(raw).catch(() => '');
        if (thumbnail) rememberThumb(asset, thumbnail);
        return;
      }
      const result = await callCapability(api, 'readMediaAsset', [asset.id, {
        variant: 'thumb',
        // Chromium can capture a still when the host cannot build a video
        // rendition. Only local IPC may pay for the original clip bytes.
        allowOriginal: localTransport && asset.kind === 'video',
      }]) as MediaAssetRead | null;
      if (stopped || !result?.base64) return;
      // Runtime metadata only carries a duration for some lanes; the poster
      // probe is authoritative for the tile badge.
      let durationSeconds = Number(result.durationSeconds) || 0;
      const raw = `data:${result.mime || (asset.kind === 'video' ? 'video/mp4' : 'image/png')};base64,${result.base64}`;
      const needsVideoPoster = asset.kind === 'video'
        && (result.downgraded || result.variant !== 'thumb'
          || String(result.mime || '').startsWith('video/'));
      if (needsVideoPoster) {
        // One decoder at a time: retaining a live <video> per tile previously
        // exhausted Windows GPU resources and blacked the renderer window.
        const poster = await scheduleVideoPosterFallback(() => captureVideoPoster(raw));
        if (stopped) return;
        durationSeconds = poster.duration || durationSeconds;
        rememberDuration(asset.id, durationSeconds);
        rememberThumb(asset, poster.url, durationSeconds);
        return;
      }
      rememberDuration(asset.id, durationSeconds);
      rememberThumb(asset, raw, durationSeconds);
    };
    void (async () => {
      const worker = async (): Promise<void> => {
        while (!stopped) {
          const asset = queue.shift();
          if (!asset) return;
          try {
            await hydrate(asset);
          } catch {
            // A missing thumbnail is cosmetic; the tile falls back to its glyph.
          }
        }
      };
      await Promise.all(Array.from(
        { length: localTransport ? 1 : THUMB_CONCURRENCY },
        () => worker(),
      ));
    })();
    return () => { stopped = true; };
    // Reading the cache through a ref keeps this loop from restarting on every
    // landed thumbnail (each restart re-rendered the whole grid).
  }, [active, api, assetUrl, captureVideoPoster, laneReady, localTransport, thumbFallbacks, visibleAssets]);

  const generating = Boolean(runningKey);
  // The pending tiles print an elapsed clock, so the pane needs a heartbeat
  // while a job runs (polling alone updates it only every 1.5s, which read as
  // a stalled timer).
  const [, setProgressTick] = useState(0);
  useEffect(() => {
    if (!active || !generating) return undefined;
    const timer = window.setInterval(() => setProgressTick((value) => value + 1), 500);
    return () => window.clearInterval(timer);
  }, [active, generating]);
  // The model publishes its own reference cap (Veo 1, Gemini 3, Grok 5/7).
  const maxRefs = modelControls(spec, activeModel).maxReferences ?? (kind === 'video' ? 7 : 5);

  const addFiles = async (files: FileList | File[]) => {
    const picked = [...files].filter((file) => file.type.startsWith('image/')).slice(0, maxRefs - refs.length);
    const loaded = await Promise.all(picked.map((file) => new Promise<{ base64: string; mime: string; url: string }>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const url = String(reader.result || '');
        resolve({ base64: url.split(',')[1] || '', mime: file.type || 'image/png', url });
      };
      reader.readAsDataURL(file);
    })));
    setRefs((current) => [...current, ...loaded.filter((entry) => entry.base64)].slice(0, maxRefs));
  };

  const generate = async () => {
    // No busy guard: a second Generate queues another run behind the first.
    if (!lane || !prompt.trim()) return;
    setError('');
    try {
      const started = await callCapability(api, 'startMediaJob', [{
        lane: lane.id,
        kind,
        model: activeModel,
        prompt: prompt.trim(),
        options: requestOptions(modelControls(spec, activeModel), kind, options),
        references: refs.map((ref) => ({ base64: ref.base64, mime: ref.mime })),
      }]) as MediaJob | undefined;
      if (started) setJobs((current) => [started, ...current]);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const dismissJob = (id: string) => setJobs((current) => current.filter((entry) => entry.id !== id));

  const cancel = async (id: string) => {
    try {
      await callCapability(api, 'cancelMediaJob', [id]);
      // A cancel is deliberate: drop the slot instead of leaving a dead tile.
      dismissJob(id);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const remove = async (asset: MediaAsset) => {
    setHoverId('');
    try {
      await callCapability(api, 'deleteMediaAsset', [asset.id]);
      if (selected?.id === asset.id) setSelected(null);
      setAssets((current) => current.filter((entry) => entry.id !== asset.id));
      const paging = assetPagingRef.current[asset.kind];
      assetPagingRef.current = {
        ...assetPagingRef.current,
        [asset.kind]: {
          ...paging,
          nextOffset: Math.max(0, paging.nextOffset - 1),
          total: Math.max(0, paging.total - 1),
        },
      };
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  // Detail actions: queue the saved request again, hand the file to the OS
  // viewer, or remove it from the gallery.
  const regenerate = async (asset: MediaAsset) => {
    if (!asset.prompt.trim()) return;
    setError('');
    try {
      const started = await callCapability(api, 'startMediaJob', [{
        lane: asset.lane,
        kind: asset.kind,
        model: asset.model,
        prompt: asset.prompt.trim(),
        options: { ...(asset.options || {}) },
        references: [],
      }]) as MediaJob | undefined;
      if (started) {
        setJobs((current) => [started, ...current]);
        setKind(asset.kind);
        setSelected(null);
      }
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const openAssetFolder = async (asset: MediaAsset) => {
    try {
      await callCapability(api, 'openMediaFolder', [asset.id]);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  /** Play the hovered clip inline. With a byte lane the <video> streams it
   *  itself (ranges, no full download); without one the clip has to arrive as
   *  an RPC payload, which is only affordable on local transport. */
  const hoverPreview = async (asset: MediaAsset) => {
    setHoverId(asset.id);
    if (assetUrl(asset.id, 'original') || !localTransport || fullUrls[asset.id]) return;
    try {
      const result = await callCapability(api, 'readMediaAsset', [asset.id]) as MediaAssetRead | null;
      if (!result?.base64) return;
      setFullUrls((current) => ({
        ...current,
        [asset.id]: `data:${result.mime || 'video/mp4'};base64,${result.base64}`,
      }));
    } catch {
      // Preview is a nicety; the still stays in place.
    }
  };

  const copyPrompt = async (asset: MediaAsset) => {
    try {
      await navigator.clipboard?.writeText(asset.prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      // Clipboard denial is silent; the prompt text stays selectable.
    }
  };

  const openDetail = (asset: MediaAsset) => {
    setPromptOpen(false);
    setSelected(asset);
  };

  // Metadata + actions for one asset in the detail overlay card.
  const detailSections = (asset: MediaAsset) => <>
    <section className="studio-detail-block studio-detail-block--prompt">
      <div className="studio-detail-block-head">
        <span>PROMPT</span>
        <button type="button" onClick={() => void copyPrompt(asset)}>
          <Copy size={12} aria-hidden="true" />{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="studio-detail-prompt" data-open={promptOpen ? 'true' : undefined}
        onClick={() => setPromptOpen((current) => !current)}>{asset.prompt}</p>
    </section>
    <section className="studio-detail-block studio-detail-block--metadata">
      <div className="studio-detail-block-head"><span>{t('DETAILS')}</span></div>
      <dl>
        <div><dt>{t('Provider')}</dt><dd>{asset.lane}</dd></div>
        <div><dt>{t('Model')}</dt><dd>{asset.model}</dd></div>
        <div><dt>{t('Size')}</dt><dd>{formatBytes(asset.bytes)}</dd></div>
        {asset.durationSeconds ? <div><dt>{t('Duration')}</dt><dd>{asset.durationSeconds}s</dd></div> : null}
        <div><dt>{t('Created')}</dt><dd>{new Date(asset.createdAt).toLocaleString()}</dd></div>
      </dl>
    </section>
    <div className="studio-detail-actions">
      <button type="button" className="studio-detail-primary" onClick={() => void regenerate(asset)}>
        <RotateCcw size={14} aria-hidden="true" />{t('Regenerate')}
      </button>
      <button type="button" onClick={() => void openAssetFolder(asset)}>
        <FolderOpen size={14} aria-hidden="true" />{t('Open Folder')}
      </button>
      <button type="button" className="studio-detail-danger" onClick={() => void remove(asset)}>
        <Trash2 size={14} aria-hidden="true" />{t('Delete')}
      </button>
    </div>
  </>;

  // Controls belong to the MODEL: Veo takes 4/6/8s, Grok takes a 1-15s range,
  // Omni takes none — a lane-wide guess would offer rejected values.
  const controls = modelControls(spec, activeModel);
  const kindSettled = kindsOffered.length === 0 || kindsOffered.includes(kind);
  const routeSettled = !lane || (lane.id === laneId && model === activeModel);
  const optionsSettled = (
    (!controls.resolution?.length || controls.resolution.includes(options.resolution))
    && (!controls.aspectRatio?.length || controls.aspectRatio.includes(options.aspectRatio))
  );
  const studioSurfaceReady = active
    && gridMotionReady
    && gallerySettled
    && catalogSettled
    && kindSettled
    && routeSettled
    && optionsSettled
    && (visibleAssets.length === 0 || firstThumbnailReady);
  useEffect(() => {
    if (!studioSurfaceReady) return;
    reportStudioLoadStage('shell', '', false, bootMetricToken);
    reportStudioLoadStage('ready', '', true, bootMetricToken);
    onReadyRef.current?.();
  }, [bootMetricToken, studioSurfaceReady]);
  // Only a missing lane disables the composer: a run in flight must not, since
  // Generate queues the next one (user: 큐에 올리는 방식이라 버튼 막지 말고).
  const disabled = !lane;
  // Justified rows: the density step is a COLUMN count, mapped to Task's
  // composer-aligned inner width (gaps included).
  const rowHeight = studioTargetRowHeight(tileSize);
  // Track the real grid width so rows stay flush when the window resizes.
  // Layout effect: measuring after paint made the first frame use the 800px
  // fallback and then jump.
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!active || !element) return undefined;
    setGridMotionReady(false);
    setGridWidth(Math.round(element.getBoundingClientRect().width) || STUDIO_GRID_MAX_WIDTH);
    if (gridMotionFrame.current !== null) window.cancelAnimationFrame(gridMotionFrame.current);
    if (typeof window.requestAnimationFrame === 'function') {
      gridMotionFrame.current = window.requestAnimationFrame(() => {
        gridMotionFrame.current = window.requestAnimationFrame(() => {
          gridMotionFrame.current = null;
          setGridMotionReady(true);
        });
      });
    } else {
      setGridMotionReady(true);
    }
    if (typeof ResizeObserver === 'undefined') return undefined;
    let pendingWidth = 0;
    const observer = new ResizeObserver((entries) => {
      pendingWidth = Math.round(entries[0]?.contentRect.width || 0);
      if (pendingWidth > 0) {
        scheduleLayoutFrame(element, () => setGridWidth(pendingWidth));
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelLayoutFrame(element);
      if (gridMotionFrame.current !== null) {
        window.cancelAnimationFrame(gridMotionFrame.current);
        gridMotionFrame.current = null;
      }
    };
  }, [active]);
  // Every authenticated lane contributes its active-kind models to the
  // anchored picker, grouped by provider.
  const modelEntries = useMemo<StudioModelEntry[]>(() => available.flatMap((entry) => {
    const kindSpec = kind === 'video' ? entry.video : entry.image;
    return (kindSpec?.models || []).map((option) => ({
      lane: entry.id,
      laneLabel: entry.label,
      model: option.id,
      label: option.label,
    }));
  }), [available, kind]);
  const handleResultsScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining > Math.max(240, element.clientHeight * 0.5)) return;
    void loadMoreAssets(kind).catch((reason) => setError(errorText(reason)));
  }, [kind, loadMoreAssets]);
  // Every queued run holds its own slot in the grid, sized from its REQUESTED
  // aspect ratio so the finished asset lands without the tile changing shape
  // (user: 비율이 기존 비율이랑 다르다).
  const pendingJobs = useMemo(
    () => jobs.filter((entry) => shouldKeepMediaJobSlot(entry, visibleAssets, kind)),
    [jobs, visibleAssets, kind],
  );
  // Requested metadata is available before image/video thumbnail hydration.
  // Use it as the first-frame authority so poster decode never resizes a tile.
  const frameRatios = useMemo(() => {
    const next = { ...ratios };
    for (const asset of visibleAssets) {
      if (!next[asset.id]) next[asset.id] = mediaFrameRatio(asset);
    }
    return next;
  }, [ratios, visibleAssets]);
  // Rows are solved against the MEASURED width so the last tile lands exactly
  // on the right edge at every window size.
  const layoutRows = useMemo(() => {
    const tiles = pendingJobs.length
      ? [...pendingJobs.map((entry) => ({ id: entry.id, kind: entry.kind } as unknown as MediaAsset)),
        ...visibleAssets]
      : visibleAssets;
    const tileRatios = { ...frameRatios };
    for (const entry of pendingJobs) tileRatios[entry.id] = mediaFrameRatio(entry);
    return justifiedRows(
      tiles,
      tileRatios,
      gridWidth,
      rowHeight,
      STUDIO_GRID_GAP,
      STUDIO_GRID_MAX_WIDTH,
    );
  }, [pendingJobs, visibleAssets, frameRatios, gridWidth, rowHeight]);
  const layout = useMemo(
    () => new Map(layoutRows.flat().map((tile) => [tile.asset.id, tile])),
    [layoutRows],
  );
  // Ratio-proportional tile style: within a row wrapper, flex-grow shares the
  // LIVE row width in the solved proportions and CSS aspect-ratio derives the
  // height, so the browser rescales every thumbnail in the same frame as a
  // moving pane divider — the solved pixel widths never lag a commit behind
  // the frame (user: 섬네일이 넓이 조정될 때 튄다). The trailing row must not
  // stretch to the full line, so it keeps proportional percentage widths.
  const tileStyle = (tile: JustifiedTile, lastRow: boolean): React.CSSProperties => {
    const ratio = Number((tile.height > 0 ? tile.width / tile.height : 1).toFixed(4));
    return lastRow
      ? {
          width: `${Number(((tile.width / Math.max(1, gridWidth)) * 100).toFixed(3))}%`,
          aspectRatio: String(ratio),
        }
      : { flexGrow: ratio, flexBasis: 0, aspectRatio: String(ratio) };
  };
  // A pending tile is solved like any other, so it can end up ~70px wide at the
  // densest step. Its overlays (spinner, Cancel) share one header row and shed
  // labels as the slot narrows (user: 제너레이트와 캔슬이 겹침).
  const pendingBox = (entry: MediaJob) => {
    const width = Math.floor(layout.get(entry.id)?.width || rowHeight * mediaFrameRatio(entry));
    return {
      width,
      height: Math.floor(layout.get(entry.id)?.height || rowHeight),
      size: width < 130 ? 'tiny' : width < 210 ? 'compact' : 'wide',
    };
  };
  const pendingById = useMemo(
    () => new Map(pendingJobs.map((entry) => [entry.id, entry])),
    [pendingJobs],
  );
  const assetIndexById = useMemo(
    () => new Map(visibleAssets.map((asset, index) => [asset.id, index])),
    [visibleAssets],
  );

  /**
   * Rail position for the running job.
   *
   * Lanes report progress unevenly (xAI percentages, Veo a single 50%
   * heartbeat, the image lanes nothing). An elapsed-time curve used to fill
   * the gap, but an invented number is worse than none: it climbed to 90%
   * while the run was barely started (user: 퍼센테이지가 안 맞는다). Only a
   * lane-reported value is shown now; everything else runs indeterminate.
   */
  const jobProgress = (entry: MediaJob): number => (entry.status === 'running'
    ? Math.max(0, Math.min(100, Number(entry.progress) || 0))
    : 0);
  // Elapsed clock per tile. The heartbeat above already re-renders twice a
  // second, so this needs no timer of its own.
  const jobElapsed = (entry: MediaJob): string => {
    const seconds = Math.floor(Math.max(0, entry.startedAt ? Date.now() - entry.startedAt : 0) / 1_000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  const controlPill = (
    label: string,
    values: readonly string[],
    current: string,
    onPick: (value: string) => void,
  ) => <OpenSelect
    className="studio-pill-select" ariaLabel={label}
    // Raw lane vocabulary ("auto", "1k") reads as noise next to the model
    // name, so the pill shows a cased label while the value stays native.
    options={values.map((value) => ({ value, label: pillLabel(value) }))}
    value={current} disabled={disabled} onChange={onPick} />;

  return <div className="studio-root stable-surface-preserved" ref={studioRootRef}
    data-surface-active={active ? 'true' : 'false'}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}
    onClick={(event) => {
      if (active && shouldFocusSurfaceInput(event)) {
        promptRef.current?.focus({ preventScroll: true });
      }
    }}>
    <div className="studio-pane">
    <div className="studio-shell">
      {/* Desktop already names this surface in its workspace tab. Phones keep
          only the drawer reopen control because their tab strip is hidden. */}
      <header className="session-header studio-header" aria-label={t('Studio navigation')}>
        <div className="session-header-content">
          {/* Phone-only sidebar reopen, exactly like the chat header (CSS
              hides it on desktop where the titlebar owns the toggle). */}
          <button type="button" className="toolbar-sidebar session-header-menu"
            aria-label={t('Toggle session list')} aria-expanded={sidebarOpen}
            onClick={onToggleSidebar}>
            <PanelLeft className="sidebar-toggle-icon" size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      {/* Mode stays visually centered while thumbnail scale owns the gallery's
          top-right corner and contracts with narrow split layouts. */}
      <div className="studio-topbar">
        {/* Only offer what the signed-in providers can produce: one kind hides
            the toggle, none hides it entirely. */}
        <div className="studio-kind"
          data-empty={kindsOffered.length > 1 ? undefined : 'true'}
          role="group" aria-label={t('Media kind')}
          aria-hidden={kindsOffered.length > 1 ? undefined : true}>
          {(['image', 'video'] as const)
            .map((value) =>
              <button key={value} type="button" className={kind === value ? 'active' : ''}
                disabled={!kindsOffered.includes(value)}
                aria-pressed={kind === value} onClick={() => setKind(value)}>
                {t(value)}
              </button>)}
        </div>
        <label className="studio-density" aria-label={t('Thumbnail size')}>
          <input type="range" min={0} max={TILE_SIZES.length - 1} step={1}
            value={TILE_SIZES.length - 1
              - Math.max(0, TILE_SIZES.indexOf(tileSize as typeof TILE_SIZES[number]))}
            onChange={(event) => {
              const scaleIndex = Math.max(0, Math.min(
                TILE_SIZES.length - 1,
                Number(event.currentTarget.value),
              ));
              const next = TILE_SIZES[TILE_SIZES.length - 1 - scaleIndex] ?? TILE_SIZES[1];
              setTileSize(next);
              try { window.localStorage.setItem(TILE_SIZE_KEY, String(next)); } catch { /* density is a convenience */ }
            }} />
        </label>
      </div>
      <div className="studio-results" aria-label={t('Generated media')} ref={resultsRef}
        onScroll={handleResultsScroll}>
        {visibleAssets.length === 0 && pendingJobs.length === 0 && !loading
          && <div className="studio-blank">
          {/* Quiet brand watermark (user: VS Code grammar — empty secondary
              surfaces carry only the centered letterpress). The provider gap
              stays visible because it is a blocker, not canvas guidance. */}
          <span className="welcome-logo" aria-hidden="true"><BrandTile crop /></span>
          {available.length === 0 && <p>
            {t('No provider supports this mode yet — sign in to Grok/ChatGPT or add a Gemini key in Settings → Providers.')}
          </p>}
        </div>}
        <div className="studio-grid" ref={gridRef}
          data-motion-ready={gridMotionReady ? 'true' : undefined}>
          {/* Solved rows render inside row wrappers (tileStyle above): queued
              runs live in the grid (reference grammar) ahead of the gallery
              and are solved with the other tiles, so each finished asset lands
              in place at the same size instead of resizing the row. */}
          {layoutRows.map((row, rowIndex) => <div className="studio-grid-row"
            key={row[0]?.asset.id || rowIndex}>
          {row.map((tile) => {
            const style = tileStyle(tile, rowIndex === layoutRows.length - 1);
            const pending = pendingById.get(tile.asset.id);
            if (!pending) return null;
            const box = pendingBox(pending);
            const progress = jobProgress(pending);
            // Only a lane-reported number is printed; the rest run indeterminate.
            const determinate = progress > 0;
            const elapsed = jobElapsed(pending);
            return <figure key={pending.id} aria-live="polite"
              className={`studio-tile studio-tile--pending${pending.status === 'failed' ? ' studio-tile--failed' : ''}`}
              data-studio-asset-id={pending.id}
              data-size={box.size}
              style={style}>
              {pending.status === 'failed'
                // A failed run keeps its slot (user): the tile carries the reason
                // and the retry, instead of vanishing without a trace.
                ? <div className="studio-tile-open">
                  <div className="studio-failed-body">
                    <Ban size={16} aria-hidden="true" />
                    <p>{pending.error || t('Generation failed')}</p>
                    <div className="studio-failed-actions">
                      {/* Retry replaces this slot with a fresh queued run. */}
                      <button type="button" onClick={() => {
                        dismissJob(pending.id);
                        void generate();
                      }}>
                        <RotateCcw size={12} aria-hidden="true" />{t('Retry')}
                      </button>
                      <button type="button" onClick={() => dismissJob(pending.id)}>{t('Dismiss')}</button>
                    </div>
                  </div>
                </div>
                : <>
                  <div className="studio-tile-open" role="img" aria-label={t('Generating')}>
                    {/* Status reads from the bottom of the tile: the elapsed clock
                        always, the percentage and a determinate rail only for a
                        lane that reports one. Everything else runs indeterminate
                        rather than printing a guess. */}
                    <div className="studio-pending-foot">
                      <span className="studio-pending-meta">
                        <span>{elapsed}</span>
                        {determinate ? <span>{progress}%</span> : null}
                      </span>
                      <span className={`studio-pending-bar${determinate ? '' : ' studio-pending-bar--idle'}`}
                        role="progressbar" aria-valuenow={determinate ? progress : undefined}
                        aria-valuemin={0} aria-valuemax={100}>
                        <span style={determinate ? { width: `${progress}%` } : undefined} />
                      </span>
                    </div>
                  </div>
                  {/* Cancel rides on its own tile, so the composer keeps a live
                      Generate action for the next run in the queue. */}
                  <div className="studio-pending-head">
                    {/* Icon only (user): the word carried no information the rail
                        and the clock below do not already show. */}
                    <span className="studio-pending-chip" role="img"
                      aria-label={determinate
                        ? t('Generating, {{progress}}%, {{elapsed}} elapsed', { progress, elapsed })
                        : t('Generating, {{elapsed}} elapsed', { elapsed })}>
                      <ProgressSpinner size={13} className="studio-spinner" aria-hidden="true" />
                    </span>
                    <button type="button" className="studio-pending-cancel" aria-label={t('Cancel generation')}
                      onClick={() => void cancel(pending.id)}>
                      <Ban size={12} aria-hidden="true" /><span>{t('Cancel')}</span>
                    </button>
                  </div>
                </>}
            </figure>;
          })}
          {row.map((tile) => {
            if (pendingById.has(tile.asset.id)) return null;
            const asset = tile.asset;
            const assetIndex = assetIndexById.get(asset.id) ?? 0;
            return <figure key={asset.id}
            className={`studio-tile ${selected?.id === asset.id ? 'selected' : ''}`}
            data-studio-asset-id={asset.id}
            style={tileStyle(tile, rowIndex === layoutRows.length - 1)}>
            <button type="button" className="studio-tile-open" onClick={() => openDetail(asset)}
              aria-label={`Open ${asset.kind}: ${asset.prompt}`}
              // Hover preview mounts ONE video at a time; a grid of live
              // decoders is what crashed the window earlier.
              onMouseEnter={!phoneViewer && asset.kind === 'video'
                && (localTransport || Boolean(assetUrl(asset.id, 'original')))
                ? () => void hoverPreview(asset) : undefined}
              onMouseLeave={!phoneViewer && asset.kind === 'video'
                ? () => setHoverId('') : undefined}>
              {mediaForeground && !phoneViewer && asset.kind === 'video' && hoverId === asset.id
                && (assetUrl(asset.id, 'original') || fullUrls[asset.id])
                ? <video src={assetUrl(asset.id, 'original') || fullUrls[asset.id]}
                  muted loop autoPlay playsInline preload="metadata" />
                : null}
              <StudioThumbnail
                src={thumbs[asset.id] || (
                  localTransport && asset.kind === 'image' && assetIndex < EAGER_THUMB_COUNT
                    ? ''
                    : assetUrl(asset.id, 'thumb')
                )}
                kind={asset.kind}
                eager={assetIndex < EAGER_THUMB_COUNT}
                pending={localTransport && asset.kind === 'image'
                  && assetIndex < EAGER_THUMB_COUNT && !thumbs[asset.id]}
                // A host without the media route answers 404 here; that tile
                // (and only that tile) falls back to the RPC payload.
                onError={thumbs[asset.id] ? undefined : () => markUrlBroken(asset.id, 'thumb')}
                // A custom-protocol request can stay pending while a cold
                // rendition is being encoded. Keep that request mounted while
                // the eager viewport starts a local fallback in parallel.
                onStall={localTransport && asset.kind === 'video'
                  && assetIndex < EAGER_THUMB_COUNT
                  && !thumbs[asset.id] && assetUrl(asset.id, 'thumb')
                  ? () => setThumbFallbacks((current) => current[asset.id]
                    ? current : { ...current, [asset.id]: true })
                  : undefined}
                onLoad={() => {
                  loadedThumbsRef.current[asset.id] = true;
                  setFirstThumbnailReady(true);
                  reportStudioLoadStage('first-thumbnail', `kind=${asset.kind}`);
                  setRatios((current) => {
                    if (current[asset.id]) return current;
                    const next = { ...current, [asset.id]: mediaFrameRatio(asset) };
                    // Keep the cache bounded to the gallery window.
                    try {
                      window.localStorage.setItem(RATIO_CACHE_KEY, JSON.stringify(next));
                    } catch { /* ratio cache is a convenience */ }
                    return next;
                  });
                }} />
              {/* Kind badge dropped: the mode toggle already scopes the grid,
                  so only a clip length is worth printing. */}
              {(asset.durationSeconds || durations[asset.id])
                ? <span className="studio-tile-badge">{asset.durationSeconds || durations[asset.id]}s</span>
                : null}
            </button>
            {/* Clean tiles: detail opens from the media itself; only destructive
                cleanup remains in the top-right hover control. */}
            {!phoneViewer && <div className="studio-tile-actions">
              <button type="button" className="studio-tile-remove" aria-label={t('Delete asset')}
                title={assetLabel(asset)}
                onClick={() => void remove(asset)}><Trash2 size={15} aria-hidden="true" /></button>
            </div>}
          </figure>;
          })}
          </div>)}
        </div>
      </div>

      <div className="studio-dock">
        {/* Progress AND job failures live on the pending tile; the banner is
            only for pane-level errors. */}
        <InlineErrors messages={[error].filter(Boolean)} />
        <div className="studio-composer"
          // Drag & drop was declared but never wired: the composer now accepts
          // dropped image files anywhere on the card.
          onDragOver={(event) => {
            if (![...event.dataTransfer.types].includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setDropping(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node)) return;
            setDropping(false);
          }}
          onDrop={(event) => {
            const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'));
            if (!files.length) return;
            event.preventDefault();
            setDropping(false);
            void addFiles(files);
          }}
          data-dropping={dropping ? 'true' : undefined}>
          {refs.length > 0 && <div className="studio-refs" aria-label={t('Reference images')}>
            {refs.map((ref, index) => <span key={ref.url} className="studio-ref">
              <img src={ref.url} alt="" />
              <button type="button" aria-label={t('Remove reference')}
                onClick={() => setRefs((current) => current.filter((_, at) => at !== index))}>
                <X size={11} aria-hidden="true" />
              </button>
            </span>)}
          </div>}
          <textarea value={prompt} rows={1} ref={promptRef}
            aria-label={t('Generation prompt')}
            placeholder={kind === 'video'
              ? t('Describe the video…')
              : t('Describe the image you want…')}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
              if (files.length) void addFiles(files);
            }}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — same grammar as the
              // session composer.
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void generate();
            }} />
          {/* Keep the controls mounted across kind switches. The model above is
              already valid for this render, so remounting would only force
              another Chromium text raster pass. */}
          <div className="studio-composer-bar">
            <button type="button" className="studio-attach" aria-label={t('Attach reference image')}
              disabled={refs.length >= maxRefs}
              data-tooltip={t('Attach reference')}
              onClick={() => fileInput.current?.click()}><Plus size={16} aria-hidden="true" /></button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden
              onChange={(event) => {
                if (event.currentTarget.files) void addFiles(event.currentTarget.files);
                event.currentTarget.value = '';
              }} />
            {/* One strip for the generation controls. It stays a SINGLE line
                (wrapping reflowed the dock on every mode switch) and scrolls
                sideways on a phone, so the model picker is never clipped —
                the chat composer keeps its route strip the same way. */}
            <div className="studio-composer-controls">
              {/* Anchored menu like every other control (user): the model list
                  is a dropdown, not a centered dialog. The lane rides along. */}
              <StudioModelMenu entries={modelEntries} lane={lane?.id || ''} model={activeModel}
                onSelect={(entry) => {
                  setLaneId(entry.lane);
                  setModel(entry.model);
                }} />
              {controls.aspectRatio?.length
                ? controlPill('Aspect', controls.aspectRatio, options.aspectRatio,
                  (value) => setOptions((current) => ({ ...current, aspectRatio: value })))
                : null}
              {controls.resolution?.length
                ? controlPill('Resolution', controls.resolution, options.resolution || controls.resolution[0],
                  (value) => setOptions((current) => ({ ...current, resolution: value })))
                : null}
              {controls.size?.length
                ? controlPill('Size', controls.size, options.size,
                  (value) => setOptions((current) => ({ ...current, size: value })))
                : null}
              {controls.quality?.length
                ? controlPill('Quality', controls.quality, options.quality,
                  (value) => setOptions((current) => ({ ...current, quality: value })))
                : null}
              {/* The duration slot is always laid out: letting it appear only
                  in video mode shifted every control on each toggle (user). */}
              <span className="studio-duration-slot"
                data-empty={kind === 'video' && (controls.durations?.length || controls.durationRange) ? undefined : 'true'}>
                {controls.durations?.length
                  ? controlPill('Duration', controls.durations.map((value) => `${value}s`), `${options.duration}s`,
                    (value) => setOptions((current) => ({ ...current, duration: Number.parseInt(value, 10) || current.duration })))
                  : <label className="studio-duration">
                    <input type="range" min={controls.durationRange?.[0] ?? 1} max={controls.durationRange?.[1] ?? 15}
                      value={options.duration} disabled={disabled} aria-label={t('Duration seconds')}
                      onChange={(event) => {
                        // Read the value BEFORE the state updater runs: React
                        // has already cleared currentTarget by then, and the
                        // null deref crashed the renderer (window went black).
                        const next = Number(event.currentTarget.value);
                        setOptions((current) => ({ ...current, duration: next }));
                      }} />
                    <span>{options.duration}s</span>
                  </label>}
              </span>
            </div>
            <span className="studio-composer-spacer" />
            {/* Never flips to a disabled spinner: each press queues another run
                and the in-flight ones report on their own tiles. */}
            <button type="button" className="studio-generate" aria-label={t('Generate')}
              data-tooltip={t('Generate')} disabled={!lane || !prompt.trim()} onClick={() => void generate()}>
              <Sparkles size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {selected && <div className="studio-detail" role="dialog" aria-label={t('Generated media detail')}
        data-phone={phoneViewer || narrowDetailViewer ? 'true' : undefined}
        data-pane-compact={narrowDetailViewer && !phoneViewer ? 'true' : undefined}
        onClick={() => setSelected(null)}>
        {/* One stable media/details frame on a dimmed backdrop. */}
        <div className="studio-detail-card" onClick={(event) => event.stopPropagation()}>
        <div className="studio-detail-stage">
          {selected.kind === 'video'
            ? <video key={mediaForeground ? 'foreground' : 'suspended'}
              src={mediaForeground ? assetUrl(selected.id, 'original') || previewUrl : undefined}
              poster={assetUrl(selected.id, 'thumb') || thumbs[selected.id] || undefined}
              controls={mediaForeground} autoPlay={mediaForeground} playsInline
              preload={mediaForeground ? 'metadata' : 'none'}
              onError={() => markUrlBroken(selected.id, 'original')} />
            // The tile rendition is already decoded, so the detail view opens
            // on it and swaps to the display rendition when that lands.
            : <img src={assetUrl(selected.id, 'display') || previewUrl || thumbs[selected.id] || ''}
              alt={selected.prompt} onError={() => markUrlBroken(selected.id, 'display')} />}
          {/* Phone viewer: the media is full-bleed, so its close control floats
              over the stage instead of sitting in the side rail's header. */}
          <button type="button" className="studio-detail-stage-close" aria-label={t('Close preview')}
            onClick={() => setSelected(null)}><X size={17} aria-hidden="true" /></button>
        </div>
        <aside className="studio-detail-side">
          <header>
            <b>{selected.kind === 'video' ? t('Video') : t('Image')}</b>
            <button type="button" className="studio-detail-close" aria-label={t('Close preview')}
              onClick={() => setSelected(null)}><X size={15} aria-hidden="true" /></button>
          </header>
          {detailSections(selected)}
        </aside>
        </div>
      </div>}
    </div>
    </div>
  </div>;
}
