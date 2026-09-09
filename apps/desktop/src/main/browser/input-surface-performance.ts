import assert from 'node:assert/strict';
import { nativeImage, type WebContents } from 'electron';
import type { BrowserHost } from './host';

/** Fixture-only input acknowledgement and visible-pixel latency measurements. */
export async function measureBrowserPresentation(
  host: BrowserHost, guest: WebContents, shell: WebContents, log: (text: string) => void,
): Promise<void> {
  await guest.executeJavaScript(`window.presentationAnimation = setInterval(() => {
    document.body.style.backgroundColor = 'rgb(' + (Date.now() % 255) + ', 80, 100)';
  }, 16); void 0`);
  await shell.executeJavaScript(`(() => {
    window.presentationLoads = 0;
    window.presentationListener = () => window.presentationLoads++;
    document.querySelector('.browser-isolated-view img').addEventListener('load', window.presentationListener);
  })()`);
  const started = performance.now();
  await new Promise(resolve => setTimeout(resolve, 1500));
  const elapsed = performance.now() - started;
  const loads = await shell.executeJavaScript(`(() => {
    document.querySelector('.browser-isolated-view img').removeEventListener('load', window.presentationListener);
    window.setSurfaceActive(false);
    return window.presentationLoads;
  })()`);
  await guest.executeJavaScript('clearInterval(window.presentationAnimation)');
  const frame = await host.browserPageFrame('visible-session');
  const samples: number[] = [];
  const visible: number[] = [];
  await guest.executeJavaScript(`(() => {
    const marker = document.createElement('div');
    marker.id = 'presentation-marker';
    marker.style.cssText = 'position:fixed;left:0;top:0;width:16px;height:16px;z-index:2147483647';
    document.body.append(marker);
    window.presentationInputs = 0;
    window.presentationInputListener = () => {
      marker.style.backgroundColor = 'rgb(' + (++window.presentationInputs + 20) + ',80,100)';
    };
    document.getElementById('agent').focus();
    document.addEventListener('input', window.presentationInputListener);
  })()`);
  try {
    for (let index = 0; index < 6; index++) {
      const start = performance.now();
      await host.browserPageControl('visible-session', {
        type: 'text', text: 'p', documentId: frame.documentId,
      });
      samples.push(performance.now() - start);
      for (;;) {
        const next = await host.browserPageFrame('visible-session');
        assert.ok(next.image);
        const pixels = nativeImage.createFromBuffer(Buffer.from(next.image.data, 'base64')).toBitmap();
        const x = Math.floor(8 * next.width / next.viewportWidth);
        const y = Math.floor(8 * next.height / next.viewportHeight);
        const offset = (y * next.width + x) * 4;
        if (pixels[offset + 2] === index + 21 && pixels[offset + 1] === 80 && pixels[offset] === 100) break;
        assert.ok(performance.now() - start < 2000, 'input must reach the displayed pixels');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      visible.push(performance.now() - start);
    }
  } finally {
    await guest.executeJavaScript(`(() => {
      document.removeEventListener('input', window.presentationInputListener);
      document.getElementById('presentation-marker').remove();
    })()`);
  }
  const p95 = (values: number[]) => Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1].toFixed(1));
  log(`presentation benchmark ${JSON.stringify({
    decodedFramesPerSecond: Number((loads * 1000 / elapsed).toFixed(2)),
    inputAcknowledgementMs: samples.map(value => Number(value.toFixed(1))),
    inputToPixelsMs: visible.map(value => Number(value.toFixed(1))),
    inputAcknowledgementP95Ms: p95(samples),
    inputToPixelsP95Ms: p95(visible),
  })}`);
}
