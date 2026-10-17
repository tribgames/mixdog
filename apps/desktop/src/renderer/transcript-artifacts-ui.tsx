import { Download, FileText, FolderOpen, Play, X } from 'lucide-react';
import { useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ImageLightbox, lightboxItemsFor, useLightboxRegistration, type LightboxItem } from './image-lightbox';
import { openProjectFileInDefaultApp, useLocalImagePreview } from './local-image-preview';
import type { ResolvedLocalLink } from './local-link-resolver';
import type { TranscriptItem } from './desktop-types';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { DocSheet, FileTypeWord, TableThumbnail, delimitedSummary, fileTone } from './file-thumbnail-art';
import { t } from './i18n';
import { fileSnapshot, usePersistedThumbnail } from './persisted-thumbnail';
import { verifyLocalLink } from './local-link-resolver';
import { MarkdownLink, MarkdownProjectContext, MarkdownSessionContext } from './MarkdownLink';
import { useGeneratedMediaFallback } from './generated-media-fallback';
import { fileDownloadBlockedReason, startFileDownload, useFileDownloadSupport } from './file-download-panel';
import { fileDownloadReasonMessage } from './file-download-transfer';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { MxIcon } from './MxIcon';
import { parseLocalFileLocation } from '../shared/local-files';
import { mediaUrl } from './studio-support';
import { openMediaAssetFromWindow, openMediaFolderFromWindow } from './studio-pane-media-actions';
import { isSshConnectionWindow } from './desktop-connection';
import { transcriptArtifacts, type TranscriptArtifact } from './transcript-artifacts';

/** file:// href for a local artifact path; a Windows drive segment stays unencoded. */
function artifactHref(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map((part, index) => (index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)))
    .join('/');
}

/** Upper-case extension shown as a card's format ("PNG", "PDF"); empty without one. */
function formatLabel(name: string): string {
  return /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toUpperCase() || '';
}

// Every card is a fixed-height plate; only its width follows the source.
const CARD_HEIGHT = 160;
const MIN_CARD_WIDTH = 120;
const MIN_RATIO = 2 / 3;
const MAX_RATIO = 16 / 9;

type MediaFit = 'contain' | 'top' | 'center' | 'native' | 'cover';

/** Card width and crop: 2:3–16:9 sources show whole at their own ratio, a
 *  taller image shows its top, a wider source or tall video its middle, and a
 *  source smaller than the card stays at its own size. Grid cards are squares. */
function mediaFrame(
  kind: TranscriptArtifact['kind'],
  size: { width: number; height: number } | null,
  hint: number | undefined,
  square: boolean
): { width: number; fit: MediaFit } {
  if (square) return { width: CARD_HEIGHT, fit: 'cover' };
  if (size && size.width < CARD_HEIGHT && size.height < CARD_HEIGHT) return { width: CARD_HEIGHT, fit: 'native' };
  const ratio = size ? size.width / size.height : hint || 1;
  let fit: MediaFit = 'contain';
  if (ratio < MIN_RATIO) fit = kind === 'video' ? 'center' : 'top';
  else if (ratio > MAX_RATIO) fit = 'center';
  const width = Math.round(CARD_HEIGHT * Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)));
  return { width: Math.max(MIN_CARD_WIDTH, width), fit };
}

/** Image/video card and its full-size dialog, shared by generated media and
 *  images written to local files. The thumbnail is the one the source already
 *  has; a video plays only inside the dialog, after the user starts it. */
