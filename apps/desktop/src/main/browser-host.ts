/**
 * Agent browser host — main-process owner of the in-app browser pane's guest
 * webviews and of the local bridge that lets the session runtime's `browser`
 * tool drive them.
 *
 * Architecture: the renderer's BrowserPane mounts a <webview> on the shared
 * persistent partition; this module vets and registers every such guest
 * (did-attach-webview), drives the CURRENT guest over CDP (navigate, snapshot
 * with element refs, click, fill, press, scroll, screenshot, read), and hosts
 * a loopback HTTP server whose port+token ride a discovery file in the Mixdog
 * data directory. The runtime tool reads that file, so the tool surface only
 * exists while this desktop app runs — no daemon protocol changes.
 *
 * background:true commands run against a hidden offscreen BrowserWindow on the
 * SAME partition, so the agent can work invisibly while staying logged in.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { BrowserWindow, session } from 'electron';

import { DESKTOP_IPC } from '../shared/contract';

/** Must match the renderer BrowserPane's <webview partition>. */
const BROWSER_PARTITION = 'persist:mixdog-browser';
const DISCOVERY_FILE = 'browser-bridge.json';
const DISCOVERY_VERSION = 1;
/** The runtime treats a discovery file older than its freshness window as a
 *  crash leftover; the heartbeat keeps a live app's file always-fresh. */
const HEARTBEAT_MS = 60_000;
const OPEN_SURFACE_TIMEOUT_MS = 8_000;
const NAVIGATE_SETTLE_TIMEOUT_MS = 20_000;
const ACTION_SETTLE_QUIET_MS = 600;
const ACTION_SETTLE_LOAD_TIMEOUT_MS = 8_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const SNAPSHOT_MAX_ELEMENTS = 120;
const SNAPSHOT_TEXT_CHARS = 1_800;
const READ_DEFAULT_CHARS = 8_000;
const READ_MAX_CHARS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 8_000;
const SCREENSHOT_FALLBACK_TIMEOUT_MS = 2_000;
/** Offscreen (background) page viewport. Fixed and generous so fixed-width
 *  desktop layouts render without a scrollbar the agent can't see. */
const OFFSCREEN_VIEWPORT = { width: 1280, height: 900 };

interface BrowserCommand {
  action: string;
  url?: string;
  ref?: string;
  text?: string;
  submit?: boolean;
  key?: string;
  dy?: number;
  maxChars?: number;
  /** Run against a hidden offscreen page instead of the visible tab. Shares
   *  the same partition, so cookies/logins carry over. */
  background?: boolean;
}

interface BrowserCommandResult {
  text: string;
  image?: { mimeType: string; data: string };
}

interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  inViewport?: boolean;
}

interface SnapshotPayload {
  url: string;
  title: string;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
  elements: SnapshotElement[];
  headings: string[];
  text: string;
}

function mixdogDataDirectory(): string {
  return process.env.MIXDOG_DATA_DIR
    || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}

