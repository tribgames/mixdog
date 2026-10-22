/**
 * Electron half of the `visualize` tool: preview URLs reuse the editor's own
 * paths (local page server for HTML, LibreOffice conversion for Office files,
 * the media scheme for PDF/image/audio/video); annotations and captures act on
 * the panel the main window is drawing.
 */
import { basename, dirname } from 'node:path';
import type { BrowserWindow, NativeImage, WebContents } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract';
import {
  type DesktopVisualizeEvent,
  VISUALIZE_THUMBNAIL_MAX_BYTES,
  VISUALIZE_THUMBNAIL_MAX_WIDTH,
  type VisualizeHostEvent,
  type VisualizeTabView,
} from '../../shared/visualize';
import { INLINE_CHART_RENDERED } from '../../shared/visualize-inline-page';
import { visualizeInspectScript } from '../../shared/visualize-inspect';
import { inspectPageOffscreen, renderPageExportDetailed, VISIBLE_PASSWORD_SCRIPT } from './export-render';
import {
  chooseExportPath,
  type ExportRenderers,
  exportRenderers,
  exportTabBytes,
  thumbnailRenderers,
} from './host-export-path';
import { watchFile } from './host-file-watch';
import { createFeedbackHost } from './host-feedback';
import {
  bodyRectNow,
  captureWindowRect,
  capturedPng,
  desktopScreenState,
  leasePrefix,
  shownBody,
  windowAccess,
} from './host-frames';
import { inlinePageUrl, panePreviewUrl } from './host-pane-preview';
import { watchPageProblems } from './host-page-observer';
import { annotatePanes, inspectPanes, requireShownWindow, shownHtmlFrames } from './host-page-ops';
import { watchVisualizeZoomInput } from './host-zoom-input';
import { preparePaneFrame } from './host-pane-frame';
import { createVisualizeService, type VisualizeService } from './service';

export { resizePaneFramesScript, restorePaneFramesScript } from './host-page-ops';

/** annotate on a tab only a paired remote device is showing (internal: the
 *  marks are then drawn by that device from the tab state). */
export const REMOTE_ONLY_ANNOTATE = 'the tab is shown only on a paired remote device';

/** inspect on a tab only a paired remote device is showing: the reading runs
 *  in the desktop window's panes. */
export const REMOTE_ONLY_INSPECT =
  'inspect reads the page in the Mixdog desktop window, and this tab is shown only on a paired remote device; ask the user to open the visualize panel on the desktop, then retry';

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

/** Whether a page pane of the tab shows a password field now. */
async function showsPassword(window: BrowserWindow, tab: VisualizeTabView): Promise<boolean> {
  const frames = window.webContents.mainFrame.framesInSubtree;
  for (const pane of tab.panes) {
    if (pane.kind !== 'html' || !pane.url) continue;
    const prefix = leasePrefix(pane.url);
    for (const frame of frames) {
      if (frame.isDestroyed() || !frame.url.startsWith(prefix)) continue;
      if ((await frame.executeJavaScript(VISIBLE_PASSWORD_SCRIPT).catch(() => false)) === true) return true;
    }
  }
  return false;
}

/** A small bitmap of `image` for the settle comparison. */
function settleSample(image: NativeImage): Buffer {
  const { width } = image.getSize();
  return (
    width > THUMBNAIL_COMPARE_WIDTH ? image.resize({ width: THUMBNAIL_COMPARE_WIDTH, quality: 'good' }) : image
  ).toBitmap();
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
      image = await captureWindowRect(window, rect);
      if (signal.aborted) return null;
      const sample = settleSample(image);
      if (previous?.equals(sample)) return image;
      previous = sample;
    }
    if (!last) await wait(THUMBNAIL_QUIET_MS, signal);
  }
  return signal.aborted ? null : image;
}

/** A downscaled PNG within the card thumbnail caps: the widest of a few steps
 *  (never above VISUALIZE_THUMBNAIL_MAX_WIDTH) that fits
 *  VISUALIZE_THUMBNAIL_MAX_BYTES; null when none does or the image is empty. */
