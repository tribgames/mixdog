import assert from 'node:assert/strict';
import type { WebContents } from 'electron';

/** Measure renderer input through the production IPC/display path, not just
 * host acknowledgement. The marker is independently advanced by guest input. */
export async function measureBrowserWheelToPixels(
  guest: WebContents, shell: WebContents, log: (text: string) => void,
): Promise<void> {
  await guest.executeJavaScript(`(() => {
    const marker = document.createElement('div');
    marker.id = 'wheel-latency-marker';
    marker.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:20px;z-index:2147483647;background:rgb(30,80,100)';
    document.body.append(marker);
    window.wheelLatencyCount = 30;
    window.wheelLatencyListener = () => {
      marker.style.background = 'rgb(' + (++window.wheelLatencyCount) + ',80,100)';
    };
    window.addEventListener('wheel', window.wheelLatencyListener, {passive:true});
  })()`);
  const samples: number[] = [];
  try {
    for (let index = 0; index < 20; index++) {
      samples.push(await shell.executeJavaScript(`new Promise((resolve, reject) => {
        const surface = document.querySelector('.browser-isolated-view');
        const image = surface.querySelector('.browser-isolated-pixels > :first-child');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', {willReadFrequently:true});
        const bounds = image.getBoundingClientRect();
        const start = performance.now();
        const timeout = setTimeout(() => {
          surface.removeEventListener('browser-frame-presented', loaded);
          reject(new Error('Wheel did not reach the displayed image.'));
        }, 3000);
        function loaded() {
          context.drawImage(surface.querySelector('.browser-isolated-pixels > :first-child'), 8, 8, 1, 1, 0, 0, 1, 1);
          const pixel = context.getImageData(0, 0, 1, 1).data;
          if (pixel[0] !== ${index + 31} || pixel[1] !== 80 || pixel[2] !== 100) return;
          clearTimeout(timeout);
          surface.removeEventListener('browser-frame-presented', loaded);
          resolve(performance.now() - start);
        }
        surface.addEventListener('browser-frame-presented', loaded);
        image.dispatchEvent(new WheelEvent('wheel', {bubbles:true,cancelable:true,
          clientX:bounds.x+800,clientY:bounds.y+300,deltaY:${index < 10 ? 32 : -32}}));
      })`));
    }
    assert.equal(await guest.executeJavaScript('window.wheelLatencyCount'), 50);
    const sorted = [...samples].sort((a, b) => a - b);
    log(`renderer wheel-to-pixels benchmark ${JSON.stringify({
      samples: samples.map(value => Number(value.toFixed(1))),
      p50Ms: Number(sorted[Math.ceil(sorted.length * 0.5) - 1].toFixed(1)),
      p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(1)),
    })}`);
  } finally {
    await guest.executeJavaScript(`window.removeEventListener('wheel', window.wheelLatencyListener);
      document.getElementById('wheel-latency-marker').remove()`);
  }
}
