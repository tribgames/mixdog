/**
 * Popup and tab handover on the visible surface: a popup is discovered and
 * selected through the tab strip while keeping its opener, login and form
 * state; tabs are created and closed; another session may not steer them;
 * and releasing the session restores (or forgets) its pages as asked.
 */
import assert from 'node:assert/strict';
import { webContents, type WebContents } from 'electron';
import type { BrowserHost } from './host';
import { readyBrowserFrame } from './harness-frame';
import { createPolling } from '../host-harness-poll';

export async function exerciseBrowserTabHandover(options: {
  host: BrowserHost;
  guest: WebContents;
  shell: WebContents;
  origin: string;
  command(sessionId: string, input: Record<string, unknown>): Promise<string>;
  log(text: string): void;
}): Promise<void> {
  const { host, guest, shell, origin, command, log } = options;
  const readFrame = (sessionId: string) => readyBrowserFrame(host, sessionId);
  const { eventually } = createPolling({ timeoutMs: 8000, intervalMs: 25 });

  await guest.executeJavaScript(`document.cookie = 'isolation_login=retained; path=/'`);
  const original = await readFrame('visible-session');
  await guest.executeJavaScript(`window.open(${JSON.stringify(`${origin}/login-popup`)}, 'login-popup'); void 0`);
  const withPopup = await eventually(
    () => readFrame('visible-session'),
    (value) => Boolean(value.tabs?.some((tab) => tab.kind === 'popup'))
  );
  const popupTab = withPopup.tabs!.find((tab) => tab.kind === 'popup')!;
  log(`popup discovered ${JSON.stringify(popupTab)}`);
  await assert.rejects(
    host.browserPageControl('parked-session', {
      type: 'select-tab',
      tabId: popupTab.id,
      documentId: original.documentId,
    }),
    /this session/
  );
  await shell.executeJavaScript('window.setSurfaceActive(true)');
  const popupSelector = `[role="tab"][data-page-id="${popupTab.id}"]`;
  await eventually(
    () => shell.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(popupSelector)}))`),
    Boolean
  );
  await shell.executeJavaScript(`document.querySelector(${JSON.stringify(popupSelector)}).click()`);
  log('popup selected through tab strip');
  const popupFrame = await eventually(
    () => readFrame('visible-session'),
    (value) => !value.loading && value.url.endsWith('/login-popup')
  );
  const popupGuest = webContents.fromId(popupFrame.webContentsId)!;
  assert.ok(popupGuest);
  assert.equal(popupFrame.tabs!.find((tab) => tab.active)!.id, popupTab.id);
  assert.match(await popupGuest.executeJavaScript('document.cookie'), /isolation_login=retained/);
  assert.equal(await popupGuest.executeJavaScript('Boolean(window.opener)'), true);
  await popupGuest.executeJavaScript(`document.getElementById('agent').value = 'popup draft'`);
  const primaryTab = original.tabs!.find((tab) => tab.active)!;
  await host.browserPageControl('visible-session', {
    type: 'select-tab',
    tabId: primaryTab.id,
    documentId: popupFrame.documentId,
  });
  host.setGuestActive('visible-session', popupFrame.webContentsId, true);
  assert.equal(
    (await readFrame('visible-session')).webContentsId,
    guest.id,
    'late display reports do not undo the user selection'
  );
  await host.browserPageControl('visible-session', {
    type: 'select-tab',
    tabId: popupTab.id,
    documentId: original.documentId,
  });
  assert.equal((await readFrame('visible-session')).webContentsId, popupGuest.id);
  assert.equal(await popupGuest.executeJavaScript(`document.getElementById('agent').value`), 'popup draft');
  await host.browserPageControl('visible-session', {
    type: 'close-tab',
    tabId: popupTab.id,
    documentId: popupFrame.documentId,
  });
  await eventually(
    () => readFrame('visible-session'),
    (value) => value.webContentsId === guest.id
  );
  await host.browserPageControl('visible-session', { type: 'new-tab', documentId: original.documentId });
  const created = await readFrame('visible-session');
  assert.notEqual(created.webContentsId, guest.id);
  assert.equal(created.url, 'about:blank');
  await host.browserPageControl('visible-session', {
    type: 'close-tab',
    tabId: created.tabs!.find((tab) => tab.active)!.id,
    documentId: created.documentId,
  });
  await eventually(
    () => readFrame('visible-session'),
    (value) => value.webContentsId === guest.id
  );
  await shell.executeJavaScript('window.setSurfaceActive(false)');
  log('visible popup switching retains opener, login and form state; tab creation, close and session isolation passed');
  await guest.executeJavaScript(`(() => {
    const popup = window.open('about:blank', 'blank-login');
    popup.document.write('<title>Blank login</title><input value="retained draft">');
    popup.document.close();
  })()`);
  const blankTabs = await eventually(
    () => readFrame('visible-session'),
    (value) => Boolean(value.tabs?.some((tab) => tab.kind === 'popup' && tab.title === 'Blank login'))
  );
  const blankTab = blankTabs.tabs!.find((tab) => tab.kind === 'popup')!;
  await host.browserPageControl('visible-session', {
    type: 'select-tab',
    tabId: blankTab.id,
    documentId: blankTabs.documentId,
  });
  const blankFrame = await readFrame('visible-session');
  assert.ok(blankFrame.viewportWidth > 0 && blankFrame.viewportHeight > 0);
  assert.equal(
    await webContents.fromId(blankFrame.webContentsId)!.executeJavaScript(`document.querySelector('input').value`),
    'retained draft'
  );
  await host.browserPageControl('visible-session', {
    type: 'close-tab',
    tabId: blankTab.id,
    documentId: blankFrame.documentId,
  });
  log('about:blank popup content is visible without losing its document');
  const other = await readFrame('parked-session');
  assert.notEqual(other.webContentsId, guest.id);
  await host.browserPageControl('visible-session', { type: 'new-tab', documentId: blankFrame.documentId });
  const resumeTab = await readFrame('visible-session');
  await host.browserPageControl('visible-session', {
    type: 'navigate',
    url: `${origin}/restore-after-unload`,
    documentId: resumeTab.documentId,
  });
  const readyToUnload = await eventually(
    () => readFrame('visible-session'),
    (value) => !value.loading && value.url.endsWith('/restore-after-unload')
  );
  const oldPageIds = readyToUnload.tabs!.map((tab) => tab.id);
  const oldActive = webContents.fromId(readyToUnload.webContentsId)!;
  const unrelated = webContents.fromId(other.webContentsId)!;
  host.releaseSession('visible-session', { restore: true });
  await eventually(async () => guest.isDestroyed() && oldActive.isDestroyed(), Boolean);
  assert.equal(unrelated.isDestroyed(), false);
  const resumed = await eventually(
    () => readFrame('visible-session'),
    (value) => !value.loading && value.url.endsWith('/restore-after-unload')
  );
  assert.equal(resumed.tabs!.length, readyToUnload.tabs!.length);
  assert.ok(resumed.tabs!.every((tab) => !oldPageIds.includes(tab.id)));
  assert.match(
    await webContents.fromId(resumed.webContentsId)!.executeJavaScript('document.cookie'),
    /isolation_login=retained/
  );
  log('runtime unload destroys only the owning session pages; next demand restores tab URLs and shared login');
  host.releaseSession('visible-session');
  const reopened = await readFrame('visible-session');
  assert.notEqual(reopened.webContentsId, guest.id);
  assert.equal(reopened.url, 'about:blank', 'deletion forgets saved browser navigation');
  await host.browserPageControl('visible-session', {
    type: 'navigate',
    url: `${origin}/reopened`,
    documentId: reopened.documentId,
  });
  await eventually(
    () => readFrame('visible-session'),
    (value) => !value.loading && value.url.endsWith('/reopened')
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const cookieCheck = await command('visible-session', { action: 'evaluate', script: 'document.cookie' });
  assert.match(cookieCheck, /isolation_login=retained/);
  log('page release and recreation retain shared login storage');
}
