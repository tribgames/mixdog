import { PanelLeft } from 'lucide-react';
import { type UIEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import type { StudioModelEntry } from './StudioRouteMenu';
import { useForegroundMedia } from './media-lifecycle';
import { ErrorNotice } from './ErrorNotice';
import { StudioCleanupBar } from './studio-cleanup';
import { ensureStudioLoad, reportStudioLoadStage } from './renderer-load-metrics';
import {
  readStudioAssetReferences,
  readStudioDraftMetadata,
  removeStudioAssetReferences,
  writeStudioDraftMetadata,
  type StudioReferenceStore,
} from './studio-draft-cache';
import {
  callCapability,
  DEFAULT_STUDIO_OPTIONS,
  errorText,
  laneSpec,
  MEDIA_KINDS,
  mediaFrameRatio,
  modelControls,
  posterFromVideo,
  resolveStudioModel,
  STUDIO_GRID_MAX_WIDTH,
  studioTargetRowHeight,
  type MediaAsset,
  type MediaAssetRead,
  type MediaKind,
  type MediaLane,
  type StudioApi,
  type StudioOptions,
} from './studio-support';
import { StudioComposer } from './studio-composer';
import { StudioGallery } from './studio-gallery';
import { StudioDetailViewer } from './studio-media-components';
import {
  useStudioAssetGallery,
  useStudioMediaJobs,
  useStudioMediaUrls,
  type StudioMediaJob,
  type StudioReference,
} from './studio-media-state';
import { shouldFocusSurfaceInput } from './surface-input-focus';
import { dataTransferHasLocalFiles } from './file-drag';
import {
  EAGER_THUMB_COUNT,
  TILE_SIZES,
  TILE_SIZE_KEY,
  RATIO_CACHE_KEY,
  mediaFile,
  startStudioThumbnailHydration,
  studioRouteRows,
} from './studio-pane-support';
import { useStudioDetailKeyboardNav } from './studio-pane-detail-nav';
import { useStudioGridWidth, useStudioPaneObserver } from './studio-pane-geometry';
import { createStudioMediaActions } from './studio-pane-media-actions';
import { useStudioDraftReferences } from './studio-pane-references';
import { createStudioGenerationActions } from './studio-pane-generation';
import { useStudioGridRows } from './studio-pane-layout';
import { useStudioRouteSync } from './studio-pane-route';
import { useStudioSelection } from './studio-pane-selection';

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
  const { assets, loadMoreAssets, reloadAssetKind, removeAsset, refreshAssetKind, visibleAssets } =
    useStudioAssetGallery(api, kind);
  const [selected, setSelected] = useState<MediaAsset | null>(null);
  // ABB: the media detail viewer closes on hardware back.
  useMobileBack(Boolean(selected), () => setSelected(null));
  useStudioDetailKeyboardNav(selected, visibleAssets, setSelected);
  const [previewUrl, setPreviewUrl] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [failedThumbs, setFailedThumbs] = useState<Record<string, boolean>>({});
  const failedThumbsRef = useRef<Record<string, boolean>>({});
  // A cold local rendition may take longer than the tile's stall threshold.
  // Start the renderer fallback without invalidating the still-live direct
  // request: dropping that URL produced an empty frame until fallback landed.
  const [thumbFallbacks, setThumbFallbacks] = useState<Record<string, true>>({});
  const [copied, setCopied] = useState(false);
  // Compact detail sheet: the prompt is clamped to two lines and expands on tap.
  const [promptOpen, setPromptOpen] = useState(false);
  // ABB: an expanded prompt folds before the detail itself closes.
  useMobileBack(Boolean(selected) && promptOpen, () => setPromptOpen(false));
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
      return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
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
    return TILE_SIZES.includes(stored as (typeof TILE_SIZES)[number]) ? stored : TILE_SIZES[1];
  });
  // Reference images for the next generation (edit / image-to-video).
  const [refs, setRefs] = useState<StudioReference[]>([]);
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
  useStudioDraftReferences(active, referenceStore, refs, setRefs);
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
  useEffect(
    () => () => {
      if (gridMotionFrame.current !== null) window.cancelAnimationFrame(gridMotionFrame.current);
    },
    []
  );
  // Mirror of the thumbnail cache: the hydration loop reads it without taking
  // a state dependency, so a landed thumbnail never restarts the loop.
  const thumbsRef = useRef<Record<string, string>>({});
  const loadedThumbsRef = useRef<Record<string, boolean>>({});

  const load = useCallback(
    async (metricToken?: number) => {
      // A thumbnail failure is terminal for ONE pass, not for the pane: a cold
      // rendition that timed out once otherwise left a permanent glyph until
      // the whole app restarted (user: 섬네일이 안 나온다). Entering Studio
      // again, or pressing Retry, starts those tiles over.
      failedThumbsRef.current = {};
      setFailedThumbs({});
      setThumbFallbacks({});
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
        .then((rows) => {
          const next = Array.isArray(rows) ? rows : [];
          setLanes(next);
          const errors = next.map((lane) => lane.catalogError).filter(Boolean);
          if (errors.length) throw new Error(errors.join('\n'));
        })
        .finally(() => setCatalogSettled(true));
      const settled = await Promise.allSettled([gallery, catalog]);
      const failed = settled.find((result) => result.status === 'rejected');
      setError(failed ? errorText((failed as PromiseRejectedResult).reason) : '');
      setLoading(false);
    },
    [api, refreshAssetKind]
  );

  useStudioPaneObserver(studioRootRef, dockRef, setNarrowPane);

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
    [lanes, kind]
  );
  // Which kinds have ANY authenticated lane: the toggle only offers what the
  // signed-in providers can actually produce (and hides entirely for one).
  const kindsOffered = useMemo(
    () => MEDIA_KINDS.filter((entry) => lanes.some((lane) => lane.authenticated && lane.kinds.includes(entry))),
    [lanes]
  );
  useEffect(() => {
    if (kindsOffered.length && !kindsOffered.includes(kind)) setKind(kindsOffered[0]);
  }, [kindsOffered, kind]);
  const lane = useMemo(
    () => available.find((entry) => entry.id === laneId) || available[0] || null,
    [available, laneId]
  );
  const spec = laneSpec(lane, kind);
  // Kind changes render before the synchronization effect runs. Resolve the
  // model against the active contract now so the previous kind's label never
  // reaches a paint.
  const activeModel = resolveStudioModel(spec, model);

  useStudioRouteSync({
    active,
    activeModel,
    api,
    kind,
    lane,
    laneId,
    model,
    setLaneId,
    setModel,
    setOptions,
    spec,
  });

  // Selected asset preview. With a byte-lane URL the DOM loads it directly;
  // this RPC payload is only the fallback for a host without that lane.
  useEffect(() => {
    // While the lane probe is in flight the RPC fallback would race it and
    // pull a payload the DOM is about to fetch itself.
    if (!selected || laneReady === null || assetUrl(selected.id, selected.kind === 'video' ? 'original' : 'display')) {
      setPreviewUrl('');
      return;
    }
    const token = ++previewToken.current;
    void (async () => {
      try {
        const result = (await callCapability(api, 'readMediaAsset', [
          selected.id,
          {
            variant: selected.kind === 'video' ? 'original' : 'display',
            allowOriginal: true,
          },
        ])) as MediaAssetRead | null;
        if (token !== previewToken.current) return;
        setPreviewUrl(result?.base64 ? `data:${result.mime || 'image/png'};base64,${result.base64}` : '');
      } catch (reason) {
        if (token === previewToken.current) setError(errorText(reason));
      }
    })();
  }, [api, assetUrl, laneReady, selected]);

  // A newly opened asset starts with its prompt collapsed again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the collapse must rerun when the opened asset id changes, though the effect body reads no dependency
  useEffect(() => {
    setPromptOpen(false);
  }, [selected?.id]);

  useEffect(() => {
    if (!active || laneReady === null) return undefined;
    return startStudioThumbnailHydration({
      api,
      assetUrl,
      captureVideoPoster,
      failedThumbsRef,
      loadedThumbsRef,
      localTransport,
      setDurations,
      setFailedThumbs,
      setThumbs,
      thumbFallbacks,
      thumbsRef,
      visibleAssets,
    });
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
  // Controls belong to the MODEL: Veo takes 4/6/8s, Grok takes a 1-15s range,
  // Omni takes none — a lane-wide guess would offer rejected values.
  const controls = modelControls(spec, activeModel);
  // The model publishes its own reference cap (Veo 1, Gemini 3, Grok 5/7).
  const maxRefs = controls.maxReferences ?? (kind === 'video' ? 7 : 5);
  useEffect(() => {
    if (!lane) return;
    setRefs((current) => (current.length > maxRefs ? current.slice(0, maxRefs) : current));
  }, [lane, maxRefs]);

  const { addDroppedFiles, addFiles, cancel, dismissJob, generate, openReference, startQueuedRequest } =
    createStudioGenerationActions({
      activeModel,
      api,
      controls,
      kind,
      lane,
      maxRefs,
      options,
      prompt,
      refs,
      setError,
      setJobs,
      setRefs,
    });

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

  const { checkedIds, cleanUp, exitSelection, selectAll, selecting, setSelecting, toggleChecked } = useStudioSelection({
    api,
    kind,
    referenceStore,
    reloadAssetKind,
    selected,
    setError,
    setHoverId,
    setJobs,
    setSelected,
  });

  /** The references an asset was generated with, as composer chips. */
  const assetReferences = async (asset: MediaAsset): Promise<StudioReference[]> =>
    (await readStudioAssetReferences(asset.id, referenceStore)).map((reference) => ({
      ...reference,
      url: `data:${reference.mime};base64,${reference.base64}`,
    }));

  // Reuse restores the recipe into the composer — prompt, route, options and
  // references — to edit before the next run instead of repeating it as is.
  const reusePrompt = async (asset: MediaAsset) => {
    const references = await assetReferences(asset);
    setKind(asset.kind);
    setLaneId(asset.lane);
    setModel(asset.model);
    setOptions((current) => ({ ...current, ...(asset.options || {}) }));
    setPrompt(asset.prompt);
    setRefs(references);
    setSelected(null);
    promptRef.current?.focus({ preventScroll: true });
  };

  const { copyPrompt, hoverPreview, openAsset, openAssetFolder, readOriginalMedia, saveAsset } =
    createStudioMediaActions({
      api,
      assetUrl,
      fullUrls,
      localTransport,
      setCopied,
      setError,
      setFullUrls,
      setHoverId,
    });

  // The asset joins the next run's references through the same reader as a
  // picked file, so the model's reference cap applies unchanged.
  const addAssetReference = async (asset: MediaAsset) => {
    try {
      await addFiles([mediaFile(asset, await readOriginalMedia(asset))]);
      setSelected(null);
      promptRef.current?.focus({ preventScroll: true });
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  // Detail actions: queue the saved request again, hand the file to the OS
  // viewer, or remove it from the gallery.
  const regenerate = async (asset: MediaAsset) => {
    if (!asset.prompt.trim()) return;
    const references = await assetReferences(asset);
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

  const openDetail = (asset: MediaAsset) => {
    setPromptOpen(false);
    setSelected(asset);
  };

  const kindSettled = kindsOffered.length === 0 || kindsOffered.includes(kind);
  const routeSettled = !lane || (lane.id === laneId && model === activeModel);
  const optionsSettled =
    (!controls.resolution?.length || controls.resolution.includes(options.resolution)) &&
    (!controls.aspectRatio?.length || controls.aspectRatio.includes(options.aspectRatio));
  // Thumbnail bytes are tile-local decoration. A cold, large, or broken first
  // asset must not hold the opaque Studio cover over an otherwise usable pane.
  const studioSurfaceReady =
    active && gridMotionReady && gallerySettled && catalogSettled && kindSettled && routeSettled && optionsSettled;
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
  useStudioGridWidth(active, gridRef, gridMotionFrame, setGridMotionReady, setGridWidth);
  // Every authenticated lane contributes its active-kind models to the
  // anchored picker, grouped by provider.
  const modelEntries = useMemo<StudioModelEntry[]>(
    () =>
      available.flatMap((entry) => {
        const kindSpec = kind === 'video' ? entry.video : entry.image;
        return (kindSpec?.models || []).map((option) => ({
          lane: entry.id,
          laneLabel: entry.label,
          authType: entry.authType,
          model: option.id,
          label: option.label,
          description: option.description,
        }));
      }),
    [available, kind]
  );
  const handleResultsScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (remaining > Math.max(240, element.clientHeight * 0.5)) return;
      void loadMoreAssets(kind).catch((reason) => setError(errorText(reason)));
    },
    [kind, loadMoreAssets]
  );
  const { layoutRows, pendingJobs } = useStudioGridRows({
    frameRatiosSource: ratios,
    gridWidth,
    jobs,
    kind,
    rowHeight,
    visibleAssets,
  });
  const { routeRows, durationSlider } = studioRouteRows({ controls, disabled, kind, options, setOptions });
  // Detail paging follows gallery order, and the rail names the route with the
  // catalog's labels instead of lane and model ids.
  const selectedIndex = selected ? visibleAssets.findIndex((asset) => asset.id === selected.id) : -1;
  const previousAsset = selectedIndex > 0 ? visibleAssets[selectedIndex - 1] || null : null;
  const nextAsset = selectedIndex >= 0 ? visibleAssets[selectedIndex + 1] || null : null;
  const selectedLane = selected ? lanes.find((entry) => entry.id === selected.lane) || null : null;
  const selectedModelLabel = selected
    ? laneSpec(selectedLane, selected.kind)?.models.find((entry) => entry.id === selected.model)?.label ||
      selected.model
    : '';
  // Paging toward the end of the loaded list pulls the next page, so a swipe
  // through a long gallery never dead-ends at a page boundary.
  useEffect(() => {
    if (selectedIndex < 0 || selectedIndex < visibleAssets.length - 3) return;
    void loadMoreAssets(kind).catch((reason) => setError(errorText(reason)));
  }, [kind, loadMoreAssets, selectedIndex, visibleAssets.length]);
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
    setThumbFallbacks((current) => (current[assetId] ? current : { ...current, [assetId]: true }));
  };
  const updateTileSize = (next: number) => {
    setTileSize(next);
    try {
      window.localStorage.setItem(TILE_SIZE_KEY, String(next));
    } catch {
      // Density is a convenience.
    }
  };

  return (
    <div
      className="studio-root stable-surface-preserved"
      ref={studioRootRef}
      data-surface-active={active ? 'true' : 'false'}
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}
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
      }}
    >
      <div className="studio-pane">
        <div className="studio-shell">
          {/* Desktop already names this surface in its workspace tab. Phones keep
          only the drawer reopen control because their tab strip is hidden. */}
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: header is the page banner landmark here; the label names it */}
          <header className="session-header studio-header" aria-label={t('Studio navigation')}>
            <div className="session-header-content">
              {/* Phone-only sidebar reopen, exactly like the chat header. Desktop
              uses the Activity Rail's Sessions control. */}
              <button
                type="button"
                className="toolbar-sidebar session-header-menu"
                aria-label={t('Toggle session list')}
                aria-expanded={sidebarOpen}
                onClick={onToggleSidebar}
              >
                <PanelLeft className="sidebar-toggle-icon" size={18} aria-hidden="true" />
              </button>
            </div>
          </header>
          <div className="studio-stage-host">
            <StudioGallery
              assetUrl={assetUrl}
              checkedIds={checkedIds}
              cleanup={
                <StudioCleanupBar
                  selecting={selecting}
                  selectedCount={checkedIds.size}
                  visibleCount={visibleAssets.length}
                  onSelectMode={() => setSelecting(true)}
                  onSelectAll={() => void selectAll()}
                  onDeleteSelected={() =>
                    void cleanUp({ ids: [...checkedIds] }, (total) =>
                      t('Delete {{total}} selected items permanently? This cannot be undone.', { total })
                    )
                  }
                  onExitSelection={exitSelection}
                  onCleanUp={(filter, confirmText) => void cleanUp(filter, confirmText)}
                />
              }
              durations={durations}
              eagerThumbnailCount={EAGER_THUMB_COUNT}
              failedThumbs={failedThumbs}
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
              selecting={selecting}
              thumbs={thumbs}
              tileSize={tileSize}
              tileSizes={TILE_SIZES}
              visibleAssets={visibleAssets}
              onCancel={(id) => void cancel(id)}
              onDelete={(asset) => void remove(asset)}
              onDismiss={dismissJob}
              onHoverEnd={() => setHoverId('')}
              onHoverStart={(asset) => void hoverPreview(asset)}
              onKindChange={(next) => {
                exitSelection();
                setKind(next);
              }}
              onOpen={openDetail}
              onResultsScroll={handleResultsScroll}
              onRetry={retryJob}
              onThumbnailError={(assetId) => markUrlBroken(assetId, 'thumb')}
              onThumbnailLoad={rememberThumbnailRatio}
              onThumbnailStall={startThumbnailFallback}
              onTileSizeChange={updateTileSize}
              onToggleChecked={toggleChecked}
            />
          </div>
          <div className="studio-dock" ref={dockRef}>
            {/* Progress AND job failures live on the pending tile; the banner is
            only for pane-level errors. */}
            <ErrorNotice error={error} onDismiss={() => setError('')} />
            {lanes.some((entry) => entry.catalogError || entry.catalogWarning) && (
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setLoading(true);
                  void load();
                }}
              >
                {t('Retry')}
              </button>
            )}
            {lanes
              .filter((entry) => entry.catalogWarning)
              .map((entry) => (
                <p className="studio-status" role="status" key={entry.id}>
                  {entry.label}: {entry.catalogWarning}
                </p>
              ))}
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
          {selected && (
            <StudioDetailViewer
              asset={selected}
              assetUrl={assetUrl}
              canUseAsReference={refs.length < maxRefs}
              copied={copied}
              localTransport={localTransport}
              mediaForeground={mediaForeground}
              modelLabel={selectedModelLabel}
              previewUrl={previewUrl}
              promptOpen={promptOpen}
              providerLabel={selectedLane?.label || selected.lane}
              thumbUrl={thumbs[selected.id] || ''}
              onClose={() => setSelected(null)}
              onCopyPrompt={(asset) => void copyPrompt(asset)}
              onNext={nextAsset ? () => setSelected(nextAsset) : undefined}
              onOpenAsset={(asset) => void openAsset(asset)}
              onOpenFolder={(asset) => void openAssetFolder(asset)}
              onPrevious={previousAsset ? () => setSelected(previousAsset) : undefined}
              onRegenerate={(asset) => void regenerate(asset)}
              onRemove={(asset) => void remove(asset)}
              onReusePrompt={(asset) => void reusePrompt(asset)}
              onSave={(asset) => void saveAsset(asset)}
              onTogglePrompt={() => setPromptOpen((current) => !current)}
              onUrlBroken={markUrlBroken}
              onUseAsReference={(asset) => void addAssetReference(asset)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
