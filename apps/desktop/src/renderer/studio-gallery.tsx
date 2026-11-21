import { Ban, Check, Trash2 } from 'lucide-react';
import { ErrorNotice } from './ErrorNotice';
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  type RefObject,
  type UIEvent,
  useCallback,
  useMemo,
  useState,
} from 'react';
import {
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  ScmContextMenu,
  type ScmContextMenuItem,
  type ScmContextMenuState,
} from './ScmContextMenu';
import { useScrollProgress } from './scroll-progress';
import type { StudioBoard } from './studio-boards';
import type { StudioGridSection } from './studio-pane-layout';

import { ProgressSpinner } from './ProgressSpinner';
import { BrandTile } from './WorkspaceEmptyState';
import { t } from './i18n';
import { StudioThumbnail } from './studio-media-components';
import type { StudioMediaJob } from './studio-media-state';
import { assetLabel, mediaFrameRatio, type JustifiedTile, type MediaAsset, type MediaKind } from './studio-support';

function tileStyle(tile: JustifiedTile, lastRow: boolean, gridWidth: number): CSSProperties {
  // Flex ratios make every tile follow a live pane resize in the same frame;
  // the trailing row keeps proportional widths instead of filling the line.
  const ratio = Number((tile.height > 0 ? tile.width / tile.height : 1).toFixed(4));
  return lastRow
    ? {
        width: `${Number(((tile.width / Math.max(1, gridWidth)) * 100).toFixed(3))}%`,
        aspectRatio: String(ratio),
      }
    : { flexGrow: ratio, flexBasis: 0, aspectRatio: String(ratio) };
}

function tileSizeBucket(width: number): 'tiny' | 'compact' | 'wide' {
  if (width < 130) return 'tiny';
  return width < 210 ? 'compact' : 'wide';
}

function pendingBox(tile: JustifiedTile, entry: StudioMediaJob, rowHeight: number) {
  const width = Math.floor(tile.width || rowHeight * mediaFrameRatio(entry));
  return { width, size: tileSizeBucket(width) };
}

function jobProgress(entry: StudioMediaJob): number {
  return entry.status === 'running' ? Math.max(0, Math.min(100, Number(entry.progress) || 0)) : 0;
}

