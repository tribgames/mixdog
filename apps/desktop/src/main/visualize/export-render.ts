/**
 * Renders one visualize page (a local page-server lease URL) off screen for an
 * export: the whole page as a PNG, or a PDF. The page runs in its own
 * throw-away window and in-memory session, cut off from the app, and — unless
 * its tab allowed network — from every address but its own lease's.
 */
import { randomUUID } from 'node:crypto';
import { localizeProblemText } from './page-problems';

/** Viewport width the page lays out at, and the tallest/widest PNG taken. */
const EXPORT_WIDTH = 1280;
const MAX_EXPORT_WIDTH = 4096;
const MAX_EXPORT_HEIGHT = 16384;
const RENDER_TIMEOUT_MS = 30_000;
/** Time for the page to lay out again after the window took its full size. */
const RESIZE_MS = 300;
/** Time for scripts and fonts to settle after the load event. */
const SETTLE_MS = 500;
/** Gap between asks of a page whether it has drawn (`options.ready`). */
const READY_POLL_MS = 50;

/** Whether the export window may make `url`'s request: its lease's own
 *  origin and inline `data:` / `blob:` / `about:` content always; any other
 *  http(s)/ws(s) address only when `allowNetwork`; no other scheme. */
export function exportRequestAllowed(leaseOrigin: string, url: string, allowNetwork: boolean): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (/^(?:data|blob|about):$/.test(target.protocol)) return true;
  if (!/^(?:https?|wss?):$/.test(target.protocol)) return false;
  return allowNetwork || target.host === new URL(leaseOrigin).host;
}

const clamp = (value: number, max: number): number => Math.min(Math.max(Math.ceil(value) || 1, 1), max);

/** Most physical pixels of one PNG: 40 MP is ~160 MB of RGBA. */
export const MAX_EXPORT_PIXELS = 40_000_000;

/** The CSS size a PNG of a page `width`×`height` (CSS px) is taken at, or the
 *  reason it is refused: the cap is on physical pixels (CSS size × scale
 *  factor squared), checked before the window is resized or anything is
 *  captured or encoded. */
export function planPngExport(
  width: number,
  height: number,
  scaleFactor: number
): { ok: true; width: number; height: number } | { ok: false; error: string } {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  const css = { width: clamp(width, MAX_EXPORT_WIDTH), height: clamp(height, MAX_EXPORT_HEIGHT) };
  const pixels = Math.ceil(css.width * scale) * Math.ceil(css.height * scale);
  if (pixels > MAX_EXPORT_PIXELS || Math.ceil(width) > MAX_EXPORT_WIDTH || Math.ceil(height) > MAX_EXPORT_HEIGHT) {
    return {
      ok: false,
      error: `page too large to export as PNG (${Math.ceil(width)}×${Math.ceil(height)} px at ${scale}× scale, over ${MAX_EXPORT_PIXELS / 1_000_000} megapixels); export as PDF or reduce the page height`,
    };
  }
  return { ok: true, ...css };
}

/** A page-server origin, with or without its lease token and trailing slash. */
const LOOPBACK_LEASE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/[\w-]{32})?\/?/g;

/** A page problem seen during an export render, as one line: no page-server
 *  URL (host port or lease token, with or without a trailing slash) and no
 *  host path (anything under `roots` is dropped, any other reduced to its
 *  file name) survives in it. */
