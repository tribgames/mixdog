import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { attachmentMenuItems, type AttachmentMenuActions, type AttachmentMenuSource } from './attachment-menu';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
import { startFileDownload } from './file-download-panel';
import './image-lightbox';
import { openImageLightbox } from './image-lightbox-host';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { t } from './i18n';
import {
  ScmContextMenu,
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  type ScmContextMenuState,
} from './ScmContextMenu';
import { copyTextToClipboard } from './text-format';

// The renderer CSP blocks fetch() of data: URLs but allows them as images, so
// the image is decoded through an <img> and re-encoded as PNG for the clipboard.
async function pngBlob(dataUrl: string): Promise<Blob> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((png) => (png ? resolve(png) : reject(new Error(t('Copy failed')))), 'image/png')
  );
}

/** The editor-pane opener chat file links use (`MarkdownOpenFileContext`). */
export type AttachmentOpenFile = (project: string, rel: string, line?: number, accessToken?: string) => void;

export function desktopAttachmentActions(onOpenFile?: AttachmentOpenFile | null): AttachmentMenuActions {
  const api = window.mixdogDesktop;
  const remote = isRemoteHostRenderer();
  return {
    // Main writes the bytes to the session's attachment temp file and answers
    // its path; the side panel previews that file like any file link. A paired
    // device has no such file on the PC (and nothing to stage into).
    openInApp:
      !remote && api?.stageAttachmentFile && onOpenFile
        ? async (url, name) => {
            const row = await api.stageAttachmentFile!(url, name);
            if (!row.projectPath || !row.relPath) throw new Error(t('Action failed'));
            onOpenFile(row.projectPath, row.relPath, undefined, row.accessToken);
          }
        : undefined,
    // The attachment is a file on the PC, named by its content hash. The
    // desktop reads it from the store and opens it in the side panel; a paired
    // device gets the same file as a one-file preview grant scoped to the
    // session, through the ordinary remote preview path.
    openStored: async (stored, name) => {
      if (remote) {
        const row = await api?.openSessionAttachment?.(stored.sessionId, stored.id);
        if (!row?.projectPath || !row.relPath || !onOpenFile) throw new Error(t('Action failed'));
        onOpenFile(row.projectPath, row.relPath, undefined, row.accessToken);
        return;
      }
      const attachment = await api?.readSessionAttachment?.(stored.sessionId, stored.id);
      if (!attachment) throw new Error(t('Action failed'));
      if (api?.stageAttachmentFile && onOpenFile) {
        const row = await api.stageAttachmentFile(attachment.dataUrl, attachment.name || name);
        if (!row.projectPath || !row.relPath) throw new Error(t('Action failed'));
        onOpenFile(row.projectPath, row.relPath, undefined, row.accessToken);
        return;
      }
      await openImageLightbox({ src: attachment.dataUrl, name });
    },
    openStoredDefault:
      !remote && api?.readSessionAttachment && api.openAttachmentFile
        ? async (stored, name) => {
            const attachment = await api.readSessionAttachment!(stored.sessionId, stored.id);
            await api.openAttachmentFile!(attachment.dataUrl, attachment.name || name);
          }
        : undefined,
    saveStored: async (stored, name) => {
      if (remote) {
        // The download grant admits only ids this session's transcript names.
        startFileDownload({ kind: 'attachment', sessionId: stored.sessionId, attachmentId: stored.id }, name);
        return;
      }
      const attachment = await api?.readSessionAttachment?.(stored.sessionId, stored.id);
      if (!attachment || !api?.saveFileAs) throw new Error(t('Action failed'));
      await api.saveFileAs(attachment.dataUrl, attachment.name || name);
    },
    openLightbox: (url, name) => openImageLightbox({ src: url, name }),
    // The OS app is the host's: a paired device downloads instead.
    openFile: !remote && api?.openAttachmentFile ? (url, name) => api.openAttachmentFile!(url, name) : undefined,
    deviceSave: remote,
    saveAs:
      api?.saveFileAs &&
      (async (source, name) => {
        await api.saveFileAs!(source, name);
      }),
    copyImage:
      typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write
        ? async (url) => {
            const blob = await pngBlob(url);
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          }
        : undefined,
    copyText: copyTextToClipboard,
    reportError: (error) => showDesktopToast(`${t('Action failed')}: ${errorMessageText(error)}`, 'error'),
  };
}

/** Clicking a chip: its preview opens inside the app (side panel, else the
 *  image lightbox); a type the app cannot show goes to the OS app on the
 *  desktop and to Download / Share on a paired device. */
export function openAttachmentSource(source: AttachmentMenuSource, onOpenFile?: AttachmentOpenFile | null): void {
  const items = attachmentMenuItems(source, desktopAttachmentActions(onOpenFile));
  const item =
    items.find((entry) => entry.id === 'open') ??
    items.find((entry) => entry.id === 'open-default') ??
    items.find((entry) => entry.id === 'save');
  item?.onSelect?.();
}

/** Context-menu handlers for attachment chips. Spread `menuProps(source)` on a
 *  chip and render `menuElement` once. The source is resolved again when the
 *  menu opens (stored data may be registered after the chip first paints); a
 *  chip with no available item at that moment leaves the event alone. */
export function useAttachmentContextMenu(onOpenFile?: AttachmentOpenFile | null) {
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const menuProps = (sourceOf: AttachmentMenuSource | (() => AttachmentMenuSource)) => {
    const resolve = () => {
      const source = typeof sourceOf === 'function' ? sourceOf() : sourceOf;
      const items = attachmentMenuItems(source, desktopAttachmentActions(onOpenFile));
      return items.length ? { label: source.name, items } : null;
    };
    const open = (point: { x: number; y: number }) => {
      const resolved = resolve();
      if (!resolved) return false;
      setMenu({ ...resolved, ...point });
      return true;
    };
    return {
      tabIndex: resolve() ? 0 : undefined,
      onContextMenu(event: MouseEvent<HTMLElement>) {
        if (open(pointerMenuPoint(event))) event.preventDefault();
      },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (isContextMenuKey(event) && open(elementMenuPoint(event.currentTarget))) event.preventDefault();
      },
    };
  };
  return { menuProps, menuElement: <ScmContextMenu state={menu} onClose={close} /> };
}
