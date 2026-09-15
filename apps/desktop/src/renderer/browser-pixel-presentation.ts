import type { DesktopBrowserPageFrame } from '../shared/contract';

/** Publish already-decoded pixels and input geometry in one JS task, without
 * making React render at compositor cadence. */
export function createBrowserPixelPresentation(host: {
  container(): HTMLDivElement | null;
  image: { current: HTMLElement | null };
  canvasId: string;
  texture?(id: string, canvasId: string): void;
  metadata(frame: DesktopBrowserPageFrame): void;
}) {
  const prepared = new WeakMap<DesktopBrowserPageFrame, HTMLImageElement>();
  let current: DesktopBrowserPageFrame | null = null;
  let metadataKey = '';
  let surface: { width: number; height: number } | undefined;
  const visibility = () => {
    if (host.image.current) host.image.current.hidden = current?.surfaceWidth !== undefined
      && (!surface || current.surfaceWidth !== surface.width || current.surfaceHeight !== surface.height);
  };
  return {
    async prepare(frame: DesktopBrowserPageFrame): Promise<void> {
      if (!frame.image) return;
      const image = new Image();
      image.draggable = false;
      image.alt = frame.title || 'Browser Use';
      image.src = `data:${frame.image.mimeType};base64,${frame.image.data}`;
      await image.decode();
      prepared.set(frame, image);
    },
    resize(width: number, height: number): void {
      surface = { width, height };
      visibility();
    },
    update(frame: DesktopBrowserPageFrame): void {
      const container = host.container();
      if (!container) return;
      let changed = false;
      if (frame.textureId && (frame.textureId !== current?.textureId || frame.documentId !== current?.documentId)) {
        if (!host.texture) throw new Error('Browser GPU display is unavailable.');
        const old = host.image.current;
        const canvas = old instanceof HTMLCanvasElement ? old : document.createElement('canvas');
        canvas.id = host.canvasId;
        if (canvas !== old) { canvas.hidden = true; container.append(canvas); }
        try { host.texture(frame.textureId, host.canvasId); }
        catch (error) { if (canvas !== old) canvas.remove(); throw error; }
        container.replaceChildren(canvas);
        host.image.current = canvas;
        changed = true;
      } else if (frame.image) {
        const image = prepared.get(frame);
        if (!image) throw new Error('Browser display image was not decoded.');
        prepared.delete(frame);
        container.replaceChildren(image);
        host.image.current = image;
        changed = true;
      } else if (frame.documentId !== current?.documentId) {
        container.replaceChildren();
        host.image.current = null;
      }
      current = frame;
      visibility();
      const { image: _image, frameId: _id, textureId: _texture, ...metadata } = frame;
      const key = JSON.stringify(metadata);
      if (metadataKey !== key) {
        metadataKey = key;
        host.metadata({ ...frame, image: undefined });
      }
      if (changed) container.dispatchEvent(new Event('browser-frame-presented', { bubbles: true }));
    },
  };
}
