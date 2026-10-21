/**
 * A person (no agent) driving the pane through a payment-style flow: the page
 * says something with alert()/confirm()/prompt() before it opens a
 * cross-origin payment layer, the layer itself speaks, or the payment opens in
 * a window.open popup whose first document speaks while it is still parsing.
 * Every dialog must reach the pane as a card the person answers, and the
 * payment layer must take their clicks afterwards. The runner starts it once
 * with the pixel surface and once with native presentation
 * (MIXDOG_BROWSER_NATIVE_VIEW).
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, webContents, type WebContents, type WebFrameMain } from 'electron';
import { createPolling } from '../host-harness-poll';
import { readyBrowserFrame } from './harness-frame';
import { createBrowserHost } from './host';

const progressPath = process.env.MIXDOG_BROWSER_INTEGRATION_LOG || '';
function progress(message: string): void {
  if (progressPath) appendFileSync(progressPath, `${message}\n`);
}

const profile = mkdtempSync(join(tmpdir(), 'mixdog-browser-user-dialogs-'));
process.env.MIXDOG_DATA_DIR = join(profile, 'data');
app.setPath('userData', join(profile, 'user-data'));
app.disableHardwareAcceleration();

const { eventually, readDiscovery } = createPolling({ timeoutMs: 6_000, intervalMs: 50 });

/** The payment provider: a cross-origin document with an agreement box. */
function paymentServer(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://payment');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const speak = url.searchParams.get('speak') === '1' ? `<script>alert('Payment layer notice');</script>` : '';
    response.end(`<!doctype html><title>Payment layer</title>${speak}
      <style>body{margin:0;font:16px sans-serif;background:#fff}label{display:block;padding:40px}</style>
      <label><input id="agree" type="checkbox" style="width:40px;height:40px"> I agree</label>`);
  });
}

/** The merchant: speaks first, then opens the payment layer or popup. */
function merchantServer(paymentOrigin: () => string): Server {
  return createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://merchant');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    const layer = (speak: boolean) => `(() => {
        const veil = document.createElement('div');
        veil.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9998';
        const frame = document.createElement('iframe');
        frame.id = 'payment';
        frame.src = ${JSON.stringify(`${paymentOrigin()}/layer${speak ? '?speak=1' : ''}`)};
        frame.style.cssText = 'position:fixed;left:40px;top:40px;width:420px;height:300px;border:0;z-index:9999';
        document.body.append(veil, frame);
      })()`;
    const attribute = (script: string) => script.replaceAll('"', '&quot;');
    if (url.pathname === '/pay') {
      response.end(`<!doctype html><title>Merchant</title>
        <p id="state">Idle</p>
        <button id="alert-pay" style="position:fixed;left:20px;top:420px;width:160px;height:40px"
          onclick="alert('Payment notice'); document.querySelector('#state').textContent = 'alerted'; ${attribute(layer(false))}">Alert, pay</button>
        <button id="confirm-pay" style="position:fixed;left:200px;top:420px;width:160px;height:40px"
          onclick="document.querySelector('#state').textContent = confirm('Proceed to payment?') ? 'confirmed' : 'cancelled'">Confirm</button>
        <button id="prompt-pay" style="position:fixed;left:380px;top:420px;width:160px;height:40px"
          onclick="document.querySelector('#state').textContent = 'prompt:' + prompt('Payer name?', 'Kim')">Prompt</button>
        <button id="popup-pay" style="position:fixed;left:20px;top:480px;width:160px;height:40px"
          onclick="window.open('/easy', 'EasyService', 'width=800,height=600')">Popup pay</button>
        <button id="layer-speaks" style="position:fixed;left:200px;top:480px;width:160px;height:40px"
          onclick="${attribute(layer(true))}">Layer speaks</button>
        <button id="blank-popup" style="position:fixed;left:380px;top:480px;width:160px;height:40px"
          onclick="${attribute(`const popup = window.open('', 'BlankPay', 'width=600,height=400');
            setTimeout(() => { popup.document.title = 'Blank pay'; popup.alert('Blank popup notice'); popup.document.title = 'Blank pay done'; }, 1000);`)}">Blank popup</button>
        <button id="quiet-popup" style="position:fixed;left:20px;top:540px;width:160px;height:40px"
          onclick="window.open('/quiet', 'Quiet', 'width=600,height=400')">Quiet popup</button>
        <button id="late-popup" style="position:fixed;left:200px;top:540px;width:160px;height:40px"
          onclick="window.open('/first', 'First', 'width=600,height=400'); setTimeout(() => window.open('/late', 'Late', 'width=600,height=400'), 800)">Late popup</button>
        <button id="notice-popup" style="position:fixed;left:380px;top:540px;width:160px;height:40px"
          onclick="alert('새창에서 열립니다.'); window.open('/notice', 'Notice', 'width=600,height=400')">Notice popup</button>`);
      return;
    }
    if (['/quiet', '/first', '/late', '/notice'].includes(url.pathname)) {
      response.end(`<!doctype html><title>${url.pathname.slice(1)} popup</title><p>Popup body</p>`);
      return;
    }
    if (url.pathname === '/easy') {
      // Like a filing service's window: its first document speaks while parsing.
      response.end(`<!doctype html><title>Easy service</title>
        <script>alert('Popup notice'); document.title = 'Easy service ready';</script>
        <body><p>Popup body</p><script>${layer(false)}</script></body>`);
      return;
    }
    response.statusCode = 404;
    response.end('missing');
  });
}