function MediaFigure({
  artifact,
  original,
  preview,
  actions,
  square,
  target,
  openDefault,
  loadClip,
}: {
  artifact: TranscriptArtifact;
  /** Video without a media lane: reads the clip when the dialog opens. */
  loadClip?: () => Promise<string>;
  original: string;
  preview: string;
  actions: ReactNode;
  square: boolean;
  /** Project file behind an image, for the lightbox's "Open in tab". */
  target?: ResolvedLocalLink | null;
  /** The artifact's existing open-in-OS path, for the lightbox. */
  openDefault?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; startId: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const video = artifact.kind === 'video';
  useEffect(() => {
    if (expanded && video) dialog.current?.showModal();
  }, [expanded, video]);
  useLightboxRegistration(
    frameRef,
    !video && original && !failed ? { id, src: original, name: artifact.name, target, openDefault } : null
  );
  // A picture that loaded is kept per session + file; when the source is gone
  // (deleted file, expired media asset) the kept copy stands in.
  const session = useContext(MarkdownSessionContext);
  const [loadedSrc, setLoadedSrc] = useState('');
  const kept = usePersistedThumbnail(
    session,
    `artifact|${artifact.assetId || artifact.path || artifact.name}`,
    loadedSrc || undefined
  );
  let source = '';
  if (!failed) source = video ? preview : preview || original;
  const thumbnail = source || kept || '';
  const [clip, setClip] = useState('');
  const playable = original || clip;
  const openable = (Boolean(original) || (video && Boolean(loadClip))) && (video || !failed);
  const frame = mediaFrame(artifact.kind, size, artifact.aspect, square);
  const label = video ? artifact.name : t('Open image');
  return (
    <figure
      className="transcript-artifact-media"
      data-fit={frame.fit}
      data-preview={thumbnail ? 'ready' : 'none'}
      style={{ '--artifact-width': `${frame.width}px` } as CSSProperties}
    >
      <button
        ref={frameRef}
        type="button"
        className="transcript-artifact-frame"
        aria-label={label}
        disabled={!openable}
        onClick={(event) => {
          if (!video) setLightbox({ items: lightboxItemsFor(event.currentTarget), startId: id });
          if (video && !original && !clip && loadClip) loadClip().then(setClip, () => setFailed(true));
          setExpanded(true);
        }}
      >
        {thumbnail ? (
          <img
            // Eager: the virtualized transcript only mounts nearby rows; a lazy
            // image there stayed blank until it was clicked.
            src={thumbnail}
            alt={artifact.name}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (width > 0 && height > 0) setSize({ width, height });
              if (!failed && event.currentTarget.currentSrc !== kept) setLoadedSrc(event.currentTarget.currentSrc);
            }}
            onError={(event) => {
              if (!video && event.currentTarget.src !== original) event.currentTarget.src = original;
              else setFailed(true);
            }}
          />
        ) : (
          !video && <FileText size={24} aria-hidden="true" />
        )}
        {video && (
          <span className="transcript-artifact-play" aria-hidden="true">
            <Play size={16} fill="currentColor" />
          </span>
        )}
      </button>
      <figcaption>
        <span title={artifact.path || artifact.name}>{artifact.name}</span>
        <small>{formatLabel(artifact.name) || (video ? t('Video') : t('Image'))}</small>
      </figcaption>
      <div className="transcript-artifact-actions">{actions}</div>
      {expanded && video && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: a backdrop press closes the dialog; Escape (native dialog) and the close button are the keyboard routes.
        <dialog
          ref={dialog}
          className="transcript-artifact-preview"
          aria-label={label}
          onClose={() => setExpanded(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) dialog.current?.close();
          }}
        >
          <button
            type="button"
            className="icon-button"
            aria-label={t('Close preview')}
            data-tooltip={t('Close preview')}
            data-tooltip-side="left"
            onClick={() => dialog.current?.close()}
          >
            <X size={16} aria-hidden="true" />
          </button>
          {artifact.assetId && isRemoteHostRenderer() && <MediaDownloadButton artifact={artifact} />}
          {/* biome-ignore lint/a11y/useMediaCaption: generated media carries no caption track to offer. */}
          {playable && <video src={playable} poster={preview || undefined} controls preload="none" playsInline />}
        </dialog>
      )}
      {expanded && !video && lightbox && (
        <ImageLightbox items={lightbox.items} startId={lightbox.startId} onClose={() => setExpanded(false)} />
      )}
    </figure>
  );
}

/** A paired device's action on generated media: download the original to
 *  this device (and share it), or the reason it cannot. */
function MediaDownloadButton({ artifact }: { artifact: TranscriptArtifact }) {
  const sessionId = useContext(MarkdownSessionContext);
  const blocked =
    fileDownloadBlockedReason(useFileDownloadSupport(true)) ||
    (sessionId ? undefined : fileDownloadReasonMessage('unavailable'));
  const label = blocked || t('Download / Share');
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={t('Download / Share')}
      data-tooltip={label}
      aria-disabled={blocked ? 'true' : undefined}
      onClick={() => {
        if (blocked) showDesktopToast(blocked, 'error');
        else startFileDownload({ kind: 'media', sessionId, assetId: artifact.assetId! }, artifact.name);
      }}
    >
      <Download size={14} aria-hidden="true" />
    </button>
  );
}

