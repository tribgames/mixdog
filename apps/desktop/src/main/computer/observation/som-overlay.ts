/**
 * The set-of-marks overlay: the captured frame with one numbered badge per
 * element, drawn by an offscreen renderer because the marks must land in the
 * same pixels the model will point at. It reads nothing but its arguments, so a
 * failed render degrades to the original image instead of failing the capture.
 */
import { BrowserWindow, type NativeImage } from 'electron';

const OVERLAY_RENDER_TIMEOUT_MS = 5_000;

export async function renderSomOverlay(
  image: { mimeType: string; data: string },
  width: number,
  height: number,
  elements: Array<Record<string, unknown>>,
  quality: number,
): Promise<{
  image: { mimeType: string; data: string };
  rendered: boolean;
  error?: string;
}> {
  if (elements.length === 0) return { image, rendered: false };
  const marks = elements.map((element) => {
    const bounds = Array.isArray(element.bounds) ? element.bounds.map(Number) : [];
    if (bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) return '';
    const [x, y, w, h] = bounds;
    const mark = Number(element.mark);
    const color = element.source === 'ocr'
      ? '#72e06a'
      : element.source === 'msaa'
        ? '#ffb020'
        : '#29d3ff';
    const badgeWidth = Math.max(20, String(mark).length * 8 + 10);
    const badgeX = Math.max(0, Math.min(width - badgeWidth, x));
    const badgeY = Math.max(0, y - 20);
    return `<g><rect x="${x}" y="${y}" width="${Math.max(1, w)}" height="${Math.max(1, h)}"`
      + ` fill="none" stroke="${color}" stroke-width="2"/>`
      + `<rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="19" rx="4"`
      + ` fill="${color}" stroke="#101419" stroke-width="1"/>`
      + `<text x="${badgeX + badgeWidth / 2}" y="${badgeY + 14}" text-anchor="middle"`
      + ' font-family="Segoe UI,Arial,sans-serif" font-size="12" font-weight="700" fill="#101419">'
      + `${mark}</text></g>`;
  }).join('');
  let overlayWindow: BrowserWindow | null = null;
  try {
    const html = '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
      + `<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}`
      + `img,svg{position:absolute;inset:0;width:${width}px;height:${height}px}</style></head><body>`
      + `<img src="data:${image.mimeType};base64,${image.data}">`
      + `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${marks}</svg>`
      + '</body></html>';
    overlayWindow = new BrowserWindow({
      show: false,
      frame: false,
      width,
      height,
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    await overlayWindow.loadURL(
      `data:text/html;base64,${Buffer.from(html).toString('base64')}`,
    );
    const rendered = await new Promise<NativeImage>((resolve, reject) => {
      if (!overlayWindow || overlayWindow.isDestroyed()) {
        reject(new Error('SOM overlay renderer is unavailable'));
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error('SOM overlay renderer timed out'));
      }, OVERLAY_RENDER_TIMEOUT_MS);
      void overlayWindow.webContents.capturePage().then((frame) => {
        clearTimeout(timer);
        if (frame.isEmpty()) reject(new Error('SOM overlay renderer returned an empty frame'));
        else resolve(frame);
      }, (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const renderedSize = rendered.getSize();
    const sized = renderedSize.width === width && renderedSize.height === height
      ? rendered
      : rendered.resize({ width, height, quality: 'best' });
    const jpeg = sized.toJPEG(quality);
    if (!jpeg.length) return { image, rendered: false };
    return {
      image: { mimeType: 'image/jpeg', data: jpeg.toString('base64') },
      rendered: true,
    };
  } catch (error) {
    return {
      image,
      rendered: false,
      error: (error as Error).message || String(error),
    };
  } finally {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  }
}
