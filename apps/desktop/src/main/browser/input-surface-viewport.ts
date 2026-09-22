/**
 * Guest viewport emulation over the local surface: the dimensions the pane
 * picker offers must reach the page, the encoded frame must carry the native
 * pixels unchanged, and the guest must be handed back its original metrics.
 */
import assert from 'node:assert/strict';
import { nativeImage, type WebContents } from 'electron';
import type { BrowserHost } from './host';
import { readyBrowserFrame } from './harness-frame';
import type { DesktopBrowserPageFrame } from '../../shared/contract';

export async function exerciseBrowserViewportResolutions(
  host: BrowserHost,
  guest: WebContents,
  baseline: DesktopBrowserPageFrame,
  log: (text: string) => void
): Promise<void> {
  // Exercise the same dimensions used by the pane picker, including a page
  // without a mobile viewport tag and a visible desktop scrollbar.
  await guest.executeJavaScript(`document.body.style.height = '2400px'`);
  for (const config of [
    { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
    { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
  ]) {
    const paints: Electron.NativeImage[] = [];
    const rememberPaint = (_event: unknown, _dirty: unknown, image: Electron.NativeImage) => {
      paints.push(image);
      if (paints.length > 8) paints.shift();
    };
    // GPU OSR paints carry textures, not bitmap pixels. Observe the actual
    // native capture input too, rather than comparing against an empty paint.
    const capturePage = guest.capturePage;
    guest.capturePage = async (...args: Parameters<WebContents['capturePage']>) => {
      const image = await capturePage.apply(guest, args);
      rememberPaint(undefined, undefined, image);
      return image;
    };
    guest.on('paint', rememberPaint);
    let resized: DesktopBrowserPageFrame;
    try {
      await host.browserPageControl('visible-session', {
        type: 'resize',
        width: config.width,
        height: config.height,
        documentId: baseline.documentId,
      });
      await host.configureGuestViewport('visible-session', guest.id, { ...config, userAgent: null });
      resized = await readyBrowserFrame(host, 'visible-session');
    } finally {
      guest.removeListener('paint', rememberPaint);
      guest.capturePage = capturePage;
    }
    assert.ok(resized.image);
    const decoded = nativeImage.createFromBuffer(Buffer.from(resized.image.data, 'base64'));
    const bitmap = decoded.toBitmap();
    const native = paints.find((image) =>
      image.toBitmap({ scaleFactor: Math.max(1, ...image.getScaleFactors()) }).equals(bitmap)
    );
    assert.ok(native, 'display encoding must preserve the original pixels, including text edges');
    const actual = await guest.executeJavaScript(`({ width: innerWidth, height: innerHeight })`);
    log(
      `resolution sample ${JSON.stringify({
        config,
        pixels: [resized.width, resized.height],
        inputViewport: [resized.viewportWidth, resized.viewportHeight],
        actual,
        encoding: resized.image.mimeType,
        nativeSize: native.getSize(),
        scales: native.getScaleFactors(),
      })}`
    );
    assert.deepEqual([resized.surfaceWidth, resized.surfaceHeight], [config.width, config.height]);
    assert.equal(resized.image.mimeType, 'image/png');
    assert.equal(resized.viewportWidth, actual.width);
    assert.equal(resized.viewportHeight, actual.height);
  }
  await host.configureGuestViewport('visible-session', guest.id, {
    width: null,
    height: null,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    userAgent: null,
  });
  await host.browserPageControl('visible-session', {
    type: 'resize',
    width: baseline.width,
    height: baseline.height,
    documentId: baseline.documentId,
  });
  await guest.executeJavaScript(`document.body.style.height = ''`);
}