/** Agent navigation stays on the web: no file://, no chrome://, no app URLs. */
function normalizeAgentUrl(raw: string): string {
  const text = String(raw || '').trim();
  if (!text) throw new Error('navigate requires url');
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`invalid url: ${text}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`only http(s) navigation is allowed (got ${parsed.protocol})`);
  }
  return parsed.href;
}

/** Page-context snapshot expression. Assigns stable refs (e1, e2, …) to the
 *  visible interactive elements via window.__mixdogAgentRefs so click/fill can
 *  resolve them later; refs reset on every navigation with the page context. */
function snapshotExpression(): string {
  return `(() => {
    const MAX = ${SNAPSHOT_MAX_ELEMENTS};
    const refs = new Map();
    window.__mixdogAgentRefs = refs;
    const selector = [
      'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
      '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]',
      '[role="radio"]', '[role="combobox"]', '[role="menuitem"]',
      '[role="option"]', '[role="searchbox"]', '[role="textbox"]',
      '[role="switch"]', '[contenteditable="true"]',
    ].join(', ');
    const compact = (value, max) => String(value == null ? '' : value)
      .replace(/\\s+/g, ' ').trim().slice(0, max);
    const viewportHeight = window.innerHeight;
    const elements = [];
    let counter = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (elements.length >= MAX) break;
      const rects = el.getClientRects();
      if (!rects.length) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const ref = 'e' + (++counter);
      refs.set(ref, el);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role')
        || (tag === 'input' ? 'input(' + (el.getAttribute('type') || 'text') + ')'
          : tag === 'a' ? 'link' : tag);
      const name = compact(
        el.getAttribute('aria-label') || el.labels?.[0]?.textContent
        || el.innerText || el.value || el.getAttribute('placeholder')
        || el.getAttribute('title') || el.getAttribute('alt') || '', 80);
      const entry = { ref, role, name };
      if (tag === 'a') entry.href = compact(el.getAttribute('href') || '', 120);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        entry.value = compact(el.value || '', 60);
      }
      if (el.checked === true) entry.checked = true;
      if (el.disabled === true) entry.disabled = true;
      if (rect.bottom > 0 && rect.top < viewportHeight) entry.inViewport = true;
      elements.push(entry);
    }
    const headings = [...document.querySelectorAll('h1, h2, h3')]
      .slice(0, 15)
      .map((el) => compact(el.tagName.toLowerCase() + ' ' + (el.innerText || ''), 100))
      .filter((line) => line.length > 3);
    return {
      url: String(location.href),
      title: compact(document.title, 150),
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(document.documentElement.scrollHeight),
      viewportHeight: Math.round(viewportHeight),
      elements,
      headings,
      text: compact(document.body ? document.body.innerText : '', ${SNAPSHOT_TEXT_CHARS}),
    };
  })()`;
}

function formatSnapshot(payload: SnapshotPayload): string {
  const lines: string[] = [];
  lines.push(`Page: ${payload.title || '(untitled)'}`);
  lines.push(`URL: ${payload.url}`);
  const below = Math.max(0, payload.scrollHeight - payload.viewportHeight - payload.scrollY);
  lines.push(`Scroll: ${payload.scrollY}px down, ${below}px below the fold`);
  if (payload.headings.length) {
    lines.push('', 'Headings:');
    for (const heading of payload.headings) lines.push(`  ${heading}`);
  }
  if (payload.elements.length) {
    lines.push('', `Interactive elements (${payload.elements.length}${payload.elements.length >= SNAPSHOT_MAX_ELEMENTS ? ', capped' : ''}; * = in viewport):`);
    for (const el of payload.elements) {
      const parts = [
        `[${el.ref}]${el.inViewport ? '*' : ''}`,
        el.role,
        el.name ? JSON.stringify(el.name) : '""',
      ];
      if (el.href) parts.push(`href=${el.href}`);
      if (el.value !== undefined && el.value !== '') parts.push(`value=${JSON.stringify(el.value)}`);
      if (el.checked) parts.push('checked');
      if (el.disabled) parts.push('disabled');
      lines.push(`  ${parts.join(' ')}`);
    }
  }
  if (payload.text) lines.push('', 'Visible text (condensed):', payload.text);
  return lines.join('\n');
}

export interface BrowserHost {
  dispose(): Promise<void>;
}

export function createBrowserHost(window: BrowserWindow): BrowserHost {
  const token = randomBytes(24).toString('base64url');
  const guests = new Set<WebContents>();
  const attachedDebuggers = new WeakSet<WebContents>();
  let currentGuest: WebContents | null = null;
  let attachWaiters: Array<(guest: WebContents) => void> = [];
  let heartbeat: NodeJS.Timeout | null = null;
  let server: Server | null = null;
  let discoveryPath: string | null = null;
  let disposed = false;
  /** Commands run strictly one at a time; parallel CDP input dispatch against
   *  one page interleaves half-finished gestures. */
  let commandChain: Promise<unknown> = Promise.resolve();

  const browserPartitionSession = session.fromPartition(BROWSER_PARTITION);
  // Web-permission posture for agent-visited pages: quiet by default.
  browserPartitionSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
  });

  // Only the browser pane's own partition may attach a webview, and never
  // with a preload or node access, no matter what the renderer asked for.
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition !== BROWSER_PARTITION) {
      event.preventDefault();
      return;
    }
    delete (webPreferences as { preload?: string }).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  window.webContents.on('did-attach-webview', (_event, guest) => {
    if (guest.session !== browserPartitionSession) return;
    guests.add(guest);
    currentGuest = guest;
    // Popups collapse into the same tab: one visible page is the whole model,
    // for the user and the agent alike.
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void guest.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    guest.on('focus', () => {
      currentGuest = guest;
    });
    guest.once('destroyed', () => {
      guests.delete(guest);
      if (currentGuest === guest) currentGuest = [...guests].at(-1) ?? null;
    });
    const waiters = attachWaiters;
    attachWaiters = [];
    for (const resolve of waiters) resolve(guest);
  });

  function liveGuest(): WebContents | null {
    if (currentGuest && !currentGuest.isDestroyed()) return currentGuest;
    currentGuest = [...guests].find((guest) => !guest.isDestroyed()) ?? null;
    return currentGuest;
  }

  // Background target: a never-shown BrowserWindow on the SAME partition, so
  // the offscreen page is logged in exactly like the visible tab. Reused
  // across background commands; created lazily on first use.
  let offscreenWindow: BrowserWindow | null = null;
  function ensureOffscreen(): WebContents {
    if (offscreenWindow && !offscreenWindow.isDestroyed()) return offscreenWindow.webContents;
    // Never shown: the page runs fully (navigate/click/snapshot are JS, not
    // frames). Screenshots go through CDP Page.captureScreenshot, which renders
    // server-side in the Blink compositor and does not need an on-screen
    // surface — an invalidate() before capture forces the frame.
    const win = new BrowserWindow({
      show: false,
      width: OFFSCREEN_VIEWPORT.width,
      height: OFFSCREEN_VIEWPORT.height,
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Keep rendering/timers running while the window is hidden.
        backgroundThrottling: false,
      },
    });
    // Popups collapse into the same offscreen page — one page is the model.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void win.webContents.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    win.once('closed', () => { if (offscreenWindow === win) offscreenWindow = null; });
    offscreenWindow = win;
    return win.webContents;
  }

  /** No live webview → ask the renderer to present a browser surface and wait
   *  for its guest to attach. */
  async function ensureGuest(): Promise<WebContents> {
    const existing = liveGuest();
    if (existing) return existing;
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error('desktop window is unavailable');
    }
    const attached = new Promise<WebContents>((resolve) => attachWaiters.push(resolve));
    window.webContents.send(DESKTOP_IPC.browserOpenRequested);
    const guest = await Promise.race([
      attached,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), OPEN_SURFACE_TIMEOUT_MS)),
    ]);
    if (!guest) throw new Error('the browser pane did not open; open Utilities → Browser in the Mixdog desktop app');
    return guest;
  }

  function guestDebugger(guest: WebContents): Electron.Debugger {
    const cdp = guest.debugger;
    if (!attachedDebuggers.has(guest)) {
      cdp.attach('1.3');
      attachedDebuggers.add(guest);
      cdp.once('detach', () => attachedDebuggers.delete(guest));
    }
    return cdp;
  }

  async function evaluate<T>(guest: WebContents, expression: string): Promise<T> {
    const cdp = guestDebugger(guest);
    const response = await cdp.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: T; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text || 'page script failed';
      throw new Error(detail.split('\n')[0]);
    }
    return response.result?.value as T;
  }

  async function waitForLoadSettle(guest: WebContents, timeoutMs: number): Promise<void> {
    if (!guest.isLoading()) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        guest.removeListener('did-stop-loading', finish);
        resolve();
      };
      timer = setTimeout(finish, timeoutMs);
      guest.on('did-stop-loading', finish);
    });
  }

  /** Post-gesture settle: give the page a beat, then ride out any navigation
   *  it started, so the follow-up snapshot describes the outcome. */
  async function settleAfterAction(guest: WebContents): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ACTION_SETTLE_QUIET_MS));
    await waitForLoadSettle(guest, ACTION_SETTLE_LOAD_TIMEOUT_MS);
  }

  async function snapshotResult(guest: WebContents): Promise<BrowserCommandResult> {
    const payload = await evaluate<SnapshotPayload>(guest, snapshotExpression());
    return { text: formatSnapshot(payload) };
  }

  async function resolveRefPoint(
    guest: WebContents,
    ref: string,
  ): Promise<{ x: number; y: number }> {
    const point = await evaluate<{ error?: string; x?: number; y?: number }>(guest, `(() => {
      const el = window.__mixdogAgentRefs?.get(${JSON.stringify(ref)});
      if (!el || !el.isConnected) return { error: 'stale' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    if (!point || point.error || typeof point.x !== 'number' || typeof point.y !== 'number') {
      throw new Error(`ref ${ref} is stale or unknown; take a fresh snapshot first`);
    }
    return { x: point.x, y: point.y };
  }

  const KEY_TABLE: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
  };

  async function pressKey(guest: WebContents, rawKey: string): Promise<void> {
    const spec = KEY_TABLE[String(rawKey || '').trim().toLowerCase()];
    if (!spec) {
      throw new Error(`unsupported key "${rawKey}"; use one of: ${Object.keys(KEY_TABLE).join(', ')}`);
    }
    const cdp = guestDebugger(guest);
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    };
    await cdp.sendCommand('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
    if (spec.text) {
      await cdp.sendCommand('Input.dispatchKeyEvent', { ...base, type: 'char', text: spec.text });
    }
    await cdp.sendCommand('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  async function clickAt(guest: WebContents, cssX: number, cssY: number): Promise<void> {
    const cdp = guestDebugger(guest);
    // Element rects are CSS pixels, but CDP input coordinates are interpreted
    // in unzoomed widget pixels — under the pane's fit-width zoom the two
    // differ by exactly the zoom factor.
    const zoom = guest.getZoomFactor();
    const x = Math.round(cssX * zoom);
    const y = Math.round(cssY * zoom);
    const base = { x, y, button: 'left', clickCount: 1 };
    await cdp.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' });
    await cdp.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await cdp.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  }

  // Two capture engines with a per-target preferred order. On this platform a
  // hidden BrowserWindow renders through Electron's native capturePage()
  // instantly, while CDP Page.captureScreenshot never produces a frame for it
  // and only wastes its timeout; a visible <webview> tab is the reverse
  // (capturePage is unreliable when unfocused/split, CDP is solid). So each
  // target tries its fast path first and falls back to the other.
  async function captureViaCdp(guest: WebContents): Promise<string | null> {
    const cdp = guestDebugger(guest);
    try {
      const shot = await Promise.race([
        cdp.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 75 }) as Promise<{ data?: string }>,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('cdp screenshot timed out')), SCREENSHOT_TIMEOUT_MS)),
      ]);
      return shot?.data || null;
    } catch {
      return null;
    }
  }
  async function captureViaNative(guest: WebContents): Promise<string | null> {
    try {
      const image = await Promise.race([
        guest.capturePage(),
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('capturePage timed out')), SCREENSHOT_FALLBACK_TIMEOUT_MS)),
      ]);
      const jpeg = image.toJPEG(75);
      return jpeg && jpeg.length > 0 ? jpeg.toString('base64') : null;
    } catch {
      return null;
    }
  }
  async function captureScreenshotJpeg(guest: WebContents, background: boolean): Promise<string> {
    try { guest.invalidate(); } catch { /* teardown can reject repaint */ }
    const order = background
      ? [captureViaNative, captureViaCdp]
      : [captureViaCdp, captureViaNative];
    for (const engine of order) {
      const data = await engine(guest);
      if (data) return data;
    }
    throw new Error('screenshot capture failed');
  }

  async function runCommand(command: BrowserCommand): Promise<BrowserCommandResult> {
    const action = String(command.action || '').trim().toLowerCase();
    if (!action) throw new Error('browser command requires action');
    // Foreground drives the visible tab (auto-opened if needed); background
    // drives a hidden offscreen page on the same partition.
    const background = command.background === true;
    const guest = background ? ensureOffscreen() : await ensureGuest();
    switch (action) {
      case 'open':
        return { text: background ? 'Background browser page is ready.' : 'Browser pane is open.' };
      case 'navigate': {
        const url = normalizeAgentUrl(command.url || '');
        const load = guest.loadURL(url).catch((error: Error & { errno?: number }) => {
          // Aborted top-level loads (redirect chains, downloads) are not
          // failures of the command itself.
          if (!/ERR_ABORTED/.test(String(error?.message))) throw error;
        });
        // A load that fails AFTER the settle timeout won the race must not
        // become an unhandled rejection; the snapshot below shows the truth.
        load.catch(() => undefined);
        await Promise.race([
          load,
          new Promise<void>((resolve) => setTimeout(resolve, NAVIGATE_SETTLE_TIMEOUT_MS)),
        ]);
        return snapshotResult(guest);
      }
      case 'snapshot':
        return snapshotResult(guest);
      case 'click': {
        if (!command.ref) throw new Error('click requires ref (from snapshot)');
        const point = await resolveRefPoint(guest, command.ref);
        await clickAt(guest, point.x, point.y);
        await settleAfterAction(guest);
        return snapshotResult(guest);
      }
      case 'fill': {
        if (!command.ref) throw new Error('fill requires ref (from snapshot)');
        if (typeof command.text !== 'string') throw new Error('fill requires text');
        const outcome = await evaluate<{ error?: string; value?: string }>(guest, `(() => {
          const el = window.__mixdogAgentRefs?.get(${JSON.stringify(command.ref)});
          if (!el || !el.isConnected) return { error: 'stale' };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.focus();
          const text = ${JSON.stringify(command.text)};
          const tag = (el.tagName || '').toLowerCase();
          if (tag === 'input' || tag === 'textarea') {
            const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { value: el.value };
          }
          if (el.isContentEditable) {
            document.execCommand('selectAll', false, undefined);
            document.execCommand('insertText', false, text);
            return { value: text };
          }
          return { error: 'element is not editable' };
        })()`);
        if (outcome?.error) {
          throw new Error(outcome.error === 'stale'
            ? `ref ${command.ref} is stale or unknown; take a fresh snapshot first`
            : outcome.error);
        }
        if (command.submit) {
          await pressKey(guest, 'enter');
          await settleAfterAction(guest);
          return snapshotResult(guest);
        }
        return { text: `Filled ${command.ref}; value is now ${JSON.stringify(outcome?.value ?? '')}.` };
      }
      case 'press': {
        await pressKey(guest, command.key || '');
        await settleAfterAction(guest);
        return snapshotResult(guest);
      }
      case 'scroll': {
        const dy = Number.isFinite(command.dy) && command.dy !== 0
          ? Math.trunc(command.dy as number)
          : null;
        const position = await evaluate<{ scrollY: number; scrollHeight: number; viewportHeight: number }>(
          guest,
          `(() => {
            window.scrollBy({ top: ${dy === null ? 'Math.round(window.innerHeight * 0.8)' : String(dy)}, behavior: 'instant' });
            return {
              scrollY: Math.round(window.scrollY),
              scrollHeight: Math.round(document.documentElement.scrollHeight),
              viewportHeight: Math.round(window.innerHeight),
            };
          })()`,
        );
        const below = Math.max(0, position.scrollHeight - position.viewportHeight - position.scrollY);
        return { text: `Scrolled to ${position.scrollY}px; ${below}px remains below the fold. Take a snapshot to see the newly visible elements.` };
      }
      case 'back':
      case 'forward': {
        const history = guest.navigationHistory;
        const can = action === 'back' ? history.canGoBack() : history.canGoForward();
        if (!can) return { text: `Cannot go ${action}: no ${action === 'back' ? 'earlier' : 'later'} history entry.` };
        if (action === 'back') history.goBack();
        else history.goForward();
        await settleAfterAction(guest);
        return snapshotResult(guest);
      }
      case 'screenshot': {
        const data = await captureScreenshotJpeg(guest, background);
        return {
          text: `Screenshot of ${guest.getURL()}`,
          image: { mimeType: 'image/jpeg', data },
        };
      }
      case 'read': {
        const maxChars = Math.min(
          READ_MAX_CHARS,
          Number.isFinite(command.maxChars) && (command.maxChars as number) > 0
            ? Math.trunc(command.maxChars as number)
            : READ_DEFAULT_CHARS,
        );
        const page = await evaluate<{ url: string; title: string; text: string; total: number }>(guest, `(() => {
          const text = (document.body ? document.body.innerText : '')
            .replace(/\\n{3,}/g, '\\n\\n').trim();
          return {
            url: String(location.href),
            title: String(document.title || ''),
            text: text.slice(0, ${maxChars}),
            total: text.length,
          };
        })()`);
        const truncated = page.total > maxChars
          ? `\n\n[truncated: showing ${maxChars.toLocaleString()} of ${page.total.toLocaleString()} characters]`
          : '';
        return { text: `Page: ${page.title}\nURL: ${page.url}\n\n${page.text}${truncated}` };
      }
      default:
        throw new Error(`unknown browser action "${action}"`);
    }
  }

  function executeSerialized(command: BrowserCommand): Promise<BrowserCommandResult> {
    const run = commandChain.then(() => runCommand(command));
    commandChain = run.catch(() => undefined);
    return run;
  }

  async function readRequestBody(request: IncomingMessage): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
          reject(new Error('request too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  function respond(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }

  function writeDiscovery(port: number): void {
    const directory = mixdogDataDirectory();
    mkdirSync(directory, { recursive: true });
    discoveryPath = join(directory, DISCOVERY_FILE);
    writeFileSync(discoveryPath, `${JSON.stringify({
      version: DISCOVERY_VERSION,
      port,
      token,
      pid: process.pid,
      startedAt: Date.now(),
    })}\n`);
    try {
      chmodSync(discoveryPath, 0o600);
    } catch { /* Windows ACLs: the per-user data dir is already private */ }
  }

  function heartbeatDiscovery(port: number): void {
    if (!discoveryPath) return;
    try {
      const now = new Date();
      utimesSync(discoveryPath, now, now);
    } catch {
      // Another instance replaced or removed the file; reclaim it so the
      // runtime keeps talking to a bridge that is actually alive.
      try {
        writeDiscovery(port);
      } catch { /* data dir gone mid-shutdown */ }
    }
  }

  const listening = new Promise<void>((resolve) => {
    server = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/command') {
          respond(response, 404, { ok: false, error: 'not found' });
          return;
        }
        const auth = String(request.headers.authorization || '');
        if (auth !== `Bearer ${token}`) {
          respond(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        let command: BrowserCommand;
        try {
          command = JSON.parse(await readRequestBody(request)) as BrowserCommand;
        } catch (error) {
          respond(response, 400, { ok: false, error: `invalid request: ${(error as Error).message}` });
          return;
        }
        try {
          const value = await executeSerialized(command);
          respond(response, 200, { ok: true, value });
        } catch (error) {
          respond(response, 200, { ok: false, error: (error as Error).message || String(error) });
        }
      })().catch(() => {
        try {
          response.destroy();
        } catch { /* already gone */ }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (port) {
        try {
          writeDiscovery(port);
          heartbeat = setInterval(() => heartbeatDiscovery(port), HEARTBEAT_MS);
          heartbeat.unref?.();
        } catch (error) {
          console.error('browser bridge discovery write failed:', error);
        }
      }
      resolve();
    });
  });
  void listening;

  return {
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (offscreenWindow && !offscreenWindow.isDestroyed()) {
        try { offscreenWindow.destroy(); } catch { /* already gone */ }
      }
      offscreenWindow = null;
      if (discoveryPath) {
        // Only remove the file while it still describes THIS bridge.
        try {
          const current = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { token?: string };
          if (current?.token === token) unlinkSync(discoveryPath);
        } catch { /* replaced or already gone */ }
      }
      await new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
        // Idle keep-alive sockets must not hold shutdown hostage.
        server.closeAllConnections?.();
      });
    },
  };
}