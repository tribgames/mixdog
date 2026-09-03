import { Ban, RotateCcw, Trash2 } from 'lucide-react';
import {
  type CSSProperties,
  type RefObject,
  type UIEvent,
  useMemo,
} from 'react';

import { ProgressSpinner } from './ProgressSpinner';
import { BrandTile } from './WorkspaceEmptyState';
import { t } from './i18n';
import { StudioThumbnail } from './studio-media-components';
import type { StudioMediaJob } from './studio-media-state';
import {
  assetLabel,
  mediaFrameRatio,
  type JustifiedTile,
  type MediaAsset,
  type MediaKind,
} from './studio-support';

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

function pendingBox(tile: JustifiedTile, entry: StudioMediaJob, rowHeight: number) {
  const width = Math.floor(tile.width || rowHeight * mediaFrameRatio(entry));
  return {
    width,
    size: width < 130 ? 'tiny' : width < 210 ? 'compact' : 'wide',
  };
}

function jobProgress(entry: StudioMediaJob): number {
  return entry.status === 'running'
    ? Math.max(0, Math.min(100, Number(entry.progress) || 0))
    : 0;
}

function jobElapsed(entry: StudioMediaJob): string {
  const seconds = Math.floor(Math.max(
    0,
    entry.startedAt ? Date.now() - entry.startedAt : 0,
  ) / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function StudioGallery({
  assetUrl,
  durations,
  eagerThumbnailCount,
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
}: {
  assetUrl: (assetId: string, variant: 'thumb' | 'original') => string;
  durations: Record<string, number>;
  eagerThumbnailCount: number;
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
}) {
  const pendingById = useMemo(
    () => new Map(pendingJobs.map((entry) => [entry.id, entry])),
    [pendingJobs],
  );
  const assetIndexById = useMemo(
    () => new Map(visibleAssets.map((asset, index) => [asset.id, index])),
    [visibleAssets],
  );

  return <>
    {/* Mode stays visually centered while thumbnail scale owns the gallery's
        top-right corner and contracts with narrow split layouts. */}
    <div className="studio-topbar">
      {/* Only offer what the signed-in providers can produce: one kind hides
          the toggle, none hides it entirely. */}
      <div className="studio-kind"
        data-empty={kindsOffered.length > 1 ? undefined : 'true'}
        role="group" aria-label={t('Media kind')}
        aria-hidden={kindsOffered.length > 1 ? undefined : true}>
        {(['image', 'video'] as const).map((value) =>
          <button key={value} type="button" className={kind === value ? 'active' : ''}
            disabled={!kindsOffered.includes(value)}
            aria-pressed={kind === value} onClick={() => onKindChange(value)}>
            {t(value)}
          </button>)}
      </div>
      <label className="studio-density" aria-label={t('Thumbnail size')}>
        <input type="range" min={0} max={tileSizes.length - 1} step={1}
          value={tileSizes.length - 1 - Math.max(0, tileSizes.indexOf(tileSize))}
          onChange={(event) => {
            const scaleIndex = Math.max(
              0,
              Math.min(tileSizes.length - 1, Number(event.currentTarget.value)),
            );
            const next = tileSizes[tileSizes.length - 1 - scaleIndex] ?? tileSizes[1];
            if (next !== undefined) onTileSizeChange(next);
          }} />
      </label>
    </div>
    <div className="studio-results" aria-label={t('Generated media')} ref={resultsRef}
      onScroll={onResultsScroll}>
      {visibleAssets.length === 0 && pendingJobs.length === 0 && !loading
        && <div className="studio-blank">
        {/* Quiet brand watermark: empty secondary surfaces carry only the
            centered letterpress. The provider gap stays visible because it is
            a blocker, not canvas guidance. */}
        <span className="welcome-logo" aria-hidden="true"><BrandTile crop /></span>
        {!hasAvailableLane && <p>
          {t('No provider supports this mode yet — sign in to Grok/ChatGPT or add a Gemini key in Settings → Providers.')}
        </p>}
      </div>}
      <div className="studio-grid" ref={gridRef}
        data-motion-ready={gridMotionReady ? 'true' : undefined}>
        {layoutRows.map((row, rowIndex) => <div className="studio-grid-row"
          key={row[0]?.asset.id || rowIndex}>
          {row.map((tile) => {
            const pending = pendingById.get(tile.asset.id);
            if (!pending) return null;
            const box = pendingBox(tile, pending, rowHeight);
            const progress = jobProgress(pending);
            const determinate = progress > 0;
            const elapsed = jobElapsed(pending);
            const queuedReference = pending.request?.references[0];
            const queuedPrompt = pending.request?.prompt || '';
            return <figure key={pending.id} aria-live="polite"
              className={`studio-tile studio-tile--pending${pending.status === 'failed' ? ' studio-tile--failed' : ''}`}
              data-studio-asset-id={pending.id}
              data-studio-prompt={queuedPrompt || undefined}
              data-size={box.size}
              style={tileStyle(tile, rowIndex === layoutRows.length - 1, gridWidth)}>
              {pending.status === 'failed'
                ? <div className="studio-tile-open">
                  <div className="studio-failed-body">
                    <Ban size={16} aria-hidden="true" />
                    <p>{pending.error || t('Generation failed')}</p>
                    <div className="studio-failed-actions">
                      <button type="button" onClick={() => onRetry(pending)}>
                        <RotateCcw size={12} aria-hidden="true" />{t('Retry')}
                      </button>
                      <button type="button" onClick={() => onDismiss(pending.id)}>{t('Dismiss')}</button>
                    </div>
                  </div>
                </div>
                : <>
                  <div className="studio-tile-open" role="img"
                    aria-label={queuedPrompt ? `${t('Generating')}: ${queuedPrompt}` : t('Generating')}>
                    {queuedReference
                      ? <img className="studio-pending-reference" src={queuedReference.url} alt="" />
                      : null}
                    {queuedPrompt ? <p className="studio-pending-prompt">{queuedPrompt}</p> : null}
                    {/* A lane-reported percentage gets a determinate rail;
                        everything else remains honestly indeterminate. */}
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
                  <div className="studio-pending-head">
                    <span className="studio-pending-chip" role="img"
                      aria-label={determinate
                        ? t('Generating, {{progress}}%, {{elapsed}} elapsed', { progress, elapsed })
                        : t('Generating, {{elapsed}} elapsed', { elapsed })}>
                      <ProgressSpinner size={14} className="studio-spinner" aria-hidden="true" />
                    </span>
                    <button type="button" className="studio-pending-cancel"
                      aria-label={t('Cancel generation')} onClick={() => onCancel(pending.id)}>
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
              className={`studio-tile ${selectedId === asset.id ? 'selected' : ''}`}
              data-studio-asset-id={asset.id}
              style={tileStyle(tile, rowIndex === layoutRows.length - 1, gridWidth)}>
              <button type="button" className="studio-tile-open" onClick={() => onOpen(asset)}
                aria-label={`Open ${asset.kind}: ${asset.prompt}`}
                // Mount at most one local decoder. Remote hover previews would
                // stream originals repeatedly, and narrow panes keep the still
                // to avoid the renderer GPU exhaustion this guard fixed.
                onMouseEnter={!narrowPane && asset.kind === 'video' && localTransport
                  ? () => onHoverStart(asset) : undefined}
                onMouseLeave={!narrowPane && asset.kind === 'video' && localTransport
                  ? onHoverEnd : undefined}>
                {mediaForeground && !narrowPane && localTransport && asset.kind === 'video'
                  && hoverId === asset.id
                  && (assetUrl(asset.id, 'original') || fullUrls[asset.id])
                  ? <video src={assetUrl(asset.id, 'original') || fullUrls[asset.id]}
                    muted loop autoPlay playsInline preload="metadata" />
                  : null}
                <StudioThumbnail
                  src={thumbs[asset.id] || (
                    localTransport && asset.kind === 'image' && assetIndex < eagerThumbnailCount
                      ? ''
                      : assetUrl(asset.id, 'thumb')
                  )}
                  kind={asset.kind}
                  eager={assetIndex < eagerThumbnailCount}
                  pending={localTransport && asset.kind === 'image'
                    && assetIndex < eagerThumbnailCount && !thumbs[asset.id]}
                  // A missing media route falls back tile-by-tile through RPC.
                  onError={thumbs[asset.id] ? undefined : () => onThumbnailError(asset.id)}
                  // A cold custom-protocol rendition may still be live; start
                  // local fallback without unmounting that direct request.
                  onStall={localTransport && asset.kind === 'video'
                    && assetIndex < eagerThumbnailCount
                    && !thumbs[asset.id] && assetUrl(asset.id, 'thumb')
                    ? () => onThumbnailStall(asset.id)
                    : undefined}
                  onLoad={() => onThumbnailLoad(asset)} />
                {(asset.durationSeconds || durations[asset.id])
                  ? <span className="studio-tile-badge">
                    {asset.durationSeconds || durations[asset.id]}s
                  </span>
                  : null}
              </button>
              <div className="studio-tile-actions">
                <button type="button" className="studio-tile-remove" aria-label={t('Delete asset')}
                  title={assetLabel(asset)} onClick={() => onDelete(asset)}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </figure>;
          })}
        </div>)}
      </div>
    </div>
  </>;
}
