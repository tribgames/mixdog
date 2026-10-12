import { useCallback, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { attachmentMenuItems, type AttachmentMenuActions, type AttachmentMenuSource } from './attachment-menu';
import { showDesktopToast } from './desktop-toasts';
import { errorMessageText } from './ErrorNotice';
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

function desktopAttachmentActions(onOpenFile?: AttachmentOpenFile | null): AttachmentMenuActions {
  const api = window.mixdogDesktop;
  return {
    openInApp:
      api?.stageAttachmentFile && onOpenFile
        ? async (url, name) => {
            const row = await api.stageAttachmentFile!(url, name);
            if (!row.projectPath || !row.relPath) throw new Error(t('Action failed'));
            onOpenFile(row.projectPath, row.relPath, undefined, row.accessToken);
          }
        : undefined,
    openImage: api?.openAttachmentImage && ((url, name) => api.openAttachmentImage!(url, name)),
    openFile: api?.openAttachmentFile && ((url, name) => api.openAttachmentFile!(url, name)),
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
