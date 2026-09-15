import assert from 'node:assert/strict';
import { BrowserWindow, nativeImage, type WebContents } from 'electron';
import type { BrowserHost } from './host';
import { createPolling } from '../host-harness-poll';
import { measureBrowserWheelToPixels } from './input-surface-latency';

/** A full-size, changing page exercises encoding and input together. The
 * isolated fixture is disposable; neither a user page nor OS input is used. */
export async function measureBrowserSurfaceLoad(
  host: BrowserHost, guest: WebContents, shell: WebContents, log: (text: string) => void,
): Promise<void> {
  const { eventually } = createPolling({ timeoutMs: 5000, intervalMs: 16 });
  const parent = BrowserWindow.fromWebContents(shell)!;
  const size = parent.getContentSize();
  const original = await guest.executeJavaScript('document.body.innerHTML');
  parent.setContentSize(1500, 1100);
  await shell.executeJavaScript(`(() => {
    const dock = document.getElementById('browser-dock');
    window.loadPreviousStyle = dock.getAttribute('style');
    dock.style.cssText = 'width:1366px;height:900px;margin-top:30px';
    window.setSurfaceActive(true);
  })()`);
  try {
    await eventually(() => shell.executeJavaScript(`(() => {
      const image = document.querySelector('.browser-isolated-pixels > :first-child');
      return image?.naturalWidth || image?.width;
    })()`),
      width => width === 1366);
    await guest.executeJavaScript(`(() => {
      document.body.innerHTML = '<input id="load-input" style="position:fixed;top:10px;left:10px;z-index:2">'
        + '<button id="load-button" style="position:fixed;top:10px;left:300px;z-index:2">Click</button>'
        + '<canvas id="load-canvas" width="1366" height="2400"></canvas>';
      document.body.style.margin = '0';
      const canvas = document.getElementById('load-canvas');
      const ctx = canvas.getContext('2d');
      // Deterministic colourful content, not a single-colour compression best case.
      for (let y = 0; y < 2400; y += 8) for (let x = 0; x < 1366; x += 8) {
        ctx.fillStyle = 'rgb(' + (x * 13 % 256) + ',' + (y * 7 % 256) + ',' + ((x + y) * 3 % 256) + ')';
        ctx.fillRect(x, y, 8, 8);
      }
      ctx.font = '16px sans-serif';
      ctx.fillStyle = '#fff';
      for (let y = 40; y < 2400; y += 40) ctx.fillText('Browser scrolling — 한글 입력 — ' + y, 20, y);
      window.loadClicks = 0;
      document.getElementById('load-button').onclick = () => window.loadClicks++;
    })()`);
    const bounds = await shell.executeJavaScript(`(() => {
      const r = document.querySelector('.browser-isolated-pixels > :first-child').getBoundingClientRect();
      window.loadFrames = 0;
      window.loadListener = () => window.loadFrames++;
      document.querySelector('.browser-isolated-view').addEventListener('browser-frame-presented', window.loadListener);
      return {x:r.x,y:r.y};
    })()`);
    const acknowledgement: number[] = [];
    const frameTimes: number[] = [];
    const originalFrame = host.browserPageFrame;
    const originalControl = host.browserPageControl;
    host.browserPageFrame = async (...args) => {
      const start = performance.now();
      const frame = await originalFrame.apply(host, args);
      frameTimes.push(performance.now() - start);
      return frame;
    };
    host.browserPageControl = async (...args) => {
      const start = performance.now();
      await originalControl.apply(host, args);
      if (args[1].type === 'wheel') acknowledgement.push(performance.now() - start);
    };
    const started = performance.now();
    try {
      // Exercise the real renderer handler and IPC queue. CDP mouseWheel on
      // the hidden *shell* waits for its throttled compositor acknowledgement,
      // an extra ~1s that a physical wheel on a visible app never pays.
      for (let index = 0; index < 60; index++) {
        await shell.executeJavaScript(`document.querySelector('.browser-isolated-pixels > :first-child').dispatchEvent(
          new WheelEvent('wheel', {bubbles:true,cancelable:true,
            clientX:${bounds.x + 800},clientY:${bounds.y + 300},deltaY:${index < 30 ? 32 : -32}}))`);
        if (index === 29) await eventually(() => guest.executeJavaScript('scrollY'), value => value > 0);
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      await eventually(() => guest.executeJavaScript('scrollY'), value => value === 0);
      assert.ok(acknowledgement.length > 0, 'the production wheel input path must be exercised');
      for (const type of ['mousePressed', 'mouseReleased']) {
        await shell.debugger.sendCommand('Input.dispatchMouseEvent', {
          type, x: bounds.x + 325, y: bounds.y + 20, button: 'left', clickCount: 1,
        });
      }
      await eventually(() => guest.executeJavaScript('window.loadClicks'), value => value === 1);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await shell.debugger.sendCommand('Input.dispatchMouseEvent', {
          type, x: bounds.x + 70, y: bounds.y + 20, button: 'left', clickCount: 1,
        });
      }
      await shell.debugger.sendCommand('Input.insertText', { text: 'scroll 한글 123' });
      await eventually(() => guest.executeJavaScript(`document.getElementById('load-input').value`),
        value => value === 'scroll 한글 123');
      assert.equal(await shell.executeJavaScript(`document.getElementById('draft').textContent`),
        'keep editing 사용자 입력');
      const frames = await shell.executeJavaScript('window.loadFrames');
      const p95 = (values: number[]) =>
        Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1].toFixed(1));
      log(`full-size scrolling benchmark ${JSON.stringify({
        width: 1366,
        decodedFramesPerSecond: Number((frames * 1000 / (performance.now() - started)).toFixed(2)),
        wheelDispatchP95Ms: p95(acknowledgement),
        frameCaptureP95Ms: p95(frameTimes),
        clickAndTyping: 'passed',
      })}`);
      await measureBrowserWheelToPixels(guest, shell, log);
      // Compare a static text/colour region against independent native pixels,
      // outside the performance sample and away from the blinking input caret.
      const source = await guest.capturePage(undefined, { stayHidden: true });
      const display = await shell.executeJavaScript(`(() => {
        const image = document.querySelector('.browser-isolated-pixels > :first-child');
        const copy = document.createElement('canvas');
        copy.width = 500; copy.height = 120;
        copy.getContext('2d').drawImage(image, 0, 100, 500, 120, 0, 0, 500, 120);
        return {kind:image.tagName, data:copy.toDataURL('image/png')};
      })()`);
      assert.ok(source.crop({ x: 0, y: 100, width: 500, height: 120 }).toBitmap()
        .equals(nativeImage.createFromDataURL(display.data).toBitmap()),
      'displayed text and colour pixels must exactly match the independent native capture');
      log(`native/display text and colour pixels match (${display.kind})`);
    } finally {
      host.browserPageFrame = originalFrame;
      host.browserPageControl = originalControl;
    }
  } finally {
    await shell.executeJavaScript(`(() => {
      window.setSurfaceActive(false);
      document.querySelector('.browser-isolated-view').removeEventListener('browser-frame-presented', window.loadListener);
      document.getElementById('browser-dock').setAttribute('style', window.loadPreviousStyle);
    })()`);
    await guest.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(original)};
      document.body.style.margin = ''; scrollTo(0,0); document.getElementById('agent').focus()`);
    parent.setContentSize(size[0], size[1]);
  }
}
