import { useContext, useId, useRef, useState, type ReactNode } from 'react';
import { ImageLightbox, lightboxItemsFor, useLightboxRegistration, type LightboxItem } from './image-lightbox';
import { t } from './i18n';
import { usePictureHold } from './local-image-hold';
import { openProjectFileInDefaultApp, useLocalImagePreview } from './local-image-preview';
import {
  documentRelativePath,
  MarkdownDocumentDirContext,
  MarkdownProjectContext,
  MarkdownSessionContext,
} from './MarkdownLink';
import { usePersistedThumbnail } from './persisted-thumbnail';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { parseLocalFileLocation } from '../shared/local-files';

const NO_FAILED: ReadonlySet<string> = new Set();

/** `![alt](local/image.png)` as an inline thumbnail that opens the lightbox.
 *  The linkify pass hands the original path link over as `children`; it is what
 *  shows whenever the image cannot be previewed (or there is no desktop API,
 *  as on a paired phone). The preview is always an `<img>`, even for SVG. */
export function MarkdownLocalImage({
  children,
  alt,
  'data-src': src,
}: {
  children?: ReactNode;
  alt?: string;
  'data-src'?: string;
}) {
  const project = useContext(MarkdownProjectContext);
  const documentDir = useContext(MarkdownDocumentDirContext);
  const path = documentRelativePath(documentDir, parseLocalFileLocation(String(src || '')).path);
  const session = useContext(MarkdownSessionContext);
  const preview = useLocalImagePreview(project, path, session);
  // The pictures that failed to load: the kept copy stands in for the live one, the link for both; a new URL is tried.
  const [failed, setFailed] = useState<ReadonlySet<string>>(NO_FAILED);
  const [opened, setOpened] = useState<{ items: LightboxItem[]; startId: string } | null>(null);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const name = alt || path.split(/[\\/]/).at(-1) || path;
  // The picture is kept per session + file; a deleted or moved image still
  // shows the kept copy instead of falling back to a bare path link.
  const live = preview.url && !failed.has(preview.url) ? preview.url : '';
  const line = `markdown-image|${project}|${path}`;
  const url = usePersistedThumbnail(session, line, live || undefined) ?? '';
  const ready = url !== '' && !failed.has(url);
  const broken = (preview.url !== '' && !live) || (url !== '' && !ready);
  const target = live ? preview.target : null;
  // Until the lookup answers, the live picture may still come, so a kept copy shown meanwhile does not end the hold.
  const hold = usePictureHold(session, line, preview.url !== '' || preview.unavailable, ready ? url : '');
  // The host's OS cannot open anything for a paired device (the lightbox offers Download / Share).
  const openDefault = target && !isRemoteHostRenderer() ? () => void openProjectFileInDefaultApp(target) : undefined;
  useLightboxRegistration(button, ready ? { id, src: url, name, target, openDefault } : null);
  if (!ready && (preview.unavailable || broken)) return <>{children}</>;
  if (!ready) {
    return <span className="markdown-local-image" data-state="loading" aria-hidden="true" style={hold.style} />;
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className="markdown-local-image"
        aria-label={t('Open image')}
        title={name}
        style={hold.style}
        onClick={(event) => setOpened({ items: lightboxItemsFor(event.currentTarget), startId: id })}
      >
        {/* Eager: the transcript only mounts rows near the viewport anyway, and a
            lazy image inside the virtualized scroller stayed blank until clicked. */}
        <img
          ref={hold.ref}
          src={url}
          alt={name}
          onLoad={hold.onLoad}
          onError={() => setFailed((before) => new Set(before).add(url))}
        />
      </button>
      {opened && <ImageLightbox items={opened.items} startId={opened.startId} onClose={() => setOpened(null)} />}
    </>
  );
}
