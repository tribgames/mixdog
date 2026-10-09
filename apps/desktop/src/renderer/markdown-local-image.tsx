import { useContext, useId, useRef, useState, type ReactNode } from 'react';
import { ImageLightbox, lightboxItemsFor, useLightboxRegistration, type LightboxItem } from './image-lightbox';
import { t } from './i18n';
import { openProjectFileInDefaultApp, useLocalImagePreview } from './local-image-preview';
import { documentRelativePath, MarkdownDocumentDirContext, MarkdownProjectContext } from './MarkdownLink';
import { parseLocalFileLocation } from '../shared/local-files';

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
  const preview = useLocalImagePreview(project, path);
  const [broken, setBroken] = useState(false);
  const [opened, setOpened] = useState<{ items: LightboxItem[]; startId: string } | null>(null);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const name = alt || path.split(/[\\/]/).at(-1) || path;
  const ready = Boolean(preview.url) && !broken;
  const { target } = preview;
  useLightboxRegistration(
    button,
    ready
      ? {
          id,
          src: preview.url,
          name,
          target,
          openDefault: target ? () => void openProjectFileInDefaultApp(target) : undefined,
        }
      : null
  );
  if (preview.unavailable || broken) return <>{children}</>;
  if (!ready) return <span className="markdown-local-image" data-state="loading" aria-hidden="true" />;
  return (
    <>
      <button
        ref={button}
        type="button"
        className="markdown-local-image"
        aria-label={t('Open image')}
        title={name}
        onClick={() => setOpened({ items: lightboxItemsFor(button.current!), startId: id })}
      >
        <img src={preview.url} alt={name} loading="lazy" onError={() => setBroken(true)} />
      </button>
      {opened && <ImageLightbox items={opened.items} startId={opened.startId} onClose={() => setOpened(null)} />}
    </>
  );
}
