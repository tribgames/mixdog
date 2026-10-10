import { Ban, Check, Trash2 } from 'lucide-react';
import { ErrorNotice } from './ErrorNotice';
import { type CSSProperties, type ReactNode, type RefObject, type UIEvent, useCallback, useMemo, useState } from 'react';
import {
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  ScmContextMenu,
  type ScmContextMenuState,
} from './ScmContextMenu';

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

export function StudioGallery({
  assetUrl,
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
  layoutRows,
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
  layoutRows: JustifiedTile[][];
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
  const pendingById = useMemo(() => new Map(pendingJobs.map((entry) => [entry.id, entry])), [pendingJobs]);
  const assetIndexById = useMemo(
    () => new Map(visibleAssets.map((asset, index) => [asset.id, index])),
    [visibleAssets]
  );
  const lastRowIndex = layoutRows.length - 1;
  const [contextMenu, setContextMenu] = useState<ScmContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const openAssetMenu = (asset: MediaAsset, point: { x: number; y: number }) =>
    setContextMenu({
      label: assetLabel(asset),
      ...point,
      items: [
        { id: 'open', label: t('Open'), onSelect: () => onOpen(asset) },
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
      {/* Mode stays visually centered while thumbnail scale owns the gallery's
        top-right corner and contracts with narrow split layouts. */}
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
          {layoutRows.map((row, rowIndex) => (
            <div className="studio-grid-row" key={row[0]?.asset.id || rowIndex}>
              {row.map((tile) => {
                const pending = pendingById.get(tile.asset.id);
                if (!pending) return null;
                const box = pendingBox(tile, pending, rowHeight);
                const progress = jobProgress(pending);
                const determinate = progress > 0;
                const elapsed = jobElapsed(pending);
                const queuedReference = pending.request?.references[0];
                const queuedPrompt = pending.request?.prompt || '';
                return (
                  <figure
                    key={pending.id}
                    aria-live="polite"
                    className={`studio-tile studio-tile--pending${pending.status === 'failed' ? ' studio-tile--failed' : ''}`}
                    data-studio-asset-id={pending.id}
                    data-studio-prompt={queuedPrompt || undefined}
                    data-size={box.size}
                    style={tileStyle(tile, rowIndex === lastRowIndex, gridWidth)}
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
                          {queuedReference ? (
                            <img className="studio-pending-reference" src={queuedReference.url} alt="" />
                          ) : null}
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
              })}
              {row.map((tile) => {
                if (pendingById.has(tile.asset.id)) return null;
                const asset = tile.asset;
                const assetIndex = assetIndexById.get(asset.id) ?? 0;
                // Mount at most one local decoder. Remote hover previews would
                // stream originals repeatedly, and narrow panes keep the still
                // to avoid the renderer GPU exhaustion this guard fixed.
                const hoverPreview = !narrowPane && asset.kind === 'video' && localTransport;
                const eagerLocalImage = localTransport && asset.kind === 'image' && assetIndex < eagerThumbnailCount;
                const checked = selecting && checkedIds.has(asset.id);
                return (
                  <figure
                    key={asset.id}
                    className={`studio-tile ${selectedId === asset.id ? 'selected' : ''}${checked ? ' checked' : ''}`}
                    data-studio-asset-id={asset.id}
                    style={tileStyle(tile, rowIndex === lastRowIndex, gridWidth)}
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
                              openAssetMenu(asset, pointerMenuPoint(event));
                            }
                      }
                      onKeyDown={
                        selecting
                          ? undefined
                          : (event) => {
                              if (!isContextMenuKey(event)) return;
                              event.preventDefault();
                              openAssetMenu(asset, elementMenuPoint(event.currentTarget));
                            }
                      }
                      onMouseEnter={hoverPreview ? () => onHoverStart(asset) : undefined}
                      onMouseLeave={hoverPreview ? onHoverEnd : undefined}
                    >
                      {mediaForeground &&
                      hoverPreview &&
                      hoverId === asset.id &&
                      (assetUrl(asset.id, 'original') || fullUrls[asset.id]) ? (
                        <video
                          src={assetUrl(asset.id, 'original') || fullUrls[asset.id]}
                          muted
                          loop
                          autoPlay
                          playsInline
                          preload="metadata"
                        />
                      ) : null}
                      <StudioThumbnail
                        src={thumbs[asset.id] || (eagerLocalImage ? '' : assetUrl(asset.id, 'thumb'))}
                        kind={asset.kind}
                        eager={assetIndex < eagerThumbnailCount}
                        pending={eagerLocalImage && !thumbs[asset.id] && !failedThumbs[asset.id]}
                        // A missing media route falls back tile-by-tile through RPC.
                        onError={thumbs[asset.id] ? undefined : () => onThumbnailError(asset.id)}
                        // A cold custom-protocol rendition may still be live; start
                        // local fallback without unmounting that direct request.
                        onStall={
                          localTransport &&
                          asset.kind === 'video' &&
                          assetIndex < eagerThumbnailCount &&
                          !thumbs[asset.id] &&
                          assetUrl(asset.id, 'thumb')
                            ? () => onThumbnailStall(asset.id)
                            : undefined
                        }
                        onLoad={() => onThumbnailLoad(asset)}
                      />
                      {asset.durationSeconds || durations[asset.id] ? (
                        <span className="studio-tile-badge">{asset.durationSeconds || durations[asset.id]}s</span>
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
              })}
            </div>
          ))}
        </div>
      </div>
      <ScmContextMenu state={contextMenu} onClose={closeContextMenu} />
    </>
  );
}