function GeneratedMedia({ artifact, square }: { artifact: TranscriptArtifact; square: boolean }) {
  const api = window.mixdogDesktop;
  const id = artifact.assetId!;
  const remote = isRemoteHostRenderer();
  const openLabel = isSshConnectionWindow() ? t('Download to this PC and open') : t('Open file');
  const folderLabel = isSshConnectionWindow() ? t('Reveal in Files') : t('Open Folder');
  const open = async (folder = false) => {
    try {
      const action = folder ? api?.openMediaFolder : api?.openMediaAsset;
      if (!action) throw new Error(t('Local file links can only be opened in the desktop app.'));
      // A server window downloads or reveals instead of handing a server path to this PC.
      await (folder ? openMediaFolderFromWindow : openMediaAssetFromWindow)(api, id);
    } catch (error) {
      showDesktopToast(t('Unable to open file: {{error}}', { error: errorMessageText(error) }), 'error');
    }
  };
  const laneOriginal = mediaUrl(api, id, 'original');
  const lanePreview = mediaUrl(api, id, artifact.kind === 'video' ? 'thumb' : 'display');
  // No media lane on a paired device: the asset is read over RPC instead.
  const fallback = useGeneratedMediaFallback(
    api,
    id,
    artifact.kind === 'video' ? 'video' : 'image',
    remote && !laneOriginal
  );
  return (
    <MediaFigure
      artifact={artifact}
      original={laneOriginal || (artifact.kind === 'video' ? '' : fallback.still)}
      preview={lanePreview || fallback.still}
      loadClip={laneOriginal ? undefined : fallback.loadClip}
      square={square}
      openDefault={remote ? undefined : () => void open()}
      actions={
        <>
          {/* Same icon-only action grammar as the response copy control: transparent
            icon-button + tooltip, never a native grey text button. The host's
            OS cannot open anything for a paired device: it downloads instead. */}
          {remote ? (
            <MediaDownloadButton artifact={artifact} />
          ) : (
            <button
              type="button"
              className="icon-button"
              aria-label={openLabel}
              data-tooltip={openLabel}
              onClick={() => void open()}
            >
              <MxIcon name="open-file" size={14} />
            </button>
          )}
          {api?.openMediaFolder && (
            <button
              type="button"
              className="icon-button"
              aria-label={folderLabel}
              data-tooltip={folderLabel}
              onClick={() => void open(true)}
            >
              <FolderOpen size={14} aria-hidden="true" />
            </button>
          )}
        </>
      }
    />
  );
}

/** An image an edit wrote (SVG), shown like generated media through the file
 *  preview lane; `<img>` never runs the SVG's scripts. A file that cannot be
 *  previewed falls back to the document row, which also reports deletion. */
function LocalImageArtifact({ artifact, square }: { artifact: TranscriptArtifact; square: boolean }) {
  const project = useContext(MarkdownProjectContext);
  const href = artifactHref(artifact.path);
  const { url, target, unavailable } = useLocalImagePreview(project, parseLocalFileLocation(href).path);
  if (unavailable) return <DocumentArtifact artifact={artifact} />;
  return (
    <MediaFigure
      key={url}
      artifact={artifact}
      original={url}
      preview={url}
      square={square}
      target={target}
      openDefault={target && !isRemoteHostRenderer() ? () => void openProjectFileInDefaultApp(target) : undefined}
      actions={
        <MarkdownLink className="icon-button" title={t('Open file')} href={href}>
          <MxIcon name="open-file" size={14} />
        </MarkdownLink>
      }
    />
  );
}

/** What a document card shows as its thumbnail. */
type DocumentThumb =
  | { phase: 'loading' }
  | { phase: 'page'; src: string; pageCount: number }
  | { phase: 'table'; rows: string[][]; rowCount: number; columnCount: number }
  | { phase: 'failed' }
  | { phase: 'missing' };

// Small first page: the thumbnail is at most 64px wide, so the preview
// service's smallest width already covers a 2x screen.
const THUMBNAIL_PAGE_WIDTH = 320;
const WIDE_DOCUMENT = /\.(?:xlsx?|xlsm|ods|csv|tsv|pptx?|pptm|odp)$/i;
const SLIDES = /\.(?:pptx?|pptm|odp)$/i;

/** The first page through the document preview pipeline (PDF in place, office
 *  files converted), or for CSV/TSV a table drawn from the file's first rows. */
async function documentThumb(match: ResolvedLocalLink, name: string, session: string): Promise<DocumentThumb> {
  const api = window.mixdogDesktop;
  // A web page has no document pages: the host renders the page itself.
  if (/\.html?$/i.test(name)) {
    const src = await fileSnapshot(session, match);
    return src ? { phase: 'page', src, pageCount: 0 } : { phase: 'failed' };
  }
  let delimiter = '';
  if (/\.tsv$/i.test(name)) delimiter = '\t';
  else if (/\.csv$/i.test(name)) delimiter = ',';
  if (delimiter) {
    const file = await api?.readProjectFile?.(match.project, match.path, match.accessToken);
    if (!file || file.binary || file.tooLarge || !file.content.trim()) return { phase: 'failed' };
    return { phase: 'table', ...delimitedSummary(file.content, delimiter) };
  }
  const reply = await api?.previewDocumentPages?.(match.project, match.path, match.accessToken, {
    pages: [1],
    maxWidth: THUMBNAIL_PAGE_WIDTH,
  });
  const page = reply?.pages.find((entry) => entry.page === 1);
  if (!reply || !page?.base64) return { phase: 'failed' };
  return { phase: 'page', src: `data:${page.mime};base64,${page.base64}`, pageCount: reply.pageCount };
}

