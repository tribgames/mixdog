import { ipcRenderer, sharedTexture } from 'electron';

sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
  const frame = importedSharedTexture.getVideoFrame();
  try {
    const canvas = document.querySelector('canvas')!;
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(frame, 0, 0);
    ipcRenderer.send('texture-pixels', Array.from(context.getImageData(8, 8, 1, 1).data));
  } finally {
    frame.close();
    importedSharedTexture.release();
  }
});
window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('texture-ready'));