export function fitVisualizeThumbnail(image: NativeImage): Buffer | null {
  if (image.isEmpty()) return null;
  // A tall picture (a whole page, stacked document pages) keeps its top at
  // the card's 16:10, which is what the card shows anyway.
  const size = image.getSize();
  const height = Math.min(size.height, Math.ceil((size.width * 10) / 16));
  if (height < size.height) image = image.crop({ x: 0, y: 0, width: size.width, height });
  const { width } = image.getSize();
  for (const step of [VISUALIZE_THUMBNAIL_MAX_WIDTH, 256, 200, 160]) {
    const png = (width > step ? image.resize({ width: step, quality: 'good' }) : image).toPNG();
    if (png.length <= VISUALIZE_THUMBNAIL_MAX_BYTES) return png;
  }
  return null;
}

/** The tab's chat-card picture: the panel's own rendering when the tab is
 *  on screen; otherwise its first pane file stands in (an image itself, the
 *  OS thumbnail of a PDF or video); null when nothing can, or once `signal`
 *  aborts (a newer job, revision or a closed tab). */
async function cardThumbnail(
  window: BrowserWindow | null,
  sessionId: string,
  tab: VisualizeTabView,
  targets: Array<{ kind: string; path: string }>,
  signal: AbortSignal
): Promise<Buffer | null> {
  if (window?.isVisible() && !window.isMinimized()) {
    const image = await settledBodyImage(window, sessionId, tab, signal);
    // A page showing a password field is never pictured (nor stood in for).
    if (image && (await showsPassword(window, tab))) return null;
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
    .createThumbnailFromPath(first.path, {
      width: VISUALIZE_THUMBNAIL_MAX_WIDTH,
      height: VISUALIZE_THUMBNAIL_MAX_WIDTH,
    })
    .catch(() => null);
  return image ? fitVisualizeThumbnail(image) : null;
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
  const { live: liveWindow, require: requireWindow } = windowAccess(options.window);
  // Only when a remote device is the sole viewer does an error say so.
  const viewer = {
    requireWindow,
    remoteViewing: async (sessionId: string) => Boolean(await options.remoteViewing?.(sessionId).catch(() => false)),
  };

  // Console output and frame navigations of the displayed pages arrive on the
  // main window's webContents; observed once per webContents.
  const observed = new WeakSet<WebContents>();
  const observePageProblems = (contents: WebContents) => {
    if (observed.has(contents)) return;
    observed.add(contents);
    watchPageProblems(contents, service);
    // A pane page that loaded again within its revision gets the tab's marks
    // back (the overlay lives on the page's window).
    contents.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
      if (isMainFrame) return;
      void import('electron').then(({ webFrameMain }) => {
        const frame = webFrameMain.fromId(processId, routingId);
        if (frame) void preparePaneFrame(frame, service);
      });
    });
  };

  /** PNG of the displayed tab body, as it is on screen. */
  const captureBody = async (sessionId: string, tab: VisualizeTabView): Promise<Buffer> => {
    const window = requireWindow();
    const rect = await shownBody(window, sessionId, tab);
    return capturedPng(await captureWindowRect(window, rect));
  };

  /** Rasterized pages of a pane's PDF / Office file, by the editor's own rasterizer. */
  const documentPages: ExportRenderers['documentPages'] = async (file, pages) => {
    const reply = (await options.invokeDesktopOperation('documentPreviewPagesIn', [
      dirname(file),
      basename(file),
      { pages },
    ])) as { pageCount: number; pages: Array<{ mime: string; base64: string }> };
    return {
      pageCount: reply.pageCount,
      pages: reply.pages.map((page) => ({ mime: page.mime, bytes: Buffer.from(page.base64, 'base64') })),
    };
  };

  const service: VisualizeService = createVisualizeService({
    ...(options.versionsDirectory ? { versions: { directory: options.versionsDirectory } } : {}),
    thumbnail: (sessionId, tab, targets, signal) => cardThumbnail(liveWindow(), sessionId, tab, targets, signal),
    // Audio and video need the panel (the capture fallback): no picture.
    async thumbnailOffscreen(_sessionId, tab, files, signal) {
      const png = await exportTabBytes(
        () => Promise.reject(new Error('only the panel can draw this tab')),
        tab,
        'png',
        0,
        { files, renderers: thumbnailRenderers({ ...exportRenderers, documentPages }, signal), tiles: true }
      );
      if (signal.aborted) return null;
      const { nativeImage } = await import('electron');
      return fitVisualizeThumbnail(nativeImage.createFromBuffer(png));
    },
    ...(options.sessionCwd ? { sessionCwd: options.sessionCwd } : {}),
    windowAvailable: () => liveWindow() !== null,
    browserAvailable: options.browserAvailable,
    publish(event: DesktopVisualizeEvent) {
      const contents = liveWindow()?.webContents;
      if (!contents) return;
      watchVisualizeZoomInput(contents);
      contents.send(DESKTOP_IPC.visualizeChanged, event);
    },
    publishHost: options.publishRemote,
    prepareInlinePage: (content) => inlinePageUrl(content, liveWindow()?.webContents, observePageProblems),
    preparePane: (target, workingDirectory) =>
      panePreviewUrl(target, workingDirectory, {
        contents: () => liveWindow()?.webContents,
        observe: observePageProblems,
        convertDocument: (cwd, rel) => options.invokeDesktopOperation('documentPreviewIn', [cwd, rel]),
      }),
    watch: watchFile,
    // Same guard as capture: never report marks nobody can see. A paired
    // device that alone shows the tab draws them from the tab state (null).
    async annotate(sessionId, tab, marks) {
      let window: BrowserWindow;
      try {
        window = await requireShownWindow(sessionId, tab, viewer, REMOTE_ONLY_ANNOTATE);
      } catch (error) {
        if (error instanceof Error && error.message === REMOTE_ONLY_ANNOTATE) return null;
        throw error;
      }
      return annotatePanes(window, tab, marks);
    },
    // Screen reading runs in the desktop window's own pane frames.
    async inspect(sessionId, tab, request) {
      const window = await requireShownWindow(sessionId, tab, viewer, REMOTE_ONLY_INSPECT);
      return inspectPanes(window, tab, request);
    },
    // Without the panel (an agent turn leaves it alone): a hidden window.
    async inspectOffscreen(pane, allowNetwork, { viewport, selector, roots }) {
      const read = await inspectPageOffscreen(
        pane.url,
        allowNetwork,
        visualizeInspectScript(selector ? { selector } : {}),
        { ...(viewport ? { viewport } : {}), roots }
      );
      return { result: read.data, problems: read.problems };
    },
    async ensureShown(sessionId, tab) {
      const window = requireWindow();
      await shownBody(window, sessionId, tab);
      await shownHtmlFrames(window, tab);
    },
    // On the desktop window, else on a paired remote device showing the session.
    async onScreen(sessionId, tab) {
      const window = liveWindow();
      const desktop = window ? await desktopScreenState(window, sessionId, tab) : 'hidden';
      if (desktop === 'visible' || (await viewer.remoteViewing(sessionId))) return 'visible';
      return desktop;
    },
    capture: captureBody,
    chooseExportPath: (request) => chooseExportPath(requireWindow, request),
    renderExport: (pane, format, allowNetwork, options) =>
      renderPageExportDetailed(pane.url, format, allowNetwork, options),
    exportBytes: (sessionId, tab, format, paneIndex, files, onPagesCut) =>
      exportTabBytes(
        () => captureBody(sessionId, tab),
        tab,
        format,
        paneIndex,
        files && { files, renderers: { ...exportRenderers, documentPages }, onPagesCut }
      ),
  });
  return Object.assign(service, createFeedbackHost(service, { live: liveWindow, require: requireWindow }));
}

export type DesktopVisualize = ReturnType<typeof createDesktopVisualize>;
