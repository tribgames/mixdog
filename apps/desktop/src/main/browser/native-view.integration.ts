// Real-Electron checks for native Browser pane presentation
// (MIXDOG_BROWSER_NATIVE_VIEW): the production BrowserPane shows the page's own
// view over its surface, agent input leaves the shell composer untouched, native
// human input takes over from the agent, overlaps fall back to pixels, and a
// hidden pane keeps its page rendering. Run through
// `node apps/desktop/scripts/run-browser-input-isolation.mjs --native`.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, webContents } from 'electron';
import { createBrowserHost, type BrowserHost } from './host';
import { createPolling } from '../host-harness-poll';
import { registerBrowserIpc } from '../ipc-browser';
import { DESKTOP_IPC } from '../../shared/contract';
import { readyBrowserFrame } from './harness-frame';

const directory = process.env.MIXDOG_INPUT_ISOLATION_DIRECTORY!;
const logPath = process.env.MIXDOG_INPUT_ISOLATION_LOG!;
process.env.MIXDOG_DATA_DIR = join(directory, 'data');
process.env.MIXDOG_BROWSER_NATIVE_VIEW = '1';
app.setPath('userData', join(directory, 'profile'));
if (!process.argv.includes('--gpu')) app.disableHardwareAcceleration();
// Same Windows occlusion setting as the desktop app (see main/index.ts).
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const log = (text: string) => appendFileSync(logPath, `${text}\n`);
const { readDiscovery } = createPolling({ timeoutMs: 5_000, intervalMs: 25 });
const { eventually } = createPolling({ timeoutMs: 8_000, intervalMs: 25 });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => {
  log('native view timed out');
  app.exit(1);
}, 110_000);

