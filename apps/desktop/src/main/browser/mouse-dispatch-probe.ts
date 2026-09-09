/** Compare actual delivery paths in the real host, without showing or focusing it. */
import assert from 'node:assert/strict';
import { BrowserWindow, type WebContents } from 'electron';

export async function probeMouseDispatch(guest: WebContents, progress: (message: string) => void) {
  const owner = BrowserWindow.fromWebContents(guest)!;
  const visible = owner.isVisible();
  const focused = BrowserWindow.getFocusedWindow()?.id;
  const samples = [];
  await guest.executeJavaScript(`(() => {
    const state = { event: null };
    state.listener = e => {
      state.event = { at: Date.now(), trusted: e.isTrusted, x: e.clientX, y: e.clientY };
      state.resolve?.(state.event);
    };
    window.__mixdogDispatchProbe = state;
    window.addEventListener('mousemove', state.listener, true);
  })()`);
  try {
    for (const mode of ['cdp', 'native', 'cdp', 'native', 'frame']) {
      progress(`mouse dispatch starting ${mode}`);
      await guest.executeJavaScript(`(() => {
        const s = window.__mixdogDispatchProbe;
        s.event = null; s.pending = new Promise(r => { s.resolve = r; });
      })()`);
      const x = 600 + samples.length * 6;
      const started = Date.now();
      if (mode === 'frame') {
        const captured = await Promise.race([
          guest.debugger.sendCommand('Page.captureScreenshot', {
            format: 'jpeg', quality: 1, fromSurface: true, captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
          }).then(() => true),
          new Promise(resolve => {
            const timer = setTimeout(() => resolve(false), 3000);
            timer.unref();
          }),
        ]);
        if (!captured) {
          progress('mouse dispatch frame capture timed out; no following input dispatched');
          break;
        }
      }
      const dispatched = Date.now();
      if (mode === 'native') {
        guest.sendInputEvent({ type: 'mouseMove',
          x: Math.round(x * guest.getZoomFactor()), y: Math.round(350 * guest.getZoomFactor()) });
      } else {
        await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x, y: 350, button: 'none', buttons: 0,
        });
      }
      const event = await guest.executeJavaScript(`Promise.race([
        window.__mixdogDispatchProbe.pending,
        new Promise(resolve => setTimeout(() => resolve(null), 2000)),
      ])`);
      assert.equal(owner.isVisible(), visible);
      assert.equal(BrowserWindow.getFocusedWindow()?.id, focused);
      samples.push({ mode, totalMs: Date.now() - started, dispatchMs: Date.now() - dispatched,
        delivered: Boolean(event?.trusted), eventMs: event ? event.at - started : null });
      progress(`mouse dispatch sample ${JSON.stringify(samples.at(-1))}`);
    }
    progress(`mouse dispatch comparison ${JSON.stringify(samples)}`);
  } finally {
    await guest.executeJavaScript(`(() => {
      window.removeEventListener('mousemove', window.__mixdogDispatchProbe.listener, true);
      delete window.__mixdogDispatchProbe;
    })()`);
  }
}
