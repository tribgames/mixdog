import { ipcRenderer, sharedTexture, type SharedTextureImported } from 'electron';
import { DESKTOP_IPC } from '../shared/contract';

/** GPU handles stay in the isolated preload. The renderer can only paint an
 * exact session/frame into its own canvas, never send input to a guest. */
export function createBrowserTextureBridge() {
  type Lease = { imported: SharedTextureImported; release(): void };
  type Read = { session: string; previous?: string; expected?: string; frames: Map<string, Lease> };
  const reads = new Map<string, Read>();
  const discard = (canvasId: string) => {
    const read = reads.get(canvasId);
    reads.delete(canvasId);
    for (const lease of read?.frames.values() ?? []) lease.release();
    read?.frames.clear();
  };
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: imported }, sessionId: string, id: string) => {
    // The host coalesces concurrent reads. Until each reply identifies its
    // frame, any pending reader of this session may need the delivered id.
    let claims = 0;
    const lease = {
      imported,
      release() {
        if (--claims === 0) imported.release();
      },
    };
    for (const read of reads.values()) {
      if (read.session !== sessionId || read.previous === id || read.frames.has(id)) continue;
      if (read.expected !== undefined && read.expected !== id) continue;
      claims++;
      read.frames.set(id, lease);
    }
    if (!claims) imported.release();
  });
  window.addEventListener('unload', () => {
    for (const canvasId of reads.keys()) discard(canvasId);
  });
  return {
    browserPageFrame: async (sessionId: string, previousId?: string, canvasId?: string) => {
      if (!canvasId) return ipcRenderer.invoke(DESKTOP_IPC.browserPageFrame, sessionId, previousId, false);
      discard(canvasId);
      const read: Read = { session: sessionId, previous: previousId, frames: new Map() };
      reads.set(canvasId, read);
      try {
        const frame = await ipcRenderer.invoke(DESKTOP_IPC.browserPageFrame, sessionId, previousId, true);
        if (reads.get(canvasId) === read) {
          if (!frame.textureId || frame.textureId === previousId) discard(canvasId);
          else {
            read.expected = frame.textureId;
            for (const [id, lease] of read.frames) {
              if (id === read.expected) continue;
              read.frames.delete(id);
              lease.release();
            }
          }
        }
        return frame;
      } catch (error) {
        if (reads.get(canvasId) === read) discard(canvasId);
        throw error;
      }
    },
    browserPresentTexture(sessionId: string, textureId: string, canvasId: string): void {
      const read = reads.get(canvasId);
      const entry = read?.session === sessionId && read.expected === textureId && read.frames.get(textureId);
      const canvas = document.getElementById(canvasId);
      if (!entry || !(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Browser display frame is not ready.');
      }
      let video: VideoFrame | undefined;
      try {
        video = entry.imported.getVideoFrame();
        if (canvas.width !== video.displayWidth) canvas.width = video.displayWidth;
        if (canvas.height !== video.displayHeight) canvas.height = video.displayHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Browser display canvas is unavailable.');
        context.drawImage(video, 0, 0);
      } finally {
        video?.close();
        discard(canvasId);
      }
    },
    browserDiscardTexture(sessionId: string, canvasId: string): void {
      if (reads.get(canvasId)?.session === sessionId) discard(canvasId);
    },
  };
}
