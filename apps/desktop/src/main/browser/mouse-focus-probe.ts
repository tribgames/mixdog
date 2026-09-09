/** Isolated comparison of Chromium focus emulation; never a production policy. */
import assert from 'node:assert/strict';
import { BrowserWindow, type WebContents } from 'electron';

export async function probeMouseFocus(guest: WebContents, progress: (message: string) => void) {
  const owner = BrowserWindow.fromWebContents(guest)!;
  const visible = owner.isVisible();
  const focused = BrowserWindow.getFocusedWindow()?.id;
  const samples: Array<{ focus: boolean; ackMs: number; eventMs: number; trusted: boolean }> = [];
  await guest.executeJavaScript(`(() => {
    const state = { eventAt: 0, trusted: false };
    state.listener = (event) => { state.eventAt = Date.now(); state.trusted = event.isTrusted; };
    window.__mixdogMouseProbe = state;
    window.addEventListener('mousemove', state.listener, true);
  })()`);
  try {
    // Alternate conditions to avoid treating a warmed renderer as an effect.
    for (const focus of [false, true, false, true]) {
      await guest.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: focus });
      for (let index = 0; index < 2; index++) {
        await guest.executeJavaScript('window.__mixdogMouseProbe.eventAt = 0');
        const started = Date.now();
        await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: 600 + samples.length * 3, y: 350,
          button: 'none', buttons: 0,
        });
        const ackMs = Date.now() - started;
        const event = await guest.executeJavaScript('({ at: window.__mixdogMouseProbe.eventAt, trusted: window.__mixdogMouseProbe.trusted })');
        assert.ok(event.at >= started, 'the trusted movement must arrive before its acknowledgement');
        assert.equal(event.trusted, true);
        assert.equal(owner.isVisible(), visible);
        assert.equal(BrowserWindow.getFocusedWindow()?.id, focused);
        samples.push({ focus, ackMs, eventMs: event.at - started, trusted: event.trusted });
      }
    }
    progress(`mouse focus comparison ${JSON.stringify(samples)}`);
  } finally {
    await guest.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
    await guest.executeJavaScript(`(() => {
      window.removeEventListener('mousemove', window.__mixdogMouseProbe.listener, true);
      delete window.__mixdogMouseProbe;
    })()`);
  }
}
