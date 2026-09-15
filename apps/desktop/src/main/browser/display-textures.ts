import type { WebContents, SharedTextureImported, OffscreenSharedTexture } from 'electron';

export interface BrowserDisplayTexture {
  id: string;
  width: number;
  height: number;
  send(sessionId: string): Promise<void>;
  release(): void;
}

/** One latest frame per guest; leases keep replaced textures alive only while
 * a display read or the receiving GPU is still using them. */
export function createBrowserDisplayTextures(host: {
  document(guest: WebContents): string;
  importTexture(texture: OffscreenSharedTexture, released: () => void): SharedTextureImported;
  send(texture: SharedTextureImported, sessionId: string, id: string): Promise<void>;
}) {
  type Frame = {
    id: string; document: string; width: number; height: number;
    texture: OffscreenSharedTexture; retain(): void; release(): void;
  };
  const frames = new WeakMap<WebContents, Frame>();
  const attached = new WeakSet<WebContents>();
  let serial = 0;
  const clear = (guest: WebContents) => {
    const old = frames.get(guest);
    frames.delete(guest);
    old?.release();
  };
  return {
    attach(guest: WebContents): void {
      if (attached.has(guest)) return;
      attached.add(guest);
      const paint = (event: Electron.Event & { texture?: OffscreenSharedTexture }) => {
        if (!event.texture) return;
        clear(guest);
        const texture = event.texture;
        if (texture.textureInfo.widgetType !== 'frame') { texture.release(); return; }
        let references = 1;
        frames.set(guest, {
          id: `gpu_${guest.id}_${++serial}`, document: host.document(guest),
          width: texture.textureInfo.visibleRect.width, height: texture.textureInfo.visibleRect.height,
          texture, retain() { references++; },
          release() { if (--references === 0) texture.release(); },
        });
      };
      const navigation = (_event: unknown, _url: string, _inPlace: boolean, main: boolean) => {
        if (main) clear(guest);
      };
      guest.on('paint', paint);
      guest.on('did-start-navigation', navigation);
      guest.once('destroyed', () => {
        clear(guest);
        guest.removeListener('paint', paint);
        guest.removeListener('did-start-navigation', navigation);
      });
    },
    acquire(guest: WebContents, document: string, width: number, height: number): BrowserDisplayTexture | undefined {
      const frame = frames.get(guest);
      // A resized, navigated, or differently scaled compositor frame must not
      // be relabelled with the new page's input coordinates.
      if (!frame || frame.document !== document || frame.width !== width || frame.height !== height) return;
      frame.retain();
      let released = false;
      return {
        id: frame.id, width: frame.width, height: frame.height,
        async send(sessionId) {
          frame.retain();
          let imported: SharedTextureImported;
          try { imported = host.importTexture(frame.texture, () => frame.release()); }
          catch (error) { frame.release(); throw error; }
          try { await host.send(imported, sessionId, frame.id); }
          finally { imported.release(); }
        },
        release() { if (!released) { released = true; frame.release(); } },
      };
    },
  };
}
