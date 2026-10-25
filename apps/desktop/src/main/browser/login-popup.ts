/**
 * The sign-in window of a login takeover (ask_user handoff purpose 'login').
 * One approval-bound, non-modal child window of the Mixdog window: the site's
 * page in a separate WebContentsView over a trusted local bottom bar (a quiet
 * status, 닫기 and 완료); no address is shown, the card names the site. The site runs on
 * the Browser Use partition's session, so a sign-in here signs the agent's
 * pages in, but it is never registered with Browser Use: no agent
 * instrumentation, page registry, thumbnails or CDP, and the model observes
 * nothing of it.
 *
 * It opens only once the takeover gate reports human control ready (agent
 * commands refused, in-flight ones drained). 완료 closes it and settles the
 * takeover as done; 닫기, the window's own close or a crash keep the takeover
 * pending (the card offers 다시 로그인하기): closing is never success. A site
 * with an explicit trusted rule (LOGIN_AUTO_CLOSE_RULES) may end it as done by
 * itself; a provider that refuses embedded sign-in ends it as refused.
 */
import { BrowserWindow, nativeTheme, screen, type Session, type WebContents, WebContentsView } from 'electron';

import { nativeT } from '../native-i18n';
import {
  type BrowserLoginStatus,
  LOGIN_AUTO_CLOSE_RULES,
  type LoginAutoCloseRule,
  loginAutoClose,
  loginNavigationUrl,
  loginPopupBounds,
  loginRefusal,
} from './login-takeover';
import { builtPreloadPath } from './preload-path';
import type { BrowserUrlPolicy } from './url-policy';

const BAR_HEIGHT = 56;
const CONTROL_CHANNEL = 'browser-login-control';
const STATE_CHANNEL = 'browser-login-state';
const AUTO_CLOSE_DELAY_MS = 1_500;
const pausedStatus = (): string =>
  nativeT('The agent is paused. Once you finish signing in, it continues with this account.');

/** The login takeover a session waits on, as this process saw it. */
export interface BrowserLoginOffer {
  id: string;
  url: string;
  tab: string;
}

export interface BrowserLoginPopupDeps {
  /** The Mixdog window it is a child of and centred on. */
  parent(): BrowserWindow | null;
  /** The Browser Use partition's session (persist:mixdog-browser). */
  session(): Session;
  urlPolicy: BrowserUrlPolicy;
  /** Human control ready for takeover `id` (takeover-gate.ts). */
  ready(sessionId: string, id: string): Promise<boolean>;
  /** Settles takeover `id` as done; false when it was already answered. */
  settle(sessionId: string, id: string): Promise<boolean>;
  /** After a sign-in, before the agent resumes: the page takeover `id`
   *  handed over may reload. */
  afterSignIn?(sessionId: string, id: string): Promise<unknown> | unknown;
  preloadPath?: string;
  autoCloseRules?: readonly LoginAutoCloseRule[];
  autoCloseDelayMs?: number;
}

interface Entry {
  sessionId: string;
  offer: BrowserLoginOffer;
  status: BrowserLoginStatus;
  window: BrowserWindow | null;
  ended: { promise: Promise<BrowserLoginStatus>; resolve(status: BrowserLoginStatus): void } | null;
  settling: boolean;
}