function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A written document as a horizontal card: its first page (or a table drawn
 *  from a CSV), name, type · pages · size and an Open affordance. Until the
 *  page arrives, when it cannot be made, or when the file is gone, the drawn
 *  document sheet stands in. Office outputs are often removed after the turn
 *  (smoke tests, cleanups): a card whose file is gone reads as deleted instead
 *  of offering an open that fails. */
function DocumentArtifact({ artifact }: { artifact: TranscriptArtifact }) {
  const project = useContext(MarkdownProjectContext);
  const session = useContext(MarkdownSessionContext);
  const href = artifactHref(artifact.path);
  const [thumb, setThumb] = useState<DocumentThumb>({ phase: 'loading' });
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    setSize(null);
    const api = window.mixdogDesktop;
    if (!api?.statProjectFile) {
      setThumb({ phase: 'failed' });
      return;
    }
    setThumb({ phase: 'loading' });
    let active = true;
    verifyLocalLink(project, parseLocalFileLocation(href).path).then(
      (match) => {
        if (!active) return;
        api.statProjectFile?.(match.project, match.path, match.accessToken).then(
          (info) => {
            if (active) setSize(info.size);
          },
          () => undefined
        );
        documentThumb(match, artifact.name, session).then(
          (next) => {
            if (active) setThumb(next);
          },
          () => {
            if (active) setThumb({ phase: 'failed' });
          }
        );
      },
      () => {
        if (active) setThumb({ phase: 'missing' });
      }
    );
    return () => {
      active = false;
    };
  }, [project, href, artifact.name, session]);
  const missing = thumb.phase === 'missing';
  const format = formatLabel(artifact.name);
  const tone = fileTone(artifact.name);
  const wide = WIDE_DOCUMENT.test(artifact.name);
  const facts: string[] = [];
  if (missing) facts.push(t('Deleted'));
  else if (thumb.phase === 'loading') facts.push(t('Preparing preview…'));
  else if (thumb.phase === 'page' && thumb.pageCount > 0) {
    facts.push(
      SLIDES.test(artifact.name)
        ? t('{{count}} slides', { count: thumb.pageCount })
        : t('{{count}} pages', { count: thumb.pageCount })
    );
  } else if (thumb.phase === 'table') {
    facts.push(t('{{count}} rows', { count: thumb.rowCount }), t('{{count}} columns', { count: thumb.columnCount }));
  }
  if (!missing && size !== null) facts.push(byteSize(size));
  let picture: ReactNode = <DocSheet tone={tone} />;
  if (thumb.phase === 'page') picture = <img className="file-page" src={thumb.src} alt="" />;
  else if (thumb.phase === 'table') picture = <TableThumbnail rows={thumb.rows} />;
  const card = (
    <>
      <span className={`transcript-artifact-thumb${wide ? ' wide' : ''}`} data-thumb={thumb.phase}>
        {picture}
      </span>
      <span className="transcript-artifact-body">
        <span>{artifact.name}</span>
        <small>
          {format && <FileTypeWord tone={tone} label={format} />}
          <span>{facts.join(' · ') || t('Open file')}</span>
        </small>
      </span>
      {!missing && (
        <span className="transcript-artifact-open" aria-hidden="true">
          {t('Open')}
        </span>
      )}
    </>
  );
  if (missing) {
    return (
      <span className="transcript-artifact-file" title={artifact.path} aria-disabled="true">
        {card}
      </span>
    );
  }
  return (
    <MarkdownLink className="transcript-artifact-file" title={artifact.path} href={href}>
      {card}
    </MarkdownLink>
  );
}

/** One to three media keep their own ratios on a row that never wraps, so a
 *  decoded size changes widths but never the turn's height; four or more
 *  become a grid of same-size squares. Files follow as document cards. */
export function TranscriptArtifacts({ items }: { items: readonly TranscriptItem[] }) {
  const artifacts = useMemo(() => transcriptArtifacts(items), [items]);
  if (!artifacts.length) return null;
  const media = artifacts.filter((artifact) => artifact.assetId || artifact.kind === 'image');
  const files = artifacts.filter((artifact) => !media.includes(artifact));
  const square = media.length >= 4;
  return (
    <div className="transcript-artifacts">
      {media.length > 0 && (
        <div className={square ? 'transcript-artifact-grid' : 'transcript-artifact-row'}>
          {media.map((artifact) =>
            artifact.assetId ? (
              <GeneratedMedia key={artifact.key} artifact={artifact} square={square} />
            ) : (
              <LocalImageArtifact key={artifact.key} artifact={artifact} square={square} />
            )
          )}
        </div>
      )}
      {files.length > 0 && (
        <div className="transcript-artifact-files">
          {files.map((artifact) => (
            <DocumentArtifact key={artifact.key} artifact={artifact} />
          ))}
        </div>
      )}
    </div>
  );
}
