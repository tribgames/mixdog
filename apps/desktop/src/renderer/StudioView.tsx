import { type UIEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n';
import { useForegroundMedia } from './media-lifecycle';
import { ErrorNotice } from './ErrorNotice';
import { StudioCleanupBar } from './studio-cleanup';
import { ensureStudioLoad, reportStudioLoadStage } from './renderer-load-metrics';
import type { StudioReferenceStore } from './studio-draft-cache';
import {
  errorText,
  MEDIA_KINDS,
  type MediaAsset,
  modelControls,
  posterFromVideo,
  studioTargetRowHeight,
  type StudioApi,
} from './studio-support';
import { useStudioDetailView, useStudioDraft, useStudioGridMotion } from './studio-pane-state';
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
import {
  focusStudioPane,
  hideStudioPane,
  publishStudioPaneState,
  showStudioPane,
  useStudioPaneOwner,
} from './studio-panel-bridge';
import {
  moveStudioAssets,
  onStudioAssetsMoved,
  openStudioBoard,
  refreshStudioBoards,
  useStudioBoards,
  useStudioBoardsWatch,
} from './studio-boards';
import { shouldFocusSurfaceInput } from './surface-input-focus';
import { EAGER_THUMB_COUNT, TILE_SIZES, studioRouteRows } from './studio-pane-support';
import { useStudioLaneCatalog, useStudioLaneChoice, useStudioLoad } from './studio-pane-catalog';
import { useStudioDetailPaging } from './studio-pane-detail';
import { useStudioJobClock, useStudioReadyReport } from './studio-pane-status';
import { useStudioThumbnailHydration, useStudioThumbnailState } from './studio-pane-thumbnails';
import { StudioCatalogNotices, StudioHeader, studioDropHandlers } from './studio-pane-chrome';
import { studioModelEntries } from './studio-pane-models';
import { useStudioTileSize } from './studio-pane-persisted';
import { useStudioSelectedPreview } from './studio-pane-preview';
import { createStudioAssetActions } from './studio-pane-asset-actions';
import { useStudioPaneObserver } from './studio-pane-geometry';
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
  tabKey,
  focused = true,
  sidebarOpen = false,
  onToggleSidebar,
  onReady,
  captureVideoPoster = posterFromVideo,
  referenceStore,
}: {
  api?: StudioApi;
  active?: boolean;
  /** This pane's tab key: where the rail panel aims a work to open. */
  tabKey?: string;
  /** The pane's leaf is the focused one. */
  focused?: boolean;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onReady?: () => void;
  captureVideoPoster?: typeof posterFromVideo;
  referenceStore?: StudioReferenceStore;
}) {
  const bootMetricToken = ensureStudioLoad();
  reportStudioLoadStage('module', '', false, bootMetricToken);
  const { kind, setKind, laneId, setLaneId, model, setModel, options, setOptions, prompt, setPrompt } =
    useStudioDraft(active);
  // The open board (shared with the rail panel): the gallery shows only its
  // results and new runs join it; '' is "전체", every result.
  const { boards, openId: boardId, total: allCount, loaded: boardsLoaded } = useStudioBoards(api, active);
  useStudioBoardsWatch(api, active);
  const {
    assets,
    loadedTotal,
    loadMoreAssets,
    moveAssets,
    reloadAssetKind,
    removeAsset,
    refreshAssetKind,
    syncAssetKind,
    visibleAssets,
  } = useStudioAssetGallery(api, kind, boardId);
  const studioRootRef = useRef<HTMLDivElement>(null);
  const { selected, setSelected, promptOpen, togglePrompt, openDetail } = useStudioDetailView(
    visibleAssets,
    studioRootRef,
    active && focused
  );
  const thumbnails = useStudioThumbnailState();
  const [copied, setCopied] = useState(false);
  // Tile hover chrome follows the Studio PANE, not the window — a split
  // leaf can be narrow while the window is still wide.
  const [narrowPane, setNarrowPane] = useState(false);
  const [dropping, setDropping] = useState(false);
  // Hover preview: exactly one <video> is mounted at a time (a grid full of
  // live decoders is what took the window down before).
  const [hoverId, setHoverId] = useState('');
  const [fullUrls, setFullUrls] = useState<Record<string, string>>({});
  const [tileSize, updateTileSize] = useStudioTileSize();
  // Reference images for the next generation (edit / image-to-video).
  const [refs, setRefs] = useState<StudioReference[]>([]);
  const [error, setError] = useState('');
  const { jobs, runningKey, setJobs } = useStudioMediaJobs({
    active,
    api,
    assets,
    referenceStore,
    refreshAssetKind,
    setError,
  });
  useStudioDraftReferences(active, referenceStore, refs, setRefs);
  // Media bytes ride local IPC on the desktop and the LAN bridge / relay in
  // the web app. Only a local host may fall back to shrinking a full-size
  // asset here; remotely that transfer is exactly the cost being removed.
  const { assetUrl, laneReady, localTransport, markUrlBroken } = useStudioMediaUrls(api, active);
  const mediaForeground = useForegroundMedia(active);
  const gridRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const { gridWidth, gridMotionReady } = useStudioGridMotion(active, gridRef);
  const { lanes, loadLanes, catalogErrorText } = useStudioLaneCatalog(api, active, setError);

  useStudioPaneObserver(studioRootRef, dockRef, setNarrowPane);

  const { loading, gallerySettled, catalogSettled, retry } = useStudioLoad({
    active,
    refreshAssetKind,
    loadLanes,
    resetThumbnails: thumbnails.reset,
    setError,
    ensureMetricToken: ensureStudioLoad,
  });

  // A Studio tab is a persistent workspace surface: switching tabs must keep
  // its prompt, mode, references, selected asset, queue, and scroll position.
  useLayoutEffect(() => {
    if (!active) return;
    // No unfold on entry (user): display:none → visible restarts CSS
    // animations. The entry frame renders animation-free.
    // Chat-composer parity (user): entering Studio lands the caret in the
    // prompt so typing starts immediately, like the session composer.
    promptRef.current?.focus();
  }, [active]);
  useEffect(() => {
    if (!mediaForeground) setHoverId('');
  }, [mediaForeground]);
  const { available, kindsOffered, lane, spec, activeModel } = useStudioLaneChoice({
    lanes,
    kind,
    setKind,
    laneId,
    model,
  });

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

  const previewUrl = useStudioSelectedPreview(api, assetUrl, laneReady, selected, setError);

  useStudioThumbnailHydration({
    state: thumbnails.hydration,
    active,
    api,
    assetUrl,
    captureVideoPoster,
    laneReady,
    localTransport,
    visibleAssets,
  });

  useStudioJobClock(active, Boolean(runningKey));
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
      boardId,
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

  const { checkedIds, cleanUp, exitSelection, selectAll, selecting, setSelecting, toggleChecked } = useStudioSelection({
    api,
    boardId,
    kind,
    referenceStore,
    reloadAssetKind,
    selected,
    setError,
    setHoverId,
    setJobs,
    setSelected,
  });

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

  const { addAssetReference, regenerate, remove, reusePrompt } = createStudioAssetActions({
    addFiles,
    api,
    promptRef,
    readOriginalMedia,
    referenceStore,
    removeAsset,
    selected,
    setError,
    setHoverId,
    setJobs,
    setKind,
    setLaneId,
    setModel,
    setOptions,
    setPrompt,
    setRefs,
    setSelected,
    startQueuedRequest,
  });

  // The rail's Studio panel mirrors the shown pane the user focused last (its
  // runs and open work), opens a work in the one pane it was aimed at, and
  // drops works from all (studio-panel-bridge).
  const instanceKey = useId();
  const paneKey = tabKey ?? instanceKey;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    if (!active) return undefined;
    showStudioPane(paneKey, focusedRef.current);
    return () => hideStudioPane(paneKey);
  }, [active, paneKey]);
  useEffect(() => {
    if (active && focused) focusStudioPane(paneKey);
  }, [active, focused, paneKey]);
  const owner = useStudioPaneOwner(paneKey);
  useEffect(() => {
    if (owner) publishStudioPaneState(paneKey, jobs);
  }, [owner, paneKey, jobs]);
  // Another board opened: the gallery reads that board from its first page.
  const shownBoardRef = useRef(boardId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the board id is the trigger
  useEffect(() => {
    if (shownBoardRef.current === boardId) return;
    shownBoardRef.current = boardId;
    exitSelection();
    setSelected(null);
    if (!active) return;
    Promise.all(MEDIA_KINDS.map((assetKind) => refreshAssetKind(assetKind))).catch((reason) =>
      setError(errorText(reason))
    );
  }, [boardId, active]);
  useEffect(() => onStudioAssetsMoved(moveAssets), [moveAssets]);
  // A finished run changes its board's count and thumbnail.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runningKey is the trigger
  useEffect(() => {
    if (active) void refreshStudioBoards(api).catch(() => {});
  }, [active, api, runningKey]);
  const recountBoards = () => refreshStudioBoards(api).catch(() => {});
  const removeAndRecount = (asset: MediaAsset) => void remove(asset).then(recountBoards);
  const moveToBoard = (asset: MediaAsset, target: string) =>
    void moveStudioAssets(api, [asset.id], target).catch((reason) => setError(errorText(reason)));
  // A board view lists only the runs that land in it.
  const boardJobs = useMemo(
    () => (boardId ? jobs.filter((entry) => (entry.request?.boardId ?? '') === boardId) : jobs),
    [jobs, boardId]
  );
  // The count the panel shows for this view; when it moves away from what the
  // loaded pages were counted at, results came from elsewhere (the agent media
  // tool, another window or device): fold them in, keeping loaded pages. A run
  // of this view's own is still landing, so that waits until it settles.
  const shownCount = boardId ? boards.find((board) => board.id === boardId)?.count : allCount;
  const viewRunning = boardJobs.some((entry) => entry.status === 'running');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shown count and the run settling are the triggers
  useEffect(() => {
    if (!active || !boardsLoaded || shownCount === undefined || viewRunning) return;
    const known = loadedTotal();
    if (known === null || known === shownCount) return;
    for (const assetKind of MEDIA_KINDS) void syncAssetKind(assetKind).catch(() => {});
  }, [active, boardsLoaded, shownCount, viewRunning]);

  useStudioReadyReport({
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
    onReady: onReadyRef,
  });
  // Only a missing lane disables the composer: a run in flight must not, since
  // Generate queues the next one (user: 큐에 올리는 방식이라 버튼 막지 말고).
  const disabled = !lane;
  // Justified rows: the density step is a COLUMN count, mapped to Task's
  // composer-aligned inner width (gaps included).
  const rowHeight = studioTargetRowHeight(tileSize);
  // Every authenticated lane contributes its active-kind models to the
  // anchored picker, grouped by provider.
  const modelEntries = useMemo(() => studioModelEntries(available, kind, lanes), [available, kind, lanes]);
  const handleResultsScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
      if (remaining > Math.max(240, element.clientHeight * 0.5)) return;
      void loadMoreAssets(kind).catch((reason) => setError(errorText(reason)));
    },
    [kind, loadMoreAssets]
  );
  const { layoutSections, pendingJobs } = useStudioGridRows({
    frameRatiosSource: thumbnails.ratios,
    gridWidth,
    jobs: boardJobs,
    kind,
    rowHeight,
    visibleAssets,
  });
  const { routeRows, durationSlider } = studioRouteRows({ controls, disabled, kind, options, setOptions });
  const { previousAsset, nextAsset, selectedLane, selectedModelLabel } = useStudioDetailPaging({
    selected,
    visibleAssets,
    lanes,
    kind,
    loadMoreAssets,
    setError,
  });
  const retryJob = (entry: StudioMediaJob) => {
    dismissJob(entry.id);
    void (entry.request ? startQueuedRequest(entry.request) : generate());
  };

  return (
    <div
      className="studio-root stable-surface-preserved"
      ref={studioRootRef}
      data-surface-active={active ? 'true' : 'false'}
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}
      {...studioDropHandlers(setDropping, addDroppedFiles)}
      onClick={(event) => {
        if (active && shouldFocusSurfaceInput(event)) {
          promptRef.current?.focus({ preventScroll: true });
        }
      }}
    >
      <div className="studio-pane">
        <div className="studio-shell">
          <StudioHeader sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar} />
          <div className="studio-stage-host">
            <StudioGallery
              assetUrl={assetUrl}
              boards={boards}
              onMoveToBoard={moveToBoard}
              checkedIds={checkedIds}
              cleanup={
                <StudioCleanupBar
                  selecting={selecting}
                  selectedCount={checkedIds.size}
                  visibleCount={visibleAssets.length}
                  onSelectMode={() => setSelecting(true)}
                  onSelectAll={() => void selectAll()}
                  onDeleteSelected={() =>
                    void Promise.resolve(
                      cleanUp({ ids: [...checkedIds] }, (total) =>
                        t('Delete {{total}} selected items permanently? This cannot be undone.', { total })
                      )
                    ).then(recountBoards)
                  }
                  onExitSelection={exitSelection}
                  onCleanUp={(filter, confirmText) =>
                    void Promise.resolve(cleanUp(filter, confirmText)).then(recountBoards)
                  }
                />
              }
              durations={thumbnails.durations}
              eagerThumbnailCount={EAGER_THUMB_COUNT}
              failedThumbs={thumbnails.failedThumbs}
              fullUrls={fullUrls}
              gridMotionReady={gridMotionReady}
              gridRef={gridRef}
              gridWidth={gridWidth}
              hasAvailableLane={available.length > 0}
              hoverId={hoverId}
              kind={kind}
              kindsOffered={kindsOffered}
              layoutSections={layoutSections}
              loading={loading}
              localTransport={localTransport}
              mediaForeground={mediaForeground}
              narrowPane={narrowPane}
              pendingJobs={pendingJobs}
              resultsRef={resultsRef}
              rowHeight={rowHeight}
              selectedId={selected?.id || ''}
              selecting={selecting}
              thumbs={thumbnails.thumbs}
              tileSize={tileSize}
              tileSizes={TILE_SIZES}
              visibleAssets={visibleAssets}
              onCancel={(id) => void cancel(id)}
              onDelete={removeAndRecount}
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
              onThumbnailLoad={thumbnails.onLoad}
              onThumbnailStall={thumbnails.onStall}
              onTileSizeChange={updateTileSize}
              onToggleChecked={toggleChecked}
            />
          </div>
          <div className="studio-dock" ref={dockRef}>
            {/* Progress AND job failures live on the pending tile; the banner is
            only for pane-level errors. */}
            <ErrorNotice
              error={error}
              // A catalog failure reads as the runtime wrote it (lane, auth,
              // reason); the generic classifier took "Model catalog
              // unavailable" for a refused model.
              summary={error && error === catalogErrorText ? error : undefined}
              onDismiss={() => setError('')}
            />
            <StudioCatalogNotices lanes={lanes} loading={loading} onRetry={retry} />
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
              boards={boards}
              boardId={boardId}
              onSelectBoard={openStudioBoard}
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
              thumbUrl={thumbnails.thumbs[selected.id] || ''}
              onClose={() => setSelected(null)}
              onCopyPrompt={(asset) => void copyPrompt(asset)}
              onNext={nextAsset ? () => setSelected(nextAsset) : undefined}
              onOpenAsset={(asset) => void openAsset(asset)}
              onOpenFolder={(asset) => void openAssetFolder(asset)}
              onPrevious={previousAsset ? () => setSelected(previousAsset) : undefined}
              onRegenerate={(asset) => void regenerate(asset)}
              onRemove={removeAndRecount}
              onReusePrompt={(asset) => void reusePrompt(asset)}
              onSave={(asset) => void saveAsset(asset)}
              onTogglePrompt={togglePrompt}
              onUrlBroken={markUrlBroken}
              onUseAsReference={(asset) => void addAssetReference(asset)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
