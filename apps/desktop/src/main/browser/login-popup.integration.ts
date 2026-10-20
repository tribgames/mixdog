/**
 * The sign-in window of a login takeover against a real Electron and a local
 * test site (scripts/run-browser-login-popup-integration.mjs): non-HTTPS is
 * refused, nothing opens before human control is ready, 닫기 is never success,
 * 완료 settles once (a second press is a no-op), a sign-in in the window signs
 * the agent's partition in, a site's own popup keeps its opener, a takeover
 * answered elsewhere and a crash both end the window without success, and the
 * site sees no Mixdog API, no CDP and no agent command while it is open.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { app, BrowserWindow, session, webContents } from 'electron';

import { createTakeoverGate } from '../takeover-gate';
import { BROWSER_PARTITION } from './command';
import { createBrowserLoginPopup } from './login-popup';

const directory = process.env.MIXDOG_LOGIN_POPUP_ROOT || '';
if (!directory) throw new Error('The sign-in window fixture requires an isolated directory.');
app.setPath('userData', join(directory, 'profile'));

function startSite(): Promise<{ origin: string; close(): void }> {
  const server = createServer((request, response) => {
    const path = request.url || '/';
    if (path === '/signin') {
      response.statusCode = 302;
      response.setHeader('Set-Cookie', 'sid=popup-session; Path=/; HttpOnly; SameSite=Lax');
      response.setHeader('Location', '/home');
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/opener-check') {
      response.end('<script>window.opener.postMessage("opener-ok", "*");</script>');
      return;
    }
    response.end(`<title>${path}</title><pre id="who">${request.headers.cookie || ''}</pre>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

async function run() {
  await app.whenReady();
  const site = await startSite();
  const partition = session.fromPartition(BROWSER_PARTITION);
  const parent = new BrowserWindow({ show: false, width: 1200, height: 800 });
  const gate = createTakeoverGate(async (work) => work());
  const order: string[] = [];
  const popup = createBrowserLoginPopup({
    parent: () => parent,
    session: () => partition,
    urlPolicy: { allowPrivateNetwork: true },
    ready: (sessionId, id) => gate.ready(sessionId, id),
    settle: async (sessionId, id) => {
      order.push(`settle ${sessionId} ${id}`);
      return true;
    },
    afterSignIn: (sessionId) => {
      order.push(`reload ${sessionId}`);
    },
    preloadPath: join(directory, 'browser-login.js'),
  });
  const takeover = (sessionId: string, id: string, url: string) => {
    gate.onSessionState({
      sessionId,
      snapshot: { toolApproval: { id, kind: 'takeover', takeover: { surface: 'browser', purpose: 'login', url } } },
    });
    popup.sync(sessionId, { id, url, tab: '' });
  };
  const loginWindow = () => BrowserWindow.getAllWindows().find((window) => window.getParentWindow() === parent);
  const siteContents = () =>
    webContents
      .getAllWebContents()
      .find((contents) => contents.session === partition && contents.getURL().startsWith(site.origin));

  // Non-HTTPS is refused before anything opens.
  takeover('s0', 't0', 'http://example.com/login');
  await assert.rejects(popup.open('s0', 't0'), /HTTPS/);
  assert.equal(loginWindow(), undefined);
  gate.onSessionState({ sessionId: 's0', snapshot: { toolApproval: null } });
  popup.sync('s0', null);

  // The privacy barrier: no window while an agent command is still in flight.
  const inFlight = gate.beginOperation();
  popup.sync('s1', { id: 't1', url: `${site.origin}/login`, tab: '' });
  const first = popup.open('s1', 't1');
  takeover('s1', 't1', `${site.origin}/login`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(inFlight.signal.aborted, true);
  assert.equal(loginWindow(), undefined, 'nothing opens before in-flight work drained');
  inFlight.release();
  await until(() => Boolean(loginWindow()?.isVisible() && siteContents()), 'the sign-in window');
  const window = loginWindow() as BrowserWindow;
  const bounds = window.getBounds();
  assert.equal(window.isModal(), false);
  assert.ok(Math.abs(bounds.width - 480) <= 16 && Math.abs(bounds.height - 720) <= 40, JSON.stringify(bounds));
  // No agent observation: Browser Use refuses commands, the site has no CDP
  // client and no Mixdog API, and only the shell holds the window's controls.
  assert.throws(() => gate.beginOperation(), /taken over/);
  const page = siteContents() as Electron.WebContents;
  assert.equal(page.debugger.isAttached(), false);
  assert.equal(await page.executeJavaScript('typeof window.mixdogBrowserLogin + typeof require'), 'undefinedundefined');
  // No address anywhere: the shell has only the bottom bar, the title is the page's.
  assert.equal(
    await window.webContents.executeJavaScript(`document.querySelectorAll('#host, #via, #lock, .title').length`),
    0
  );
  await until(() => !window.getTitle().includes('127.0.0.1') && window.getTitle() !== '', 'the page title');

  // 닫기 is never success: the takeover stays pending and can open again.
  await window.webContents.executeJavaScript(`document.getElementById('close').click()`);
  assert.deepEqual(await first, { state: 'closed' });
  assert.deepEqual(popup.status('s1', 't1'), { state: 'closed' });
  assert.deepEqual(order, []);

  const second = popup.open('s1', 't1');
  await until(() => Boolean(loginWindow()?.isVisible() && siteContents()), 'the reopened window');
  const again = loginWindow() as BrowserWindow;
  const signIn = siteContents() as Electron.WebContents;
  // A site's own popup keeps its opener; a plain-http one is refused.
  const opened = await signIn.executeJavaScript(`new Promise((resolve) => {
    window.addEventListener('message', (event) => resolve(event.data), { once: true });
    window.open('/opener-check');
  })`);
  assert.equal(opened, 'opener-ok');
  assert.equal(await signIn.executeJavaScript(`window.open('http://example.com/') === null`), true);
  // The person signs in inside the window.
  await signIn.executeJavaScript(`location.href = '/signin'`);
  await until(() => signIn.getURL().endsWith('/home'), 'the signed-in page');
  // 완료 in the shell, and a second completion racing it: one settles.
  void again.webContents.executeJavaScript(`document.getElementById('done').click()`);
  const racing = popup.complete('s1', 't1');
  assert.deepEqual(await second, { state: 'done' });
  await racing;
  assert.equal(await popup.complete('s1', 't1'), false, 'a completion after done is a no-op');
  assert.deepEqual(order, ['reload s1', 'settle s1 t1'], "one settle; the agent's page reloads before it resumes");
  await until(() => !loginWindow(), 'the window to close after 완료');

  // The agent's browser (same partition) is now signed in.
  const agentPage = new BrowserWindow({ show: false, webPreferences: { partition: BROWSER_PARTITION } });
  await agentPage.loadURL(`${site.origin}/whoami`);
  assert.match(
    await agentPage.webContents.executeJavaScript(`document.getElementById('who').textContent`),
    /sid=popup-session/
  );
  agentPage.destroy();

  // Answered elsewhere (취소 on the card, or the phone): the window closes, no success.
  takeover('s2', 't2', `${site.origin}/login`);
  const cancelled = popup.open('s2', 't2');
  await until(() => Boolean(loginWindow()), 'the s2 window');
  popup.sync('s2', null);
  assert.deepEqual(await cancelled, { state: 'unavailable' });
  await until(() => !loginWindow(), 'the cancelled window to close');

  // A crash of the site ends the window as closed, never done.
  takeover('s3', 't3', `${site.origin}/login`);
  const crashed = popup.open('s3', 't3');
  await until(() => Boolean(loginWindow()?.isVisible() && siteContents()), 'the s3 window');
  (siteContents() as Electron.WebContents).forcefullyCrashRenderer();
  assert.deepEqual(await crashed, { state: 'closed' });
  assert.deepEqual(order, ['reload s1', 'settle s1 t1']);

  popup.dispose();
  gate.dispose();
  site.close();
  process.stdout.write('Sign-in window integration passed.\n');
  app.exit(0);
}

void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
