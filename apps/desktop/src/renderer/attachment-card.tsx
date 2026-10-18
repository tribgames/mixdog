// One attachment tile shared by the composer, the automation editors and sent
// user messages: an image is its own thumbnail; anything else shows a picture
// of its content (PDF first page, code or prose minimap, else the drawn
// document sheet) above a bar with its name and a small coloured type word.
import { X } from 'lucide-react';
import { useEffect, useState, type HTMLAttributes, type ReactNode } from 'react';
import { textLineCount, type ComposerAttachment } from './composer-support';
import {
  ContentMinimap,
  DocSheet,
  FileTypeWord,
  fileExtension,
  fileTone,
  looksLikeCode,
  type FileTone,
} from './file-thumbnail-art';
import { t } from './i18n';
import { MxIcon } from './MxIcon';

type AttachmentCardKind = 'image' | 'pasted' | 'text' | 'pdf' | 'office';

/** Tone, type word and prose/code reading of a non-image card. */
function attachmentCardType(
  kind: AttachmentCardKind,
  name: string,
  text = ''
): { tone: FileTone; word: string; prose: boolean } {
  const extension = fileExtension(name);
  if (kind === 'pasted' || (kind === 'text' && !extension)) {
    const code = looksLikeCode(text);
    return { tone: code ? 'code' : 'txt', word: code ? 'CODE' : 'TXT', prose: !code };
  }
  const tone = kind === 'pdf' ? 'pdf' : fileTone(name, kind === 'text');
  const word = extension && extension.length <= 5 ? extension.toUpperCase() : kind === 'pdf' ? 'PDF' : t('File');
  return { tone, word, prose: tone === 'txt' };
}

// Rendered first pages of attached PDFs, by their base64 data: a card that
// re-renders, or the same file in the composer and the sent message, reuses
// one rasterization. Bounded; failures stay cached so they never retry in a loop.
// Exported so tests can seed a page without rasterizing a PDF.
const PDF_PAGE_CACHE_LIMIT = 12;
export const pdfPages = new Map<string, Promise<string>>();

function pdfFirstPage(data: string): Promise<string> {
  let page = pdfPages.get(data);
  if (!page) {
    page = import('unpdf').then(({ renderPageAsImage }) =>
      renderPageAsImage(
        Uint8Array.from(atob(data), (char) => char.charCodeAt(0)),
        1,
        { width: 176, toDataURL: true }
      )
    );
    pdfPages.set(data, page);
    while (pdfPages.size > PDF_PAGE_CACHE_LIMIT) pdfPages.delete(pdfPages.keys().next().value!);
  }
  return page;
}

/** First page of an attached PDF, rendered in the renderer (no file path
 *  exists for it); the drawn sheet stands in until it arrives or if it fails. */
function PdfFirstPage({ data, tone }: { data: string; tone: FileTone }) {
  const [page, setPage] = useState({ data: '', src: '' });
  useEffect(() => {
    let active = true;
    pdfFirstPage(data).then(
      (src) => {
        if (active) setPage({ data, src });
      },
      () => undefined
    );
    return () => {
      active = false;
    };
  }, [data]);
  return page.data === data && page.src ? (
    <span className="attachment-card-frame">
      <img className="file-page" src={page.src} alt="" />
    </span>
  ) : (
    <DocSheet tone={tone} />
  );
}

function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Card kind of a composer or automation attachment. */
export function composerCardKind(attachment: {
  kind: ComposerAttachment['kind'];
  source?: ComposerAttachment['source'];
}): AttachmentCardKind {
  if (attachment.kind === 'text') return attachment.source === 'paste' ? 'pasted' : 'text';
  return attachment.kind;
}

/** Line count for text, decoded size for binary files, nothing for images. */
export function composerCardMeta(attachment: { kind: ComposerAttachment['kind']; data: string }): string {
  if (attachment.kind === 'image') return '';
  if (attachment.kind === 'text') return t('{{count}} lines', { count: textLineCount(attachment.data) });
  const padding = attachment.data.endsWith('==') ? 2 : attachment.data.endsWith('=') ? 1 : 0;
  return byteSize(Math.max(0, Math.floor((attachment.data.length * 3) / 4) - padding));
}

export function AttachmentCard({
  kind,
  name,
  tooltip,
  imageUrl,
  content,
  meta,
  menu,
  onOpen,
  onEdit,
  onRemove,
  removeDisabled = false,
}: {
  kind: AttachmentCardKind;
  name: string;
  /** Hover text; defaults to the name (and the meta, for a non-image card). */
  tooltip?: string;
  /** Thumbnail source; an image without one renders as an icon card. */
  imageUrl?: string;
  /** What the thumbnail is drawn from: the text of a text or pasted card, the
   *  base64 data of a PDF. Without it the card shows the drawn sheet. */
  content?: string;
  meta?: string;
  /** Context-menu handlers from `useAttachmentContextMenu().menuProps`. */
  menu?: HTMLAttributes<HTMLElement>;
  onOpen?: () => void;
  onEdit?: () => void;
  onRemove?: () => void;
  removeDisabled?: boolean;
}) {
  const imageFallback = kind === 'image' && !imageUrl;
  const pasted = kind === 'pasted' && !!meta;
  const label = pasted ? `${t('Paste')} · ${meta}` : name;
  let body: ReactNode;
  let hover = tooltip || name;
  if (imageUrl) {
    body = onOpen ? (
      <button
        type="button"
        className="attachment-card-open"
        aria-label={t('Open image')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onOpen}
      >
        <img src={imageUrl} alt={name} />
      </button>
    ) : (
      <img src={imageUrl} alt={name} />
    );
  } else if (imageFallback) {
    body = (
      <span className="attachment-card-body">
        <MxIcon name="photo" size={16} />
        <span className="attachment-card-name">{name}</span>
        {meta ? <span className="attachment-card-meta">{meta}</span> : null}
      </span>
    );
  } else {
    const text = kind === 'text' || kind === 'pasted' ? content || '' : '';
    const type = attachmentCardType(kind, name, text);
    let thumbnail: ReactNode = <DocSheet tone={type.tone} />;
    if (text)
      thumbnail = (
        <span className="attachment-card-frame">
          <ContentMinimap text={text} prose={type.prose} />
        </span>
      );
    else if (kind === 'pdf' && content) thumbnail = <PdfFirstPage data={content} tone={type.tone} />;
    if (!tooltip && meta) hover = pasted ? label : `${name} · ${meta}`;
    const parts = (
      <>
        <span className="attachment-card-shot">{thumbnail}</span>
        <span className="attachment-card-bar">
          <span className="attachment-card-name">{label}</span>
          <FileTypeWord tone={type.tone} label={type.word} />
        </span>
      </>
    );
    body = onEdit ? (
      // Pointer shortcut only; the pencil button is the keyboard path.
      <button type="button" className="attachment-card-file" tabIndex={-1} onClick={onEdit}>
        {parts}
      </button>
    ) : (
      <span className="attachment-card-file">{parts}</span>
    );
  }
  return (
    <div className={`attachment-card ${kind}${imageUrl ? ' thumb' : ''}`} data-tooltip={hover} {...menu}>
      {body}
      {onEdit && (
        <button
          type="button"
          className="attachment-card-edit"
          aria-label={t('Edit pasted text')}
          data-tooltip={t('Edit pasted text')}
          onClick={onEdit}
        >
          <MxIcon name="edit" size={12} />
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          className="attachment-card-remove"
          aria-label={t('Remove {{name}}', { name: label })}
          data-tooltip={t('Remove')}
          disabled={removeDisabled}
          onClick={onRemove}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