export function exportProblemLine(kind: string, message: string, line = 0, roots: readonly string[] = []): string {
  const text = localizeProblemText(message, roots)
    .replace(LOOPBACK_LEASE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return line > 0 ? `${kind}: ${text} (line ${line})` : `${kind}: ${text}`;
}

/** The problem line of a finished or failed subresource request, or null when
 *  it is fine, was one this export blocked itself (`blockedIds`), was cancelled
 *  (`net::ERR_ABORTED`) or is the main page (reported by `did-fail-load`). */
export function failedRequestLine(
  details: { id: number; url: string; resourceType?: string; statusCode?: number; error?: string },
  blockedIds: ReadonlySet<number>,
  roots: readonly string[] = []
): string | null {
  if (blockedIds.has(details.id)) return null;
  const url = details.url.replace(/[?#].*/, '').slice(0, 160);
  if (typeof details.error === 'string') {
    if (details.resourceType === 'mainFrame' || details.error === 'net::ERR_ABORTED') return null;
    return exportProblemLine('failed request', `${details.error} ${url}`, 0, roots);
  }
  if (typeof details.statusCode === 'number' && details.statusCode >= 400) {
    return exportProblemLine('failed request', `HTTP ${details.statusCode} ${url}`, 0, roots);
  }
  return null;
}
const MAX_EXPORT_PROBLEMS = 10;

export async function renderPageExport(pageUrl: string, format: 'png' | 'pdf', allowNetwork: boolean): Promise<Buffer> {
  return (await renderPageExportDetailed(pageUrl, format, allowNetwork)).data;
}

/** The export plus what went wrong in the page while it rendered (uncaught
 *  errors and console errors/warnings, blocked requests, failed loads and
 *  subresources). `options.signal` aborts the render and destroys its window;
 *  `options.roots` are host folders kept out of every problem line.
 *  `options.ready` is a script the page answers `true` once it has drawn
 *  (polled after the load), or an error text when it cannot. */
export async function renderPageExportDetailed(
  pageUrl: string,
  format: 'png' | 'pdf',
  allowNetwork: boolean,
  options: { roots?: readonly string[]; signal?: AbortSignal; ready?: string } = {}
): Promise<{ data: Buffer; problems: string[] }> {
  const { screen } = await import('electron');
  return withOffscreenPage(pageUrl, allowNetwork, options, async (window) => {
    const contents = window.webContents;
    if (format === 'pdf') return contents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    // Size the window to the whole page and take what it shows. (Not the
    // DevTools screenshot: it never answers in a window that is not shown.)
    const size = (await contents.executeJavaScript(
      `({ width: Math.max(document.documentElement.scrollWidth, innerWidth), height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) })`
    )) as { width: number; height: number };
    const plan = planPngExport(size.width, size.height, screen.getDisplayMatching(window.getBounds()).scaleFactor);
    if (!plan.ok) throw new Error(plan.error);
    window.setContentSize(plan.width, plan.height);
    await new Promise((resolve) => setTimeout(resolve, RESIZE_MS));
    return (await contents.capturePage()).toPNG();
  });
}

/** The default size a page is read at off screen (`inspectPageOffscreen`). */
export const OFFSCREEN_VIEWPORT = { width: EXPORT_WIDTH, height: 900 };

/** Reads one visualize page off screen, laid out at `viewport`: the result of
 *  `script` in it (an inspection) plus the problems the page showed while it
 *  loaded. Nothing in the app window is shown or changed. */
export async function inspectPageOffscreen(
  pageUrl: string,
  allowNetwork: boolean,
  script: string,
  options: { viewport?: { width: number; height: number }; roots?: readonly string[]; signal?: AbortSignal } = {}
): Promise<{ data: unknown; problems: string[] }> {
  return withOffscreenPage(
    pageUrl,
    allowNetwork,
    { ...options, size: options.viewport ?? OFFSCREEN_VIEWPORT },
    (window) => window.webContents.executeJavaScript(script)
  );
}

/** In a page: whether it shows a password field (a sign-in form), which a
 *  card picture must never capture. */
export const VISIBLE_PASSWORD_SCRIPT = `[...document.querySelectorAll('input[type="password"]')].some((input) => {
  const box = input.getBoundingClientRect();
  const style = getComputedStyle(input);
  return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
})`;

/** The size a card picture's page is laid out at (the card's 16:10). */
export const THUMBNAIL_VIEWPORT = { width: EXPORT_WIDTH, height: 800 };
/** A card picture waits less after the load than an export: it has to be
 *  ready within a turn end's short wait, and a small picture of the first
 *  screen does not need late fonts. */
const THUMBNAIL_SETTLE_MS = 200;

/** A chat card's picture of one page off screen: its first screen at
 *  THUMBNAIL_VIEWPORT as a PNG (never the whole page). Rejects when the page
 *  shows a password field. */
export async function renderPageThumbnail(
  pageUrl: string,
  allowNetwork: boolean,
  options: { signal?: AbortSignal; ready?: string } = {}
): Promise<Buffer> {
  const read = await withOffscreenPage(
    pageUrl,
    allowNetwork,
    { ...options, size: THUMBNAIL_VIEWPORT, settleMs: THUMBNAIL_SETTLE_MS },
    async (window) => {
      if ((await window.webContents.executeJavaScript(VISIBLE_PASSWORD_SCRIPT)) === true) {
        throw new Error('the page shows a password field');
      }
      return (await window.webContents.capturePage()).toPNG();
    }
  );
  return read.data;
}

/** Loads `pageUrl` in a throw-away hidden window (own in-memory session, the
 *  lease-only request filter unless `allowNetwork`), lets it settle and runs
 *  `work` on it, collecting the page's problems meanwhile. One deadline covers
 *  the whole run; the window is always destroyed. */
async function withOffscreenPage<T>(
  pageUrl: string,
  allowNetwork: boolean,
  options: {
    roots?: readonly string[];
    signal?: AbortSignal;
    ready?: string;
    size?: { width: number; height: number };
    /** Time after the load (and `ready`) before `work`; SETTLE_MS by default. */
    settleMs?: number;
  },
  work: (window: import('electron').BrowserWindow) => Promise<T>
): Promise<{ data: T; problems: string[] }> {
  const roots = options.roots ?? [];
  options.signal?.throwIfAborted();
  const { BrowserWindow } = await import('electron');
  const origin = new URL(pageUrl).origin;
  const window = new BrowserWindow({
    show: false,
    width: options.size?.width ?? EXPORT_WIDTH,
    height: options.size?.height ?? 900,
    // A requested size is the page's own (no frame taken off it).
    ...(options.size ? { useContentSize: true } : {}),
    webPreferences: {
      // No `persist:` prefix: an in-memory session shared with nothing.
      partition: `visualize-export-${randomUUID()}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const contents = window.webContents;
  const problems: string[] = [];
  const blockedIds = new Set<number>();
  const note = (line: string) => {
    if (problems.length < MAX_EXPORT_PROBLEMS && !problems.includes(line)) problems.push(line);
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    contents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const allowed = exportRequestAllowed(origin, details.url, allowNetwork);
      if (!allowed) {
        blockedIds.add(details.id);
        note(exportProblemLine('blocked request', details.url.replace(/[?#].*/, '').slice(0, 120), 0, roots));
      }
      callback({ cancel: !allowed });
    });
    const noteRequest = (details: Parameters<typeof failedRequestLine>[0]) => {
      const line = failedRequestLine(details, blockedIds, roots);
      if (line) note(line);
    };
    contents.session.webRequest.onCompleted({ urls: ['<all_urls>'] }, noteRequest);
    contents.session.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, noteRequest);
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('console-message', (event) => {
      const { level, message, lineNumber } = event as unknown as { level: string; message: string; lineNumber: number };
      // Electron's own development-build advice is not a page problem.
      if (message.startsWith('%cElectron Security Warning')) return;
      if (level === 'warning' || level === 'error') note(exportProblemLine(level, message, lineNumber, roots));
    });
    contents.on('did-fail-load', (_event, _code, description, _url, isMainFrame) => {
      if (isMainFrame) note(exportProblemLine('load failed', description, 0, roots));
    });
    // One deadline for the whole render: a step that never settles (the
    // DevTools `Page.captureScreenshot` of a never-shown window does exactly
    // that) must fail the export visibly instead of hanging it.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the page took too long to render for the export')), RENDER_TIMEOUT_MS);
      options.signal?.addEventListener('abort', () => reject(new Error('the export was cancelled')), { once: true });
    });
    const render = async (): Promise<T> => {
      await window.loadURL(pageUrl);
      if (options.ready) {
        for (;;) {
          const state = await contents.executeJavaScript(options.ready);
          if (state === true) break;
          if (typeof state === 'string') throw new Error(state);
          await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? SETTLE_MS));
      return work(window);
    };
    const rendering = render();
    // The window is destroyed when the deadline wins: a late failure of the
    // abandoned render is not an unhandled rejection.
    rendering.catch(() => {});
    return { data: await Promise.race([rendering, deadline]), problems };
  } finally {
    clearTimeout(timer);
    window.destroy();
  }
}
