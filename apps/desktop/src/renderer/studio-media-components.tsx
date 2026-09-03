import {
  Copy,
  FolderOpen,
  Image as ImageIcon,
  Play,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ProgressSpinner } from './ProgressSpinner';
import { t } from './i18n';
import {
  formatBytes,
  type MediaAsset,
  type MediaKind,
} from './studio-support';

const THUMB_STALL_MS = 120;

export function StudioThumbnail({
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
      {kind === 'video'
        ? <Play size={24} aria-hidden="true" />
        : <ImageIcon size={24} aria-hidden="true" />}
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

export function StudioDetailViewer({
  asset,
  assetUrl,
  copied,
  localTransport,
  mediaForeground,
  previewUrl,
  promptOpen,
  thumbUrl,
  onClose,
  onCopyPrompt,
  onOpenAsset,
  onOpenFolder,
  onRegenerate,
  onRemove,
  onTogglePrompt,
  onUrlBroken,
}: {
  asset: MediaAsset;
  assetUrl: (assetId: string, variant: string) => string;
  copied: boolean;
  localTransport: boolean;
  mediaForeground: boolean;
  previewUrl: string;
  promptOpen: boolean;
  thumbUrl: string;
  onClose: () => void;
  onCopyPrompt: (asset: MediaAsset) => void;
  onOpenAsset: (asset: MediaAsset) => void;
  onOpenFolder: (asset: MediaAsset) => void;
  onRegenerate: (asset: MediaAsset) => void;
  onRemove: (asset: MediaAsset) => void;
  onTogglePrompt: () => void;
  onUrlBroken: (assetId: string, variant: string) => void;
}) {
  const displayUrl = assetUrl(asset.id, 'display') || previewUrl || thumbUrl;
  const originalUrl = assetUrl(asset.id, 'original') || previewUrl;
  const posterUrl = assetUrl(asset.id, 'thumb') || thumbUrl || undefined;
  return <div className="studio-detail" role="dialog" aria-label={t('Generated media detail')}
    onClick={onClose}>
    <div className="studio-detail-card" onClick={(event) => event.stopPropagation()}>
      <div className="studio-detail-stage">
        {asset.kind === 'video'
          ? <video key={mediaForeground ? 'foreground' : 'suspended'}
            src={mediaForeground ? originalUrl : undefined}
            poster={posterUrl}
            controls={mediaForeground}
            autoPlay={mediaForeground && localTransport} playsInline
            preload={mediaForeground && localTransport ? 'metadata' : 'none'}
            onError={() => onUrlBroken(asset.id, 'original')} />
          : <button type="button" className="studio-detail-media-open" title={t('Open image')}
            aria-label={t('Open image')} onClick={() => onOpenAsset(asset)}>
            <img src={displayUrl} alt={asset.prompt}
              onError={() => onUrlBroken(asset.id, 'display')} />
          </button>}
        <button type="button" className="studio-detail-stage-close" aria-label={t('Close preview')}
          onClick={onClose}><X size={16} aria-hidden="true" /></button>
      </div>
      <aside className="studio-detail-side">
        <header>
          <b>{asset.kind === 'video' ? t('Video') : t('Image')}</b>
          <button type="button" className="studio-detail-close" aria-label={t('Close preview')}
            onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </header>
        <section className="studio-detail-block studio-detail-block--prompt">
          <div className="studio-detail-block-head">
            <span>{t('PROMPT')}</span>
            <button type="button" onClick={() => onCopyPrompt(asset)}>
              <Copy size={12} aria-hidden="true" />{copied ? t('Copied') : t('Copy')}
            </button>
          </div>
          <p className="studio-detail-prompt" data-open={promptOpen ? 'true' : undefined}
            onClick={onTogglePrompt}>{asset.prompt}</p>
        </section>
        <section className="studio-detail-block studio-detail-block--metadata">
          <div className="studio-detail-block-head"><span>{t('DETAILS')}</span></div>
          <dl>
            <div><dt>{t('Provider')}</dt><dd>{asset.lane}</dd></div>
            <div><dt>{t('Model')}</dt><dd>{asset.model}</dd></div>
            <div><dt>{t('Size')}</dt><dd>{formatBytes(asset.bytes)}</dd></div>
            {asset.durationSeconds
              ? <div><dt>{t('Duration')}</dt><dd>{asset.durationSeconds}s</dd></div>
              : null}
            <div><dt>{t('Created')}</dt><dd>{new Date(asset.createdAt).toLocaleString()}</dd></div>
          </dl>
        </section>
        <div className="studio-detail-actions">
          <button type="button" className="studio-detail-primary"
            onClick={() => onRegenerate(asset)}>
            <RotateCcw size={14} aria-hidden="true" />{t('Regenerate')}
          </button>
          <button type="button" onClick={() => onOpenFolder(asset)}>
            <FolderOpen size={14} aria-hidden="true" />{t('Open Folder')}
          </button>
          <button type="button" className="studio-detail-danger"
            onClick={() => onRemove(asset)}>
            <Trash2 size={14} aria-hidden="true" />{t('Delete')}
          </button>
        </div>
      </aside>
    </div>
  </div>;
}
