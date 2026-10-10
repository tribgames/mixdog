import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  PencilLine,
  Play,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ProgressSpinner } from './ProgressSpinner';
import { t, uiFormatLocale } from './i18n';
import { useMobileBack } from './mobile-back';
import { formatBytes, pillLabel, type MediaAsset, type MediaKind } from './studio-support';

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
    return (
      <span className="studio-thumbnail-loading" aria-hidden="true">
        <ProgressSpinner size={18} className="studio-spinner" />
      </span>
    );
  }
  if (!src || failed) {
    return (
      <span className="studio-tile-glyph">
        {kind === 'video' ? <Play size={24} aria-hidden="true" /> : <ImageIcon size={24} aria-hidden="true" />}
      </span>
    );
  }
  return (
    <>
      {!ready && (
        <span className="studio-thumbnail-loading" aria-hidden="true">
          <ProgressSpinner size={18} className="studio-spinner" />
        </span>
      )}
      <img
        src={src}
        alt=""
        className="studio-thumbnail-image"
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
          setFailedSource((current) => (current === src ? '' : current));
          setLoadedSource(src);
          onLoad();
        }}
      />
    </>
  );
}

/** A touch drag pages the detail once it is this long and mostly horizontal. */
const SWIPE_DISTANCE = 48;

export function StudioDetailViewer({
  asset,
  assetUrl,
  canUseAsReference,
  copied,
  localTransport,
  mediaForeground,
  modelLabel,
  previewUrl,
  promptOpen,
  providerLabel,
  thumbUrl,
  onClose,
  onCopyPrompt,
  onNext,
  onOpenAsset,
  onOpenFolder,
  onPrevious,
  onRegenerate,
  onRemove,
  onReusePrompt,
  onSave,
  onTogglePrompt,
  onUrlBroken,
  onUseAsReference,
}: {
  asset: MediaAsset;
  assetUrl: (assetId: string, variant: string) => string;
  canUseAsReference: boolean;
  copied: boolean;
  localTransport: boolean;
  mediaForeground: boolean;
  modelLabel: string;
  previewUrl: string;
  promptOpen: boolean;
  providerLabel: string;
  thumbUrl: string;
  onClose: () => void;
  onCopyPrompt: (asset: MediaAsset) => void;
  /** Absent at the gallery's last asset. */
  onNext?: () => void;
  onOpenAsset: (asset: MediaAsset) => void;
  onOpenFolder: (asset: MediaAsset) => void;
  /** Absent at the gallery's first asset. */
  onPrevious?: () => void;
  onRegenerate: (asset: MediaAsset) => void;
  onRemove: (asset: MediaAsset) => void;
  onReusePrompt: (asset: MediaAsset) => void;
  onSave: (asset: MediaAsset) => void;
  onTogglePrompt: () => void;
  onUrlBroken: (assetId: string, variant: string) => void;
  onUseAsReference: (asset: MediaAsset) => void;
}) {
  const displayUrl = assetUrl(asset.id, 'display') || previewUrl || thumbUrl;
  const originalUrl = assetUrl(asset.id, 'original') || previewUrl;
  const posterUrl = assetUrl(asset.id, 'thumb') || thumbUrl || undefined;
  const videoKey = mediaForeground ? 'foreground' : 'suspended';
  const videoSrc = mediaForeground ? originalUrl : undefined;
  const videoPreload = mediaForeground && localTransport ? 'metadata' : 'none';
  // The web app reaches no OS viewer or folder on the device: a tap on the
  // image folds the rail away instead, and Save hands the file to the device.
  const remote = !localTransport;
  const [detailsHidden, setDetailsHidden] = useState(false);
  // Keyed by asset, so paging to the next one never carries an open menu.
  const [menuAsset, setMenuAsset] = useState('');
  const moreOpen = menuAsset === asset.id;
  const [promptClamped, setPromptClamped] = useState(false);
  const promptNode = useRef<HTMLParagraphElement>(null);
  const moreNode = useRef<HTMLDivElement>(null);
  const swipeStart = useRef<{ id: number; x: number; y: number } | null>(null);
  const swiped = useRef(false);
  useMobileBack(moreOpen, () => setMenuAsset(''));

  // Show all appears only when the line clamp actually cut the prompt.
  const prompt = asset.prompt;
  useLayoutEffect(() => {
    const node = promptNode.current;
    if (!node || promptOpen || !prompt) {
      if (!prompt) setPromptClamped(false);
      return undefined;
    }
    const measure = () => setPromptClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [prompt, promptOpen]);

  useEffect(() => {
    if (!moreOpen) return undefined;
    const dismiss = (event: PointerEvent) => {
      if (!moreNode.current?.contains(event.target as Node)) setMenuAsset('');
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setMenuAsset('');
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onEscape, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onEscape, true);
    };
  }, [moreOpen]);

  const startSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    swiped.current = false;
    // Native video controls own their drags; the stage buttons keep plain taps.
    const target = event.target as Element;
    swipeStart.current =
      event.pointerType === 'touch' && !target.closest('video, .studio-detail-nav, .studio-detail-stage-close')
        ? { id: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
  };
  const endSwipe = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(event.clientY - start.y) * 1.5) return;
    const page = dx < 0 ? onNext : onPrevious;
    if (!page) return;
    swiped.current = true;
    page();
  };

  const options = asset.options || {};
  const duration = asset.durationSeconds || (asset.kind === 'video' ? Number(options.duration) || 0 : 0);
  // The request as it was made, in the catalog's words; unset rows drop out.
  const details: Array<[string, string]> = [
    [t('Provider'), providerLabel],
    [t('Model'), modelLabel],
    [t('Aspect'), options.aspectRatio ? pillLabel(options.aspectRatio) : ''],
    [t('Resolution'), options.resolution ? pillLabel(options.resolution) : ''],
    [t('Size'), options.size ? pillLabel(options.size) : ''],
    [t('Quality'), options.quality ? pillLabel(options.quality) : ''],
    [t('Duration'), duration ? `${duration}s` : ''],
    [t('File size'), formatBytes(asset.bytes)],
    [
      t('Created'),
      new Date(asset.createdAt).toLocaleString(uiFormatLocale(), { dateStyle: 'medium', timeStyle: 'short' }),
    ],
  ];
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-dismiss; Escape handling closes the dialog from the keyboard
    <div
      className="studio-detail"
      role="dialog"
      aria-label={t('Generated media detail')}
      data-details={detailsHidden ? 'hidden' : undefined}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the click only stops propagation to the backdrop */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the click only stops propagation to the backdrop */}
      <div className="studio-detail-card" onClick={(event) => event.stopPropagation()}>
        <div
          className="studio-detail-stage"
          onPointerDown={startSwipe}
          onPointerUp={endSwipe}
          onPointerCancel={() => {
            swipeStart.current = null;
          }}
        >
          {asset.kind === 'video' ? (
            // biome-ignore lint/a11y/useMediaCaption: generated clips have no caption track
            <video
              key={videoKey}
              src={videoSrc}
              poster={posterUrl}
              controls={mediaForeground}
              autoPlay={mediaForeground && localTransport}
              playsInline
              preload={videoPreload}
              onError={() => onUrlBroken(asset.id, 'original')}
            />
          ) : (
            <button
              type="button"
              className="studio-detail-media-open"
              title={remote ? undefined : t('Open image')}
              aria-label={remote ? t('Toggle details') : t('Open image')}
              aria-expanded={remote ? !detailsHidden : undefined}
              onClick={() => {
                // A swipe that paged the detail must not also count as a tap.
                if (swiped.current) {
                  swiped.current = false;
                  return;
                }
                if (remote) setDetailsHidden((hidden) => !hidden);
                else onOpenAsset(asset);
              }}
            >
              {/* alt stays empty: a prompt here painted as a wall of text in the
                  image's place until the display rendition landed (user: 섬네일
                  자리에 긴 글자가 뜸). The button above carries the label and the
                  side rail already shows the prompt itself. */}
              <img src={displayUrl} alt="" onError={() => onUrlBroken(asset.id, 'display')} />
            </button>
          )}
          {onPrevious ? (
            <button
              type="button"
              className="studio-detail-nav"
              data-direction="previous"
              aria-label={t('Previous')}
              onClick={onPrevious}
            >
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
          ) : null}
          {onNext ? (
            <button
              type="button"
              className="studio-detail-nav"
              data-direction="next"
              aria-label={t('Next')}
              onClick={onNext}
            >
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" className="studio-detail-stage-close" aria-label={t('Close preview')} onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <aside className="studio-detail-side">
          <header>
            <b>{asset.kind === 'video' ? t('Video') : t('Image')}</b>
            <button type="button" className="studio-detail-close" aria-label={t('Close preview')} onClick={onClose}>
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          <div className="studio-detail-body">
            <section className="studio-detail-block studio-detail-block--prompt">
              <div className="studio-detail-block-head">
                <span>{t('PROMPT')}</span>
                <span className="studio-detail-block-tools">
                  {promptOpen || promptClamped ? (
                    <button type="button" aria-expanded={promptOpen} onClick={onTogglePrompt}>
                      {promptOpen ? t('Show less') : t('Show all')}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => onCopyPrompt(asset)}>
                    <Copy size={12} aria-hidden="true" />
                    {copied ? t('Copied') : t('Copy')}
                  </button>
                </span>
              </div>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut that expands the prompt; the full text remains readable without it */}
              <p
                ref={promptNode}
                className="studio-detail-prompt"
                data-open={promptOpen ? 'true' : undefined}
                onClick={onTogglePrompt}
              >
                {asset.prompt}
              </p>
            </section>
            <section className="studio-detail-block studio-detail-block--metadata">
              <div className="studio-detail-block-head">
                <span>{t('DETAILS')}</span>
              </div>
              <dl>
                {details
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label} title={`${label}: ${value}`}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
              </dl>
            </section>
          </div>
          {/* One action set for every layout: the wide rail lists it, compact
              layouts turn it into an icon bar and move Delete behind More. */}
          <div className="studio-detail-actions">
            <button type="button" className="studio-detail-primary" onClick={() => onRegenerate(asset)}>
              <RotateCcw size={14} aria-hidden="true" />
              <span>{t('Regenerate')}</span>
            </button>
            <button type="button" onClick={() => onReusePrompt(asset)}>
              <PencilLine size={14} aria-hidden="true" />
              <span>{t('Reuse prompt')}</span>
            </button>
            {asset.kind === 'image' ? (
              <button type="button" disabled={!canUseAsReference} onClick={() => onUseAsReference(asset)}>
                <ImagePlus size={14} aria-hidden="true" />
                <span>{t('Use as reference')}</span>
              </button>
            ) : null}
            {remote ? (
              <button type="button" onClick={() => onSave(asset)}>
                <Download size={14} aria-hidden="true" />
                <span>{t('Save')}</span>
              </button>
            ) : (
              <button type="button" onClick={() => onOpenFolder(asset)}>
                <FolderOpen size={14} aria-hidden="true" />
                <span>{t('Open Folder')}</span>
              </button>
            )}
            <button type="button" className="studio-detail-danger" onClick={() => onRemove(asset)}>
              <Trash2 size={14} aria-hidden="true" />
              <span>{t('Delete')}</span>
            </button>
            <div className="studio-detail-more" ref={moreNode}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMenuAsset(moreOpen ? '' : asset.id)}
              >
                <Ellipsis size={14} aria-hidden="true" />
                <span>{t('More actions')}</span>
              </button>
              {moreOpen ? (
                <div className="studio-detail-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="studio-detail-danger"
                    onClick={() => {
                      setMenuAsset('');
                      onRemove(asset);
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {t('Delete')}
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