async function run(): Promise<void> {
  const chosenFile = join(directory, 'chosen.txt');
  writeFileSync(chosenFile, 'browser upload fixture');
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (request.url === '/fixture.js' || request.url === '/fixture.css') {
      const css = request.url.endsWith('.css');
      response.setHeader('content-type', css ? 'text/css' : 'text/javascript');
      response.end(readFileSync(join(directory, css ? 'fixture-renderer.css' : 'fixture-renderer.js')));
      return;
    }
    if (request.url === '/shell') {
      response.end(`<!doctype html><link rel="stylesheet" href="/fixture.css">
        <style>html,body{margin:0}#root{width:1000px;height:720px}.browser-pane{height:100%}</style>
        <div id="root"></div><script src="/fixture.js"></script>`);
      return;
    }
    if (request.url === '/frame') {
      response.end(`<!doctype html><label>Frame input <input id="frame"></label>`);
      return;
    }
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    response.end(`<!doctype html><title>Native view</title>
      <body style="margin:0;height:3000px;background:rgb(20,120,200)">
      <label>Agent input <input id="agent"></label>
      <button onclick="document.getElementById('agent').focus()">Focus field</button>
      <iframe src="http://127.0.0.2:${address.port}/frame"></iframe></body>`);
  });
  let parent: BrowserWindow | undefined;
  let host: BrowserHost | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    parent = new BrowserWindow({
      show: false,
      // Native pages are shown only over a visible shell, so this one is on the
      // display for the run, without ever taking focus.
      focusable: false,
      width: 1000,
      height: 720,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(directory, 'fixture-preload.cjs'),
      },
    });
    host = createBrowserHost(parent, {
      requestApproval: async () => true,
      chooseBrowserFiles: async () => ({ canceled: false, filePaths: [chosenFile] }),
    });
    const shell = parent.webContents;
    let pixelReads = 0;
    let metadataReads = 0;
    const presentCalls: string[] = [];
    registerBrowserIpc({
      browserHost: host,
      handle(channel, listener) {
        ipcMain.handle(channel, (event, ...args) => {
          assert.equal(event.sender, shell, 'only the fixture shell may address the pane');
          if (channel === DESKTOP_IPC.browserPageFrame) pixelReads += 1;
          if (channel === DESKTOP_IPC.browserPageMetadata) metadataReads += 1;
          if (channel === DESKTOP_IPC.browserPresentNative) {
            const result = listener(event, ...args);
            presentCalls.push(JSON.stringify([args[1], result]));
            return result;
          }
          return listener(event, ...args);
        });
      },
    });

    const first = await readyBrowserFrame(host, 'visible-session');
    const guest = webContents.fromId(first.webContentsId)!;
    assert.ok(guest);
    assert.equal(guest.isOffscreen(), false, 'native presentation composes pages in native windows');
    const owner = BrowserWindow.fromWebContents(guest)!;
    assert.ok(owner && owner !== parent);
    // Page windows are never hidden: a new one starts parked off-screen.
    assert.equal(owner.isVisible(), true);
    assert.ok(owner.getBounds().x < -10_000, JSON.stringify(owner.getBounds()));
    assert.equal(owner.getParentWindow(), null);
    assert.equal(owner.isFocusable(), false);
    await guest.loadURL(`${origin}/visible`);

    host.setBridgeEnabled(true);
    const discovery = await readDiscovery(join(directory, 'data', 'browser-bridge.json'));
    let turn = 0;
    const request = async (input: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'visible-session', turn_id: ++turn, ...input }),
        signal: AbortSignal.timeout(15_000),
      });
      return (await response.json()) as {
        ok: boolean;
        error?: string;
        value?: { text: string; image?: { data: string } };
      };
    };
    const command = async (input: Record<string, unknown>) => {
      const result = await request(input);
      assert.ok(result.ok, `${input.action}: ${result.error}`);
      return result.value!;
    };

    // A presented page is its own window, owned by the shell and shown over the
    // pane; a parked page's window is hidden (and keeps rendering).
    // Parked page windows stay shown, but unowned and far off every display.
    const onPane = (window: BrowserWindow) =>
      window.isVisible() && window.getParentWindow() === parent && window.getBounds().x > -10_000;
    const shownPages = () => BrowserWindow.getAllWindows().filter((window) => window !== parent && onPane(window));
    const presented = () => onPane(owner);
    const parked = () => !onPane(owner);
    const otherPresented = () => parked() && shownPages().length === 1;
    // Where the pane's surface is on screen, in DIPs.
    const paneOnScreen = (rect: { x: number; y: number; width: number; height: number }) => {
      const content = parent!.getContentBounds();
      return { x: content.x + rect.x, y: content.y + rect.y, width: rect.width, height: rect.height };
    };
    const surfaceRect = () =>
      shell.executeJavaScript(`(() => {
        const r = document.querySelector('.browser-isolated-surface').getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
      })()`);

    // Animation frames the page produced in one second; timers keep running
    // even when frames stop, so a stalled page reports a count near zero.
    const frameRate = (): Promise<number> =>
      guest.executeJavaScript(`new Promise((resolve) => {
        let frames = 0;
        const count = () => { frames += 1; requestAnimationFrame(count); };
        requestAnimationFrame(count);
        setTimeout(() => resolve(frames), 1000);
      })`);

    await parent.loadURL(`${origin}/shell`);
    parent.showInactive();
    shell.focus();
    await eventually(() => shell.executeJavaScript('Boolean(window.fixtureReady)'), Boolean);
    try {
      await eventually(async () => presented(), Boolean);
    } catch (error) {
      log(
        `not presented: last requests ${presentCalls.slice(-3).join(' ')}; window ${JSON.stringify(owner.getBounds())}`
      );
      throw error;
    }
    assert.equal(owner.isResizable(), false, 'the page edge must not resize independently of the browser panel');
    const initialBounds = owner.getBounds();
    for (const width of [400, 560, 600]) {
      // A right-docked panel changes its left edge while its right edge stays
      // put. Disabling native edge grips must still allow panel-driven sizing.
      await shell.executeJavaScript(`(() => {
        const dock = document.getElementById('browser-dock');
        dock.style.width = '${width}px';
        dock.style.marginLeft = '${600 - width}px';
      })()`);
      await eventually(async () => {
        const pane = paneOnScreen(await surfaceRect());
        const actual = owner.getBounds();
        return (['x', 'y', 'width', 'height'] as const).every((key) => Math.abs(actual[key] - pane[key]) <= 1);
      }, Boolean);
      const resized = owner.getBounds();
      assert.ok(Math.abs(resized.width - width) <= 1, `page must follow the panel width ${width}`);
      assert.ok(
        Math.abs(resized.x + resized.width - initialBounds.x - initialBounds.width) <= 1,
        'the page and panel must keep their right edge aligned during left-edge resizing'
      );
    }
    log('native page edge resizing disabled; panel-driven shrink and leftward expansion stay aligned');
    const rect = await surfaceRect();
    const bounds = owner.getContentBounds();
    const pane = paneOnScreen(rect);
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      assert.ok(
        Math.abs(bounds[key] - pane[key]) <= 1,
        `page window ${key} ${bounds[key]} must match pane ${pane[key]}`
      );
    }
    assert.equal(BrowserWindow.fromWebContents(guest), owner, 'the page window keeps owning the page');
    assert.equal(owner.isFocused(), false, 'showing the page does not activate it');
    await eventually(
      () => guest.executeJavaScript('innerWidth + "x" + innerHeight'),
      (value) => value === `${bounds.width}x${bounds.height}`
    );
    // A pixel read already in flight when the view appeared may still land.
    await eventually(async () => metadataReads > 0, Boolean);
    await pause(200);
    const readsBefore = { pixels: pixelReads, metadata: metadataReads };
    await pause(600);
    assert.equal(pixelReads, readsBefore.pixels, 'a natively presented page is never sampled for pixels');
    assert.ok(metadataReads > readsBefore.metadata, 'the pane keeps reading page facts');
    log(`native page presented at ${JSON.stringify(bounds)}; pixel reads stopped`);
    log(`presented page frames: ${await frameRate()}/s`);
    // An idle shell must not hit-test the pane every display frame.
    const idleHitTests = await shell.executeJavaScript(`new Promise((resolve) => {
      const original = document.elementFromPoint;
      let calls = 0;
      document.elementFromPoint = function (...args) { calls += 1; return original.apply(this, args); };
      setTimeout(() => { document.elementFromPoint = original; resolve(calls); }, 1000);
    })`);
    log(`idle overlap hit tests: ${idleHitTests}/s`);
    assert.ok(
      idleHitTests <= 25 * 6,
      `an idle pane checks overlap a few times a second, not every frame: ${idleHitTests}`
    );
    {
      // What the screen shows in the middle of the pane. The shell is raised
      // above other windows for the capture (without activation); its owned
      // page window stays above it.
      parent.setAlwaysOnTop(true);
      await pause(400);
      // Low in the pane, clear of the fixture's controls and frame.
      const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height * 0.85 };
      const display = screen.getDisplayNearestPoint(centre);
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: display.size.width * display.scaleFactor,
          height: display.size.height * display.scaleFactor,
        },
      });
      parent.setAlwaysOnTop(false);
      const source = sources.find((entry) => entry.display_id === String(display.id)) ?? sources[0];
      assert.ok(source, 'the display can be captured');
      const size = source.thumbnail.getSize();
      const x = Math.round(((centre.x - display.bounds.x) * size.width) / display.bounds.width);
      const y = Math.round(((centre.y - display.bounds.y) * size.height) / display.bounds.height);
      const shown = source.thumbnail.crop({ x, y, width: 1, height: 1 }).toBitmap();
      const colour = [shown[2], shown[1], shown[0]];
      log(`display colour at the pane centre: ${colour}`);
      assert.ok(
        [20, 120, 200].every((value, index) => Math.abs(colour[index] - value) <= 12),
        `the presented page is what the display shows: ${colour}`
      );
    }

    // Agent input while the page is presented must leave the composer alone.
    const resetComposer = async () => {
      shell.focus();
      await shell.executeJavaScript(`(() => {
        const field = document.getElementById('composer');
        field.focus(); field.setSelectionRange(2, 6, 'backward');
      })()`);
    };
    const composer = () =>
      shell.executeJavaScript(`(() => {
        const field = document.getElementById('composer');
        return {active: document.activeElement.id, value: field.value, draft: document.getElementById('draft').textContent,
          start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection};
      })()`);
    let snapshot = (await command({ action: 'snapshot' })).text;
    const ref = (name: string) => {
      const line = snapshot.split('\n').find((entry) => entry.includes(JSON.stringify(name)));
      const match = line?.match(/\[(p\d+-s\d+-e\d+)\]/);
      assert.ok(match, snapshot);
      return match[1];
    };
    shell.debugger.attach('1.3');
    for (const [label, input] of [
      ['click', () => ({ action: 'click', ref: ref('Focus field') })],
      ['type', () => ({ action: 'type', ref: ref('Agent input'), text: 'agent-type' })],
      ['press', () => ({ action: 'press', key: 'z' })],
      ['frame type', () => ({ action: 'type', ref: ref('Frame input'), text: 'frame-text' })],
      ['IME type', () => ({ action: 'type', ref: ref('Agent input'), text: 'agent-ime' })],
    ] as const) {
      await resetComposer();
      if (label === 'IME type') {
        await shell.debugger.sendCommand('Input.imeSetComposition', { text: 'ㅎ', selectionStart: 1, selectionEnd: 1 });
      }
      const before = await composer();
      snapshot = (await command({ action: 'snapshot' })).text;
      const result = await command(input());
      if (result.text.includes('[p')) snapshot = result.text;
      assert.deepEqual(await composer(), before, `agent ${label} must preserve the composer`);
      if (label === 'IME type') {
        for (const text of ['하', '한']) {
          await shell.debugger.sendCommand('Input.imeSetComposition', { text, selectionStart: 1, selectionEnd: 1 });
        }
        await shell.debugger.sendCommand('Input.insertText', { text: '한' });
        await eventually(
          () => shell.executeJavaScript(`document.getElementById('draft').textContent`),
          (value) => String(value).includes('한')
        );
        await shell.executeJavaScript(`(() => {
          const field = document.getElementById('composer');
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(field, 'keep editing'); field.dispatchEvent(new Event('input', {bubbles:true}));
        })()`);
      }
      assert.ok(presented(), `agent ${label} must not be mistaken for local input`);
    }
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'agent-ime');
    const child = guest.mainFrame.frames.find((frame) => frame.url.endsWith('/frame'));
    assert.ok(child, 'cross-origin frame must exist');
    assert.equal(await child.executeJavaScript(`document.getElementById('frame').value`), 'frame-text');
    log('agent click/type/press, cross-origin iframe and composer IME preserved the composer');
    // What an idle presented pane costs each process, as percent of one core.
    app.getAppMetrics();
    await pause(3000);
    const idleCpu = Object.fromEntries(
      app
        .getAppMetrics()
        .map((metric) => [
          metric.pid === shell.getOSProcessId()
            ? 'shell'
            : metric.pid === guest.getOSProcessId()
              ? 'page'
              : `${metric.type}${metric.pid === process.pid ? '(main)' : ''}`,
          Math.round(metric.cpu.percentCPUUsage * 10) / 10,
        ])
    );
    log(`idle presented pane cpu: ${JSON.stringify(idleCpu)}`);

    // Native human input takes over from a waiting agent command.
    for (const [label, send] of [
      [
        'mouse',
        () => {
          guest.sendInputEvent({ type: 'mouseDown', x: 40, y: 12, button: 'left', clickCount: 1 });
          guest.sendInputEvent({ type: 'mouseUp', x: 40, y: 12, button: 'left', clickCount: 1 });
        },
      ],
      ['keyboard', () => guest.sendInputEvent({ type: 'keyDown', keyCode: 'End' })],
      ['wheel', () => guest.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: -60 })],
    ] as const) {
      await pause(1100);
      const started = performance.now();
      const waiting = request({ action: 'wait', text: 'never-present-native-takeover', timeoutMs: 10_000 });
      await pause(200);
      send();
      const result = await waiting;
      assert.equal(result.ok, false, `${label} input must interrupt the agent`);
      assert.match(String(result.error), /interrupted by local user input/);
      log(`native ${label} takeover: ${(performance.now() - started - 200).toFixed(1)}ms`);
    }

    // Anything the shell draws over the page parks it; pixels take over.
    await pause(1100);
    await shell.executeJavaScript(`(() => {
      const overlay = document.createElement('div');
      overlay.id = 'overlay';
      overlay.style.cssText = 'position:fixed;left:${Math.round(rect.x + 30)}px;top:${Math.round(rect.y + 30)}px;width:160px;height:90px;z-index:99999;background:#333';
      document.body.append(overlay);
    })()`);
    await eventually(async () => parked(), Boolean);
    log(`overlapped (parked) page frames: ${await frameRate()}/s`);
    await eventually(
      () =>
        shell.executeJavaScript(`(() => {
          const image = document.querySelector('.browser-isolated-pixels > :first-child');
          return Boolean(image?.naturalWidth || image?.width);
        })()`),
      Boolean
    );
    await shell.executeJavaScript(`document.getElementById('overlay').remove()`);
    await eventually(async () => presented(), Boolean);
    log('overlapping shell UI parks the page and shows pixels until it is gone');

    await guest.executeJavaScript(
      `setTimeout(() => { window.alertDone = alert('Native fixture alert') || true; }, 0); void 0`
    );
    await eventually(() => shell.executeJavaScript(`Boolean(document.querySelector('.browser-page-prompt'))`), Boolean);
    // The pane prompt is drawn by the shell, so the next frame parks the page.
    await eventually(async () => parked(), Boolean);
    await shell.executeJavaScript(`(() => {
      const buttons = document.querySelectorAll('.browser-page-prompt button');
      buttons[buttons.length - 1].click();
    })()`);
    await eventually(() => guest.executeJavaScript('window.alertDone === true'), Boolean);
    await eventually(async () => presented(), Boolean);
    log('page prompts fall back to the pane prompt and return to native display');

    // The page window follows the shell: hidden with it, back with it, and
    // moved with it.
    parent.hide();
    await eventually(async () => parked(), Boolean);
    parent.showInactive();
    await eventually(async () => presented(), Boolean);
    const [shellX, shellY] = parent.getPosition();
    parent.setPosition(shellX + 40, shellY + 30);
    await eventually(async () => {
      const moved = owner.getContentBounds();
      const pane = paneOnScreen(await surfaceRect());
      return Math.abs(moved.x - pane.x) <= 1 && Math.abs(moved.y - pane.y) <= 1;
    }, Boolean);
    parent.setPosition(shellX, shellY);
    log('the page window hides, returns and moves with the shell');

    // A hidden pane parks the page; the agent keeps seeing and driving it.
    await shell.executeJavaScript('window.setSurfaceActive(false)');
    await eventually(async () => parked(), Boolean);
    assert.equal(await guest.executeJavaScript('document.visibilityState'), 'visible');
    log(`hidden-pane (parked) page frames: ${await frameRate()}/s`);
    // A new renderer after a cross-site navigation must draw too: a page window
    // that was shown and then hidden commits it without frames.
    await guest.loadURL(`http://localhost:${address.port}/visible`);
    const crossSiteFrames = await frameRate();
    log(`hidden-pane page frames after a cross-site navigation: ${crossSiteFrames}/s`);
    assert.ok(crossSiteFrames >= 30, `a parked page keeps drawing after a cross-site navigation: ${crossSiteFrames}/s`);
    await guest.loadURL(`${origin}/visible`);
    // A page the pane never showed — an agent background tab — too.
    await command({ action: 'navigate', url: `${origin}/visible`, background: true, tab: 'never-shown' });
    await command({ action: 'navigate', url: `http://localhost:${address.port}/visible`, tab: 'never-shown' });
    const neverShown = await command({
      action: 'evaluate',
      tab: 'never-shown',
      script: `new Promise((resolve) => {
        let frames = 0;
        const count = () => { frames += 1; requestAnimationFrame(count); };
        requestAnimationFrame(count);
        setTimeout(() => resolve({ frames }), 1000);
      })`,
    });
    const neverShownFrames = Number(neverShown.text.match(/"frames": (\d+)/)?.[1] ?? 0);
    log(`never-shown page frames after a cross-site navigation: ${neverShownFrames}/s`);
    assert.ok(
      neverShownFrames >= 30,
      `a never-shown page keeps drawing after a cross-site navigation: ${neverShownFrames}/s`
    );
    await command({ action: 'close_tab', tab: 'never-shown' });
    await guest.executeJavaScript(`document.body.style.background = 'rgb(200, 30, 60)'`);
    const shot = await command({ action: 'snapshot', mode: 'visual' });
    assert.ok(shot.image?.data, 'agent screenshot while parked');
    const pixel = nativeImage
      .createFromBuffer(Buffer.from(shot.image.data, 'base64'))
      .crop({ x: 5, y: 60, width: 1, height: 1 })
      .toBitmap();
    // The agent image is lossy; the page's new colour must still be what it shows.
    const colour = [pixel[2], pixel[1], pixel[0]];
    assert.ok(
      [200, 30, 60].every((value, index) => Math.abs(colour[index] - value) <= 12),
      `the parked screenshot shows the current page: ${colour}`
    );
    await resetComposer();
    const beforeParkedType = await composer();
    snapshot = (await command({ action: 'snapshot' })).text;
    await command({ action: 'type', ref: ref('Agent input'), text: 'parked-type' });
    assert.deepEqual(await composer(), beforeParkedType);
    assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'parked-type');
    await shell.executeJavaScript('window.setSurfaceActive(true)');
    await eventually(async () => presented(), Boolean);
    log('hidden pane parks its page; agent screenshots and typing stay current and leave the composer alone');

    // Selecting another tab presents that page and parks the previous one.
    const current = await host.browserPageMetadata('visible-session');
    await host.browserPageControl('visible-session', { type: 'new-tab', documentId: current.documentId });
    await eventually(async () => otherPresented(), Boolean);
    const tabs = (await host.browserPageMetadata('visible-session')).tabs ?? [];
    const original = tabs.find((tab) => !tab.active);
    assert.ok(original, JSON.stringify(tabs));
    await host.browserPageControl('visible-session', {
      type: 'select-tab',
      tabId: original.id,
      documentId: (await host.browserPageMetadata('visible-session')).documentId,
    });
    await eventually(async () => presented() && shownPages().length === 1, Boolean);
    log('tab selection presents the selected page and parks the other');

    // A popup the page opens is a page view of its own, presented like a tab.
    await guest.executeJavaScript(`window.open(${JSON.stringify(`${origin}/visible?popup`)}, '_blank'); void 0`, true);
    const popupTab = await eventually(
      async () => ((await host!.browserPageMetadata('visible-session')).tabs ?? []).find((tab) => tab.kind === 'popup'),
      Boolean
    );
    const popupGuest = await eventually(
      async () => webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/visible?popup')),
      Boolean
    );
    const popupWindow = BrowserWindow.fromWebContents(popupGuest!)!;
    assert.equal(onPane(popupWindow), false, 'a popup opens parked, not over the pane');
    await host.browserPageControl('visible-session', {
      type: 'select-tab',
      tabId: popupTab!.id,
      documentId: (await host.browserPageMetadata('visible-session')).documentId,
    });
    await eventually(async () => parked() && onPane(popupWindow), Boolean);
    log('a page popup is presented as its own page window');

    // A shell that navigates away cannot place pages any more; none may stay on top.
    await shell.loadURL('about:blank');
    await eventually(async () => shownPages().length === 0, Boolean);
    log('shell navigation parks every native page');
    log('native view passed');
  } catch (error) {
    log((error as Error).stack || String(error));
    throw error;
  } finally {
    await host?.dispose();
    if (parent && !parent.isDestroyed()) parent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    log(error.stack || String(error));
    app.exit(1);
  })
  .finally(() => clearTimeout(deadline));
