import assert from 'node:assert/strict';
import { BrowserWindow, ipcMain, nativeImage, webContents, type WebContents } from 'electron';
import type { BrowserHost } from './host';
import { createPolling } from '../host-harness-poll';
import { registerBrowserIpc } from '../ipc-browser';
import { DESKTOP_IPC, type DesktopBrowserPageFrame } from '../../shared/contract';
import { measureBrowserPresentation } from './input-surface-performance';
import { exerciseBrowserErrorNotice } from './input-surface-errors';
import { exerciseBrowserPrompts } from './input-surface-prompts';

export async function readyBrowserFrame(host: BrowserHost, sessionId: string): Promise<DesktopBrowserPageFrame> {
  const { eventually } = createPolling({ timeoutMs: 8000, intervalMs: 50 });
  let lastError: unknown;
  try {
    const frame = await eventually(async () => {
      try { return await host.browserPageFrame(sessionId); }
      catch (error) {
        if (!/UnknownVizError|Browser display frame is not ready|Browser page changed during capture/.test(String(error))) throw error;
        lastError = error;
        return null;
      }
    }, value => value !== null);
    return frame!;
  } catch (error) {
    throw lastError ?? error;
  }
}

export async function exerciseBrowserInputSurface(options: {
  parent: BrowserWindow; host: BrowserHost; guest: WebContents; origin: string;
  command(sessionId: string, input: Record<string, unknown>): Promise<string>;
  log(text: string): void;
}): Promise<void> {
  const { parent, host, guest, origin, command, log } = options;
  const readFrame = (sessionId: string) => readyBrowserFrame(host, sessionId);
  const { eventually } = createPolling({ timeoutMs: 8000, intervalMs: 25 });
  const shell = parent.webContents;
  async function diagnostic<T>(work: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work.catch(() => null),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
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
      () => shell.executeJavaScript(`(() => {
        const image = document.querySelector('.browser-isolated-view img');
        return Boolean(window.fixtureReady && image?.naturalWidth);
      })()`),
      Boolean,
    );
    log('local display ready');
    await eventually(() => shell.executeJavaScript(`document.activeElement.id`), value => value === 'composer');
    assert.equal(await shell.executeJavaScript(`document.activeElement.id`), 'composer');
    await eventually(async () => guest.getZoomFactor(), value => value === 1);
    const originalCapture = host.browserPageFrame;
    let releaseResize!: () => void;
    const resizeGate = new Promise<void>(resolve => { releaseResize = resolve; });
    host.browserPageFrame = async (...args: Parameters<BrowserHost['browserPageFrame']>) => {
      await resizeGate;
      return originalCapture.apply(host, args);
    };
    try {
      await shell.executeJavaScript(`document.getElementById('browser-dock').style.width = '420px'`);
      await shell.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      assert.equal(await shell.executeJavaScript(
        `getComputedStyle(document.querySelector('.browser-isolated-view img')).visibility`), 'hidden',
      'old pixels must not stretch into the resized pane while a new frame is pending');
    } finally {
      host.browserPageFrame = originalCapture;
      releaseResize();
    }
    await eventually(() => readFrame('visible-session'), value => value.width === 420);
    assert.equal(guest.getZoomFactor(), 1, 'normal browsing does not shrink text with the pane');
    await shell.executeJavaScript(`document.getElementById('browser-dock').style.width = '600px'`);
    await eventually(() => readFrame('visible-session'), value => value.width === 600);
    await eventually(() => shell.executeJavaScript(`(() => {
      const image = document.querySelector('.browser-isolated-view img');
      return image?.naturalWidth === 600 && getComputedStyle(image).visibility === 'visible';
    })()`), Boolean);
    const point = await guest.executeJavaScript(`(() => {
      const r = document.getElementById('agent').getBoundingClientRect();
      return {x:r.x+r.width/2, y:r.y+r.height/2};
    })()`);
    const frame = await readFrame('visible-session');
    const bounds = await shell.executeJavaScript(`(() => {
      const r = document.querySelector('.browser-isolated-view img').getBoundingClientRect();
      return {x:r.x,y:r.y,width:r.width,height:r.height};
    })()`);
    const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);
    const x = bounds.x + (bounds.width - frame.width * scale) / 2 + point.x * frame.width / frame.viewportWidth * scale;
    const y = bounds.y + (bounds.height - frame.height * scale) / 2 + point.y * frame.height / frame.viewportHeight * scale;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await shell.debugger.sendCommand('Input.insertText', { text: 'manual 한글' });
    log(`manual input sent at ${x.toFixed(1)},${y.toFixed(1)}; image ${frame.width}x${frame.height}, viewport ${frame.viewportWidth}x${frame.viewportHeight}`);
    await eventually(() => guest.executeJavaScript(`document.getElementById('agent').value`), value => value === 'manual 한글');
    assert.equal(await shell.executeJavaScript(`document.getElementById('draft').textContent`), 'keep editing');
    log('local display click and Korean text reached only its page');

    const child = guest.mainFrame.frames.find(frame => frame.url.endsWith('/frame'));
    assert.ok(child);
    const childPoint = await child.executeJavaScript(`(() => {
      const r = document.getElementById('frame').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`) as { x: number; y: number };
    const childOffset = await guest.executeJavaScript(`(() => {
      const el = document.querySelector('iframe'), r = el.getBoundingClientRect();
      return { x: r.x + el.clientLeft, y: r.y + el.clientTop };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', {
        type, button: 'left', clickCount: 1,
        x: bounds.x + (childOffset.x + childPoint.x) * frame.width / frame.viewportWidth * scale,
        y: bounds.y + (childOffset.y + childPoint.y) * frame.height / frame.viewportHeight * scale,
      });
    }
    await shell.debugger.sendCommand('Input.insertText', { text: 'iframe 한글' });
    await eventually(() => child.executeJavaScript(`document.getElementById('frame').value`),
      value => value === 'iframe 한글');
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'manual 한글');
    await new Promise(resolve => setTimeout(resolve, 1100));
    let iframeWaitFinished = false;
    const iframeWait = command('visible-session', {
      action: 'wait', text: 'never-present-iframe-handoff', timeoutMs: 10_000,
    }).then(() => null, error => error).finally(() => { iframeWaitFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(iframeWaitFinished, false);
    const handoffStarted = performance.now();
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', {
        type, button: 'left', clickCount: 1,
        x: bounds.x + (childOffset.x + childPoint.x) * frame.width / frame.viewportWidth * scale,
        y: bounds.y + (childOffset.y + childPoint.y) * frame.height / frame.viewportHeight * scale,
      });
    }
    await shell.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35,
    });
    await shell.debugger.sendCommand('Input.insertText', { text: ' takeover' });
    assert.match(String(await iframeWait), /interrupted by local user input/);
    await eventually(() => child.executeJavaScript(`document.getElementById('frame').value`),
      value => value === 'iframe 한글 takeover');
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'manual 한글');
    assert.equal(await shell.executeJavaScript(`document.getElementById('draft').textContent`), 'keep editing');
    log(`iframe human takeover preserves parent and composer: ${(performance.now() - handoffStarted).toFixed(1)}ms`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await shell.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await eventually(() => guest.executeJavaScript(`document.activeElement.id`), value => value === 'agent');
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
      type: 'pointer' as const, documentId: gestureFrame.documentId,
      x: childOffset.x + childPoint.x, y: childOffset.y + childPoint.y,
      button: 'left' as const, modifiers: 0, clickCount: 1,
    };
    await host.browserPageControl('visible-session', { ...pointer, phase: 'mousePressed', buttons: 1 });
    const outside = { ...pointer, x: gestureFrame.viewportWidth - 10, y: gestureFrame.viewportHeight - 10 };
    await host.browserPageControl('visible-session', { ...outside, phase: 'mouseMoved', buttons: 1 });
    await host.browserPageControl('visible-session', { ...outside, phase: 'mouseReleased', buttons: 0 });
    await eventually(() => child.executeJavaScript('gestureEvents') as Promise<Array<{ type: string; trusted: boolean }>>, events =>
      events.some((event: { type: string; trusted: boolean }) => event.type === 'pointerup' && event.trusted));
    log(`cross-frame captured drag and release: ${(performance.now() - gestureStart).toFixed(1)}ms`);
    await child.executeJavaScript(`(() => {
      document.getElementById('frame').onpointerdown = null;
      for (const type of ['pointermove','pointerup']) document.removeEventListener(type, window.gestureListener);
    })()`);
    await guest.executeJavaScript(`document.body.style.height = '2400px'`);
    const scrollStart = performance.now();
    await host.browserPageControl('visible-session', {
      type: 'wheel', documentId: gestureFrame.documentId,
      x: gestureFrame.viewportWidth - 1, y: 250, deltaX: 0, deltaY: 160,
    });
    await eventually(() => guest.executeJavaScript('scrollY'), value => value > 0);
    log(`scrollbar-area wheel to page scroll: ${(performance.now() - scrollStart).toFixed(1)}ms`);
    await guest.executeJavaScript(`document.body.style.height = ''; scrollTo(0,0); document.getElementById('agent').focus()`);

    await shell.executeJavaScript(`(() => {
      window.setSurfaceActive(false);
      const composer = document.getElementById('composer');
      composer.focus(); composer.setSelectionRange(composer.value.length, composer.value.length);
    })()`);
    // Local input deliberately owns the foreground until the user is idle.
    await new Promise(resolve => setTimeout(resolve, 1100));
    let waitSettled = false;
    const waiting = command('visible-session', {
      action: 'wait', text: 'never-present-handoff-condition', timeoutMs: 10_000,
    }).then(() => null, error => error).finally(() => { waitSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(waitSettled, false, 'the automation wait is still active');
    const duringWait = await readFrame('visible-session');
    const takeoverStarted = performance.now();
    await host.browserPageControl('visible-session', {
      type: 'text', text: ' takeover', documentId: duringWait.documentId,
    });
    assert.match(String(await waiting), /interrupted by local user input/);
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'manual 한글 takeover');
    log(`human takeover of active Browser Use wait: ${(performance.now() - takeoverStarted).toFixed(1)}ms`);
    await assert.rejects(command('visible-session', { action: 'snapshot' }), /local user input/);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const snapshot = await command('visible-session', { action: 'snapshot' });
    const ref = snapshot.split('\n').find(line => line.includes('"Agent input"'))?.match(/\[(p\d+-s\d+-e\d+)\]/)?.[1];
    assert.ok(ref, snapshot);
    await Promise.all([
      command('visible-session', { action: 'type', ref, text: 'agent while hidden' }),
      shell.debugger.sendCommand('Input.insertText', { text: ' 사용자 입력' }),
    ]);
    assert.equal(await shell.executeJavaScript(`document.getElementById('draft').textContent`), 'keep editing 사용자 입력');
    assert.equal(await shell.executeJavaScript(`document.activeElement.id`), 'composer');
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'agent while hidden');
    await shell.executeJavaScript('window.setSurfaceActive(true)');
    await eventually(async () => captures, count => count > 2);
    await shell.executeJavaScript('window.setFixtureVisible(false)');
    // Allow the one already-issued read to settle before measuring the idle period.
    await new Promise(resolve => setTimeout(resolve, 300));
    const hiddenCount = captures;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(captures, hiddenCount, 'hidden documents must stop presentation polling');
    await shell.executeJavaScript('window.setFixtureVisible(true)');
    await eventually(async () => captures, count => count > hiddenCount);
    log('concurrent composer typing, parked execution, and presentation polling isolation passed');

    const before = await readFrame('visible-session');
    await guest.loadURL(`${origin}/next-document`);
    await assert.rejects(host.browserPageControl('visible-session', {
      type: 'text', text: 'must not appear', documentId: before.documentId,
    }), /page changed/);
    const next = await readFrame('visible-session');
    await assert.rejects(host.browserPageControl('parked-session', {
      type: 'text', text: 'wrong session', documentId: next.documentId,
    }), /page changed/);
    log('stale document and cross-session input refused');

    const samples: number[] = [];
    for (let count = 0; count < 8; count += 1) {
      const started = performance.now();
      await readFrame('visible-session');
      samples.push(performance.now() - started);
    }
    log(`local frame capture ms: ${samples.map(value => value.toFixed(1)).join(', ')}`);
    await measureBrowserPresentation(host, guest, shell, log);
    await exerciseBrowserErrorNotice(host, guest, shell, log);
    await exerciseBrowserPrompts(guest, shell, log);
    await shell.executeJavaScript('window.setSurfaceActive(false)');
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
      guest.on('paint', rememberPaint);
      let resized: DesktopBrowserPageFrame;
      try {
        await host.browserPageControl('visible-session', {
          type: 'resize', width: config.width, height: config.height, documentId: next.documentId,
        });
        await host.configureGuestViewport('visible-session', guest.id, { ...config, userAgent: null });
        resized = await readFrame('visible-session');
      } finally { guest.removeListener('paint', rememberPaint); }
      assert.ok(resized.image);
      const decoded = nativeImage.createFromBuffer(Buffer.from(resized.image.data, 'base64'));
      const bitmap = decoded.toBitmap();
      const native = paints.find(image =>
        image.toBitmap({ scaleFactor: Math.max(1, ...image.getScaleFactors()) }).equals(bitmap));
      assert.ok(native,
        'display encoding must preserve the original pixels, including text edges');
      const actual = await guest.executeJavaScript(`({ width: innerWidth, height: innerHeight })`);
      log(`resolution sample ${JSON.stringify({
        config, pixels: [resized.width, resized.height],
        inputViewport: [resized.viewportWidth, resized.viewportHeight], actual,
        encoding: resized.image.mimeType, nativeSize: native.getSize(), scales: native.getScaleFactors(),
      })}`);
      assert.deepEqual([resized.surfaceWidth, resized.surfaceHeight], [config.width, config.height]);
      assert.equal(resized.image.mimeType, 'image/png');
      assert.equal(resized.viewportWidth, actual.width);
      assert.equal(resized.viewportHeight, actual.height);
    }
    await host.configureGuestViewport('visible-session', guest.id, {
      width: null, height: null, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null,
    });
    await host.browserPageControl('visible-session', {
      type: 'resize', width: next.width, height: next.height, documentId: next.documentId,
    });
    await guest.executeJavaScript(`document.body.style.height = ''`);
    await shell.executeJavaScript('window.setSurfaceActive(false)');
    await guest.executeJavaScript(`document.cookie = 'isolation_login=retained; path=/'`);
    const original = await readFrame('visible-session');
    await guest.executeJavaScript(`window.open(${JSON.stringify(`${origin}/login-popup`)}, 'login-popup'); void 0`);
    const withPopup = await eventually(
      () => readFrame('visible-session'),
      value => Boolean(value.tabs?.some(tab => tab.kind === 'popup')),
    );
    const popupTab = withPopup.tabs!.find(tab => tab.kind === 'popup')!;
    log(`popup discovered ${JSON.stringify(popupTab)}`);
    await assert.rejects(host.browserPageControl('parked-session', {
      type: 'select-tab', tabId: popupTab.id, documentId: original.documentId,
    }), /this session/);
    await shell.executeJavaScript('window.setSurfaceActive(true)');
    const popupSelector = `[role="tab"][data-page-id="${popupTab.id}"]`;
    await eventually(
      () => shell.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(popupSelector)}))`),
      Boolean,
    );
    await shell.executeJavaScript(`document.querySelector(${JSON.stringify(popupSelector)}).click()`);
    log('popup selected through tab strip');
    const popupFrame = await eventually(
      () => readFrame('visible-session'),
      value => !value.loading && value.url.endsWith('/login-popup'),
    );
    const popupGuest = webContents.fromId(popupFrame.webContentsId)!;
    assert.ok(popupGuest);
    assert.equal(popupFrame.tabs!.find(tab => tab.active)!.id, popupTab.id);
    assert.match(await popupGuest.executeJavaScript('document.cookie'), /isolation_login=retained/);
    assert.equal(await popupGuest.executeJavaScript('Boolean(window.opener)'), true);
    await popupGuest.executeJavaScript(`document.getElementById('agent').value = 'popup draft'`);
    const primaryTab = original.tabs!.find(tab => tab.active)!;
    await host.browserPageControl('visible-session', {
      type: 'select-tab', tabId: primaryTab.id, documentId: popupFrame.documentId,
    });
    host.setGuestActive('visible-session', popupFrame.webContentsId, true);
    assert.equal((await readFrame('visible-session')).webContentsId, guest.id,
      'late display reports do not undo the user selection');
    await host.browserPageControl('visible-session', {
      type: 'select-tab', tabId: popupTab.id, documentId: original.documentId,
    });
    assert.equal((await readFrame('visible-session')).webContentsId, popupGuest.id);
    assert.equal(await popupGuest.executeJavaScript(`document.getElementById('agent').value`), 'popup draft');
    await host.browserPageControl('visible-session', {
      type: 'close-tab', tabId: popupTab.id, documentId: popupFrame.documentId,
    });
    await eventually(() => readFrame('visible-session'), value => value.webContentsId === guest.id);
    await host.browserPageControl('visible-session', { type: 'new-tab', documentId: original.documentId });
    const created = await readFrame('visible-session');
    assert.notEqual(created.webContentsId, guest.id);
    assert.equal(created.url, 'about:blank');
    await host.browserPageControl('visible-session', {
      type: 'close-tab', tabId: created.tabs!.find(tab => tab.active)!.id, documentId: created.documentId,
    });
    await eventually(() => readFrame('visible-session'), value => value.webContentsId === guest.id);
    await shell.executeJavaScript('window.setSurfaceActive(false)');
    log('visible popup switching retains opener, login and form state; tab creation, close and session isolation passed');
    await guest.executeJavaScript(`(() => {
      const popup = window.open('about:blank', 'blank-login');
      popup.document.write('<title>Blank login</title><input value="retained draft">');
      popup.document.close();
    })()`);
    const blankTabs = await eventually(
      () => readFrame('visible-session'),
      value => Boolean(value.tabs?.some(tab => tab.kind === 'popup' && tab.title === 'Blank login')),
    );
    const blankTab = blankTabs.tabs!.find(tab => tab.kind === 'popup')!;
    await host.browserPageControl('visible-session', {
      type: 'select-tab', tabId: blankTab.id, documentId: blankTabs.documentId,
    });
    const blankFrame = await readFrame('visible-session');
    assert.ok(blankFrame.viewportWidth > 0 && blankFrame.viewportHeight > 0);
    assert.equal(await webContents.fromId(blankFrame.webContentsId)!.executeJavaScript(
      `document.querySelector('input').value`), 'retained draft');
    await host.browserPageControl('visible-session', {
      type: 'close-tab', tabId: blankTab.id, documentId: blankFrame.documentId,
    });
    log('about:blank popup content is visible without losing its document');
    const other = await readFrame('parked-session');
    assert.notEqual(other.webContentsId, guest.id);
    await host.browserPageControl('visible-session', { type: 'new-tab', documentId: blankFrame.documentId });
    const resumeTab = await readFrame('visible-session');
    await host.browserPageControl('visible-session', {
      type: 'navigate', url: `${origin}/restore-after-unload`, documentId: resumeTab.documentId,
    });
    const readyToUnload = await eventually(
      () => readFrame('visible-session'),
      value => !value.loading && value.url.endsWith('/restore-after-unload'),
    );
    const oldPageIds = readyToUnload.tabs!.map(tab => tab.id);
    const oldActive = webContents.fromId(readyToUnload.webContentsId)!;
    const unrelated = webContents.fromId(other.webContentsId)!;
    host.releaseSession('visible-session', { restore: true });
    await eventually(async () => guest.isDestroyed() && oldActive.isDestroyed(), Boolean);
    assert.equal(unrelated.isDestroyed(), false);
    const resumed = await eventually(
      () => readFrame('visible-session'),
      value => !value.loading && value.url.endsWith('/restore-after-unload'),
    );
    assert.equal(resumed.tabs!.length, readyToUnload.tabs!.length);
    assert.ok(resumed.tabs!.every(tab => !oldPageIds.includes(tab.id)));
    assert.match(await webContents.fromId(resumed.webContentsId)!.executeJavaScript('document.cookie'),
      /isolation_login=retained/);
    log('runtime unload destroys only the owning session pages; next demand restores tab URLs and shared login');
    host.releaseSession('visible-session');
    const reopened = await readFrame('visible-session');
    assert.notEqual(reopened.webContentsId, guest.id);
    assert.equal(reopened.url, 'about:blank', 'deletion forgets saved browser navigation');
    await host.browserPageControl('visible-session', {
      type: 'navigate', url: `${origin}/reopened`, documentId: reopened.documentId,
    });
    await eventually(() => readFrame('visible-session'), value => !value.loading && value.url.endsWith('/reopened'));
    await new Promise(resolve => setTimeout(resolve, 1100));
    const cookieCheck = await command('visible-session', { action: 'evaluate', script: 'document.cookie' });
    assert.match(cookieCheck, /isolation_login=retained/);
    log('page release and recreation retain shared login storage');
  } catch (error) {
    log((error as Error).stack || String(error));
    for (const page of webContents.getAllWebContents().filter(page => page !== shell)) {
      try {
      log(JSON.stringify({
        page: page.id, url: page.getURL(), offscreen: page.isOffscreen(),
        painting: page.isOffscreen() ? page.isPainting() : null,
        bounds: BrowserWindow.fromWebContents(page)?.getBounds(),
        document: await diagnostic(page.executeJavaScript(`({
          ready: document.readyState, visibility: document.visibilityState,
          width: innerWidth, height: innerHeight, focused: document.hasFocus(),
        })`)),
      }));
      } catch { log('page destroyed while collecting diagnostics'); }
    }
    log(JSON.stringify(await diagnostic(shell.executeJavaScript(`({
      active: document.activeElement?.className,
      image: (() => { const image = document.querySelector('.browser-isolated-view img');
        return image ? {width:image.naturalWidth,height:image.naturalHeight,box:image.getBoundingClientRect().toJSON()} : null; })(),
      notices: [...document.querySelectorAll('[role="status"]')].map(node => node.textContent),
    })`))));
    log(JSON.stringify(guest.isDestroyed() ? { destroyed: true } : await diagnostic(guest.executeJavaScript(`({
      focused: document.activeElement?.id,
      text: document.getElementById('agent')?.value,
      keys: window.keys,
    })`))));
    throw error;
  } finally {
    for (const channel of channels) ipcMain.removeHandler(channel);
  }
}
