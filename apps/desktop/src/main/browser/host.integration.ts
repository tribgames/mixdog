import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, nativeImage, webContents, type WebContents } from 'electron';
import { BROWSER_ACTIONS } from '../../../../../src/runtime/browser-bridge/browser-action-contract.mjs';
import { createBrowserHost, type BrowserHost } from './host';
import { createPolling } from '../host-harness-poll';
import { DESKTOP_IPC, type DesktopBrowserOpenRequest } from '../../shared/contract';

interface CommandResponse {
  ok: boolean;
  value?: {
    text?: string;
    image?: { mimeType?: string; data?: string };
    file?: { mimeType?: string; data?: string; name?: string };
  };
  error?: string;
}

const progressPath = process.env.MIXDOG_BROWSER_INTEGRATION_LOG || '';
function progress(message: string): void {
  if (progressPath) appendFileSync(progressPath, `${message}\n`);
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

const profile = mkdtempSync(join(tmpdir(), 'mixdog-browser-host-profile-'));
const dataDirectory = join(profile, 'data');
const downloadsDirectory = join(profile, 'downloads');
const uploadFixturePath = join(profile, 'browser-upload-fixture.txt');
mkdirSync(downloadsDirectory, { recursive: true });
writeFileSync(uploadFixturePath, 'Browser upload fixture');
process.env.MIXDOG_DATA_DIR = dataDirectory;
app.setPath('userData', join(profile, 'user-data'));
app.setPath('downloads', downloadsDirectory);
app.disableHardwareAcceleration();
progress('module loaded; profile configured');

function refNamed(snapshot: string, name: string): string {
  const line = snapshot.split('\n').find(
    (entry) => entry.includes(JSON.stringify(name)) && /\[p\d+-s\d+-e\d+\]/.test(entry),
  );
  const ref = line?.match(/\[(p\d+-s\d+-e\d+)\]/)?.[1];
  assert.ok(ref, `snapshot did not contain ${JSON.stringify(name)}:\n${snapshot}`);
  return ref;
}

function visualGrounding(snapshot: string): {
  snapshotId: string;
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
} {
  const match = snapshot.match(
    /Visual screenshot: (p\d+-s\d+) is (\d+)x(\d+) image px; viewport (\d+)x(\d+) CSS px/,
  );
  assert.ok(match, `visual snapshot result did not contain grounding metadata:\n${snapshot}`);
  return {
    snapshotId: match[1],
    imageWidth: Number(match[2]),
    imageHeight: Number(match[3]),
    viewportWidth: Number(match[4]),
    viewportHeight: Number(match[5]),
  };
}

function networkRequestId(network: string, urlPart: string): string {
  const line = network.split('\n').find((entry) => entry.includes(urlPart));
  const requestId = line?.match(/\[(r\d+)\]/)?.[1];
  assert.ok(requestId, `network list did not contain ${JSON.stringify(urlPart)}:\n${network}`);
  return requestId;
}

function contentsWithUrl(urlPart: string): WebContents {
  const found = webContents.getAllWebContents().find((entry) => entry.getURL().includes(urlPart));
  assert.ok(found, `no Electron WebContents matched ${JSON.stringify(urlPart)}`);
  return found;
}

function imagePixel(
  data: string,
  xRatio: number,
  yRatio: number,
): [number, number, number] {
  const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  const { width, height } = image.getSize();
  const x = Math.min(width - 1, Math.max(0, Math.round((width - 1) * xRatio)));
  const y = Math.min(height - 1, Math.max(0, Math.round((height - 1) * yRatio)));
  const bitmap = image.toBitmap();
  const offset = (y * width + x) * 4;
  return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
}

const { eventually, readDiscovery } = createPolling({ timeoutMs: 5_000, intervalMs: 50 });

async function run(): Promise<void> {
  const stalledResponses = new Set<ServerResponse>();
  const socketFixture = createServer();
  socketFixture.on('upgrade', (request, socket) => {
    const key = String(request.headers['sec-websocket-key'] || '');
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('data', (frame) => {
      if (frame.length < 6) return;
      const opcode = frame[0] & 0x0f;
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      const length = frame[1] & 0x7f;
      if (length >= 126 || frame.length < 6 + length) return;
      const mask = frame.subarray(2, 6);
      const payload = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = frame[6 + index] ^ mask[index % 4];
      }
      const response = Buffer.from(`echo:${payload.toString('utf8')}`);
      socket.write(Buffer.concat([Buffer.from([0x81, response.length]), response]));
    });
  });
  let frameOrigin = '';
  const frameFixture = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><title>Cross-origin frame</title>
      <p>Cross-frame evidence</p>
      <button onclick="this.textContent = 'Frame clicked'">Frame action</button>`);
  });
  const fixture = createServer((request, response) => {
    const origin = `http://${request.headers.host}`;
    const path = new URL(request.url || '/', origin).pathname;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/root') {
      response.end(`<!doctype html><title>Root fixture</title>
        <p id="state">Waiting</p>
        <label>Password <input type="password" value="do-not-leak-password"></label>
        <button onclick="setTimeout(() => { const state = document.querySelector('#state'); const count = Number(state.dataset.spa || 0) + 1; state.dataset.spa = count; state.textContent = 'SPA done ' + count; }, 100)">Update SPA</button>
        <button onclick="document.querySelector('#state').textContent = confirm('Proceed with fixture?') ? 'Dialog accepted' : 'Dialog dismissed'">Open dialog</button>
        <a href="${origin}/popup" target="_blank">Open popup</a>
        <button onclick="setTimeout(() => { const target = document.querySelector('#self-heal'); target.replaceWith(target.cloneNode(true)); }, 700)">Arm rerender</button>
        <button id="self-heal" onclick="document.querySelector('#state').textContent = 'Self-heal clicked'">Self-heal target</button>
        <label>First name <input aria-label="First name"></label>
        <label>Last name <input aria-label="Last name"></label>
        <label>Preferred role <select aria-label="Preferred role" onchange="document.querySelector('#state').textContent = 'Role ' + this.value"><option value="designer">Designer</option><option value="engineer">Engineer</option></select></label>
        <button id="mouse-options" onmousedown="document.querySelector('#state').textContent = 'Mouse ' + event.button + ' ctrl=' + event.ctrlKey + ' shift=' + event.shiftKey">Mouse options</button>
        <label>Default checkbox <input type="checkbox" onchange="document.querySelector('#state').textContent = this.checked ? 'Checkbox checked' : 'Checkbox unchecked'"></label>
        <label>Type probe <input aria-label="Type probe" oninput="document.querySelector('#state').textContent = 'Typed ' + this.value"></label>
        <label>Upload fixture <input type="file" aria-label="Upload fixture" onchange="document.querySelector('#state').textContent = 'Uploaded ' + (this.files[0]?.name || 'none')"></label>
        <button id="proxy-upload" onclick="document.querySelector('#hidden-upload').click()">Choose attachment</button>
        <input id="hidden-upload" type="file" style="display:none" onchange="document.querySelector('#state').textContent = 'Proxy uploaded ' + (this.files[0]?.name || 'none')">
        <button id="hover-target" onmouseenter="document.querySelector('#state').textContent = 'Semantic hovered'">Hover target</button>
        <button id="drag-source" style="position:fixed;left:600px;top:200px" onmousedown="window.fixtureDragging=true">Drag source</button>
        <button id="drag-target" style="position:fixed;left:820px;top:200px" onmousemove="if (event.buttons === 1 && window.fixtureDragging) document.querySelector('#state').textContent = 'Mouse dragged'" onmouseup="window.fixtureDragging=false">Drag target</button>
        <div id="city-combo">
          <button id="city-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="city-list"
            onclick="const open = this.getAttribute('aria-expanded') === 'true'; this.setAttribute('aria-expanded', String(!open)); document.querySelector('#city-list').style.display = open ? 'none' : 'block'">Choose city</button>
          <ul id="city-list" role="listbox" style="display:none">
            <li role="option" data-value="seoul" onclick="document.querySelector('#state').textContent = 'City Seoul'">Seoul</li>
            <li role="option" data-value="busan" onclick="document.querySelector('#state').textContent = 'City Busan'">Busan</li>
          </ul>
        </div>
        <ul id="products">
          <li class="product" data-price="1200">Widget one</li>
          <li class="product" data-price="3400">Widget two</li>
          <li class="product" data-price="5600">Widget three</li>
        </ul>
        <p id="visual-state">Visual idle</p>
        <div aria-hidden="true" onmouseenter="document.querySelector('#visual-state').textContent = 'Visual hovered'"
          onclick="const state = document.querySelector('#visual-state'); const count = Number(state.dataset.count || 0) + 1; state.dataset.count = count; state.textContent = 'Visual clicked ' + count"
          style="position:fixed;left:600px;top:100px;width:120px;height:60px;background:#fc0"></div>
        <p>${'x'.repeat(2800)} Extended snapshot tail</p>
        <script>console.info('fixture-info-ready'); console.warn('fixture-warning-ready');</script>`);
      return;
    }
    if (path === '/popup') {
      response.end('<!doctype html><title>Popup fixture</title><p>Popup ready</p>');
      return;
    }
    if (path === '/secondary') {
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Secondary fixture</title>
        <style>body{min-height:1800px;background:linear-gradient(to bottom,#f44 0 33%,#4f4 33% 66%,#44f 66% 100%)}#touch-target{position:fixed;left:100px;top:100px;width:120px;height:50px;background:#4af}#touch-drag-source{position:fixed;left:100px;top:200px;width:80px;height:50px}#touch-drag-target{position:fixed;left:330px;top:200px;width:50px;height:50px}#input-probe{position:fixed;right:0;bottom:0;max-width:360px;pointer-events:none}</style>
        <p>Secondary page</p>
        <button id="touch-target" ontouchstart="this.textContent='Touched'">Touch target</button>
        <button id="touch-drag-source" ontouchmove="if (event.touches[0] && event.touches[0].clientX > 300) document.querySelector('p').textContent='Touch dragged'">Touch drag source</button>
        <button id="touch-drag-target">Touch drag target</button>
        <p id="input-probe">Input idle</p>
        <div id="scroll-box" style="position:fixed;left:300px;top:300px;width:260px;height:120px;overflow:auto;border:1px solid">
          <button>Scroll inside</button><div style="width:900px;height:900px"></div>
        </div>
        <script>
          window.inputProbe = [];
          const sourceRect = document.querySelector('#touch-drag-source').getBoundingClientRect();
          window.sourceRectLabel = 'source:'
            + [sourceRect.left, sourceRect.top, sourceRect.right, sourceRect.bottom].map(Math.round).join(',');
          document.querySelector('#input-probe').textContent = window.sourceRectLabel;
          for (const type of ['touchstart','touchmove','touchend','pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','click']) {
            document.addEventListener(type, (event) => {
              const point = event.touches?.[0] || event.changedTouches?.[0] || event;
              window.inputProbe.push(type + ':' + (event.target?.id || event.target?.tagName)
                + '@' + Math.round(point.clientX || 0) + ',' + Math.round(point.clientY || 0));
              const events = window.inputProbe.length <= 8
                ? window.inputProbe.join(' | ')
                : [...window.inputProbe.slice(0, 3), ...window.inputProbe.slice(-5)].join(' | ');
              document.querySelector('#input-probe').textContent = window.sourceRectLabel + ' | ' + events;
            }, true);
          }
        </script>`);
      return;
    }
    if (path === '/api/echo-headers') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ headers: request.headers }));
      return;
    }
    if (path === '/api/submit') {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.setHeader('x-fixture', 'network-detail');
        response.end(JSON.stringify({ ok: true, received: JSON.parse(body) }));
      });
      return;
    }
    if (path === '/download') {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.setHeader('content-disposition', 'attachment; filename="browser-fixture.txt"');
      response.end('download attachment ready');
      return;
    }
    if (path === '/initial-dialog') {
      response.end(`<!doctype html><title>Initial dialog fixture</title>
        <script>document.documentElement.dataset.answer = confirm('Initial fixture dialog') ? 'yes' : 'no';</script>
        <p>Initial dialog complete</p>`);
      return;
    }
    if (path === '/frames') {
      response.end(`<!doctype html><title>Frame host fixture</title>
        <h1>Frame host</h1><iframe src="${frameOrigin}/frame"></iframe>`);
      return;
    }
    if (path === '/recovered') {
      response.end('<!doctype html><title>Recovered fixture</title><p>Queue recovered</p>');
      return;
    }
    if (path === '/missing') {
      response.statusCode = 404;
      response.end('<!doctype html><title>Missing fixture</title><p>Nothing here</p>');
      return;
    }
    if (path === '/stall') {
      response.write('<!doctype html><title>Stalled fixture</title><p>Still loading');
      stalledResponses.add(response);
      response.once('close', () => stalledResponses.delete(response));
      return;
    }
    response.statusCode = 404;
    response.end('<!doctype html><title>Missing</title>');
  });

  let parent: BrowserWindow | null = null;
  let host: BrowserHost | null = null;
  try {
    progress('starting fixture server');
    await new Promise<void>((resolve, reject) => {
      socketFixture.once('error', reject);
      socketFixture.listen(0, '127.0.0.1', () => resolve());
    });
    const socketAddress = socketFixture.address();
    assert.ok(socketAddress && typeof socketAddress === 'object');
    const socketUrl = `ws://127.0.0.1:${socketAddress.port}/socket`;
    await new Promise<void>((resolve, reject) => {
      frameFixture.once('error', reject);
      frameFixture.listen(0, '0.0.0.0', () => resolve());
    });
    const frameAddress = frameFixture.address();
    assert.ok(frameAddress && typeof frameAddress === 'object');
    frameOrigin = `http://127.0.0.2:${frameAddress.port}`;
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', () => resolve());
    });
    const address = fixture.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;

    progress('creating browser host');
    parent = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      },
    });
    host = createBrowserHost(parent);
    const browserSurfaceRequests: DesktopBrowserOpenRequest[] = [];
    const parentWebContents = parent.webContents;
    const sendToRenderer = parentWebContents.send.bind(parentWebContents);
    parentWebContents.send = ((channel: string, ...args: unknown[]) => {
      if (channel === DESKTOP_IPC.browserOpenRequested) {
        browserSurfaceRequests.push(args[0] as DesktopBrowserOpenRequest);
      }
      sendToRenderer(channel, ...args);
    }) as typeof parentWebContents.send;
    const visibleGuestAttached = new Promise<WebContents>((resolve) => {
      parent?.webContents.once('did-attach-webview', (_event, guest) => resolve(guest));
    });
    await parent.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html>
      <style>html,body,webview{width:100%;height:100%;margin:0;display:block}</style>
      <webview src="${origin}/root" partition="persist:mixdog-browser"></webview>
    `)}`);
    const visibleGuest = await visibleGuestAttached;
    host.setGuestActive('browser-integration-session', visibleGuest.id, true);
    host.setBridgeEnabled(true);
    const discovery = await readDiscovery(join(dataDirectory, 'browser-bridge.json'));
    progress('browser bridge discovered');
    let turnId = 1;
    const commandDurations = new Map<string, number[]>();
    const commandDurationDetails = new Map<string, Array<{ label: string; duration: number }>>();
    const completedActions = new Set<string>();

    const command = async (
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<{
      text: string;
      image?: { mimeType?: string; data?: string };
      file?: { mimeType?: string; data?: string; name?: string };
    }> => {
      const action = String(input.action || 'unknown');
      const startedAt = performance.now();
      try {
        const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${discovery.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            session_id: 'browser-integration-session',
            turn_id: turnId,
            ...input,
          }),
          signal,
        });
        const payload = await response.json() as CommandResponse;
        if (!payload.ok) throw new Error(payload.error || 'browser command failed');
        completedActions.add(action);
        return {
          text: String(payload.value?.text || ''),
          ...(payload.value?.image ? { image: payload.value.image } : {}),
          ...(payload.value?.file ? { file: payload.value.file } : {}),
        };
      } finally {
        const duration = performance.now() - startedAt;
        const samples = commandDurations.get(action) || [];
        samples.push(duration);
        commandDurations.set(action, samples);
        const details = commandDurationDetails.get(action) || [];
        details.push({
          label: [
            String(input.tab || 'visible'),
            input.expect ? 'expect' : '',
            input.includeScreenshot ? 'screenshot' : '',
          ].filter(Boolean).join('+'),
          duration,
        });
        commandDurationDetails.set(action, details);
      }
    };

    const initialDialogStartedAt = Date.now();
    const initialDialog = await command({
      action: 'navigate',
      url: `${origin}/initial-dialog`,
      background: true,
      tab: 'initial-dialog',
    });
    assert.match(initialDialog.text, /dialog is blocking the page/i);
    assert.ok(Date.now() - initialDialogStartedAt < 6_000);
    await command({ action: 'handle_dialog', accept: false, tab: 'initial-dialog' });
    progress('initial navigation dialog interception complete');

    let alpha = await command({
      action: 'navigate',
      url: `${origin}/root`,
      background: true,
      tab: 'alpha',
      maxChars: 6_000,
    });
    assert.match(alpha.text, /Extended snapshot tail/);
    assert.match(alpha.text, /fresh; use these refs directly, do not call snapshot again/);
    assert.deepEqual(browserSurfaceRequests, []);
    const alphaGuest = contentsWithUrl('/root');
    alphaGuest.setZoomFactor(0.75);
    assert.ok(Math.abs(alphaGuest.getZoomFactor() - 0.75) < 0.01);
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    assert.doesNotMatch(alpha.text, /Extended snapshot tail/);
    progress('root navigation complete');
    await command({ action: 'open' });
    await command({ action: 'open' });
    assert.deepEqual(browserSurfaceRequests.splice(0), [
      { sessionId: 'browser-integration-session', reveal: true },
      { sessionId: 'browser-integration-session', reveal: true },
    ]);
    progress('existing foreground guest reveal complete');
    assert.doesNotMatch(alpha.text, /do-not-leak-password/);
    const spaRef = refNamed(alpha.text, 'Update SPA');
    alpha = await command({
      action: 'click',
      ref: spaRef,
      expect: { text: 'SPA done 1', timeoutMs: 2_000 },
      tab: 'alpha',
    });
    assert.match(alpha.text, /Postcondition met/);
    assert.match(alpha.text, /SPA done 1/);
    const secondSpaRef = refNamed(alpha.text, 'Update SPA');
    await assert.rejects(
      command({
        action: 'click',
        ref: secondSpaRef,
        expect: { text: 'condition that never appears', timeoutMs: 600 },
        tab: 'alpha',
      }),
      /Postcondition failed[\s\S]*executed once and was not retried[\s\S]*SPA done 2/,
    );
    alpha = await command({ action: 'snapshot', settleMs: 150, tab: 'alpha' });
    assert.match(alpha.text, /Explicit settle completed/);
    assert.match(alpha.text, /SPA done 2/);
    assert.doesNotMatch(alpha.text, /SPA done 3/);
    const weakExpectationRef = refNamed(alpha.text, 'Update SPA');
    const weakExpectation = await command({
      action: 'click',
      ref: weakExpectationRef,
      expect: { text: 'Update SPA', timeoutMs: 2_000 },
      includeScreenshot: true,
      tab: 'alpha',
    });
    assert.match(weakExpectation.text, /Postcondition is inconclusive because it was already satisfied/);
    assert.doesNotMatch(weakExpectation.text, /Postcondition met/);
    assert.match(weakExpectation.text, /SPA done 3/);
    assert.equal(weakExpectation.image?.mimeType, 'image/jpeg');
    progress('SPA postcondition and no-replay failure complete');
    const pageConsole = await command({ action: 'console', tab: 'alpha' });
    assert.doesNotMatch(pageConsole.text, /ACTION_SETTLE_QUIET_MS|ReferenceError/);
    turnId = 25;
    await assert.rejects(
      command({
        action: 'wait',
        text: 'condition that never appears',
        timeoutMs: 500,
        tab: 'alpha',
      }),
      /Wait timed out[\s\S]*Root fixture/,
    );

    const observed = await command({ action: 'snapshot', mode: 'both', tab: 'alpha' });
    assert.match(observed.text, /Snapshot: p\d+-s\d+/);
    assert.equal(observed.image?.mimeType, 'image/jpeg');
    assert.ok((observed.image?.data?.length || 0) > 100);
    alpha = { text: observed.text };
    progress('combined visual snapshot complete');

    turnId = 41;
    const readResult = await command({ action: 'read', query: 'SPA done 3', tab: 'alpha' });
    assert.match(readResult.text, /SPA done 3/);
    alpha = await command({ action: 'wait', text: 'SPA done 3', tab: 'alpha' });
    assert.match(alpha.text, /Condition met after \d+ms/);
    alpha = await command({
      action: 'type',
      ref: refNamed(alpha.text, 'Type probe'),
      text: 'bridge',
      tab: 'alpha',
    });
    assert.match(alpha.text, /Typed bridge/);
    alpha = await command({ action: 'press', key: 'Tab', tab: 'alpha' });
    alpha = await command({
      action: 'upload',
      ref: refNamed(alpha.text, 'Upload fixture'),
      paths: [uploadFixturePath],
      confirm: true,
      tab: 'alpha',
    });
    assert.match(alpha.text, /Uploaded browser-upload-fixture\.txt/);
    progress('read, wait, type, press, and upload dispatch complete');

    // A styled button over a hidden input: the click opens a native picker
    // that Chromium hands to the host instead of showing, and upload answers it.
    turnId = 42;
    alpha = await command({
      action: 'upload',
      ref: refNamed(alpha.text, 'Choose attachment'),
      paths: [uploadFixturePath],
      confirm: true,
      tab: 'alpha',
    });
    assert.match(alpha.text, /Proxy uploaded browser-upload-fixture\.txt/);
    assert.doesNotMatch(alpha.text, /Pending file chooser/);
    progress('proxy-button upload through the intercepted file chooser complete');

    const blockedSpaRef = refNamed(alpha.text, 'Update SPA');
    const dialogRef = refNamed(alpha.text, 'Open dialog');
    const dialogStartedAt = Date.now();
    const blocked = await command({ action: 'click', ref: dialogRef, tab: 'alpha' });
    assert.ok(Date.now() - dialogStartedAt < 2_000, 'dialog interception should not wait for native CDP timeout');
    if (!/dialog is blocking the page/i.test(blocked.text)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const status = await command({ action: 'status', tab: 'alpha' });
      assert.match(`${blocked.text}\n\nStatus:\n${status.text}`, /dialog is blocking the page/i);
    }
    // A gesture sent while the dialog is up must be refused, not queued behind
    // it: otherwise it would fire as a ghost click once the dialog closes.
    const ghostStartedAt = Date.now();
    const ghost = await command({ action: 'click', ref: blockedSpaRef, tab: 'alpha' });
    assert.match(ghost.text, /dialog is blocking the page/i);
    assert.ok(Date.now() - ghostStartedAt < 1_000, 'a blocked gesture returns without dispatching');
    alpha = await command({ action: 'handle_dialog', accept: false, tab: 'alpha' });
    assert.match(alpha.text, /Dialog dismissed/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterDialog = await command({ action: 'read', tab: 'alpha' });
    assert.match(afterDialog.text, /Dialog dismissed/);
    assert.doesNotMatch(afterDialog.text, /SPA done 4/);
    progress('dialog handling and blocked-gesture refusal complete');

    turnId = 2;
    const armRef = refNamed(alpha.text, 'Arm rerender');
    const armed = await command({ action: 'click', ref: armRef, tab: 'alpha' });
    const healingRef = refNamed(armed.text, 'Self-heal target');
    await new Promise((resolve) => setTimeout(resolve, 900));
    alpha = await command({ action: 'click', ref: healingRef, tab: 'alpha' });
    assert.match(alpha.text, /Automatic ref recovery before input dispatch \(no action replay\)/);
    assert.match(alpha.text, /Self-heal clicked/);
    progress('stale ref self-healing complete');

    turnId = 20;
    const firstNameRef = refNamed(alpha.text, 'First name');
    const lastNameRef = refNamed(alpha.text, 'Last name');
    const preferredRoleRef = refNamed(alpha.text, 'Preferred role');
    const checkboxRef = refNamed(alpha.text, 'Default checkbox');
    alpha = await command({
      action: 'fill',
      fields: [
        { ref: firstNameRef, text: 'Ada' },
        { ref: lastNameRef, value: 'Lovelace' },
        { ref: preferredRoleRef, values: ['engineer'] },
        { ref: checkboxRef, checked: true },
      ],
      tab: 'alpha',
    });
    assert.match(alpha.text, /value="Ada"/);
    assert.match(alpha.text, /value="Lovelace"/);
    assert.match(alpha.text, /value="Engineer"/);
    assert.match(alpha.text, /checkbox "Default checkbox" checked=true/);

    // One call, several gestures on the same page: every step must land, the
    // whole chain must cost ONE snapshot and ONE budget unit, and a step that
    // fails must report exactly how far the chain got.
    // Every block owns its own turn: 20-25 and 30-32 are already spoken for,
    // and each of them fills its per-turn budget on its own.
    turnId = 26;
    // Every step addresses the SAME snapshot: steps take none of their own, so
    // one generation drives the whole chain.
    const sequenceFirstNameRef = refNamed(alpha.text, 'First name');
    const sequenceLastNameRef = refNamed(alpha.text, 'Last name');
    const sequenceRoleRef = refNamed(alpha.text, 'Preferred role');
    const sequenced = await command({
      action: 'sequence',
      steps: [
        { action: 'fill', ref: sequenceFirstNameRef, text: 'Grace' },
        { action: 'fill', ref: sequenceLastNameRef, text: 'Hopper' },
        { action: 'select', ref: sequenceRoleRef, values: ['designer'] },
      ],
      expect: { text: 'Role designer', timeoutMs: 2_000 },
      tab: 'alpha',
    });
    assert.match(sequenced.text, /Sequence completed 3 steps \(1:fill, 2:fill, 3:select\)/);
    assert.match(sequenced.text, /value="Grace"/);
    assert.match(sequenced.text, /value="Hopper"/);
    assert.match(sequenced.text, /value="Designer"/);
    assert.match(sequenced.text, /Postcondition met/);
    await assert.rejects(
      command({
        action: 'sequence',
        steps: [
          { action: 'fill', ref: refNamed(sequenced.text, 'First name'), text: 'Ada' },
          { action: 'click', ref: 'p1-s1-e9999' },
        ],
        tab: 'alpha',
      }),
      /Sequence stopped at step 2 \(click\)[\s\S]*completed 1:fill/,
    );
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    assert.match(alpha.text, /value="Ada"/);
    await assert.rejects(
      command({
        action: 'sequence',
        steps: [{ action: 'navigate', url: `${origin}/secondary` }, { action: 'press', key: 'Enter' }],
        tab: 'alpha',
      }),
      /is not chainable/,
    );
    progress('sequence chaining complete');

    // Custom (non-native) dropdown: the page owns the popup, so select has to
    // open the trigger and activate the matching option instead of assigning.
    turnId = 28;
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    const cityRef = refNamed(alpha.text, 'Choose city');
    const citySelected = await command({
      action: 'select',
      ref: cityRef,
      values: ['Busan'],
      expect: { text: 'City Busan', timeoutMs: 2_000 },
      tab: 'alpha',
    });
    assert.match(citySelected.text, /City Busan/);
    assert.match(citySelected.text, /Postcondition met/);
    // An open list with no match is a real failure, and it reports what IS on
    // offer instead of silently waiting.
    await assert.rejects(
      command({
        action: 'select',
        ref: refNamed(citySelected.text, 'Choose city'),
        values: ['Atlantis'],
        tab: 'alpha',
      }),
      /no open option matched[\s\S]*Seoul/,
    );

    const products = await command({
      action: 'extract',
      selector: 'li.product',
      attributes: ['data-price'],
      tab: 'alpha',
    });
    assert.match(products.text, /Extracted 3 match\(es\)/);
    assert.match(products.text, /1\. Widget one \{data-price="1200"\}/);
    assert.match(products.text, /3\. Widget three \{data-price="5600"\}/);
    const limitedProducts = await command({
      action: 'extract',
      selector: 'li.product',
      limit: 1,
      tab: 'alpha',
    });
    assert.match(limitedProducts.text, /showing 1 of 3 matches/);
    await assert.rejects(
      command({ action: 'extract', selector: 'li..broken', tab: 'alpha' }),
      /not a valid CSS selector/,
    );
    progress('custom dropdown and extraction complete');

    // Reading a control instead of changing it, and reaching a phrase whose
    // position nobody knows. A phrase that is absent must not scroll blindly.
    turnId = 34;
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    const roleOptions = await command({
      action: 'select',
      ref: refNamed(alpha.text, 'Preferred role'),
      tab: 'alpha',
    });
    assert.match(roleOptions.text, /Options for [\w-]+ \(2\)/);
    assert.match(roleOptions.text, /- Designer/);
    assert.match(roleOptions.text, /- Engineer/);
    const scrolledToText = await command({
      action: 'scroll',
      text: 'Extended snapshot tail',
      tab: 'alpha',
    });
    assert.match(scrolledToText.text, /Snapshot: /);
    await assert.rejects(
      command({ action: 'scroll', text: 'no such phrase on this fixture', tab: 'alpha' }),
      /was not found on this page/,
    );
    progress('option read and text scroll complete');

    // Pixels can answer beside the run instead of inside the conversation, and
    // a printed page always does.
    turnId = 35;
    const filedShot = await command({
      action: 'snapshot',
      mode: 'visual',
      image_output: 'file',
      tab: 'alpha',
    });
    assert.equal(filedShot.image, undefined, filedShot.text);
    const framePath = filedShot.text.match(/Frame written to (.+?) \((\d+) bytes\)/);
    assert.ok(framePath, filedShot.text);
    assert.equal(statSync(framePath[1]).size, Number(framePath[2]));
    const printed = await command({
      action: 'snapshot',
      mode: 'visual',
      format: 'pdf',
      tab: 'alpha',
    });
    assert.equal(printed.image, undefined, printed.text);
    const pdfPath = printed.text.match(/to (.+?\.pdf) \((\d+) bytes\)/);
    assert.ok(pdfPath, printed.text);
    assert.equal(statSync(pdfPath[1]).size, Number(pdfPath[2]));
    progress('frame file output and pdf print complete');

    // Read-only commands overlap: serialized, two 400ms waits could not both
    // finish inside one 400ms window plus overhead.
    turnId = 33;
    const overlapStartedAt = Date.now();
    const overlapped = await Promise.allSettled([
      command({ action: 'wait', text: 'never-appears-a', timeoutMs: 400, tab: 'alpha' }),
      command({ action: 'wait', text: 'never-appears-b', timeoutMs: 400, tab: 'alpha' }),
    ]);
    const overlapElapsed = Date.now() - overlapStartedAt;
    assert.equal(overlapped.every((entry) => entry.status === 'rejected'), true);
    assert.ok(overlapElapsed < 800, `read-only commands did not overlap: ${overlapElapsed}ms`);
    progress('read concurrency complete');

    // A fresh turn: the interaction block below already fills the per-turn
    // budget on its own, and the sequence checks above must not eat into it.
    turnId = 27;
    // The blocks above advanced the ref generation several times.
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    const mouseOptionsRef = refNamed(alpha.text, 'Mouse options');
    alpha = await command({
      action: 'click',
      ref: mouseOptionsRef,
      button: 'right',
      modifiers: ['Control', 'Shift'],
      tab: 'alpha',
    });
    assert.match(alpha.text, /Mouse 2 ctrl=true shift=true/);
    const uncheckedRef = refNamed(alpha.text, 'Default checkbox');
    alpha = await command({
      action: 'check',
      ref: uncheckedRef,
      checked: false,
      tab: 'alpha',
    });
    assert.match(alpha.text, /Checkbox unchecked/);
    assert.match(alpha.text, /checkbox "Default checkbox" checked=false/);
    const hoverRef = refNamed(alpha.text, 'Hover target');
    alpha = await command({ action: 'hover', ref: hoverRef, tab: 'alpha' });
    assert.match(alpha.text, /Semantic hovered/);
    const dragSourceRef = refNamed(alpha.text, 'Drag source');
    const dragTargetRef = refNamed(alpha.text, 'Drag target');
    alpha = await command({
      action: 'drag',
      ref: dragSourceRef,
      targetRef: dragTargetRef,
      tab: 'alpha',
    });
    assert.match(alpha.text, /Mouse dragged/);
    const infoConsole = await command({
      action: 'console',
      level: 'info',
      query: 'fixture-info',
      tab: 'alpha',
    });
    assert.match(infoConsole.text, /\[info\].*fixture-info-ready/);
    const visualOnly = await command({
      action: 'snapshot',
      mode: 'visual',
      format: 'png',
      tab: 'alpha',
    });
    assert.equal(visualOnly.image?.mimeType, 'image/png');
    assert.doesNotMatch(visualOnly.text, /Snapshot: p\d+-s\d+/);
    progress('compressed interaction fields and visual-only snapshot complete');

    turnId = 21;
    const visual = await command({ action: 'snapshot', mode: 'both', tab: 'alpha' });
    let grounding = visualGrounding(visual.text);
    const visualHovered = await command({
      action: 'hover',
      snapshotId: grounding.snapshotId,
      x: 660 * grounding.imageWidth / grounding.viewportWidth,
      y: 130 * grounding.imageHeight / grounding.viewportHeight,
      tab: 'alpha',
    });
    assert.match(visualHovered.text, /Visual hovered/);
    const clickGrounding = await command({ action: 'snapshot', mode: 'both', tab: 'alpha' });
    grounding = visualGrounding(clickGrounding.text);
    const visualClicked = await command({
      action: 'click',
      snapshotId: grounding.snapshotId,
      x: 660 * grounding.imageWidth / grounding.viewportWidth,
      y: 130 * grounding.imageHeight / grounding.viewportHeight,
      tab: 'alpha',
    });
    assert.match(visualClicked.text, /Visual clicked 1/);
    await assert.rejects(
      command({
        action: 'click',
        snapshotId: grounding.snapshotId,
        x: 660 * grounding.imageWidth / grounding.viewportWidth,
        y: 130 * grounding.imageHeight / grounding.viewportHeight,
        tab: 'alpha',
      }),
      /latest snapshot\(mode=both\) or locate result/,
    );
    alpha = await command({ action: 'snapshot', tab: 'alpha' });
    assert.match(alpha.text, /Visual clicked 1/);
    const dragVisual = await command({ action: 'snapshot', mode: 'both', tab: 'alpha' });
    grounding = visualGrounding(dragVisual.text);
    const coordinateDragged = await command({
      action: 'drag',
      snapshotId: grounding.snapshotId,
      x: 640 * grounding.imageWidth / grounding.viewportWidth,
      y: 225 * grounding.imageHeight / grounding.viewportHeight,
      targetX: 850 * grounding.imageWidth / grounding.viewportWidth,
      targetY: 225 * grounding.imageHeight / grounding.viewportHeight,
      tab: 'alpha',
    });
    assert.match(coordinateDragged.text, /Mouse dragged/);
    turnId = 22;
    const located = await command({ action: 'locate', query: 'yellow', tab: 'alpha' });
    assert.equal(located.image?.mimeType, 'image/jpeg');
    assert.match(located.text, /Visual candidates[\s\S]*yellow[\s\S]*center=\(\d+,\d+\) image px/);
    alpha = { text: located.text };
    progress('visual grounding and stale-coordinate replay guard complete');

    const popupRef = refNamed(alpha.text, 'Open popup');
    await command({ action: 'click', ref: popupRef, tab: 'alpha' });
    const tabs = await eventually(
      () => command({ action: 'list_tabs' }),
      (result) => result.text.includes('popup-1') && result.text.includes('Popup fixture'),
    );
    assert.match(tabs.text, /p\d+ \["popup-1"\] \(popup from p\d+\)/);
    progress('popup tracking complete');

    turnId = 38;
    await command({
      action: 'open',
      background: true,
      tab: 'history',
    });
    const wentBack = await command({ action: 'back', tab: 'history' });
    assert.match(wentBack.text, /Cannot go back: no earlier history entry/);
    const wentForward = await command({ action: 'forward', tab: 'history' });
    assert.match(wentForward.text, /Cannot go forward: no later history entry/);
    const closedHistory = await command({ action: 'close_tab', tab: 'history' });
    assert.match(closedHistory.text, /Closed background tab "history"/);
    progress('history navigation and tab closure complete');

    turnId = 3;
    await command({
      action: 'navigate',
      url: `${origin}/secondary`,
      background: true,
      tab: 'beta',
    });
    const betaGuest = contentsWithUrl('/secondary');
    betaGuest.setZoomFactor(0.75);
    assert.ok(Math.abs(betaGuest.getZoomFactor() - 0.75) < 0.01);
    assert.match((await command({ action: 'snapshot', tab: 'alpha' })).text, /Root fixture/);
    const betaSnapshot = await command({ action: 'snapshot', tab: 'beta' });
    assert.match(betaSnapshot.text, /Secondary fixture/);
    const betaStatus = await command({ action: 'status', tab: 'beta' });
    assert.match(betaStatus.text, /Pending requests: 0/);
    const betaDocuments = await command({
      action: 'network',
      query: '/secondary',
      resourceTypes: ['document'],
      tab: 'beta',
    });
    const betaDocumentId = networkRequestId(betaDocuments.text, '/secondary');
    const betaDocument = await command({
      action: 'network',
      requestId: betaDocumentId,
      maxChars: 2_000,
      tab: 'beta',
    });
    assert.doesNotMatch(betaDocument.text, /still pending/);
    assert.match(betaDocument.text, /Status: 200 OK/);
    turnId = 23;
    const scrollInsideRef = refNamed(betaSnapshot.text, 'Scroll inside');
    await command({
      action: 'scroll',
      ref: scrollInsideRef,
      dy: 180,
      tab: 'beta',
    });
    const nestedScroll = await command({
      action: 'evaluate',
      script: `(() => {
        const box = document.querySelector('#scroll-box');
        return { scrollLeft: box.scrollLeft, scrollTop: box.scrollTop };
      })()`,
      tab: 'beta',
    });
    assert.match(nestedScroll.text, /"scrollLeft": 0/);
    assert.match(nestedScroll.text, /"scrollTop": [1-9]\d*/);
    const resetNestedScroll = await command({
      action: 'evaluate',
      script: `(() => {
        const box = document.querySelector('#scroll-box');
        box.scrollTo(0, 0);
        return { scrollLeft: box.scrollLeft, scrollTop: box.scrollTop };
      })()`,
      tab: 'beta',
    });
    const horizontalScrollRef = refNamed(resetNestedScroll.text, 'Scroll inside');
    await command({
      action: 'scroll',
      ref: horizontalScrollRef,
      dx: 120,
      tab: 'beta',
    });
    const horizontalScroll = await command({
      action: 'evaluate',
      script: `(() => {
        const box = document.querySelector('#scroll-box');
        return { scrollLeft: box.scrollLeft, scrollTop: box.scrollTop };
      })()`,
      tab: 'beta',
    });
    assert.match(horizontalScroll.text, /"scrollLeft": [1-9]\d*/);
    assert.match(horizontalScroll.text, /"scrollTop": 0/);
    const evaluated = await command({
      action: 'evaluate',
      script: `new Promise((resolve) => setTimeout(() => {
        document.querySelector('p').textContent = 'Secondary evaluated';
        resolve({ title: document.title, status: 'async complete' });
      }, 50))`,
      tab: 'beta',
    });
    assert.match(evaluated.text, /"status": "async complete"/);
    assert.match(evaluated.text, /Secondary evaluated/);
    const reloaded = await command({ action: 'navigate', reload: true, tab: 'beta' });
    assert.match(reloaded.text, /Secondary page/);
    assert.doesNotMatch(reloaded.text, /Secondary evaluated/);
    const fullPage = await command({
      action: 'snapshot',
      mode: 'visual',
      fullPage: true,
      format: 'jpeg',
      quality: 60,
      tab: 'beta',
    });
    assert.equal(fullPage.image?.mimeType, 'image/jpeg');
    assert.match(fullPage.text, /Full-page screenshot/);
    assert.ok((fullPage.image?.data?.length || 0) > 1_000);
    const fullPageImage = nativeImage.createFromBuffer(Buffer.from(fullPage.image?.data || '', 'base64'));
    const fullPageSize = fullPageImage.getSize();
    assert.ok(fullPageSize.height > 1_000, `full-page capture was too short: ${fullPageSize.height}px`);
    const topPixel = imagePixel(fullPage.image?.data || '', 0.9, 0.1);
    const bottomPixel = imagePixel(fullPage.image?.data || '', 0.9, 0.9);
    const colorDistance = topPixel.reduce(
      (total, channel, index) => total + Math.abs(channel - bottomPixel[index]),
      0,
    );
    assert.ok(colorDistance > 150, `full-page capture repeated vertically: ${topPixel} vs ${bottomPixel}`);
    turnId = 24;
    await command({
      action: 'evaluate',
      script: `fetch(${JSON.stringify(`${origin}/api/submit`)}, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer do-not-leak' },
        body: JSON.stringify({ message: 'hello network' }),
      }).then((response) => response.json())`,
      tab: 'beta',
    });
    const network = await command({
      action: 'network',
      query: '/api/submit',
      resourceTypes: ['fetch'],
      tab: 'beta',
    });
    assert.match(network.text, /POST fetch 200/);
    const requestId = networkRequestId(network.text, '/api/submit');
    const request = await command({ action: 'network', requestId, tab: 'beta' });
    assert.match(request.text, /Request body:[\s\S]*hello network/);
    assert.match(request.text, /Response body:[\s\S]*"ok":true/);
    assert.match(request.text, /x-fixture: network-detail/i);
    assert.doesNotMatch(request.text, /do-not-leak/);
    progress('background isolation complete');

    turnId = 30;
    await command({
      action: 'cookies',
      operation: 'set',
      name: 'mixdog-fixture',
      value: 'cookie-ready',
      httpOnly: true,
      tab: 'beta',
    });
    const cookies = await command({
      action: 'cookies',
      operation: 'list',
      name: 'mixdog-fixture',
      tab: 'beta',
    });
    assert.match(cookies.text, /cookie-ready/);
    assert.match(cookies.text, /"httpOnly": true/);
    await command({
      action: 'storage',
      operation: 'set',
      storageType: 'local',
      name: 'mixdog-fixture',
      value: 'storage-ready',
      tab: 'beta',
    });
    const storage = await command({
      action: 'storage',
      operation: 'get',
      storageType: 'local',
      name: 'mixdog-fixture',
      tab: 'beta',
    });
    assert.match(storage.text, /storage-ready/);
    await assert.rejects(
      command({ action: 'cookies', operation: 'clear', tab: 'beta' }),
      /shared clear requires confirm=true/,
    );
    await assert.rejects(
      command({
        action: 'storage',
        operation: 'clear',
        storageType: 'local',
        tab: 'beta',
      }),
      /shared clear requires confirm=true/,
    );
    await command({ action: 'cookies', operation: 'clear', confirm: true, tab: 'beta' });
    await command({
      action: 'storage',
      operation: 'clear',
      storageType: 'local',
      confirm: true,
      tab: 'beta',
    });
    progress('cookie and storage management complete');

    turnId = 36;
    await command({
      action: 'intercept',
      operation: 'add',
      url: '*/recovered*',
      body: 'fixture-mocked',
      tab: 'beta',
    });
    const replacedResponse = await command({
      action: 'evaluate',
      script: `fetch('/recovered').then(async (response) => ({
        status: response.status,
        body: await response.text(),
      }))`,
      tab: 'beta',
    });
    // The payload is the rule's while the status line stays the server's, which
    // is exactly what a replaced body promises and all Chromium honours here.
    assert.match(replacedResponse.text, /fixture-mocked/);
    assert.match(replacedResponse.text, /"status": 200/);
    const interceptList = await command({ action: 'intercept', tab: 'beta' });
    assert.match(interceptList.text, /\[i\d+\] replace body [\s\S]*— 1 hit/);
    await command({
      action: 'intercept',
      operation: 'add',
      url: '*/api/submit*',
      abort: true,
      tab: 'beta',
    });
    const abortedRequest = await command({
      action: 'evaluate',
      script: `fetch('/api/submit', { method: 'POST', body: '{}' })
        .then(() => 'reached the server')
        .catch((error) => 'refused:' + error.name)`,
      tab: 'beta',
    });
    assert.match(abortedRequest.text, /refused:TypeError/);
    await command({ action: 'intercept', operation: 'clear', tab: 'beta' });
    // Clearing has to restore the real network, not leave the page answering
    // from a rule table nobody can see anymore.
    const liveAgain = await command({
      action: 'evaluate',
      script: "fetch('/recovered').then((response) => response.text())",
      tab: 'beta',
    });
    assert.match(liveAgain.text, /Queue recovered/);
    progress('request interception complete');

    turnId = 37;
    await command({
      action: 'emulate',
      headers: { 'x-mixdog-fixture': 'header-ready' },
      latitude: 37.5665,
      longitude: 126.978,
      accuracy: 25,
      tab: 'beta',
    });
    const echoedHeaders = await command({
      action: 'evaluate',
      script: `fetch(${JSON.stringify(`${origin}/api/echo-headers`)})
        .then((response) => response.json())
        .then((payload) => payload.headers['x-mixdog-fixture'] || 'missing')`,
      tab: 'beta',
    });
    assert.match(echoedHeaders.text, /header-ready/);
    const registered = await command({
      action: 'init_script',
      operation: 'add',
      script: 'window.__mixdogSeed = "seeded-before-boot";',
      tab: 'beta',
    });
    assert.match(registered.text, /Registered init script is\d+/);
    const registeredId = registered.text.match(/init script (is\d+)/)?.[1] || '';
    await command({ action: 'navigate', url: `${origin}/secondary`, tab: 'beta' });
    const seedPresent = await command({
      action: 'evaluate',
      script: 'window.__mixdogSeed || "absent"',
      tab: 'beta',
    });
    assert.match(seedPresent.text, /seeded-before-boot/);
    await command({
      action: 'init_script',
      operation: 'remove',
      scriptId: registeredId,
      tab: 'beta',
    });
    await command({ action: 'navigate', url: `${origin}/secondary`, tab: 'beta' });
    const seedGone = await command({
      action: 'evaluate',
      script: 'window.__mixdogSeed || "absent"',
      tab: 'beta',
    });
    assert.match(seedGone.text, /absent/);
    progress('extra headers, geolocation, and init scripts complete');

    turnId = 31;
    await command({
      action: 'emulate',
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      touch: true,
      userAgent: 'MixdogMobileFixture/1.0',
      locale: 'en-US',
      timezone: 'UTC',
      colorScheme: 'dark',
      tab: 'beta',
    });
    const emulated = await command({
      action: 'evaluate',
      script: `({
        width: innerWidth,
        touchPoints: navigator.maxTouchPoints,
        userAgent: navigator.userAgent,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
      })`,
      tab: 'beta',
    });
    assert.match(emulated.text, /"width": 390/);
    assert.match(emulated.text, /"touchPoints": 5/);
    assert.match(emulated.text, /MixdogMobileFixture/);
    assert.match(emulated.text, /"timezone": "UTC"/);
    assert.match(emulated.text, /"dark": true/);
    const touchObserved = await command({ action: 'snapshot', mode: 'both', tab: 'beta' });
    const touchGrounding = visualGrounding(touchObserved.text);
    const touched = await command({
      action: 'click',
      pointer: 'touch',
      snapshotId: touchGrounding.snapshotId,
      x: 160 * touchGrounding.imageWidth / touchGrounding.viewportWidth,
      y: 125 * touchGrounding.imageHeight / touchGrounding.viewportHeight,
      tab: 'beta',
    });
    assert.match(touched.text, /Touched/);
    await command({
      action: 'evaluate',
      script: `(() => {
        window.inputProbe = [];
        const rect = document.querySelector('#touch-drag-source').getBoundingClientRect();
        window.sourceRectLabel = 'source:' + [
          rect.left, rect.top, rect.right, rect.bottom,
        ].map(Math.round).join(',');
        document.querySelector('#input-probe').textContent = window.sourceRectLabel;
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      })()`,
      tab: 'beta',
    });
    const touchDragObserved = await command({ action: 'snapshot', mode: 'both', tab: 'beta' });
    const touchDragGrounding = visualGrounding(touchDragObserved.text);
    const touchDragged = await command({
      action: 'drag',
      pointer: 'touch',
      snapshotId: touchDragGrounding.snapshotId,
      x: 140 * touchDragGrounding.imageWidth / touchDragGrounding.viewportWidth,
      y: 225 * touchDragGrounding.imageHeight / touchDragGrounding.viewportHeight,
      targetX: 350 * touchDragGrounding.imageWidth / touchDragGrounding.viewportWidth,
      targetY: 225 * touchDragGrounding.imageHeight / touchDragGrounding.viewportHeight,
      tab: 'beta',
    });
    assert.match(touchDragged.text, /Touch dragged/);
    progress('mobile emulation and touch complete');

    turnId = 32;
    await command({ action: 'performance', operation: 'start', tab: 'beta' });
    await command({
      action: 'evaluate',
      script: `(() => {
        const started = performance.now();
        while (performance.now() - started < 25) Math.sqrt(Math.random());
        return 'trace work complete';
      })()`,
      tab: 'beta',
    });
    const trace = await command({ action: 'performance', operation: 'stop', tab: 'beta' });
    assert.match(trace.text, /Performance trace stopped/);
    assert.match(trace.text, /Events: [1-9]\d*/);
    const metrics = await command({ action: 'performance', operation: 'metrics', tab: 'beta' });
    assert.match(metrics.text, /JSHeapUsedSize|TaskDuration/);

    await command({
      action: 'evaluate',
      script: `new Promise((resolve, reject) => {
        const socket = new WebSocket(${JSON.stringify(socketUrl)});
        socket.onopen = () => socket.send('hello-server');
        socket.onerror = () => reject(new Error('socket failed'));
        socket.onmessage = (event) => { const value = event.data; socket.close(); resolve(value); };
      })`,
      tab: 'beta',
    });
    const sockets = await command({
      action: 'network',
      query: '/socket',
      resourceTypes: ['websocket'],
      tab: 'beta',
    });
    const socketRequestId = networkRequestId(sockets.text, '/socket');
    const socketDetail = await command({
      action: 'network',
      requestId: socketRequestId,
      frameLimit: 10,
      tab: 'beta',
    });
    assert.match(socketDetail.text, /WebSocket frames/);
    assert.match(socketDetail.text, /hello-server/);
    assert.match(socketDetail.text, /echo:hello-server/);
    progress('performance trace and WebSocket frames complete');

    turnId = 4;
    const frameSnapshot = await command({
      action: 'navigate',
      url: `${origin}/frames`,
      background: true,
      tab: 'frames',
    });
    assert.match(frameSnapshot.text, /Cross-frame evidence/);
    assert.doesNotMatch(frameSnapshot.text, /rootwebarea/);
    const frameRef = refNamed(frameSnapshot.text, 'Frame action');
    const frameEvaluated = await command({
      action: 'evaluate',
      ref: frameRef,
      script: '({ text: element.textContent, origin: location.origin })',
      tab: 'frames',
    });
    assert.match(frameEvaluated.text, /"text": "Frame action"/);
    assert.match(frameEvaluated.text, new RegExp(frameOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const evaluatedFrameRef = refNamed(frameEvaluated.text, 'Frame action');
    const frameClicked = await command({ action: 'click', ref: evaluatedFrameRef, tab: 'frames' });
    assert.match(frameClicked.text, /Frame clicked/);
    progress('cross-origin frame accessibility complete');

    turnId = 40;
    const downloadNavigation = await command({
      action: 'navigate',
      url: `${origin}/download`,
      background: true,
      tab: 'download',
    });
    const download = await command({
      action: 'downloads',
      wait: true,
      attach: true,
      timeoutMs: 5_000,
    });
    assert.equal(download.file?.name, 'browser-fixture.txt');
    assert.equal(download.file?.mimeType, 'text/plain');
    assert.equal(
      Buffer.from(download.file?.data || '', 'base64').toString('utf8'),
      'download attachment ready',
    );
    // The page report mentions the download once, on whichever snapshot
    // first follows its start or completion.
    const downloadSnapshot = await command({ action: 'snapshot', tab: 'download' });
    assert.match(
      `${downloadNavigation.text}\n${downloadSnapshot.text}`,
      /Downloads since last report:\n- \[d\d+\] browser-fixture\.txt/,
    );
    progress('download inline attachment and snapshot report complete');

    const missing = await command({
      action: 'navigate',
      url: `${origin}/missing`,
      background: true,
      tab: 'missing',
    });
    assert.match(missing.text, /^Status: HTTP 404 Not Found/m);
    assert.match(missing.text, /Nothing here/);
    progress('document error status report complete');

    turnId = 5;
    const abort = new AbortController();
    const stalled = command({
      action: 'navigate',
      url: `${origin}/stall`,
      tab: 'alpha',
    }, abort.signal);
    setTimeout(() => abort.abort(), 250);
    await assert.rejects(stalled, /abort/i);
    const recovered = await Promise.race([
      command({ action: 'navigate', url: `${origin}/recovered`, tab: 'alpha' }),
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error('queue recovery timed out')),
        5_000,
      )),
    ]);
    assert.match(recovered.text, /Queue recovered/);
    progress('queue recovery complete');

    turnId = 98;
    for (const removed of [
      'observe', 'screenshot', 'click_at', 'tap', 'hover_at', 'drag_at', 'swipe', 'fill_form',
    ]) {
      await assert.rejects(
        command({ action: removed, tab: 'alpha' }),
        new RegExp(`unknown browser action "${removed}"`),
      );
    }

    const surfaceRequestCountBeforeRemoteFrame = browserSurfaceRequests.length;
    const remoteFrame = await host.remoteBrowserFrame('browser-integration-session');
    assert.equal(browserSurfaceRequests.length, surfaceRequestCountBeforeRemoteFrame);
    assert.match(remoteFrame.frameId, /^rbf_[a-z0-9]+$/);
    assert.ok(remoteFrame.image?.data);
    await assert.rejects(
      host.remoteBrowserControl('browser-integration-session', {
        type: 'tap',
        frameId: 'rbf_stale',
        x: 10,
        y: 10,
      }),
      /frame is stale/,
    );
    progress('remote Browser Use frame binding complete');

    turnId = 99;
    for (let index = 0; index < 10; index += 1) {
      await command({ action: 'open', tab: 'beta' });
    }
    await assert.rejects(
      command({ action: 'open', tab: 'beta' }),
      /per-turn action limit \(10\)/,
    );
    progress('per-turn action budget complete');

    host.releaseSession('browser-integration-session');
    const releasedTabs = await command({ action: 'list_tabs' });
    assert.doesNotMatch(releasedTabs.text, /\["(?:alpha|beta|popup-\d+)"\]/);
    progress('session resource release complete');

    for (const action of ['navigate', 'snapshot', 'click']) {
      const samples = commandDurations.get(action) || [];
      progress(
        `latency ${action}: n=${samples.length} p50=${percentile(samples, 0.5).toFixed(1)}ms `
        + `p95=${percentile(samples, 0.95).toFixed(1)}ms`,
      );
      if (action === 'click' || action === 'navigate') {
        progress(
          `latency samples ${action}: ${(commandDurationDetails.get(action) || [])
            .map((sample) => `${sample.label}=${sample.duration.toFixed(1)}ms`)
            .join(', ')}`,
        );
      }
    }
    assert.deepEqual(
      BROWSER_ACTIONS.filter((action) => !completedActions.has(action)),
      [],
      'every public Browser Use action must complete through the live bridge',
    );
    progress('integration passed');
    console.log('Browser host integration passed: device emulation and touch, geolocation and extra headers, cookies/storage, visual locate, AX/OOPIF refs and script execution, request/response/WebSocket inspection, request interception, init scripts, performance tracing, download attachment and reporting, document error status, recovery, dialogs and blocked-gesture refusal, intercepted file chooser upload, popup tracking, isolation, queue recovery, and action budget.');
  } finally {
    for (const response of stalledResponses) response.destroy();
    await host?.dispose();
    if (parent && !parent.isDestroyed()) parent.destroy();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await new Promise<void>((resolve) => frameFixture.close(() => resolve()));
    await new Promise<void>((resolve) => socketFixture.close(() => resolve()));
  }
}

progress('waiting for Electron ready');
void app.whenReady().then(async () => {
  progress('Electron ready');
  await run();
  await rm(profile, { recursive: true, force: true });
  app.exit(0);
}).catch(async (error) => {
  console.error(error);
  await rm(profile, { recursive: true, force: true });
  process.exitCode = 1;
  app.exit(1);
});
