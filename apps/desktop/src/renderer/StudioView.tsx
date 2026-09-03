import { PanelLeft } from 'lucide-react';
import { type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import {
  type StudioModelEntry,
  type StudioOptionRow,
  type StudioSliderRow,
} from './StudioRouteMenu';
import { cancelLayoutFrame, scheduleLayoutFrame } from './interaction-frame-scheduler';
import { useForegroundMedia } from './media-lifecycle';
import { InlineErrors } from './notifications';
import {
  ensureStudioLoad,
  reportStudioLoadStage,
} from './renderer-load-metrics';
import {
  readStudioAssetReferences,
  readStudioDraftMetadata,
  readStudioDraftReferences,
  removeStudioAssetReferences,
  writeStudioDraftMetadata,
  writeStudioDraftReferences,
  type StudioReferenceStore,
} from './studio-draft-cache';
import {
  callCapability,
  DEFAULT_STUDIO_OPTIONS,
  errorText,
  justifiedRows,
  laneSpec,
  MEDIA_KINDS,
  mediaFrameRatio,
  modelControls,
  posterFromVideo,
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
import { StudioComposer } from './studio-composer';
import { StudioGallery } from './studio-gallery';
import { StudioDetailViewer } from './studio-media-components';
import {
  useStudioAssetGallery,
  useStudioMediaJobs,
  useStudioMediaUrls,
  type QueuedMediaRequest,
  type StudioMediaJob,
  type StudioReference,
} from './studio-media-state';
import { shouldFocusSurfaceInput } from './surface-input-focus';

// Thumbnails are round-trip bound, not byte bound: a strictly sequential loop
// paid one full relay round trip per tile.
const THUMB_CONCURRENCY = 4;
const EAGER_THUMB_COUNT = 12;
const STUDIO_NARROW_PANE = 760;
// Gallery density steps: columns per row. The slider presents these in reverse
// so moving right follows the familiar smaller → larger thumbnail direction.
const TILE_SIZES = [3, 4, 5, 6] as const;
const TILE_SIZE_KEY = 'mixdog.studio-tile-size';
const RATIO_CACHE_KEY = 'mixdog.studio-tile-ratios';
let videoPosterFallbackTail: Promise<void> = Promise.resolve();

function scheduleVideoPosterFallback<T>(task: () => Promise<T>): Promise<T> {
  const result = videoPosterFallbackTail.then(task, task);
  videoPosterFallbackTail = result.then(() => undefined, () => undefined);
  return result;
}

function thumbnailPayload(dataUrl: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl);
  return match ? { mime: match[1], base64: match[2] } : null;
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
import {
  dataTransferHasLocalFiles,
  materializeDroppedFiles,
} from "./file-drag";

export function StudioPane({
  api = window.mixdogDesktop,
  active = true,
  sidebarOpen = false,
  onToggleSidebar,
  onReady,
  captureVideoPoster = posterFromVideo,
  referenceStore,
}: {
  api?: StudioApi;
  active?: boolean;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onReady?: () => void;
  captureVideoPoster?: typeof posterFromVideo;
  referenceStore?: StudioReferenceStore;
}) {
  const bootMetricToken = ensureStudioLoad();
  reportStudioLoadStage('module', '', false, bootMetricToken);
  const [restoredDraft] = useState(() => readStudioDraftMetadata());
  const [lanes, setLanes] = useState<MediaLane[]>([]);
  const [kind, setKind] = useState<MediaKind>(restoredDraft?.kind || 'image');
  const [laneId, setLaneId] = useState(restoredDraft?.laneId || '');
  const [model, setModel] = useState(restoredDraft?.model || '');
  const [options, setOptions] = useState<StudioOptions>(() => ({
    ...DEFAULT_STUDIO_OPTIONS,
    ...(restoredDraft?.options || {}),
  }));
  const [prompt, setPrompt] = useState(restoredDraft?.prompt || '');
  const {
    assets,
    loadMoreAssets,
    removeAsset,
    refreshAssetKind,
    visibleAssets,
  } = useStudioAssetGallery(api, kind);
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  // ABB: the media detail viewer closes on hardware back.
  useMobileBack(Boolean(selected), () => setSelected(null));
  useEffect(() => {
    if (!selected) return undefined;
    const navigate = (event: KeyboardEvent) => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || event.isComposing || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target instanceof HTMLVideoElement
        || (target instanceof HTMLElement && target.isContentEditable)) return;
      const index = visibleAssets.findIndex((asset) => asset.id === selected.id);
      if (index < 0) return;
      const next = visibleAssets[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setSelected(next);
    };
    window.addEventListener('keydown', navigate);
    return () => window.removeEventListener('keydown', navigate);
  }, [selected, visibleAssets]);
  const [previewUrl, setPreviewUrl] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  // A cold local rendition may take longer than the tile's stall threshold.
  // Start the renderer fallback without invalidating the still-live direct
  // request: dropping that URL produced an empty frame until fallback landed.
  const [thumbFallbacks, setThumbFallbacks] = useState<Record<string, true>>({});
  const [copied, setCopied] = useState(false);
  // Compact detail sheet: the prompt is clamped to two lines and expands on tap.
  const [promptOpen, setPromptOpen] = useState(false);
  // Tile hover chrome follows the Studio PANE, not the window — a split
  // leaf can be narrow while the window is still wide.
  const [narrowPane, setNarrowPane] = useState(false);
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
  const [refs, setRefs] = useState<StudioReference[]>([]);
  const [refsHydrated, setRefsHydrated] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [gallerySettled, setGallerySettled] = useState(false);
  const [catalogSettled, setCatalogSettled] = useState(false);
  const { jobs, runningKey, setJobs } = useStudioMediaJobs({
    active,
    api,
    assets,
    referenceStore,
    refreshAssetKind,
    setError,
  });
  const previewToken = useRef(0);
  useEffect(() => {
    if (!active) return;
    writeStudioDraftMetadata({ kind, laneId, model, options, prompt });
  }, [active, kind, laneId, model, options, prompt]);
  useEffect(() => {
    let stopped = false;
    void readStudioDraftReferences(referenceStore).then((cached) => {
      if (stopped) return;
      setRefs((current) => current.length ? current : cached.map((reference) => ({
        ...reference,
        url: `data:${reference.mime};base64,${reference.base64}`,
      })));
      setRefsHydrated(true);
    });
    return () => { stopped = true; };
  }, [referenceStore]);
  useEffect(() => {
    if (!active || !refsHydrated) return;
    void writeStudioDraftReferences(refs, referenceStore);
  }, [active, referenceStore, refs, refsHydrated]);
  // Media bytes ride local IPC on the desktop and the LAN bridge / relay in
  // the web app. Only a local host may fall back to shrinking a full-size
  // asset here; remotely that transfer is exactly the cost being removed.
  const { assetUrl, laneReady, localTransport, markUrlBroken } = useStudioMediaUrls(api, active);
  const mediaForeground = useForegroundMedia(active);
  const gridRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const studioRootRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => () => {
    if (gridMotionFrame.current !== null) window.cancelAnimationFrame(gridMotionFrame.current);
  }, []);
  // Mirror of the thumbnail cache: the hydration loop reads it without taking
  // a state dependency, so a landed thumbnail never restarts the loop.
  const thumbsRef = useRef<Record<string, string>>({});
  const loadedThumbsRef = useRef<Record<string, boolean>>({});

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

  useLayoutEffect(() => {
    const element = studioRootRef.current;
    if (!element) return undefined;
    const dock = dockRef.current;
    const apply = (width: number) => {
      if (width > 0) setNarrowPane(width <= STUDIO_NARROW_PANE);
    };
    const applyDockHeight = (height: number) => {
      if (height > 0) {
        element.style.setProperty('--studio-dock-overlay-height', `${Math.ceil(height)}px`);
      }
    };
    apply(element.getBoundingClientRect().width);
    applyDockHeight(dock?.getBoundingClientRect().height || 0);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver((entries) => {
      const rootEntry = entries.find((candidate) => candidate.target === element);
      if (rootEntry) apply(rootEntry.contentRect.width || element.getBoundingClientRect().width);
      const dockEntry = entries.find((candidate) => candidate.target === dock);
      if (dockEntry) applyDockHeight(dockEntry.contentRect.height);
    });
    observer.observe(element);
    if (dock) observer.observe(dock);
    return () => {
      observer.disconnect();
      element.style.removeProperty('--studio-dock-overlay-height');
    };
  }, []);

  useEffect(() => {
    if (active) {
      const metricToken = ensureStudioLoad();
      void load(metricToken);
    }
  }, [active, load]);

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
  useEffect(() => {
    if (!lane) return;
    setRefs((current) => current.length > maxRefs ? current.slice(0, maxRefs) : current);
  }, [lane, maxRefs]);

  const openReference = async (
    reference: StudioReference,
    index: number,
  ) => {
    const extension = reference.mime.split('/')[1]?.replace(/[^a-z0-9.+-]/gi, '') || 'png';
    try {
      await api?.openAttachmentImage?.(reference.url, `reference-${index + 1}.${extension}`);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

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
  const addDroppedFiles = async (transfer: DataTransfer) => {
    const loaded = await materializeDroppedFiles(
      window.mixdogDesktop,
      transfer,
      Math.max(0, maxRefs - refs.length),
    );
    const images = loaded.files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      setError(loaded.errors[0] || t("Drop an image file to add a reference."));
      return;
    }
    setError(loaded.errors[0] || "");
    await addFiles(images);
  };

  const startQueuedRequest = async (request: QueuedMediaRequest): Promise<boolean> => {
    setError('');
    try {
      const started = await callCapability(api, 'startMediaJob', [{
        lane: request.lane,
        kind: request.kind,
        model: request.model,
        prompt: request.prompt,
        options: { ...request.options },
        references: request.references.map((ref) => ({
          base64: ref.base64,
          mime: ref.mime,
        })),
      }]) as MediaJob | undefined;
      if (started) {
        setJobs((current) => [{ ...started, request }, ...current]);
        return true;
      }
      // An empty answer used to return silently, so Generate looked like a
      // dead button with nothing to read anywhere (user: 생성이 안 되는데
      // 오류도 안 뜬다).
      setError(t('Generation did not start — the runtime returned no job.'));
    } catch (reason) {
      setError(errorText(reason));
    }
    return false;
  };

  const generate = async () => {
    // No busy guard: a second Generate queues another run behind the first.
    if (!lane || !prompt.trim()) return;
    // Capture every mutable composer field before crossing the async bridge.
    // Later prompt/reference edits belong only to the next queue slot.
    await startQueuedRequest({
      lane: lane.id,
      kind,
      model: activeModel,
      prompt: prompt.trim(),
      options: { ...requestOptions(modelControls(spec, activeModel), kind, options) },
      references: refs.map((ref) => ({ ...ref })),
    });
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
      await removeStudioAssetReferences(asset.id, referenceStore);
      if (selected?.id === asset.id) setSelected(null);
      removeAsset(asset);
      // The run that produced this asset goes with it. A job left behind would
      // re-open its queue slot the moment the asset left the gallery.
      setJobs((current) => current.filter((entry) => entry.assetId !== asset.id));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  // Detail actions: queue the saved request again, hand the file to the OS
  // viewer, or remove it from the gallery.
  const regenerate = async (asset: MediaAsset) => {
    if (!asset.prompt.trim()) return;
    const references = (await readStudioAssetReferences(asset.id, referenceStore)).map((reference) => ({
      ...reference,
      url: `data:${reference.mime};base64,${reference.base64}`,
    }));
    const started = await startQueuedRequest({
      lane: asset.lane,
      kind: asset.kind,
      model: asset.model,
      prompt: asset.prompt.trim(),
      options: { ...(asset.options || {}) },
      references,
    });
    if (started) {
      setKind(asset.kind);
      setSelected(null);
    }
  };

  const openAsset = async (asset: MediaAsset) => {
    try {
      if (api?.openMediaAsset) await api.openMediaAsset(asset.id);
      else await callCapability(api, 'openMediaAsset', [asset.id]);
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const openAssetFolder = async (asset: MediaAsset) => {
    try {
      if (api?.openMediaFolder) await api.openMediaFolder(asset.id);
      else await callCapability(api, 'openMediaFolder', [asset.id]);
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

  // Controls belong to the MODEL: Veo takes 4/6/8s, Grok takes a 1-15s range,
  // Omni takes none — a lane-wide guess would offer rejected values.
  const controls = modelControls(spec, activeModel);
  const kindSettled = kindsOffered.length === 0 || kindsOffered.includes(kind);
  const routeSettled = !lane || (lane.id === laneId && model === activeModel);
  const optionsSettled = (
    (!controls.resolution?.length || controls.resolution.includes(options.resolution))
    && (!controls.aspectRatio?.length || controls.aspectRatio.includes(options.aspectRatio))
  );
  // Thumbnail bytes are tile-local decoration. A cold, large, or broken first
  // asset must not hold the opaque Studio cover over an otherwise usable pane.
  const studioSurfaceReady = active
    && gridMotionReady
    && gallerySettled
    && catalogSettled
    && kindSettled
    && routeSettled
    && optionsSettled;
  useEffect(() => {
    if (!studioSurfaceReady) return;
    reportStudioLoadStage('shell', '', false, bootMetricToken);
    reportStudioLoadStage('interactive', '', true, bootMetricToken);
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
  const handleResultsScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
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
  // Raw lane vocabulary ("auto", "1k") reads as noise next to the model
  // name, so rows show a cased label while the value stays native.
  const optionRow = (
    id: string,
    label: string,
    values: readonly string[],
    current: string,
    onPick: (value: string) => void,
  ): StudioOptionRow => ({
    id,
    label,
    options: values.map((value) => ({ value, label: pillLabel(value) })),
    value: current,
    valueLabel: pillLabel(current),
    disabled,
    onPick,
  });
  const routeRows: StudioOptionRow[] = [
    ...(controls.aspectRatio?.length
      ? [optionRow('aspectRatio', t('Aspect'), controls.aspectRatio, options.aspectRatio,
        (value) => setOptions((current) => ({ ...current, aspectRatio: value })))]
      : []),
    ...(controls.resolution?.length
      ? [optionRow('resolution', t('Resolution'), controls.resolution,
        options.resolution || controls.resolution[0],
        (value) => setOptions((current) => ({ ...current, resolution: value })))]
      : []),
    ...(controls.size?.length
      ? [optionRow('size', t('Size'), controls.size, options.size,
        (value) => setOptions((current) => ({ ...current, size: value })))]
      : []),
    ...(controls.quality?.length
      ? [optionRow('quality', t('Quality'), controls.quality, options.quality,
        (value) => setOptions((current) => ({ ...current, quality: value })))]
      : []),
    ...(kind === 'video' && controls.durations?.length
      ? [optionRow('duration', t('Duration'),
        controls.durations.map((value) => `${value}s`), `${options.duration}s`,
        (value) => setOptions((current) => ({
          ...current,
          duration: Number.parseInt(value, 10) || current.duration,
        })))]
      : []),
  ];
  const durationSlider: StudioSliderRow | null = kind === 'video'
    && !controls.durations?.length && controls.durationRange
    ? {
        label: t('Duration'),
        min: controls.durationRange[0] ?? 1,
        max: controls.durationRange[1] ?? 15,
        value: options.duration,
        disabled,
        onChange: (next) => setOptions((current) => ({ ...current, duration: next })),
      }
    : null;
  const retryJob = (entry: StudioMediaJob) => {
    dismissJob(entry.id);
    void (entry.request ? startQueuedRequest(entry.request) : generate());
  };
  const rememberThumbnailRatio = (asset: MediaAsset) => {
    loadedThumbsRef.current[asset.id] = true;
    setRatios((current) => {
      if (current[asset.id]) return current;
      const next = { ...current, [asset.id]: mediaFrameRatio(asset) };
      try {
        window.localStorage.setItem(RATIO_CACHE_KEY, JSON.stringify(next));
      } catch {
        // Ratio cache is a convenience.
      }
      return next;
    });
  };
  const startThumbnailFallback = (assetId: string) => {
    setThumbFallbacks((current) => current[assetId]
      ? current
      : { ...current, [assetId]: true });
  };
  const updateTileSize = (next: number) => {
    setTileSize(next);
    try {
      window.localStorage.setItem(TILE_SIZE_KEY, String(next));
    } catch {
      // Density is a convenience.
    }
  };

  return <div className="studio-root stable-surface-preserved" ref={studioRootRef}
    data-surface-active={active ? 'true' : 'false'}
    inert={active ? undefined : true} aria-hidden={active ? undefined : true}
    onDragEnter={(event) => {
      if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropping(true);
    }}
    onDragOver={(event) => {
      if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      setDropping(true);
    }}
    onDragLeave={(event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node)) return;
      setDropping(false);
    }}
    onDrop={(event) => {
      if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropping(false);
      void addDroppedFiles(event.dataTransfer);
    }}
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
          {/* Phone-only sidebar reopen, exactly like the chat header. Desktop
              uses the Activity Rail's Sessions control. */}
          <button type="button" className="toolbar-sidebar session-header-menu"
            aria-label={t('Toggle session list')} aria-expanded={sidebarOpen}
            onClick={onToggleSidebar}>
            <PanelLeft className="sidebar-toggle-icon" size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="studio-stage-host">
        <StudioGallery
          assetUrl={assetUrl}
          durations={durations}
          eagerThumbnailCount={EAGER_THUMB_COUNT}
          fullUrls={fullUrls}
          gridMotionReady={gridMotionReady}
          gridRef={gridRef}
          gridWidth={gridWidth}
          hasAvailableLane={available.length > 0}
          hoverId={hoverId}
          kind={kind}
          kindsOffered={kindsOffered}
          layoutRows={layoutRows}
          loading={loading}
          localTransport={localTransport}
          mediaForeground={mediaForeground}
          narrowPane={narrowPane}
          pendingJobs={pendingJobs}
          resultsRef={resultsRef}
          rowHeight={rowHeight}
          selectedId={selected?.id || ''}
          thumbs={thumbs}
          tileSize={tileSize}
          tileSizes={TILE_SIZES}
          visibleAssets={visibleAssets}
          onCancel={(id) => void cancel(id)}
          onDelete={(asset) => void remove(asset)}
          onDismiss={dismissJob}
          onHoverEnd={() => setHoverId('')}
          onHoverStart={(asset) => void hoverPreview(asset)}
          onKindChange={setKind}
          onOpen={openDetail}
          onResultsScroll={handleResultsScroll}
          onRetry={retryJob}
          onThumbnailError={(assetId) => markUrlBroken(assetId, 'thumb')}
          onThumbnailLoad={rememberThumbnailRatio}
          onThumbnailStall={startThumbnailFallback}
          onTileSizeChange={updateTileSize}
        />
      </div>
      <div className="studio-dock" ref={dockRef}>
        {/* Progress AND job failures live on the pending tile; the banner is
            only for pane-level errors. */}
        <InlineErrors messages={[error].filter(Boolean)} />
        <StudioComposer
          dropping={dropping}
          kind={kind}
          lane={lane?.id || ''}
          maxReferences={maxRefs}
          model={activeModel}
          modelEntries={modelEntries}
          prompt={prompt}
          promptRef={promptRef}
          references={refs}
          routeRows={routeRows}
          slider={durationSlider}
          onFiles={addFiles}
          onGenerate={() => void generate()}
          onOpenReference={openReference}
          onPromptChange={setPrompt}
          onReferencesChange={setRefs}
          onSelectModel={(entry) => {
            setLaneId(entry.lane);
            setModel(entry.model);
          }}
        />
      </div>
      {selected && <StudioDetailViewer
        asset={selected}
        assetUrl={assetUrl}
        copied={copied}
        localTransport={localTransport}
        mediaForeground={mediaForeground}
        previewUrl={previewUrl}
        promptOpen={promptOpen}
        thumbUrl={thumbs[selected.id] || ''}
        onClose={() => setSelected(null)}
        onCopyPrompt={(asset) => void copyPrompt(asset)}
        onOpenAsset={(asset) => void openAsset(asset)}
        onOpenFolder={(asset) => void openAssetFolder(asset)}
        onRegenerate={(asset) => void regenerate(asset)}
        onRemove={(asset) => void remove(asset)}
        onTogglePrompt={() => setPromptOpen((current) => !current)}
        onUrlBroken={markUrlBroken}
      />}
    </div>
    </div>
  </div>;
}
