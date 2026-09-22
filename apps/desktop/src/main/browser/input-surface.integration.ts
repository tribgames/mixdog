import assert from 'node:assert/strict';
import { type BrowserWindow, ipcMain, type WebContents } from 'electron';
import type { BrowserHost } from './host';
import { createPolling } from '../host-harness-poll';
import { registerBrowserIpc } from '../ipc-browser';
import { DESKTOP_IPC } from '../../shared/contract';
import { readyBrowserFrame } from './harness-frame';
import { measureBrowserPresentation } from './input-surface-performance';
import { exerciseBrowserErrorNotice } from './input-surface-errors';
import { exerciseBrowserPrompts } from './input-surface-prompts';
import { exerciseBrowserIme } from './input-surface-ime';
import { exerciseBrowserViewportResolutions } from './input-surface-viewport';
import { exerciseBrowserTabHandover } from './input-surface-tabs';
import { logBrowserSurfaceDiagnostics } from './input-surface-diagnostics';

export { readyBrowserFrame } from './harness-frame';

export async function exerciseBrowserInputSurface(options: {
  parent: BrowserWindow;
  host: BrowserHost;
  guest: WebContents;
  origin: string;
  command(sessionId: string, input: Record<string, unknown>): Promise<string>;
  log(text: string): void;
}): Promise<void> {
  const { parent, host, guest, origin, command, log } = options;
  const readFrame = (sessionId: string) => readyBrowserFrame(host, sessionId);
  const { eventually } = createPolling({ timeoutMs: 8000, intervalMs: 25 });
  const shell = parent.webContents;
  const channels: string[] = [];
  let captures = 0;
  registerBrowserIpc({
    browserHost: host,
    handle(channel, listener) {
      channels.push(channel);
      ipcMain.handle(channel, (event, ...args) => {
        assert.equal(event.sender, shell, 'only the fixture shell may send local input');
        if (channel === DESKTOP_IPC.browserPageFrame) captures += 1;
        return listener(event, ...args);
      });
    },
  });
  try {
    await parent.loadURL(`${origin}/shell`);
    // The surface-only lane has not focused the hidden fixture through the
    // earlier keyboard probes. Give its composer the same starting state.
    shell.focus();
    log('waiting for local display');
    await eventually(
      () =>
        shell.executeJavaScript(`(() => {
        const image = document.querySelector('.browser-isolated-pixels > :first-child');
        return Boolean(window.fixtureReady && (image?.naturalWidth || image?.width));
      })()`),
      Boolean
    );
    log('local display ready');
    await eventually(
      () => shell.executeJavaScript(`document.activeElement.id`),
      (value) => value === 'composer'
    );
    assert.equal(await shell.executeJavaScript(`document.activeElement.id`), 'composer');
    await eventually(
      async () => guest.getZoomFactor(),
      (value) => value === 1
    );
    const originalCapture = host.browserPageFrame;
    let releaseResize!: () => void;
    const resizeGate = new Promise<void>((resolve) => {
      releaseResize = resolve;
    });
    host.browserPageFrame = async (...args: Parameters<BrowserHost['browserPageFrame']>) => {
      await resizeGate;
      return originalCapture.apply(host, args);
    };
    try {
      await shell.executeJavaScript(`document.getElementById('browser-dock').style.width = '420px'`);
      await shell.executeJavaScript(
        `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
      );
      assert.equal(
        await shell.executeJavaScript(
          `getComputedStyle(document.querySelector('.browser-isolated-pixels > :first-child')).visibility`
        ),
        'hidden',
        'old pixels must not stretch into the resized pane while a new frame is pending'
      );
    } finally {
      host.browserPageFrame = originalCapture;
      releaseResize();
    }
    await eventually(
      () => readFrame('visible-session'),
      (value) => value.width === 420
    );
    assert.equal(guest.getZoomFactor(), 1, 'normal browsing does not shrink text with the pane');
    await shell.executeJavaScript(`document.getElementById('browser-dock').style.width = '600px'`);
    await eventually(
      () => readFrame('visible-session'),
      (value) => value.width === 600
    );
    await eventually(
      () =>
        shell.executeJavaScript(`(() => {
      const image = document.querySelector('.browser-isolated-pixels > :first-child');
      return (image?.naturalWidth || image?.width) === 600 && getComputedStyle(image).visibility === 'visible';
    })()`),
      Boolean
    );
    const point = await guest.executeJavaScript(`(() => {
      const r = document.getElementById('agent').getBoundingClientRect();
      return {x:r.x+r.width/2, y:r.y+r.height/2};
    })()`);
    const frame = await readFrame('visible-session');
    const bounds = await shell.executeJavaScript(`(() => {
      const r = document.querySelector('.browser-isolated-pixels > :first-child').getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`);
    const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);
    const x =
      bounds.x + (bounds.width - frame.width * scale) / 2 + ((point.x * frame.width) / frame.viewportWidth) * scale;
    const y =
      bounds.y + (bounds.height - frame.height * scale) / 2 + ((point.y * frame.height) / frame.viewportHeight) * scale;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await shell.debugger.sendCommand('Input.insertText', { text: 'manual 한글' });
    log(
      `manual input sent at ${x.toFixed(1)},${y.toFixed(1)}; image ${frame.width}x${frame.height}, viewport ${frame.viewportWidth}x${frame.viewportHeight}`
    );
    await eventually(
      () => guest.executeJavaScript(`document.getElementById('agent').value`),
      (value) => value === 'manual 한글'
    );
    assert.equal(await shell.executeJavaScript(`document.getElementById('draft').textContent`), 'keep editing');
    log('local display click and Korean text reached only its page');
    await exerciseBrowserIme(shell, guest, 'agent', 'manual 한글');
    log('native Korean composition updates, commits, cancellation and mixed English input passed');

    const child = guest.mainFrame.frames.find((frame) => frame.url.endsWith('/frame'));
    assert.ok(child);
    const childPoint = (await child.executeJavaScript(`(() => {
      const r = document.getElementById('frame').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`)) as { x: number; y: number };
    const childOffset = await guest.executeJavaScript(`(() => {
      const el = document.querySelector('iframe'), r = el.getBoundingClientRect();
      return { x: r.x + el.clientLeft, y: r.y + el.clientTop };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        button: 'left',
        clickCount: 1,
        x: bounds.x + (((childOffset.x + childPoint.x) * frame.width) / frame.viewportWidth) * scale,
        y: bounds.y + (((childOffset.y + childPoint.y) * frame.height) / frame.viewportHeight) * scale,
      });
    }
    await shell.debugger.sendCommand('Input.insertText', { text: 'iframe 한글' });
    await eventually(
      () => child.executeJavaScript(`document.getElementById('frame').value`),
      (value) => value === 'iframe 한글'
    );
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'manual 한글');
    await exerciseBrowserIme(shell, child, 'frame', 'iframe 한글');
    log('native Korean composition in a cross-origin iframe passed');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    let iframeWaitFinished = false;
    const iframeWait = command('visible-session', {
      action: 'wait',
      text: 'never-present-iframe-handoff',
      timeoutMs: 10_000,
    })
      .then(
        () => null,
        (error) => error
      )
      .finally(() => {
        iframeWaitFinished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(iframeWaitFinished, false);
    const handoffStarted = performance.now();
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', {
        type,
        button: 'left',
        clickCount: 1,
        x: bounds.x + (((childOffset.x + childPoint.x) * frame.width) / frame.viewportWidth) * scale,
        y: bounds.y + (((childOffset.y + childPoint.y) * frame.height) / frame.viewportHeight) * scale,
      });
    }
    await shell.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'End',
      code: 'End',
      windowsVirtualKeyCode: 35,
    });
    await shell.debugger.sendCommand('Input.insertText', { text: ' takeover' });
    assert.match(String(await iframeWait), /interrupted by local user input/);
    await eventually(
      () => child.executeJavaScript(`document.getElementById('frame').value`),
      (value) => value === 'iframe 한글 takeover'
    );
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'manual 한글');
    assert.equal(await shell.executeJavaScript(`document.getElementById('draft').textContent`), 'keep editing');
    log(`iframe human takeover preserves parent and composer: ${(performance.now() - handoffStarted).toFixed(1)}ms`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await eventually(
      () => guest.executeJavaScript(`document.activeElement.id`),
      (value) => value === 'agent'
    );
    log('local cross-origin iframe click and Korean text delivery passed');

    await child.executeJavaScript(`(() => {
      window.gestureEvents = [];
      const field = document.getElementById('frame');
      field.onpointerdown = e => field.setPointerCapture(e.pointerId);
      window.gestureListener = e => gestureEvents.push({type:e.type, x:e.clientX, trusted:e.isTrusted});
      for (const type of ['pointermove','pointerup']) document.addEventListener(type, window.gestureListener);
    })()`);
    const gestureFrame = await readFrame('visible-session');
    const gestureStart = performance.now();
    const pointer = {
      type: 'pointer' as const,
      documentId: gestureFrame.documentId,
      x: childOffset.x + childPoint.x,
      y: childOffset.y + childPoint.y,
      button: 'left' as const,
      modifiers: 0,
      clickCount: 1,
    };
    await host.browserPageControl('visible-session', { ...pointer, phase: 'mousePressed', buttons: 1 });
    const outside = { ...pointer, x: gestureFrame.viewportWidth - 10, y: gestureFrame.viewportHeight - 10 };
    await host.browserPageControl('visible-session', { ...outside, phase: 'mouseMoved', buttons: 1 });
    await host.browserPageControl('visible-session', { ...outside, phase: 'mouseReleased', buttons: 0 });
    await eventually(
      () => child.executeJavaScript('gestureEvents') as Promise<Array<{ type: string; trusted: boolean }>>,
      (events) =>
        events.some((event: { type: string; trusted: boolean }) => event.type === 'pointerup' && event.trusted)
    );
    log(`cross-frame captured drag and release: ${(performance.now() - gestureStart).toFixed(1)}ms`);
    await child.executeJavaScript(`(() => {
      document.getElementById('frame').onpointerdown = null;
      for (const type of ['pointermove','pointerup']) document.removeEventListener(type, window.gestureListener);
    })()`);
    await guest.executeJavaScript(`document.body.style.height = '2400px'`);
    const scrollStart = performance.now();
    await host.browserPageControl('visible-session', {
      type: 'wheel',
      documentId: gestureFrame.documentId,
      x: gestureFrame.viewportWidth - 1,
      y: 250,
      deltaX: 0,
      deltaY: 160,
    });
    await eventually(
      () => guest.executeJavaScript('scrollY'),
      (value) => value > 0
    );
    log(`scrollbar-area wheel to page scroll: ${(performance.now() - scrollStart).toFixed(1)}ms`);
    await guest.executeJavaScript(
      `document.body.style.height = ''; scrollTo(0,0); document.getElementById('agent').focus()`
    );

    await shell.executeJavaScript(`(() => {
      window.setSurfaceActive(false);
      const composer = document.getElementById('composer');
      composer.focus(); composer.setSelectionRange(composer.value.length, composer.value.length);
    })()`);
    // Local input deliberately owns the foreground until the user is idle.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    let waitSettled = false;
    const waiting = command('visible-session', {
      action: 'wait',
      text: 'never-present-handoff-condition',
      timeoutMs: 10_000,
    })
      .then(
        () => null,
        (error) => error
      )
      .finally(() => {
        waitSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(waitSettled, false, 'the automation wait is still active');
    const duringWait = await readFrame('visible-session');
    const takeoverStarted = performance.now();
    await host.browserPageControl('visible-session', {
      type: 'text',
      text: ' takeover',
      documentId: duringWait.documentId,
    });
    assert.match(String(await waiting), /interrupted by local user input/);
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'manual 한글 takeover');
    log(`human takeover of active Browser Use wait: ${(performance.now() - takeoverStarted).toFixed(1)}ms`);
    await assert.rejects(command('visible-session', { action: 'snapshot' }), /local user input/);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const snapshot = await command('visible-session', { action: 'snapshot' });
    const ref = snapshot
      .split('\n')
      .find((line) => line.includes('"Agent input"'))
      ?.match(/\[(p\d+-s\d+-e\d+)\]/)?.[1];
    assert.ok(ref, snapshot);
    await Promise.all([
      command('visible-session', { action: 'type', ref, text: 'agent while hidden' }),
      shell.debugger.sendCommand('Input.insertText', { text: ' 사용자 입력' }),
    ]);
    assert.equal(
      await shell.executeJavaScript(`document.getElementById('draft').textContent`),
      'keep editing 사용자 입력'
    );
    assert.equal(await shell.executeJavaScript(`document.activeElement.id`), 'composer');
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'agent while hidden');
    await shell.executeJavaScript('window.setSurfaceActive(true)');
    await eventually(
      async () => captures,
      (count) => count > 2
    );
    await shell.executeJavaScript('window.setFixtureVisible(false)');
    // Allow the one already-issued read to settle before measuring the idle period.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const hiddenCount = captures;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(captures, hiddenCount, 'hidden documents must stop presentation polling');
    await shell.executeJavaScript('window.setFixtureVisible(true)');
    await eventually(
      async () => captures,
      (count) => count > hiddenCount
    );
    log('concurrent composer typing, parked execution, and presentation polling isolation passed');

    const before = await readFrame('visible-session');
    await guest.loadURL(`${origin}/next-document`);
    await assert.rejects(
      host.browserPageControl('visible-session', {
        type: 'text',
        text: 'must not appear',
        documentId: before.documentId,
      }),
      /page changed/
    );
    const next = await readFrame('visible-session');
    await assert.rejects(
      host.browserPageControl('parked-session', {
        type: 'text',
        text: 'wrong session',
        documentId: next.documentId,
      }),
      /page changed/
    );
    log('stale document and cross-session input refused');

    const samples: number[] = [];
    for (let count = 0; count < 8; count += 1) {
      const started = performance.now();
      await readFrame('visible-session');
      samples.push(performance.now() - started);
    }
    log(`local frame capture ms: ${samples.map((value) => value.toFixed(1)).join(', ')}`);
    await measureBrowserPresentation(host, guest, shell, log);
    await exerciseBrowserErrorNotice(host, guest, shell, log);
    await exerciseBrowserPrompts(guest, shell, log);
    await shell.executeJavaScript('window.setSurfaceActive(false)');
    await exerciseBrowserViewportResolutions(host, guest, next, log);
    await shell.executeJavaScript('window.setSurfaceActive(false)');
    await exerciseBrowserTabHandover({ host, guest, shell, origin, command, log });
  } catch (error) {
    log((error as Error).stack || String(error));
    await logBrowserSurfaceDiagnostics(shell, guest, log);
    throw error;
  } finally {
    for (const channel of channels) ipcMain.removeHandler(channel);
  }
}
