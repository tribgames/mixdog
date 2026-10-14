/**
 * Electron half of the `visualize` tool: preview URLs reuse the editor's own
 * paths (local page server for HTML, LibreOffice conversion for Office files,
 * the media scheme for PDF/image/audio/video); annotations and captures act on
 * the panel the main window is drawing.
 */
import { watch as watchFs } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { BrowserWindow, NativeImage, WebContents, WebFrameMain } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract';
import {
  type DesktopVisualizeEvent,
  VISUALIZE_THUMBNAIL_MAX_BYTES,
  VISUALIZE_THUMBNAIL_MAX_WIDTH,
  type VisualizeHostEvent,
  type VisualizeTabView,
} from '../../shared/visualize';
import { visualizeFeedbackScript, type VisualizeFeedbackRect } from '../../shared/visualize-feedback';
import { visualizeInspectScript } from '../../shared/visualize-inspect';
import { INLINE_CHART_RENDERED } from '../../shared/visualize-inline-page';
import { registerFilePreview } from '../file-preview';
import { localPageUrl, localVirtualPageUrl } from '../local-page-server';
import { renderPageExport, renderPageExportDetailed } from './export-render';
import { inlinePageFiles } from './inline-page';
import {
  createVisualizeGestureTokens,
  type VisualizeGestureTarget,
  visualizeGestureTarget,
  visualizePaneHitQuery,
} from './gestures';
import { visualizeOverlayScript, type VisualizeOverlayResult } from './overlay-script';
import { createVisualizeService, type RequesterFrame, type VisualizeService } from './service';

const DISPLAY_RETRIES = 12;
const DISPLAY_RETRY_MS = 150;
const NOT_ON_SCREEN =
  'the visualize tab is not on screen (its side panel is closed or its session is not shown); ask the user to open it, then retry';

/** annotate on a tab only a paired remote device is showing: marks exist in
 *  the desktop window alone, and remote panes draw pages without them. */
export const REMOTE_ONLY_ANNOTATE =
  'annotate draws its marks only in the Mixdog desktop window, and this tab is shown only on a paired remote device, which displays pages without marks; ask the user to open the visualize panel on the desktop, then retry';

/** inspect on a tab only a paired remote device is showing: the reading runs
 *  in the desktop window's panes. */
export const REMOTE_ONLY_INSPECT =
  'inspect reads the page in the Mixdog desktop window, and this tab is shown only on a paired remote device; ask the user to open the visualize panel on the desktop, then retry';

/** After a pane frame is resized, before the page is read (its layout and
 *  resize handlers settle). */
const RESIZE_SETTLE_MS = 350;

/** Main-window script: size the iframes of the given page-server leases to
 *  `size` (remembering their inline style); returns how many it resized. */
export function resizePaneFramesScript(prefixes: string[], size: { width: number; height: number }): string {
  return `(() => {
    const prefixes = ${JSON.stringify(prefixes)};
    let count = 0;
    for (const frame of document.querySelectorAll('[data-visualize-body] iframe')) {
      if (!prefixes.some((prefix) => frame.src.startsWith(prefix))) continue;
      if (frame.dataset.mixdogInspectStyle === undefined) frame.dataset.mixdogInspectStyle = frame.getAttribute('style') || '';
      for (const [name, value] of [['width', '${size.width}px'], ['min-width', '${size.width}px'], ['max-width', 'none'], ['height', '${size.height}px'], ['min-height', '${size.height}px'], ['max-height', 'none'], ['flex', 'none']]) {
        frame.style.setProperty(name, value, 'important');
      }
      count += 1;
    }
    return count;
  })()`;
}

