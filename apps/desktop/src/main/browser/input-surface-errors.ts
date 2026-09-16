import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import type { BrowserHost } from './host';
import { createPolling } from '../host-harness-poll';

/** Exercise the actual renderer/preload/IPC path, without OS input or live tabs. */
export async function exerciseBrowserErrorNotice(
  host: BrowserHost,
  guest: WebContents,
  shell: WebContents,
  log: (message: string) => void
): Promise<void> {
  const { eventually } = createPolling({ timeoutMs: 8000, intervalMs: 25 });
  const original = host.browserPageControl;
  let reject = true;
  const forwarded: string[] = [];
  const failure = 'Browser input was not sent.\nInjected diagnostic detail.';
  host.browserPageControl = async (session, input) => {
    if (['pointer', 'wheel', 'key', 'text'].includes(input.type)) forwarded.push(input.type);
    if (input.type === 'text' && reject) throw new Error(failure);
    return original(session, input);
  };
  const visibleNotice = () =>
    shell.executeJavaScript(`Boolean(document.querySelector('.browser-isolated-view .error-notice'))`);
  const click = async (selector: string) => {
    const point = await shell.executeJavaScript(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Missing error notice control');
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { x, y, reachable: el.contains(document.elementFromPoint(x, y)),
        rect: r.toJSON(), width: innerWidth, height: innerHeight };
    })()`);
    assert.ok(point.reachable, `Notice control is not reachable: ${selector} ${JSON.stringify(point)}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        x: point.x,
        y: point.y,
        button: 'left',
        clickCount: 1,
      });
    }
  };
  const type = async (text: string) => {
    await shell.executeJavaScript(`document.querySelector('.browser-isolated-input').focus()`);
    await shell.debugger.sendCommand('Input.insertText', { text });
  };
  const before = await guest.executeJavaScript(`document.getElementById('agent').value`);
  try {
    await shell.executeJavaScript('window.setSurfaceActive(true)');
    await type('must-not-arrive');
    await eventually(visibleNotice, Boolean);
    assert.equal(await shell.executeJavaScript(`Boolean(document.querySelector('.browser-input-recovery'))`), true);
    assert.equal(
      await shell.executeJavaScript(`document.body.textContent.includes('must-not-arrive')`),
      false,
      'potentially sensitive recovery text is never exposed in the page UI'
    );
    const beforeOverlay = forwarded.length;
    await click('.browser-isolated-view .error-notice-actions button');
    await eventually(
      () => shell.executeJavaScript(`Boolean(document.querySelector('.browser-isolated-view .error-notice-details'))`),
      Boolean
    );
    assert.equal(
      await shell.executeJavaScript(`document.activeElement.classList.contains('browser-isolated-input')`),
      false,
      'notice interaction must not steal focus back to the page input proxy'
    );
    await click('.browser-isolated-view .error-notice-dismiss');
    await eventually(visibleNotice, (value) => !value);
    assert.equal(forwarded.length, beforeOverlay, 'notice controls must not dispatch clicks to the guest');
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), before);

    await type('another-rejected-input');
    await eventually(visibleNotice, Boolean);
    reject = false;
    await type(' recovered');
    await eventually(
      () => guest.executeJavaScript(`document.getElementById('agent').value`),
      (value) => value === `${before} recovered`
    );
    await eventually(visibleNotice, (value) => !value);
    assert.equal(forwarded.filter((type) => type === 'text').length, 3, 'failed input is never replayed');
    await shell.executeJavaScript(`(() => {
      window.clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { window.recoveredInputText = text; } } });
    })()`);
    try {
      await click('.browser-input-recovery button:first-of-type');
      await eventually(
        () => shell.executeJavaScript('window.recoveredInputText'),
        (value) => value === 'must-not-arriveanother-rejected-input'
      );
      await click('.browser-input-recovery button:last-of-type');
      await eventually(
        () => shell.executeJavaScript(`Boolean(document.querySelector('.browser-input-recovery'))`),
        (value) => !value
      );
    } finally {
      await shell.executeJavaScript(`(() => {
        if (window.clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', window.clipboardDescriptor);
        else delete navigator.clipboard;
      })()`);
    }
    log('error details/dismiss remain local; new successful input clears the notice without replaying failures');
  } finally {
    host.browserPageControl = original;
  }
}