/** The shell preload. */
function shellPreloadPath(): string {
  return builtPreloadPath('browser-login.js');
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

/** The trusted shell: only the bottom bar, in the app's theme. Electron's
 *  prefers-color-scheme follows nativeTheme.themeSource, which the app pins
 *  to its own theme (window-options.ts); the colors are 01-tokens.css's
 *  window band, base, ink, hairline and status tokens of each theme. */
function shellHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{--band:#18181b;--base:#222225;--text:#e9e9e9;--muted:#a8a8a8;--border:rgba(255,255,255,.125);--line:rgba(255,255,255,.09);--hover:#2a2a2d;--ok:#3ddc6e;--warn:#ffb52e}
@media (prefers-color-scheme: light){:root{--band:#f7f7f7;--base:#ffffff;--text:#222222;--muted:#606060;--border:rgba(20,20,20,.15);--line:rgba(20,20,20,.1);--hover:#f0f0f0;--ok:#077528;--warn:#a35200}}
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}
body{display:flex;flex-direction:column;background:var(--band);color:var(--text);font:13px/16px "Pretendard Variable",Pretendard,"Malgun Gothic","Segoe UI",-apple-system,"Apple SD Gothic Neo",sans-serif;user-select:none}
.page{flex:1;background:#fff}
.bar{flex:none;height:${BAR_HEIGHT}px;display:flex;align-items:center;gap:12px;padding:0 12px 0 14px;background:var(--band);border-top:1px solid var(--line)}
.status{flex:1;min-width:0;display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;line-height:16px;word-break:keep-all}
.pause{flex:none;width:6px;height:6px;border-radius:50%;background:var(--muted);opacity:.7}
body[data-tone="ok"] .status{color:var(--ok)}body[data-tone="ok"] .pause{background:var(--ok)}
body[data-tone="blocked"] .status{color:var(--warn)}body[data-tone="blocked"] .pause{background:var(--warn)}
.btns{display:flex;gap:8px;flex:none}
.mx-button{min-height:28px;border:1px solid var(--border);border-radius:3px;color:var(--text);background:var(--base);font:inherit;font-size:13px;display:inline-flex;align-items:center;justify-content:center;padding:0 14px;cursor:pointer}
.mx-button:hover:not(:disabled){background:var(--hover)}.mx-button:disabled{opacity:.6;cursor:default}
.mx-button[data-primary]{background:#1967d2;border-color:transparent;color:#fff}
</style></head><body>
<div class="page"></div>
<div class="bar"><div class="status"><span class="pause"></span><span id="status"></span></div><div class="btns"><button id="close" class="mx-button" type="button">${escapeHtml(nativeT('Close'))}</button><button id="done" class="mx-button" type="button" data-primary>${escapeHtml(nativeT('Done'))}</button></div></div>
<script>
const api = window.mixdogBrowserLogin;
const byId = (id) => document.getElementById(id);
byId('close').onclick = () => void api.close();
byId('done').onclick = () => {
  byId('done').disabled = true;
  api.complete().catch(() => {}).finally(() => { byId('done').disabled = false; });
};
api.onState((state) => {
  byId('status').textContent = state.status;
  document.body.dataset.tone = state.tone;
  byId('close').disabled = state.tone === 'ok';
});
</script></body></html>`;
}

export function createBrowserLoginPopup(deps: BrowserLoginPopupDeps) {
  /** sessionId → its login takeover and its window. */
  const entries = new Map<string, Entry>();
  const rules = deps.autoCloseRules ?? LOGIN_AUTO_CLOSE_RULES;

  /** Ends the window (if any) with `status`; a takeover stays pending unless done. */
  function finish(entry: Entry, status: BrowserLoginStatus): void {
    entry.status = status;
    const window = entry.window;
    entry.window = null;
    if (window && !window.isDestroyed()) window.destroy();
    entry.ended?.resolve(status);
    entry.ended = null;
  }

  async function complete(entry: Entry): Promise<boolean> {
    // One completion per takeover: a second 완료 (or a rule racing it) is a no-op.
    if (entry.settling || entry.status.state === 'done' || entries.get(entry.sessionId) !== entry) return false;
    entry.settling = true;
    try {
      await deps.afterSignIn?.(entry.sessionId, entry.offer.id);
    } catch (error) {
      console.warn('[browser-login] reload after sign-in failed:', (error as Error)?.message || error);
    }
    let settled: boolean;
    try {
      settled = await deps.settle(entry.sessionId, entry.offer.id);
    } catch (error) {
      entry.settling = false;
      throw error;
    }
    finish(entry, settled ? { state: 'done' } : { state: 'unavailable' });
    return settled;
  }

  /** Navigation of the site and of every window it opens: the URL policy, and
   *  HTTPS except loopback. A site's own popups keep their opener. */
  function guardContents(contents: WebContents, parent: BrowserWindow, onBlocked: () => void): void {
    const guard = (event: Electron.Event, url: string) => {
      try {
        loginNavigationUrl(url, deps.urlPolicy);
      } catch {
        event.preventDefault();
        onBlocked();
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      try {
        if (url !== 'about:blank') loginNavigationUrl(url, deps.urlPolicy);
      } catch {
        onBlocked();
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent,
          width: 480,
          height: 640,
          autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    });
    contents.on('did-create-window', (child) => guardContents(child.webContents, parent, onBlocked));
  }

  function createWindow(entry: Entry, url: string): void {
    const parent = deps.parent();
    const parentBounds = parent && !parent.isDestroyed() ? parent.getBounds() : null;
    const workArea = (parentBounds ? screen.getDisplayMatching(parentBounds) : screen.getPrimaryDisplay()).workArea;
    const window = new BrowserWindow({
      ...loginPopupBounds(parentBounds, workArea),
      minWidth: 360,
      minHeight: 420,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      modal: false,
      show: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      // A native frame whose title is the page's own (or 로그인): no address.
      title: nativeT('Sign in'),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#18181b' : '#f7f7f7',
      webPreferences: {
        preload: deps.preloadPath ?? shellPreloadPath(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    entry.window = window;
    const view = new WebContentsView({
      webPreferences: {
        session: deps.session(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    window.contentView.addChildView(view);
    const layout = () => {
      const [width, height] = window.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height: Math.max(0, height - BAR_HEIGHT) });
    };
    layout();
    window.on('resize', layout);

    const shown = { status: pausedStatus(), tone: '' };
    let shellReady = false;
    const push = () => {
      if (shellReady && !window.isDestroyed()) window.webContents.send(STATE_CHANNEL, shown);
    };
    const navigated = (raw: string) => {
      const provider = loginRefusal(raw);
      if (provider) {
        finish(entry, { state: 'refused', provider });
        return;
      }
      if (shown.tone === 'blocked') Object.assign(shown, { tone: '', status: pausedStatus() });
      if (loginAutoClose(raw, rules) && shown.tone !== 'ok') {
        Object.assign(shown, { tone: 'ok', status: nativeT('Signed in. This window closes in a moment.') });
        setTimeout(() => void complete(entry).catch(() => {}), deps.autoCloseDelayMs ?? AUTO_CLOSE_DELAY_MS);
      }
      push();
    };
    const blocked = () => {
      Object.assign(shown, {
        tone: 'blocked',
        status: nativeT('This page was not opened: sign-in pages must use HTTPS.'),
      });
      push();
    };
    const site = view.webContents;
    guardContents(site, window, blocked);
    site.on('did-navigate', (_event, next) => navigated(next));
    site.on('page-title-updated', (_event, title) => {
      if (!window.isDestroyed()) window.setTitle(title.trim() || nativeT('Sign in'));
    });
    site.on('did-navigate-in-page', (_event, next, isMainFrame) => {
      if (isMainFrame) navigated(next);
    });
    // A crash of either side ends the window, never as a success.
    site.on('render-process-gone', () => finish(entry, { state: 'closed' }));
    window.webContents.on('render-process-gone', () => finish(entry, { state: 'closed' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('did-finish-load', () => {
      shellReady = true;
      push();
    });
    const shell = window.webContents;
    shell.ipc.handle(CONTROL_CHANNEL, async (event, request) => {
      if (shell.isDestroyed() || event.sender !== shell || event.senderFrame !== shell.mainFrame) {
        throw new Error('Invalid sign-in window sender');
      }
      const action = (request as { action?: unknown } | null)?.action;
      if (action === 'close') {
        if (!window.isDestroyed()) window.close();
        return true;
      }
      if (action === 'complete') return complete(entry);
      throw new Error('Invalid sign-in window request');
    });
    // 닫기 and the OS close alike: still pending, offered again on the card.
    window.on('closed', () => {
      if (!site.isDestroyed()) site.close();
      if (entry.window === window) {
        entry.window = null;
        finish(entry, { state: 'closed' });
      }
    });
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show();
    });
    void window.loadURL(`data:text/html;base64,${Buffer.from(shellHtml()).toString('base64')}`);
    void site.loadURL(url).catch(() => {});
  }

  return {
    /** The login takeover `sessionId` waits on now (null: none). A takeover
     *  answered anywhere else closes its window. */
    sync(sessionId: string, offer: BrowserLoginOffer | null): void {
      const entry = entries.get(sessionId);
      if (entry && offer && entry.offer.id === offer.id) return;
      if (entry) {
        entries.delete(sessionId);
        finish(entry, entry.status.state === 'done' ? entry.status : { state: 'unavailable' });
      }
      if (offer) {
        entries.set(sessionId, {
          sessionId,
          offer,
          status: { state: 'idle' },
          window: null,
          ended: null,
          settling: false,
        });
      }
    },
    /** 완료 for takeover `id` while its window is open (the shell's button); a
     *  second completion is a no-op that returns false. */
    complete(sessionId: string, id: string): Promise<boolean> {
      const entry = entries.get(sessionId);
      if (!entry || entry.offer.id !== id || !entry.window) return Promise.resolve(false);
      return complete(entry);
    },
    status(sessionId: string, id: string): BrowserLoginStatus {
      const entry = entries.get(sessionId);
      return entry && entry.offer.id === id ? entry.status : { state: 'unavailable' };
    },
    /** Opens (or focuses) the window of takeover `id` once human control is
     *  ready; resolves with how it ended. */
    async open(sessionId: string, id: string): Promise<BrowserLoginStatus> {
      const entry = entries.get(sessionId);
      if (!entry || entry.offer.id !== id) return { state: 'unavailable' };
      if (entry.status.state === 'done') return entry.status;
      if (entry.ended) {
        entry.window?.show();
        entry.window?.focus();
        return entry.ended.promise;
      }
      const url = loginNavigationUrl(entry.offer.url, deps.urlPolicy);
      let resolve: (status: BrowserLoginStatus) => void = () => {};
      const promise = new Promise<BrowserLoginStatus>((done) => {
        resolve = done;
      });
      const ended = { promise, resolve };
      entry.ended = ended;
      entry.status = { state: 'open' };
      // The privacy barrier: no window before the agent's work has drained.
      const ready = await deps.ready(sessionId, id);
      if (entry.ended !== ended) return promise;
      if (!ready || entries.get(sessionId) !== entry) {
        finish(entry, { state: 'idle' });
        return { state: 'unavailable' };
      }
      createWindow(entry, url);
      return promise;
    },
    dispose(): void {
      for (const [sessionId, entry] of entries) {
        entries.delete(sessionId);
        finish(entry, { state: 'unavailable' });
      }
    },
  };
}

export type BrowserLoginPopup = ReturnType<typeof createBrowserLoginPopup>;