async function listen(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function scenario(origin: string, paymentOrigin: string, native: boolean): Promise<void> {
  const mode = native ? 'native view' : 'pixel surface';
  const session = 'user-dialogs-session';
  const parent = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const browser = createBrowserHost(parent, { remoteSession: false, requestApproval: async () => true });
  try {
    await parent.loadURL('data:text/html,<p>shell</p>');
    const first = await readyBrowserFrame(browser, session);
    const opener = webContents.fromId(first.webContentsId)!;
    browser.setGuestActive(session, opener.id, true);
    await opener.loadURL(`${origin}/pay`);

    const frameNow = () => readyBrowserFrame(browser, session);
    /** A person's click at a page point, the way the pane sends it. */
    const click = async (point: { x: number; y: number }) => {
      const { documentId } = await frameNow();
      const pointer = {
        type: 'pointer' as const,
        documentId,
        ...point,
        button: 'left' as const,
        modifiers: 0,
        clickCount: 1,
      };
      await browser.browserPageControl(session, { ...pointer, phase: 'mousePressed', buttons: 1 });
      await browser.browserPageControl(session, { ...pointer, phase: 'mouseReleased', buttons: 0 });
    };
    const center = async (target: WebContents | WebFrameMain, selector: string) =>
      (await target.executeJavaScript(`(() => {
        const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`)) as { x: number; y: number };
    const stateOf = (guest: WebContents) => guest.executeJavaScript(`document.querySelector('#state').textContent`);
    const dialogShown = async (type: string, message: string) => {
      const frame = await eventually(frameNow, (value) => value.dialog?.type === type).catch(async (error) => {
        const last = await frameNow();
        throw new Error(
          `no ${type} card in the pane (${mode}): ${(error as Error).message}; ` +
            `dialog=${JSON.stringify(last.dialog)} on ${last.url}`
        );
      });
      assert.equal(frame.dialog?.message, message);
    };
    const answer = async (accept: boolean, promptText?: string) => {
      const frame = await frameNow();
      assert.ok(frame.dialog);
      await browser.browserPageControl(session, {
        type: 'answer-dialog',
        documentId: frame.documentId,
        requestId: frame.dialog.id,
        accept,
        ...(promptText === undefined ? {} : { promptText }),
      });
    };
    /** Click the agreement box in the cross-origin payment layer and see it checked. */
    const agree = async (guest: WebContents) => {
      const layer = (await eventually(
        async () => guest.mainFrame.framesInSubtree.find((frame) => frame.url.startsWith(paymentOrigin)) ?? null,
        (frame) => frame !== null
      )) as WebFrameMain;
      await eventually(
        () =>
          layer.executeJavaScript(`document.readyState === 'complete' && Boolean(document.querySelector('#agree'))`),
        Boolean
      );
      const inner = await center(layer, '#agree');
      const offset = (await guest.executeJavaScript(`(() => {
        const r = document.querySelector('#payment').getBoundingClientRect();
        return { x: r.x, y: r.y };
      })()`)) as { x: number; y: number };
      await click({ x: offset.x + inner.x, y: offset.y + inner.y });
      await eventually(() => layer.executeJavaScript(`document.querySelector('#agree').checked`), Boolean, 3_000);
    };

    await click(await center(opener, '#alert-pay'));
    await dialogShown('alert', 'Payment notice');
    await answer(true);
    await eventually(
      () => stateOf(opener),
      (value) => value === 'alerted'
    );
    await agree(opener);
    progress(`${mode}: alert card answered, then the cross-origin payment layer took the click`);

    await opener.loadURL(`${origin}/pay`);
    for (const [accept, expected] of [
      [false, 'cancelled'],
      [true, 'confirmed'],
    ] as const) {
      await click(await center(opener, '#confirm-pay'));
      await dialogShown('confirm', 'Proceed to payment?');
      await answer(accept);
      await eventually(
        () => stateOf(opener),
        (value) => value === expected
      );
    }
    await click(await center(opener, '#prompt-pay'));
    await dialogShown('prompt', 'Payer name?');
    await answer(true, 'Lee');
    await eventually(
      () => stateOf(opener),
      (value) => value === 'prompt:Lee'
    );
    progress(`${mode}: confirm OK/Cancel and prompt answers reached the page`);

    await click(await center(opener, '#layer-speaks'));
    await dialogShown('alert', 'Payment layer notice');
    await answer(true);
    await agree(opener);
    progress(`${mode}: the payment layer's own alert reached the pane, then the layer took the click`);

    await opener.loadURL(`${origin}/pay`);
    await click(await center(opener, '#popup-pay'));
    const popup = (await eventually(
      async () => webContents.getAllWebContents().find((entry) => entry.getURL().endsWith('/easy')) ?? null,
      (entry) => entry !== null
    )) as WebContents;
    // Dismissed silently rather than shown, or an OS message box owned by a
    // hidden window, if the popup lost the page preferences.
    // Electron's own record of the page's preferences (untyped).
    const preferences = (
      popup as WebContents & { getLastWebPreferences(): { disableDialogs?: boolean } | null }
    ).getLastWebPreferences();
    assert.equal(preferences?.disableDialogs, true, `${mode}: popup keeps disableDialogs`);
    /** The pane shows `guest` as the selected tab, with no select-tab sent. */
    const selected = (guest: WebContents, label: string) =>
      eventually(frameNow, (frame) => frame.webContentsId === guest.id).catch(async (error) => {
        const last = await frameNow();
        throw new Error(
          `${mode}: ${label}: ${(error as Error).message}; shown ${last.url}, ` +
            `tabs ${JSON.stringify(last.tabs?.map((entry) => [entry.url, entry.active]))}`
        );
      });
    // The person's click opened it in front: it is the tab they now see, as
    // Chrome brings it forward, with its first-document alert on it.
    const shownPopup = await selected(popup, "the person's popup is not the selected tab");
    assert.equal(shownPopup.tabs?.find((entry) => entry.url.endsWith('/easy'))?.active, true);
    await dialogShown('alert', 'Popup notice');
    await answer(true);
    await eventually(
      () => popup.executeJavaScript('document.title'),
      (value) => value === 'Easy service ready'
    );
    await agree(popup);
    progress(`${mode}: the person's popup became the selected tab; its alert and payment layer took their input`);

    // Payment done: the popup closes itself, and the person is back on the opener.
    void popup.executeJavaScript('setTimeout(() => window.close(), 0)').catch(() => undefined);
    const closed = await selected(opener, 'closing the popup did not return to its opener');
    assert.equal(
      closed.tabs?.some((entry) => entry.url.endsWith('/easy')),
      false
    );
    progress(`${mode}: the popup's window.close() returned the selection to its opener`);

    // A popup the opener writes into keeps about:blank as its address.
    await opener.loadURL(`${origin}/pay`);
    await click(await center(opener, '#blank-popup'));
    await dialogShown('alert', 'Blank popup notice');
    await answer(true);
    const blank = (await eventually(
      async () => webContents.getAllWebContents().find((entry) => entry.getTitle() === 'Blank pay done') ?? null,
      (entry) => entry !== null
    )) as WebContents;
    assert.equal(blank.getURL(), 'about:blank');
    await selected(blank, "the person's about:blank popup is not the selected tab");
    progress(`${mode}: an about:blank popup's alert reached the pane`);

    // The agent's click opens a popup: it stays behind and the agent is told.
    const back = await frameNow();
    const openerTab = back.tabs?.find((entry) => entry.url.endsWith('/pay'));
    assert.ok(openerTab);
    await browser.browserPageControl(session, { type: 'select-tab', tabId: openerTab.id, documentId: back.documentId });
    await selected(opener, 'the opener tab could not be picked');

    // The click's window comes forward; the one the page opens later from a
    // timer (no gesture of its own) stays behind it.
    const popupAt = (path: string) =>
      eventually(
        async () => webContents.getAllWebContents().find((entry) => entry.getURL().endsWith(path)) ?? null,
        (entry) => entry !== null
      ) as Promise<WebContents>;
    await click(await center(opener, '#late-popup'));
    const firstPopup = await popupAt('/first');
    await selected(firstPopup, "the click's popup is not the selected tab");
    const latePopup = await popupAt('/late');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterLate = await frameNow();
    assert.equal(
      afterLate.webContentsId,
      firstPopup.id,
      `${mode}: a timer-opened popup took the selection: shown ${afterLate.url}, ` +
        `tabs ${JSON.stringify(afterLate.tabs?.map((entry) => [entry.url, entry.active]))}`
    );
    assert.equal(afterLate.tabs?.find((entry) => entry.url.endsWith('/late'))?.active, false);
    assert.equal(latePopup.isDestroyed(), false);
    progress(`${mode}: a popup opened later from a timer stayed behind the click's popup`);
    const reselect = await frameNow();
    const openerAgain = reselect.tabs?.find((entry) => entry.url.endsWith('/pay'));
    assert.ok(openerAgain);
    await browser.browserPageControl(session, {
      type: 'select-tab',
      tabId: openerAgain.id,
      documentId: reselect.documentId,
    });
    await selected(opener, 'the opener tab could not be picked again');

    // alert('새창에서 열립니다.'); window.open(...): the person reads the alert past
    // Chromium's 5 s activation window, answers it, and the window still
    // comes forward as theirs.
    await click(await center(opener, '#notice-popup'));
    await dialogShown('alert', '새창에서 열립니다.');
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await answer(true);
    const notice = await popupAt('/notice');
    await selected(notice, 'the popup opened right after the alert answer is not the selected tab');
    progress(`${mode}: a popup opened right after the person answered an alert became the selected tab`);
    const noticeFrame = await frameNow();
    const openerThird = noticeFrame.tabs?.find((entry) => entry.url.endsWith('/pay'));
    assert.ok(openerThird);
    await browser.browserPageControl(session, {
      type: 'select-tab',
      tabId: openerThird.id,
      documentId: noticeFrame.documentId,
    });
    await selected(opener, 'the opener tab could not be picked a third time');
    // The agent waits out the person's quiet period (command-queue-local-input).
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    browser.setBridgeEnabled(true);
    const discovery = await readDiscovery(join(process.env.MIXDOG_DATA_DIR!, 'browser-bridge.json'));
    const command = async (input: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
        method: 'POST',
        headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: session, turn_id: 1, ...input }),
      });
      const payload = (await response.json()) as { ok: boolean; value?: { text?: string }; error?: string };
      if (!payload.ok) throw new Error(payload.error || 'browser command failed');
      return String(payload.value?.text || '');
    };
    const snapshot = await command({ action: 'snapshot' });
    const ref = snapshot
      .split('\n')
      .find((line) => line.includes('"Quiet popup"'))
      ?.match(/\[(p\d+-s\d+-e\d+)\]/)?.[1];
    assert.ok(ref, `no Quiet popup ref in the agent snapshot:\n${snapshot}`);
    const reply = await command({ action: 'click', ref });
    assert.match(reply, /popup-\d+/, `${mode}: the agent is told about the popup it opened:\n${reply}`);
    const quiet = (await eventually(
      async () => webContents.getAllWebContents().find((entry) => entry.getURL().endsWith('/quiet')) ?? null,
      (entry) => entry !== null
    )) as WebContents;
    const after = await frameNow();
    assert.equal(after.webContentsId, opener.id, `${mode}: the agent's popup took the selection`);
    assert.equal(after.tabs?.find((entry) => entry.url.endsWith('/quiet'))?.active, false);
    assert.equal(quiet.isDestroyed(), false);
    progress(`${mode}: the agent's popup stayed an unselected tab and its reply named it`);
  } finally {
    await browser.dispose().catch(() => undefined);
    parent.destroy();
  }
}

async function run(): Promise<void> {
  const payment = paymentServer();
  let paymentOrigin = '';
  const merchant = merchantServer(() => paymentOrigin);
  try {
    paymentOrigin = `http://127.0.0.2:${await listen(payment, '0.0.0.0')}`;
    const origin = `http://127.0.0.1:${await listen(merchant, '127.0.0.1')}`;
    // One presentation per process: the host reads it once, at creation.
    await scenario(origin, paymentOrigin, process.env.MIXDOG_BROWSER_NATIVE_VIEW === '1');
    progress('user dialogs integration passed');
  } finally {
    payment.close();
    merchant.close();
  }
}

void app
  .whenReady()
  .then(async () => {
    await run();
    app.exit(0);
  })
  .catch((error) => {
    progress(`FAILED: ${(error as Error).stack || error}`);
    app.exit(1);
  });