function jobElapsed(entry: StudioMediaJob): string {
  const seconds = Math.floor(Math.max(0, entry.startedAt ? Date.now() - entry.startedAt : 0) / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function PendingTile({
  pending,
  tile,
  lastRow,
  gridWidth,
  rowHeight,
  onCancel,
  onDismiss,
  onRetry,
}: {
  pending: StudioMediaJob;
  tile: JustifiedTile;
  lastRow: boolean;
  gridWidth: number;
  rowHeight: number;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onRetry: (entry: StudioMediaJob) => void;
}) {
  const box = pendingBox(tile, pending, rowHeight);
  const progress = jobProgress(pending);
  const determinate = progress > 0;
  const elapsed = jobElapsed(pending);
  const queuedReference = pending.request?.references[0];
  const queuedPrompt = pending.request?.prompt || '';
  return (
    <figure
      aria-live="polite"
      className={`studio-tile studio-tile--pending${pending.status === 'failed' ? ' studio-tile--failed' : ''}`}
      data-studio-asset-id={pending.id}
      data-studio-prompt={queuedPrompt || undefined}
      data-size={box.size}
      style={tileStyle(tile, lastRow, gridWidth)}
    >
      {pending.status === 'failed' && (
        <div className="studio-tile-open">
          <ErrorNotice
            error={pending.error || t('Generation failed')}
            onRetry={() => onRetry(pending)}
            onDismiss={() => onDismiss(pending.id)}
          />
        </div>
      )}
      {pending.status !== 'failed' && (
        <>
          <div
            className="studio-tile-open"
            role="img"
            aria-label={queuedPrompt ? `${t('Generating')}: ${queuedPrompt}` : t('Generating')}
          >
            {queuedReference ? <img className="studio-pending-reference" src={queuedReference.url} alt="" /> : null}
            {queuedPrompt ? <p className="studio-pending-prompt">{queuedPrompt}</p> : null}
            {/* A lane-reported percentage gets a determinate rail;
              everything else remains honestly indeterminate. */}
            <div className="studio-pending-foot">
              <span className="studio-pending-meta">
                <span>{elapsed}</span>
                {determinate ? <span>{progress}%</span> : null}
              </span>
              <span
                className={`studio-pending-bar${determinate ? '' : ' studio-pending-bar--idle'}`}
                role="progressbar"
                aria-valuenow={determinate ? progress : undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={determinate ? { width: `${progress}%` } : undefined} />
              </span>
            </div>
          </div>
          <div className="studio-pending-head">
            <span
              className="studio-pending-chip"
              role="img"
              aria-label={
                determinate
                  ? t('Generating, {{progress}}%, {{elapsed}} elapsed', { progress, elapsed })
                  : t('Generating, {{elapsed}} elapsed', { elapsed })
              }
            >
              <ProgressSpinner size={14} className="studio-spinner" aria-hidden="true" />
            </span>
            <button
              type="button"
              className="studio-pending-cancel"
              aria-label={t('Cancel generation')}
              onClick={() => onCancel(pending.id)}
            >
              <Ban size={12} aria-hidden="true" />
              <span>{t('Cancel')}</span>
            </button>
          </div>
        </>
      )}
    </figure>
  );
}

function StudioTopbar({
  kind,
  kindsOffered,
  tileSize,
  tileSizes,
  cleanup,
  onKindChange,
  onTileSizeChange,
}: {
  kind: MediaKind;
  kindsOffered: MediaKind[];
  tileSize: number;
  tileSizes: readonly number[];
  cleanup: ReactNode;
  onKindChange: (kind: MediaKind) => void;
  onTileSizeChange: (size: number) => void;
}) {
  return (
    <div className="studio-topbar">
      {/* Only offer what the signed-in providers can produce: one kind hides
        the toggle, none hides it entirely. */}
      {/* biome-ignore lint/a11y/useSemanticElements: tag must stay a div; a fieldset would change layout and styling */}
      <div
        className="studio-kind"
        data-empty={kindsOffered.length > 1 ? undefined : 'true'}
        role="group"
        aria-label={t('Media kind')}
        aria-hidden={kindsOffered.length > 1 ? undefined : true}
      >
        {(['image', 'video'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={kind === value ? 'active' : ''}
            disabled={!kindsOffered.includes(value)}
            aria-pressed={kind === value}
            onClick={() => onKindChange(value)}
          >
            {t(value)}
          </button>
        ))}
      </div>
      <div className="studio-topbar-tools">
        <label className="studio-density" aria-label={t('Thumbnail size')}>
          <input
            type="range"
            min={0}
            max={tileSizes.length - 1}
            step={1}
            value={tileSizes.length - 1 - Math.max(0, tileSizes.indexOf(tileSize))}
            onChange={(event) => {
              const scaleIndex = Math.max(0, Math.min(tileSizes.length - 1, Number(event.currentTarget.value)));
              const next = tileSizes[tileSizes.length - 1 - scaleIndex] ?? tileSizes[1];
              if (next !== undefined) onTileSizeChange(next);
            }}
          />
        </label>
        {cleanup}
      </div>
    </div>
  );
}

function StudioAssetTile({
  asset,
  tile,
  lastRow,
  gridWidth,
  assetIndex,
  eagerThumbnailCount,
  selected,
  selecting,
  checked,
  narrowPane,
  localTransport,
  mediaForeground,
  hovering,
  assetUrl,
  fullUrl,
  thumb,
  thumbFailed,
  duration,
  onDelete,
  onHoverEnd,
  onHoverStart,
  onOpen,
  onOpenMenu,
  onThumbnailError,
  onThumbnailLoad,
  onThumbnailStall,
  onToggleChecked,
}: {
  asset: MediaAsset;
  tile: JustifiedTile;
  lastRow: boolean;
  gridWidth: number;
  assetIndex: number;
  eagerThumbnailCount: number;
  selected: boolean;
  selecting: boolean;
  checked: boolean;
  narrowPane: boolean;
  localTransport: boolean;
  mediaForeground: boolean;
  hovering: boolean;
  assetUrl: (assetId: string, variant: 'thumb' | 'original') => string;
  fullUrl: string | undefined;
  thumb: string | undefined;
  thumbFailed: boolean;
  duration: number | undefined;
  onDelete: (asset: MediaAsset) => void;
  onHoverEnd: () => void;
  onHoverStart: (asset: MediaAsset) => void;
  onOpen: (asset: MediaAsset) => void;
  onOpenMenu: (asset: MediaAsset, point: { x: number; y: number }) => void;
  onThumbnailError: (assetId: string) => void;
  onThumbnailLoad: (asset: MediaAsset) => void;
  onThumbnailStall: (assetId: string) => void;
  onToggleChecked: (asset: MediaAsset) => void;
}) {
  // Mount at most one local decoder. Remote hover previews would
  // stream originals repeatedly, and narrow panes keep the still
  // to avoid the renderer GPU exhaustion this guard fixed.
  const hoverPreview = !narrowPane && asset.kind === 'video' && localTransport;
  const eagerLocalImage = localTransport && asset.kind === 'image' && assetIndex < eagerThumbnailCount;
  return (
    <figure
      key={asset.id}
      className={`studio-tile ${selected ? 'selected' : ''}${checked ? ' checked' : ''}`}
      data-studio-asset-id={asset.id}
      style={tileStyle(tile, lastRow, gridWidth)}
    >
      <button
        type="button"
        className="studio-tile-open"
        onClick={() => (selecting ? onToggleChecked(asset) : onOpen(asset))}
        aria-pressed={selecting ? checked : undefined}
        aria-label={t('Open {{kind}}: {{prompt}}', { kind: t(asset.kind), prompt: asset.prompt })}
        onContextMenu={
          selecting
            ? undefined
            : (event) => {
                event.preventDefault();
                onOpenMenu(asset, pointerMenuPoint(event));
              }
        }
        onKeyDown={
          selecting
            ? undefined
            : (event) => {
                if (!isContextMenuKey(event)) return;
                event.preventDefault();
                onOpenMenu(asset, elementMenuPoint(event.currentTarget));
              }
        }
        onMouseEnter={hoverPreview ? () => onHoverStart(asset) : undefined}
        onMouseLeave={hoverPreview ? onHoverEnd : undefined}
      >
        {mediaForeground && hoverPreview && hovering && (assetUrl(asset.id, 'original') || fullUrl) ? (
          <video src={assetUrl(asset.id, 'original') || fullUrl} muted loop autoPlay playsInline preload="metadata" />
        ) : null}
        <StudioThumbnail
          src={thumb || (eagerLocalImage ? '' : assetUrl(asset.id, 'thumb'))}
          kind={asset.kind}
          eager={assetIndex < eagerThumbnailCount}
          pending={eagerLocalImage && !thumb && !thumbFailed}
          // A missing media route falls back tile-by-tile through RPC.
          onError={thumb ? undefined : () => onThumbnailError(asset.id)}
          // A cold custom-protocol rendition may still be live; start
          // local fallback without unmounting that direct request.
          onStall={
            localTransport &&
            asset.kind === 'video' &&
            assetIndex < eagerThumbnailCount &&
            !thumb &&
            assetUrl(asset.id, 'thumb')
              ? () => onThumbnailStall(asset.id)
              : undefined
          }
          onLoad={() => onThumbnailLoad(asset)}
        />
        {asset.durationSeconds || duration ? (
          <span className="studio-tile-badge">{asset.durationSeconds || duration}s</span>
        ) : null}
      </button>
      {selecting ? (
        <span className="studio-tile-check" aria-hidden="true">
          {checked ? <Check size={14} /> : null}
        </span>
      ) : (
        <div className="studio-tile-actions">
          <button
            type="button"
            className="studio-tile-remove"
            aria-label={t('Delete asset')}
            title={assetLabel(asset)}
            onClick={() => onDelete(asset)}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </figure>
  );
}

export function StudioGallery({
  assetUrl,
  boards,
  onMoveToBoard,
  checkedIds,
  cleanup,
  durations,
  eagerThumbnailCount,
  failedThumbs,
  fullUrls,
  gridMotionReady,
  gridRef,
  gridWidth,
  hasAvailableLane,
  hoverId,
  kind,
  kindsOffered,
  layoutSections,
  loading,
  localTransport,
  mediaForeground,
  narrowPane,
  pendingJobs,
  resultsRef,
  rowHeight,
  selectedId,
  selecting,
  thumbs,
  tileSize,
  tileSizes,
  visibleAssets,
  onCancel,
  onDelete,
  onDismiss,
  onHoverEnd,
  onHoverStart,
  onKindChange,
  onOpen,
  onResultsScroll,
  onRetry,
  onThumbnailError,
  onThumbnailLoad,
  onThumbnailStall,
  onTileSizeChange,
  onToggleChecked,
}: {
  assetUrl: (assetId: string, variant: 'thumb' | 'original') => string;
  boards: readonly StudioBoard[];
  /** Moves `asset` into board `boardId` ('' = out of its board). */
  onMoveToBoard: (asset: MediaAsset, boardId: string) => void;
  checkedIds: ReadonlySet<string>;
  cleanup: ReactNode;
  durations: Record<string, number>;
  eagerThumbnailCount: number;
  failedThumbs: Record<string, boolean>;
  fullUrls: Record<string, string>;
  gridMotionReady: boolean;
  gridRef: RefObject<HTMLDivElement | null>;
  gridWidth: number;
  hasAvailableLane: boolean;
  hoverId: string;
  kind: MediaKind;
  kindsOffered: MediaKind[];
  layoutSections: StudioGridSection[];
  loading: boolean;
  localTransport: boolean;
  mediaForeground: boolean;
  narrowPane: boolean;
  pendingJobs: StudioMediaJob[];
  resultsRef: RefObject<HTMLDivElement | null>;
  rowHeight: number;
  selectedId: string;
  selecting: boolean;
  thumbs: Record<string, string>;
  tileSize: number;
  tileSizes: readonly number[];
  visibleAssets: MediaAsset[];
  onCancel: (id: string) => void;
  onDelete: (asset: MediaAsset) => void;
  onDismiss: (id: string) => void;
  onHoverEnd: () => void;
  onHoverStart: (asset: MediaAsset) => void;
  onKindChange: (kind: MediaKind) => void;
  onOpen: (asset: MediaAsset) => void;
  onResultsScroll: (event: UIEvent<HTMLDivElement>) => void;
  onRetry: (entry: StudioMediaJob) => void;
  onThumbnailError: (assetId: string) => void;
  onThumbnailLoad: (asset: MediaAsset) => void;
  onThumbnailStall: (assetId: string) => void;
  onTileSizeChange: (size: number) => void;
  onToggleChecked: (asset: MediaAsset) => void;
}) {
  useScrollProgress(resultsRef, ':scope > .transcript-scroll-fade');
  const pendingById = useMemo(() => new Map(pendingJobs.map((entry) => [entry.id, entry])), [pendingJobs]);
  const assetIndexById = useMemo(
    () => new Map(visibleAssets.map((asset, index) => [asset.id, index])),
    [visibleAssets]
  );
  const [contextMenu, setContextMenu] = useState<ScmContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const boardMenu = (asset: MediaAsset): ScmContextMenuItem[] => {
    const current = boards.some((board) => board.id === asset.boardId) ? asset.boardId : '';
    if (!boards.length) return [];
    return [
      {
        id: 'board',
        label: current ? t('Move to board') : t('Add to board'),
        separatorBefore: true,
        children: [
          ...boards.map((board) => ({
            id: `board:${board.id}`,
            label: board.name,
            checked: board.id === current,
            onSelect: () => onMoveToBoard(asset, board.id),
          })),
          ...(current
            ? [
                {
                  id: 'board:none',
                  label: t('Remove from board'),
                  separatorBefore: true,
                  onSelect: () => onMoveToBoard(asset, ''),
                },
              ]
            : []),
        ],
      },
    ];
  };
  const openAssetMenu = (asset: MediaAsset, point: { x: number; y: number }) =>
    setContextMenu({
      label: assetLabel(asset),
      ...point,
      items: [
        { id: 'open', label: t('Open'), onSelect: () => onOpen(asset) },
        ...boardMenu(asset),
        {
          id: 'delete',
          label: t('Delete asset'),
          danger: true,
          separatorBefore: true,
          onSelect: () => onDelete(asset),
        },
      ],
    });

  return (
    <>
      <StudioTopbar
        kind={kind}
        kindsOffered={kindsOffered}
        tileSize={tileSize}
        tileSizes={tileSizes}
        cleanup={cleanup}
        onKindChange={onKindChange}
        onTileSizeChange={onTileSizeChange}
      />
      {/* The session transcript's top fade (12-transcript.css), driven by the
        results scroller's position; see 19-studio.css for where it sits. */}
      <div className="transcript-scroll-fade" aria-hidden="true" />
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: label names the results region without adding a role, which would change screen-reader semantics */}
      <div className="studio-results" aria-label={t('Generated media')} ref={resultsRef} onScroll={onResultsScroll}>
        {visibleAssets.length === 0 && pendingJobs.length === 0 && !loading && (
          <div className="studio-blank">
            {/* Quiet brand watermark: empty secondary surfaces carry only the
            centered letterpress. The provider gap stays visible because it is
            a blocker, not canvas guidance. */}
            <span className="welcome-logo" aria-hidden="true">
              <BrandTile crop />
            </span>
            {!hasAvailableLane && (
              <p>
                {t(
                  'No provider supports this mode yet — sign in to Grok/ChatGPT or add a Gemini key in Settings → Providers.'
                )}
              </p>
            )}
          </div>
        )}
        <div className="studio-grid" ref={gridRef} data-motion-ready={gridMotionReady ? 'true' : undefined}>
          {layoutSections.map((section) => (
            <Fragment key={section.id}>
              <h3 className="studio-day-heading">{section.label}</h3>
              {section.rows.map((row, rowIndex) => (
                <div className="studio-grid-row" key={row[0]?.asset.id || rowIndex}>
                  {row.map((tile) => {
                    const pending = pendingById.get(tile.asset.id);
                    if (!pending) return null;
                    return (
                      <PendingTile
                        key={pending.id}
                        pending={pending}
                        tile={tile}
                        lastRow={rowIndex === section.rows.length - 1}
                        gridWidth={gridWidth}
                        rowHeight={rowHeight}
                        onCancel={onCancel}
                        onDismiss={onDismiss}
                        onRetry={onRetry}
                      />
                    );
                  })}
                  {row.map((tile) => {
                    const asset = tile.asset;
                    if (pendingById.has(asset.id)) return null;
                    return (
                      <StudioAssetTile
                        key={asset.id}
                        asset={asset}
                        tile={tile}
                        lastRow={rowIndex === section.rows.length - 1}
                        gridWidth={gridWidth}
                        assetIndex={assetIndexById.get(asset.id) ?? 0}
                        eagerThumbnailCount={eagerThumbnailCount}
                        selected={selectedId === asset.id}
                        selecting={selecting}
                        checked={selecting && checkedIds.has(asset.id)}
                        narrowPane={narrowPane}
                        localTransport={localTransport}
                        mediaForeground={mediaForeground}
                        hovering={hoverId === asset.id}
                        assetUrl={assetUrl}
                        fullUrl={fullUrls[asset.id]}
                        thumb={thumbs[asset.id]}
                        thumbFailed={Boolean(failedThumbs[asset.id])}
                        duration={durations[asset.id]}
                        onDelete={onDelete}
                        onHoverEnd={onHoverEnd}
                        onHoverStart={onHoverStart}
                        onOpen={onOpen}
                        onOpenMenu={openAssetMenu}
                        onThumbnailError={onThumbnailError}
                        onThumbnailLoad={onThumbnailLoad}
                        onThumbnailStall={onThumbnailStall}
                        onToggleChecked={onToggleChecked}
                      />
                    );
                  })}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
      <ScmContextMenu state={contextMenu} onClose={closeContextMenu} />
    </>
  );
}