/** Main-window script: undo `resizePaneFramesScript`. */
export function restorePaneFramesScript(prefixes: string[]): string {
  return `(() => {
    const prefixes = ${JSON.stringify(prefixes)};
    for (const frame of document.querySelectorAll('[data-visualize-body] iframe')) {
      if (!prefixes.some((prefix) => frame.src.startsWith(prefix)) || frame.dataset.mixdogInspectStyle === undefined) continue;
      const style = frame.dataset.mixdogInspectStyle;
      delete frame.dataset.mixdogInspectStyle;
      if (style) frame.setAttribute('style', style);
      else frame.removeAttribute('style');
    }
  })()`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A card picture is taken once two captures this far apart match… */
const THUMBNAIL_QUIET_MS = 400;
/** …or as the page looks after this many rounds (about 1.2 s): a page that
 *  never holds still (an animation) costs at most this many captures. */
const THUMBNAIL_SETTLE_ROUNDS = 4;
/** Captures are compared at this width: whether the picture still moves, not
 *  every pixel of a full-resolution bitmap. */
const THUMBNAIL_COMPARE_WIDTH = 64;

/** `sleep` that ends early once `signal` aborts. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

type BodyRect = { x: number; y: number; width: number; height: number };

/** The displayed tab body's rect right now, or null when it is not on screen. */
async function bodyRectNow(window: BrowserWindow, sessionId: string, tabId: string): Promise<BodyRect | null> {
  const query = `(() => {
    const nodes = document.querySelectorAll('[data-visualize-body]');
    for (const node of nodes) {
      if (node.dataset.visualizeSession !== ${JSON.stringify(sessionId)}) continue;
      if (node.dataset.visualizeTab !== ${JSON.stringify(tabId)}) continue;
      if (node.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width >= 1 && rect.height >= 1) return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }
    return null;
  })()`;
  return (await window.webContents.executeJavaScript(query)) as BodyRect | null;
}

/** Whether every page pane of the tab has loaded, and a chart page has
 *  drawn its last frame (ECharts `finished`, animations included). */
async function pagesReady(window: BrowserWindow, tab: VisualizeTabView): Promise<boolean> {
  const frames = window.webContents.mainFrame.framesInSubtree;
  for (const pane of tab.panes) {
    if (pane.kind !== 'html' || !pane.url) continue;
    const prefix = leasePrefix(pane.url);
    const frame = frames.find((candidate) => !candidate.isDestroyed() && candidate.url.startsWith(prefix));
    if (!frame) return false;
    const check =
      pane.inline?.kind === 'chart'
        ? `document.readyState === 'complete' && document.documentElement.hasAttribute(${JSON.stringify(INLINE_CHART_RENDERED)})`
        : `document.readyState === 'complete'`;
    if (!(await frame.executeJavaScript(check).catch(() => false))) return false;
  }
  return true;
}

/** A small bitmap of `image` for the settle comparison. */
function settleSample(image: NativeImage): Buffer {
  const { width } = image.getSize();
  return (width > THUMBNAIL_COMPARE_WIDTH ? image.resize({ width: THUMBNAIL_COMPARE_WIDTH, quality: 'good' }) : image).toBitmap();
}

/** The shown tab body once its picture holds still: pages loaded (charts
 *  done drawing), then two captures THUMBNAIL_QUIET_MS apart whose downscaled
 *  samples match. A page that never settles is taken as it is after the last
 *  round. Null when the tab is not (or no longer) on screen, or once `signal`
 *  aborts (checked between every step of every round). The picture returned
 *  is always a real full-size capture. */
export async function settledBodyImage(
  window: BrowserWindow,
  sessionId: string,
  tab: VisualizeTabView,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = pause
): Promise<NativeImage | null> {
  let image: NativeImage | null = null;
  let previous: Buffer | null = null;
  for (let round = 0; round < THUMBNAIL_SETTLE_ROUNDS; round += 1) {
    if (signal.aborted || window.isDestroyed()) return null;
    const rect = await bodyRectNow(window, sessionId, tab.id).catch(() => null);
    if (!rect || signal.aborted) return null;
    const last = round === THUMBNAIL_SETTLE_ROUNDS - 1;
    if (last || (await pagesReady(window, tab))) {
      if (signal.aborted) return null;
      const zoom = window.webContents.getZoomFactor();
      image = await window.webContents.capturePage({
        x: Math.round(rect.x * zoom),
        y: Math.round(rect.y * zoom),
        width: Math.max(1, Math.round(rect.width * zoom)),
        height: Math.max(1, Math.round(rect.height * zoom)),
      });
      if (signal.aborted) return null;
      const sample = settleSample(image);
      if (previous?.equals(sample)) return image;
      previous = sample;
    }
    if (!last) await wait(THUMBNAIL_QUIET_MS, signal);
  }
  return signal.aborted ? null : image;
}

/** `http://127.0.0.1:port/<token>/` of a local page URL: every page and asset
 *  of that lease shares it. */
function leasePrefix(url: string): string {
  const parsed = new URL(url);
  const token = parsed.pathname.split('/')[1] ?? '';
  return `${parsed.origin}/${token}/`;
}

/** A downscaled PNG within the card thumbnail caps: the widest of a few steps
 *  (never above VISUALIZE_THUMBNAIL_MAX_WIDTH) that fits
 *  VISUALIZE_THUMBNAIL_MAX_BYTES; null when none does or the image is empty. */
export function fitVisualizeThumbnail(image: NativeImage): Buffer | null {
  if (image.isEmpty()) return null;
  const { width } = image.getSize();
  for (const step of [VISUALIZE_THUMBNAIL_MAX_WIDTH, 256, 200, 160]) {
    const png = (width > step ? image.resize({ width: step, quality: 'good' }) : image).toPNG();
    if (png.length <= VISUALIZE_THUMBNAIL_MAX_BYTES) return png;
  }
  return null;
}

async function retry<T>(find: () => Promise<T | null> | T | null): Promise<T> {
  for (let attempt = 0; attempt < DISPLAY_RETRIES; attempt += 1) {
    const found = await find();
    if (found) return found;
    await sleep(DISPLAY_RETRY_MS);
  }
  throw new Error(NOT_ON_SCREEN);
}

export function createDesktopVisualize(options: {
  window(): BrowserWindow | null;
  invokeDesktopOperation(method: string, args: unknown[]): Promise<unknown>;
  browserAvailable(): boolean;
  /** Mirror every change to the daemon for paired remote clients. */
  publishRemote?(event: VisualizeHostEvent): void;
  /** Whether a paired remote device is showing this session's visualize tabs. */
  remoteViewing?(sessionId: string): Promise<boolean>;
  /** Version history folder (the app's data folder); absent = no history. */
  versionsDirectory?: string;
  /** A session's working directory (reopening a closed tab from its card). */
  sessionCwd?(sessionId: string): Promise<string | null>;
}) {
  const liveWindow = (): BrowserWindow | null => {
    const window = options.window();
    return window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window : null;
  };
  const requireWindow = (): BrowserWindow => {
    const window = liveWindow();
    if (!window) throw new Error('the Mixdog desktop window is not open');
    return window;
  };
  const htmlFrames = (window: BrowserWindow, tab: VisualizeTabView): Array<{ pane: string; frame: WebFrameMain }> => {
    const frames = window.webContents.mainFrame.framesInSubtree;
    const found: Array<{ pane: string; frame: WebFrameMain }> = [];
    for (const pane of tab.panes) {
      if (pane.kind !== 'html') continue;
      const prefix = leasePrefix(pane.url);
      for (const frame of frames) {
        if (!frame.isDestroyed() && frame.url.startsWith(prefix)) found.push({ pane: pane.label, frame });
      }
    }
    return found;
  };

  /** The tab body's rect once it is really on screen: window shown and not
   *  minimized, panel open, session and tab displayed. Throws otherwise. */
  const shownBody = async (window: BrowserWindow, sessionId: string, tab: VisualizeTabView): Promise<BodyRect> => {
    if (window.isMinimized() || !window.isVisible()) {
      throw new Error('the Mixdog window is minimized or hidden; restore it, then retry');
    }
    return retry(() => bodyRectNow(window, sessionId, tab.id));
  };

  /** The tab's chat-card picture: the panel's own rendering when the tab is
   *  on screen; otherwise its first pane file stands in (an image itself, the
   *  OS thumbnail of a PDF or video); null when nothing can, or once `signal`
   *  aborts (a newer job, revision or a closed tab). */
  const thumbnailOf = async (
    sessionId: string,
    tab: VisualizeTabView,
    targets: Array<{ kind: string; path: string }>,
    signal: AbortSignal
  ): Promise<Buffer | null> => {
    const window = liveWindow();
    if (window && window.isVisible() && !window.isMinimized()) {
      const image = await settledBodyImage(window, sessionId, tab, signal);
      const png = image ? fitVisualizeThumbnail(image) : null;
      if (png) return png;
    }
    if (signal.aborted) return null;
    const first = targets[0];
    if (!first || !['image', 'pdf', 'video'].includes(first.kind)) return null;
    const { nativeImage } = await import('electron');
    if (first.kind === 'image') return fitVisualizeThumbnail(nativeImage.createFromPath(first.path));
    // PDF / video: the OS thumbnail (Windows and macOS only; elsewhere the
    // card keeps its kind icon).
    const image = await nativeImage
      .createThumbnailFromPath(first.path, { width: VISUALIZE_THUMBNAIL_MAX_WIDTH, height: VISUALIZE_THUMBNAIL_MAX_WIDTH })
      .catch(() => null);
    return image ? fitVisualizeThumbnail(image) : null;
  };

  // HTML panes are iframes of the main window, so their console output and
  // frame navigations arrive on its webContents; the service keeps only what
  // belongs to a displayed page. Observed once per webContents.
  const observed = new WeakSet<WebContents>();
  const observePageProblems = (contents: WebContents) => {
    if (observed.has(contents)) return;
    observed.add(contents);
    contents.on('console-message', (event) => {
      const frame = event.frame;
      service.reportConsole({
        level: event.level,
        message: event.message,
        sourceId: event.sourceId,
        lineNumber: event.lineNumber,
        frameUrl: frame && !frame.isDestroyed() ? frame.url : '',
      });
    });
    // Chromium logs a failed subresource load ("Failed to load resource") to
    // the devtools console only, never to `console-message`; the network
    // layer is the reliable source for a page's missing styles, scripts,
    // images and fonts. The service keeps only those of a displayed page's
    // page-server lease.
    const requests = contents.session.webRequest;
    // Pages run scripts, so their outside network is cut here, in main, where
    // the page cannot reach: a request is refused when the frame that made it
    // (or an ancestor, or its referrer) is a visualize lease whose tab has not
    // allowed network. Every other request — the app, the browser panel,
    // other windows — is left alone.
    // The session is shared by every webContents using it, so a request counts
    // only when the main window made it: the URLs of its requesting frame and
    // that frame's ancestors (and the referrer). Another webContents' requests
    // yield none and are never judged or reported.
    const frameChain = (start: WebFrameMain | null | undefined): RequesterFrame[] => {
      const chain: RequesterFrame[] = [];
      try {
        for (let frame = start; frame && !frame.isDestroyed(); frame = frame.parent) {
          chain.push({ url: frame.url, id: frame.frameTreeNodeId });
        }
      } catch {
        // A frame going away mid-request: judge by what was read.
      }
      return chain;
    };
    const requesterOrigins = (details: {
      webContentsId?: number;
      frame?: WebFrameMain | null;
      referrer: string;
    }): RequesterFrame[] => {
      if (details.webContentsId !== contents.id) return [];
      const chain = frameChain(details.frame);
      if (details.referrer) chain.push(details.referrer);
      return chain;
    };
    // A pane frame may not navigate itself away from its lease (a link, a
    // `location` assignment, a `blob:`/`data:` URL): that would hand the page
    // an origin the request guard no longer recognizes by URL. Navigations the
    // app starts itself (it points the iframe) are initiated by the main frame.
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame || !event.frame) return;
      const appInitiated = event.initiator ? event.initiator.parent === null : false;
      if (service.guardNavigation(frameChain(event.frame), event.url, appInitiated)) event.preventDefault();
    });
    requests.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      callback({
        cancel: service.guardRequest(requesterOrigins(details), { url: details.url, resourceType: details.resourceType }),
      });
    });
    const isAsset = (type: string) => type !== 'mainFrame' && type !== 'subFrame';
    requests.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      if (details.statusCode >= 400 && isAsset(details.resourceType)) {
        service.reportAssetFailure(details.url, `${details.statusCode}`, requesterOrigins(details));
      }
    });
    requests.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      // An aborted request is a navigation or a removed element, not a missing file.
      if (isAsset(details.resourceType) && details.error !== 'net::ERR_ABORTED') {
        service.reportAssetFailure(details.url, details.error, requesterOrigins(details));
      }
    });
    contents.on('did-frame-navigate', (_event, url, httpResponseCode, _statusText, isMainFrame) => {
      if (!isMainFrame) service.reportNavigation(url, httpResponseCode);
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is a navigation that was superseded, not a failure.
      if (!isMainFrame && code !== -3) service.reportLoadFailure(url, description);
    });
  };

  /** PNG of the displayed tab body, as it is on screen. */
  const captureBody = async (sessionId: string, tab: VisualizeTabView): Promise<Buffer> => {
    const window = requireWindow();
    const rect = await shownBody(window, sessionId, tab);
    const zoom = window.webContents.getZoomFactor();
    const image = await window.webContents.capturePage({
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(1, Math.round(rect.width * zoom)),
      height: Math.max(1, Math.round(rect.height * zoom)),
    });
    if (image.isEmpty()) throw new Error('the capture came back empty; make sure the Mixdog window is visible');
    return image.toPNG();
  };

  const service: VisualizeService = createVisualizeService({
    ...(options.versionsDirectory ? { versions: { directory: options.versionsDirectory } } : {}),
    thumbnail: thumbnailOf,
    ...(options.sessionCwd ? { sessionCwd: options.sessionCwd } : {}),
    windowAvailable: () => liveWindow() !== null,
    browserAvailable: options.browserAvailable,
    publish(event: DesktopVisualizeEvent) {
      liveWindow()?.webContents.send(DESKTOP_IPC.visualizeChanged, event);
    },
    publishHost: options.publishRemote,
    async prepareInlinePage(content) {
      // A chart / html sketch as a virtual page: its own lease (opaque origin,
      // scripts on), the same problem capture and network guard as file pages.
      const contents = liveWindow()?.webContents;
      if (contents) observePageProblems(contents);
      return localVirtualPageUrl(await inlinePageFiles(content), { owner: contents, async authorize() {} });
    },
    async preparePane(target, workingDirectory) {
      // Targets arrive symlink-resolved; so must the root they are relative to.
      const cwd = await realpath(workingDirectory);
      const rel = relative(cwd, target.path).split(sep).join('/');
      if (target.kind === 'html') {
        const contents = liveWindow()?.webContents;
        if (contents) observePageProblems(contents);
        // The project scope serves the page's own styles, scripts and media
        // from the working directory; the lease dies with the window.
        return localPageUrl(cwd, rel, {
          scope: 'project',
          owner: liveWindow()?.webContents,
          async authorize() {},
        });
      }
      if (target.kind === 'document') {
        const converted = (await options.invokeDesktopOperation('documentPreviewIn', [cwd, rel])) as {
          path: string;
          mtimeMs: number;
          size: number;
        };
        const preview = registerFilePreview(converted.path, `${converted.mtimeMs}:${converted.size}`);
        if (!preview) throw new Error(`the converted preview of ${target.target} is unavailable`);
        return preview.url;
      }
      const info = await stat(target.path);
      // Rooted: every request re-resolves the file and refuses it once it no
      // longer lies inside cwd.
      const preview = registerFilePreview(target.path, `${info.mtimeMs}:${info.size}`, { root: cwd });
      if (!preview) throw new Error(`no in-app preview for ${target.target}`);
      return preview.url;
    },
    watch(path, onChange) {
      // Watch the folder: editors and generators often replace the file
      // (write + rename), which a watch on the file itself would lose.
      const name = basename(path);
      const comparable = process.platform === 'win32' || process.platform === 'darwin' ? name.toLowerCase() : name;
      try {
        const watcher = watchFs(dirname(path), { persistent: false }, (_event, changed) => {
          if (!changed) return onChange();
          const value = String(changed);
          if ((comparable === name ? value : value.toLowerCase()) === comparable) onChange();
        });
        watcher.on('error', () => {});
        return () => watcher.close();
      } catch {
        return () => {};
      }
    },
    async annotate(sessionId, tab, op) {
      // Same guard as capture: never report marks nobody can see.
      let window: BrowserWindow;
      try {
        window = requireWindow();
        await shownBody(window, sessionId, tab);
      } catch (error) {
        // Only when a remote device is the sole viewer does the result say so.
        if (await options.remoteViewing?.(sessionId).catch(() => false)) throw new Error(REMOTE_ONLY_ANNOTATE);
        throw error;
      }
      const frames = await retry(() => {
        const found = htmlFrames(window, tab);
        return found.length ? found : null;
      });
      return Promise.all(
        frames.map(async ({ pane, frame }) => ({
          pane,
          result: (await frame.executeJavaScript(visualizeOverlayScript(op))) as VisualizeOverlayResult,
        }))
      );
    },
    async inspect(sessionId, tab, { viewport, selector }) {
      // Screen reading runs in the desktop window's own pane frames.
      let window: BrowserWindow;
      try {
        window = requireWindow();
        await shownBody(window, sessionId, tab);
      } catch (error) {
        if (await options.remoteViewing?.(sessionId).catch(() => false)) throw new Error(REMOTE_ONLY_INSPECT);
        throw error;
      }
      const frames = await retry(() => {
        // The pane frames themselves, not frames nested inside a page.
        const found = htmlFrames(window, tab).filter(({ frame }) => frame.parent !== null && frame.parent.parent === null);
        return found.length ? found : null;
      });
      const script = visualizeInspectScript(selector ? { selector } : {});
      const read = () =>
        Promise.all(frames.map(async ({ pane, frame }) => ({ pane, result: (await frame.executeJavaScript(script)) as unknown })));
      if (!viewport) return read();
      // Lay the pane frames out at the requested size for the reading only:
      // the iframe elements live in the panel, so main sizes them there.
      const prefixes = [...new Set(tab.panes.filter((pane) => pane.kind === 'html').map((pane) => leasePrefix(pane.url)))];
      const sized = (await window.webContents.executeJavaScript(resizePaneFramesScript(prefixes, viewport))) as number;
      try {
        if (!sized) {
          throw new Error(
            `the panel could not lay the page out at ${viewport.width}×${viewport.height}; run inspect without a viewport to read it at its current size`
          );
        }
        await sleep(RESIZE_SETTLE_MS);
        return await read();
      } finally {
        await window.webContents.executeJavaScript(restorePaneFramesScript(prefixes)).catch(() => {});
      }
    },
    async ensureShown(sessionId, tab) {
      const window = requireWindow();
      await shownBody(window, sessionId, tab);
      await retry(() => {
        const found = htmlFrames(window, tab);
        return found.length ? found : null;
      });
    },
    capture: captureBody,
    async chooseExportPath({ directory, fallback, name, format }) {
      const { dialog } = await import('electron');
      const folder = await stat(directory).then(
        (info) => (info.isDirectory() ? directory : fallback),
        () => fallback
      );
      const result = await dialog.showSaveDialog(requireWindow(), {
        defaultPath: join(folder, name),
        filters: [{ name: format === 'png' ? 'PNG' : 'PDF', extensions: [format] }],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    renderExport: (pane, format, allowNetwork, options) => renderPageExportDetailed(pane.url, format, allowNetwork, options),
    async exportBytes(sessionId, tab, format, paneIndex) {
      const pane = tab.panes[paneIndex];
      // An HTML page is rendered whole off screen; a PDF viewer, image or
      // inline render (and a multi-pane tab) is what the panel shows now.
      if (pane?.kind === 'html' && (format === 'pdf' || tab.panes.length === 1)) {
        return renderPageExport(pane.url, format, tab.networkAllowed === true);
      }
      if (format === 'pdf') throw new Error('Save as PDF is for HTML pages');
      return captureBody(sessionId, tab);
    },
  });
  let cropping = false;
  // `data-choice` picks need a real gesture in their pane (gestures.ts),
  // observed here from the main window's own input, outside page control.
  const gestures = createVisualizeGestureTokens();
  const gestureWatched = new WeakSet<WebContents>();
  /** The visualize pane that holds keyboard focus, or null. */
  const paneOfFocus = (contents: WebContents): VisualizeGestureTarget | null => {
    let frame = contents.focusedFrame;
    if (!frame) return null;
    while (frame.parent?.parent) frame = frame.parent;
    // The panel's own document has focus: no pane does.
    if (!frame.parent || frame.isDestroyed()) return null;
    const url = frame.url;
    for (const state of service.snapshot()) {
      for (const tab of state.tabs) {
        const pane = tab.panes.findIndex((candidate) => candidate.kind === 'html' && url.startsWith(leasePrefix(candidate.url)));
        if (pane >= 0) return { sessionId: state.sessionId, tabId: tab.id, pane };
      }
    }
    return null;
  };
  const watchGestures = (window: BrowserWindow) => {
    const contents = window.webContents;
    if (gestureWatched.has(contents)) return;
    gestureWatched.add(contents);
    // A mouse release on a pane's frame itself (screen point → window CSS
    // px); panel UI over the frame is hit instead and mints nothing.
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseUp' || typeof mouse.globalX !== 'number' || typeof mouse.globalY !== 'number') return;
      const current = liveWindow();
      if (!current || current.webContents !== contents) return;
      const bounds = current.getContentBounds();
      const zoom = contents.getZoomFactor();
      const point = { x: (mouse.globalX - bounds.x) / zoom, y: (mouse.globalY - bounds.y) / zoom };
      gestures.track(
        contents.executeJavaScript(visualizePaneHitQuery(point)).then((answer: unknown) => {
          const hit = visualizeGestureTarget(answer);
          if (hit) gestures.mint(hit);
        })
      );
    });
    // Enter/Space with keyboard focus inside a pane.
    contents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat || (input.key !== 'Enter' && input.key !== ' ')) return;
      const hit = paneOfFocus(contents);
      if (hit) gestures.mint(hit);
    });
  };
  return Object.assign(service, {
    /** Runs the feedback page script (Comment pins, `data-choice` picks) in
     *  the tab's HTML panes: the panel's own frames only, not frames nested
     *  inside a page. Idempotent per page load. */
    async attachFeedback(sessionId: string, tabId: string): Promise<void> {
      const window = liveWindow();
      const tab = service.tabView(sessionId, tabId);
      if (!window || !tab) return;
      watchGestures(window);
      const script = visualizeFeedbackScript();
      await Promise.all(
        htmlFrames(window, tab)
          .filter(({ frame }) => frame.parent !== null && frame.parent.parent === null)
          .map(({ frame }) => frame.executeJavaScript(script).catch(() => false))
      );
    },
    /** Spend one real gesture made in this pane on a `data-choice` pick;
     *  false when the user made none there in the last second. */
    consumeChoiceGesture(target: VisualizeGestureTarget): Promise<boolean> {
      return gestures.consume(target);
    },
    /** Base64 PNG of an area of the main window given in CSS px (a pin's
     *  crop); the renderer paints secret fields over it. */
    async captureRect(rect: VisualizeFeedbackRect): Promise<string> {
      // One crop at a time, whatever the renderer asks.
      if (cropping) throw new Error('a visualize crop is already being captured');
      const window = requireWindow();
      cropping = true;
      try {
        const zoom = window.webContents.getZoomFactor();
        const image = await window.webContents.capturePage({
          x: Math.round(rect.x * zoom),
          y: Math.round(rect.y * zoom),
          width: Math.max(1, Math.round(rect.width * zoom)),
          height: Math.max(1, Math.round(rect.height * zoom)),
        });
        if (image.isEmpty()) throw new Error('the capture came back empty; make sure the Mixdog window is visible');
        return image.toPNG().toString('base64');
      } finally {
        cropping = false;
      }
    },
  });
}

export type DesktopVisualize = ReturnType<typeof createDesktopVisualize>;
