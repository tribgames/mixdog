import { ipcRenderer, sharedTexture, type SharedTextureImported } from 'electron';
import { DESKTOP_IPC } from '../shared/contract';

/** GPU handles stay in the isolated preload. The renderer can only paint an
 * exact session/frame into its own canvas, never send input to a guest. */
export function createBrowserTextureBridge() {
  const active = new Set<string>();
  const frames = new Map<string, { id: string; imported: SharedTextureImported }>();
  const presented = new Map<string, string>();
  const discard = (sessionId: string) => {
    frames.get(sessionId)?.imported.release();
    frames.delete(sessionId);
  };
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture: imported }, sessionId: string, id: string) => {
    if (!active.has(sessionId) || presented.get(sessionId) === id) { imported.release(); return; }
    discard(sessionId);
    frames.set(sessionId, { id, imported });
  });
  window.addEventListener('unload', () => { for (const sessionId of frames.keys()) discard(sessionId); });
  return {
    browserPageFrame: (sessionId: string, previousId?: string) => {
      active.add(sessionId);
      return ipcRenderer.invoke(DESKTOP_IPC.browserPageFrame, sessionId, previousId, true);
    },
    browserPresentTexture(sessionId: string, textureId: string, canvasId: string): void {
      const entry = frames.get(sessionId);
      const canvas = document.getElementById(canvasId);
      if (!entry || entry.id !== textureId || !(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Browser display frame is not ready.');
      }
      const video = entry.imported.getVideoFrame();
      try {
        if (canvas.width !== video.displayWidth) canvas.width = video.displayWidth;
        if (canvas.height !== video.displayHeight) canvas.height = video.displayHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Browser display canvas is unavailable.');
        context.drawImage(video, 0, 0);
        presented.set(sessionId, textureId);
      } finally {
        video.close();
        discard(sessionId);
      }
    },
    browserDiscardTexture(sessionId: string): void {
      active.delete(sessionId);
      presented.delete(sessionId);
      discard(sessionId);
    },
  };
}
