import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { app, BrowserWindow, webContents, type WebContents } from 'electron';
import { createBrowserHost, type BrowserHost } from './host';
import { createPolling } from '../host-harness-poll';
import { exerciseBrowserInputSurface, readyBrowserFrame } from './input-surface.integration';

const directory = process.env.MIXDOG_INPUT_ISOLATION_DIRECTORY!;
const logPath = process.env.MIXDOG_INPUT_ISOLATION_LOG!;
process.env.MIXDOG_DATA_DIR = join(directory, 'data');
app.setPath('userData', join(directory, 'profile'));
app.disableHardwareAcceleration();
const log = (text: string) => appendFileSync(logPath, `${text}\n`);
const { readDiscovery } = createPolling({ timeoutMs: 5_000, intervalMs: 25 });
const deadline = setTimeout(() => { log('input isolation timed out'); app.exit(1); }, 110_000);

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
      response.end(`<!doctype html><label>Frame input <input id="frame"></label>
        <script>window.keys=[]; document.addEventListener('keydown', e=>keys.push(e.key));</script>`);
      return;
    }
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    response.end(`<!doctype html><title>Input isolation</title>
      <label>Agent input <input id="agent" autofocus></label>
      <button onclick="document.getElementById('agent').focus()">Focus field</button>
      <iframe src="http://127.0.0.2:${address.port}/frame"></iframe>
      <script>window.keys = []; document.addEventListener('keydown', e => keys.push(e.key));</script>`);
  });
  let parent: BrowserWindow | undefined;
  let host: BrowserHost | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    parent = new BrowserWindow({
      show: false, width: 1000, height: 720,
      webPreferences: {
        webviewTag: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
        preload: join(directory, 'fixture-preload.cjs'),
      },
    });
    host = createBrowserHost(parent, {
      requestApproval: async () => true,
      chooseBrowserFiles: async () => ({ canceled: false, filePaths: [chosenFile] }),
    });
    await parent.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html><style>webview{display:flex;width:400px;height:300px}#parked{position:fixed;left:-10000px}</style>
      <section data-pane-id="editing"><form class="composer"><textarea id="composer">user draft untouched</textarea></form></section>
      <script>
        window.events = [];
        for (const type of ['focusin','focusout','keydown','beforeinput','input','compositionstart','compositionupdate','compositionend']) {
          document.addEventListener(type, e => events.push({type, target:e.target.id, key:e.key, data:e.data}), true);
        }
      </script>` )}`);
    const guests: WebContents[] = [];
    for (const [sessionId, path] of [['visible-session', 'visible'], ['parked-session', 'parked']]) {
      log(`preparing display ${sessionId}`);
      const frame = await readyBrowserFrame(host, sessionId);
      const guest = webContents.fromId(frame.webContentsId);
      assert.ok(guest);
      assert.notEqual(guest.getType(), 'webview');
      const owner = BrowserWindow.fromWebContents(guest);
      assert.ok(owner && owner !== parent);
      assert.equal(owner.isVisible(), false);
      assert.equal(owner.isFocusable(), false);
      await guest.loadURL(`${origin}/${path}`);
      guests.push(guest);
    }
    host.setBridgeEnabled(true);
    const discovery = await readDiscovery(join(directory, 'data', 'browser-bridge.json'));
    let turn = 0;
    const command = async (sessionId: string, input: Record<string, unknown>) => {
      log(`command ${sessionId} ${input.action}`);
      const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId, turn_id: ++turn,
          ...input,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const result = await response.json() as { ok: boolean; error?: string; value?: { text: string } };
      assert.ok(result.ok, result.error);
      return result.value!.text;
    };
    const shell = parent.webContents;
    shell.debugger.attach('1.3');
    const reset = async () => {
      shell.focus();
      await shell.executeJavaScript(`(() => {
        const field = document.getElementById('composer');
        field.value = 'user draft untouched'; field.focus(); field.setSelectionRange(5,10,'backward');
        window.events = [];
      })()`);
    };
    const state = () => shell.executeJavaScript(`(() => {
      const field = document.getElementById('composer');
      return {active:document.activeElement.id, value:field.value,
        start:field.selectionStart, end:field.selectionEnd, direction:field.selectionDirection, events:window.events};
    })()`);
    const failures: string[] = [];
    if (!process.argv.includes('--surface-only')) {
    for (const guest of guests) {
      const sessionId = guest.getURL().endsWith('/visible') ? 'visible-session' : 'parked-session';
      let snapshot = await command(sessionId, { action: 'snapshot' });
      const ref = (name = 'Agent input') => {
        const line = snapshot.split('\n').find(line => line.includes(JSON.stringify(name)));
        const match = line?.match(/\[(p\d+-s\d+-e\d+)\]/);
        assert.ok(match, snapshot);
        return match[1];
      };
      const probes: Array<[string, () => Promise<unknown>]> = [
        ['page focus', () => guest.executeJavaScript(`document.getElementById('agent').focus()`)],
        ['fill', () => command(sessionId, { action: 'fill', ref: ref(), text: 'agent-fill' })],
        ['type', () => command(sessionId, { action: 'type', ref: ref(), text: 'agent-type' })],
        ['press', () => command(sessionId, { action: 'press', key: 'z' })],
        ['click', () => command(sessionId, { action: 'click', ref: ref('Focus field') })],
        ['tab boundary', () => command(sessionId, { action: 'press', key: 'Tab' })],
        ['IME type', () => command(sessionId, { action: 'type', ref: ref(), text: 'agent-ime' })],
        ['frame type', () => command(sessionId, { action: 'type', ref: ref('Frame input'), text: 'frame-text' })],
        ['frame press', () => command(sessionId, { action: 'press', key: 'z' })],
        ['navigate autofocus', async () => { snapshot = await command(sessionId, { action: 'navigate', url: `${origin}/reload` }); }],
      ];
      for (const [label, probe] of probes) {
        log(`probe ${sessionId} ${label}`);
        await reset();
        if (label === 'IME type') {
          await shell.debugger.sendCommand('Input.imeSetComposition', {
            text: 'ㅎ', selectionStart: 1, selectionEnd: 1,
          });
          await shell.executeJavaScript('window.events = []');
        }
        const before = await state();
        try {
          const result = await probe();
          if (typeof result === 'string' && result.includes('[p')) snapshot = result;
          const after = await state();
          log(JSON.stringify({ sessionId, label, shellFocused: shell.isFocused(), guestFocused: guest.isFocused(), after }));
          assert.deepEqual(after, before, `${sessionId}: ${label} must preserve composer including focus and events`);
          if (label === 'type') {
            assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'agent-type');
          }
          if (label === 'press') {
            assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'agent-typez');
          }
          if (label.startsWith('frame ')) {
            const frame = guest.mainFrame.frames.find(frame => frame.url.endsWith('/frame'));
            assert.ok(frame, 'cross-origin frame must exist');
            assert.equal(await frame.executeJavaScript(`document.getElementById('frame').value`),
              label === 'frame type' ? 'frame-text' : 'frame-textz');
          }
          if (label === 'IME type') {
            for (const text of ['하', '한']) {
              await shell.debugger.sendCommand('Input.imeSetComposition', {
                text, selectionStart: 1, selectionEnd: 1,
              });
            }
            await shell.debugger.sendCommand('Input.insertText', { text: '한' });
            assert.equal((await state()).value, 'user 한 untouched');
            assert.equal(await guest.executeJavaScript(`document.getElementById('agent').value`), 'agent-ime');
          }
        } catch (error) {
          const failure = `${sessionId}: ${label}: ${(error as Error).message.split('\n')[0]}`;
          failures.push(failure);
          log(failure);
        }
      }
    }
    assert.deepEqual(failures, []);
    }
    await exerciseBrowserInputSurface({ parent, host, guest: guests[0], origin, command, log });
    log('input isolation passed');
  } catch (error) {
    // Preserve the actual assertion before teardown can close its CDP target
    // or stall while an unrelated cleanup request is still outstanding.
    log((error as Error).stack || String(error));
    throw error;
  } finally {
    await host?.dispose();
    if (parent && !parent.isDestroyed()) parent.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

void app.whenReady().then(run).then(() => app.exit(0)).catch(error => {
  log(error.stack || String(error));
  app.exit(1);
}).finally(() => clearTimeout(deadline));
