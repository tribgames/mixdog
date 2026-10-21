// The pane dock's visualize view: the agent `visualize` tool's tabs for one
// session. Main owns the tabs; this view draws the active one and reports the
// user's tab picks and closes. Capture finds the tab body by its data
// attributes, so they name the session and tab.
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  ListTree,
  Maximize2,
  MessageSquarePlus,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { DesktopApi, DesktopDocumentPreviewPages } from '../shared/contract';
import { type VisualizePaneSource, type VisualizePaneView, visualizeProblemLocation } from '../shared/visualize';
import { postToPage, visualizeFeedbackPageMessage, withVisualizeFeedbackScript } from '../shared/visualize-feedback';
import { visualizePaneMarks, withVisualizeOverlay } from '../shared/visualize-annotations';
import { t } from './i18n';
import { VisualizeIcon } from './visualize-icon';
import { visualizeCommentKind } from '../shared/visualize-comment-kinds';
import { announceVisualizeCommentMode, useVisualizeFeedbackBridge, VisualizeCommentLayer } from './VisualizeFeedback';
import { startElementPin, useVisualizeInspection, VisualizeElements } from './VisualizeElements';
import { VisualizeTweaksDrawer } from './VisualizeTweaks';
import { useVisualizeTweaksRevision, visualizeTabHasTweaks } from './visualize-tweaks-store';
import { loadSandboxedPage } from './sandboxed-page-preview';
import { servePageFetches, withPageFetchBridge } from './page-fetch-bridge';
import { serveFrameZoom, withFrameZoomBridge } from './visualize-frame-zoom';
import { useMediaSessionEpoch } from './remote-file-preview';
import { serveBlockedNetwork, withBlockedNetwork, withBlockedNetworkReporter } from './visualize-blocked-network';
import { DockHeaderRow } from './pane-dock-chrome';
import { InlinePaneContent } from './VisualizeInline';
import { useVisualizePanelExtras } from './VisualizePanelExtras';
import { VisualizeSource } from './VisualizeSource';
import { visualizePaneHasSource } from './visualize-source';
import { remoteInlinePageSource } from './visualize-inline-remote';
import {
  activateVisualizeTab,
  allowVisualizeReveal,
  closeVisualizeTab,
  markVisualizePanelHidden,
  markVisualizePanelShown,
  reportVisualizeBlockedNetwork,
  reportVisualizeRender,
  setVisualizePanelOnScreen,
  useVisualizeState,
  useVisualizeUpdatedTabs,
  visualizeHeaderActions,
  visualizePanesStacked,
  visualizeTabTooltip,
} from './visualize-store';
import { VISUALIZE_ZOOM_RANGE, visualizeZoomStyle, useVisualizeZoom } from './visualize-zoom';
import { setVisualizeSoloPane, useVisualizeSoloPane, visualizeSoloStep } from './visualize-solo-pane';
import { useZoomBarVisible, zoomBarAction } from './zoom-bar-pref';
import { ZoomPill } from './ZoomPill';
import { PREVIEW_ZOOM_PRESETS, stepSnapped } from './zoom-range';
import './visualize.css';

/** How long a reloaded page may take to run its page script before it is
 *  shown without its scroll position restored. */
const SCROLL_RESTORE_WAIT_MS = 1_500;
/** Lets the restored scroll reach the page and paint before the swap. */
const SCROLL_RESTORE_SETTLE_MS = 60;

interface BufferedFrameSpec {
  src: string;
  revision: number;
  /** Same value = same document (the file), so its scroll position carries over. */
  doc: string;
  id: number;
}

/** A pane frame that never blanks on a reload: the new content loads in a
 *  hidden second frame laid over the shown one and replaces it once loaded.
 *  A page of the same file gets the shown page's scroll position back first
 *  (the page script reports and sets it); other frames just swap. */
function BufferedFrame({
  src,
  revision,
  doc,
  page,
  title,
  className,
  sandbox,
  referrerPolicy,
}: {
  src: string;
  revision: number;
  doc: string;
  /** A live page running the feedback page script (scroll can be restored). */
  page: boolean;
  title: string;
  className?: string;
  sandbox?: string;
  referrerPolicy?: 'no-referrer';
}) {
  const ids = useRef(0);
  const [front, setFront] = useState<BufferedFrameSpec>({ src, revision, doc, id: 0 });
  const [back, setBack] = useState<BufferedFrameSpec | null>(null);
  const frontFrame = useRef<HTMLIFrameElement>(null);
  const backFrame = useRef<HTMLIFrameElement>(null);
  const scroll = useRef<{ x: number; y: number } | null>(null);
  const pageReady = useRef(false);
  const onReady = useRef<(() => void) | null>(null);
  /** What the pending page announced (`ready`, `tweaks`) before it was shown. */
  const announced = useRef<unknown[]>([]);
  const timers = useRef<number[]>([]);
  const clearTimers = () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    onReady.current = null;
  };

  // New content goes to the back frame; a newer one replaces a pending one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the shown spec is read at the moment the content changes
  useEffect(() => {
    if (src === front.src && revision === front.revision) {
      setBack(null);
      return;
    }
    ids.current += 1;
    const id = ids.current;
    setBack((pending) =>
      pending?.src === src && pending.revision === revision ? pending : { src, revision, doc, id }
    );
  }, [src, revision, doc]);

  // The shown page's scroll, as its page script reports it; the pending
  // page's `ready` says its script is there to take the restored scroll.
  useEffect(() => {
    if (!page) return undefined;
    const onMessage = (event: MessageEvent) => {
      if (!event.source) return;
      const message = visualizeFeedbackPageMessage(event.data);
      if (!message) return;
      if (message.type === 'scrolled' && event.source === frontFrame.current?.contentWindow) {
        scroll.current = { x: message.x, y: message.y };
      } else if (
        (message.type === 'ready' || message.type === 'tweaks') &&
        event.source === backFrame.current?.contentWindow
      ) {
        // Elements, Comment and Tweaks bind to the shown frame, which this one
        // is not yet: they get these again once it is (see the replay below).
        announced.current.push(event.data);
        if (message.type === 'ready') {
          pageReady.current = true;
          onReady.current?.();
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [page]);

  // A different pending frame starts clean; so does unmounting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pending frame's identity is the trigger
  useEffect(() => {
    pageReady.current = false;
    announced.current = [];
    return clearTimers;
  }, [back?.id]);

  // The swapped-in page announced itself while hidden, where the panels that
  // listen for `ready` (they match the shown frame) could not accept it:
  // announce it again, now from the frame that is shown. A `ready` that comes
  // later is accepted as it is.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the swap (a new shown frame) is the trigger
  useLayoutEffect(() => {
    const queued = announced.current;
    announced.current = [];
    const source = frontFrame.current?.contentWindow;
    if (!source) return;
    for (const data of queued) window.dispatchEvent(new window.MessageEvent('message', { data, source }));
  }, [front.id]);

  const swap = (spec: BufferedFrameSpec) => {
    clearTimers();
    if (spec.doc !== front.doc) scroll.current = null;
    setFront(spec);
    setBack(null);
  };
  const onBackLoad = () => {
    const pending = back;
    const frame = backFrame.current;
    if (!pending) return;
    const restore = scroll.current;
    if (!page || !frame || !restore || pending.doc !== front.doc) {
      swap(pending);
      return;
    }
    // The page script attaches after the load: wait for it (bounded), put the
    // document back where it was, give that a moment, then show the page.
    const place = () => {
      onReady.current = null;
      postToPage(frame, { type: 'scroll-to', x: restore.x, y: restore.y });
      timers.current.push(window.setTimeout(() => swap(pending), SCROLL_RESTORE_SETTLE_MS));
    };
    if (pageReady.current) place();
    else {
      onReady.current = place;
      timers.current.push(window.setTimeout(() => swap(pending), SCROLL_RESTORE_WAIT_MS));
    }
  };

  // `allow` lets a page's own video fullscreen button work; the sandbox still
  // isolates everything else.
  const frameProps = { title, className, sandbox, referrerPolicy, allow: 'fullscreen' };
  return (
    <div className="visualize-frame-stack">
      <iframe key={front.id} ref={frontFrame} src={front.src} {...frameProps} />
      {back ? (
        <iframe
          key={back.id}
          ref={backFrame}
          src={back.src}
          {...frameProps}
          className={`${className ?? ''} visualize-frame-pending`.trim()}
          aria-hidden="true"
          tabIndex={-1}
          onLoad={onBackLoad}
        />
      ) : null}
    </div>
  );
}

function PaneContent({ pane, revision = 0 }: { pane: VisualizePaneView; revision?: number }) {
  const doc = `${pane.target}\0${pane.version ?? ''}`;
  if (pane.kind === 'html') {
    // A project page from the tokenized loopback page server: its own origin,
    // never the app's, and no top-level navigation or popups.
    return (
      <BufferedFrame
        src={pane.url}
        revision={revision}
        doc={doc}
        page
        title={pane.label}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
        referrerPolicy="no-referrer"
      />
    );
  }
  // PDFs and converted Office documents use Chromium's built-in viewer,
  // which a sandboxed frame would refuse.
  if (pane.kind === 'pdf' || pane.kind === 'document') {
    return (
      <BufferedFrame
        src={pane.url}
        revision={revision}
        doc={doc}
        page={false}
        title={pane.label}
        className="visualize-document-frame"
      />
    );
  }
  if (pane.kind === 'image') return <img src={pane.url} alt={pane.label} />;
  if (pane.kind === 'audio') {
    // biome-ignore lint/a11y/useMediaCaption: agent-produced media carries no caption track.
    return <audio src={pane.url} controls />;
  }
  // biome-ignore lint/a11y/useMediaCaption: agent-produced media carries no caption track.
  return <video src={pane.url} controls />;
}

const DOCUMENT_PAGE_BATCH = 4;
type DocumentPages = DesktopDocumentPreviewPages['pages'];

/** The nearest ancestor of `node` that scrolls vertically, if any. */
function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** Whether `node` is shown and inside both the window and `scroller`'s box.
 *  Without a rendering engine (no checkVisibility) it counts as in view. */
function shownInView(node: HTMLElement, scroller: HTMLElement | null): boolean {
  if (typeof node.checkVisibility !== 'function') return true;
  if (!node.checkVisibility()) return false;
  const rect = node.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  return rect.bottom >= top && rect.top <= bottom;
}

/** A remote PDF / Office pane as page images (a phone shows no PDF in a
 *  frame): the first page at once, then the next batch as the end scrolls
 *  into view. `onFail` hands the pane back to the blob path when not even
 *  the first page could be had (an older host). */
function RemoteDocumentPages({
  label,
  read,
  onFail,
}: {
  label: string;
  read(pages: number[], maxWidth: number): Promise<DesktopDocumentPreviewPages>;
  onFail(): void;
}) {
  const [state, setState] = useState<{ pages: DocumentPages; count: number | null; error: string }>({
    pages: [],
    count: null,
    error: '',
  });
  const live = useRef(state);
  live.current = state;
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const box = useRef<HTMLDivElement>(null);
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const load = useCallback(() => {
    const current = live.current;
    const start = current.pages.length + 1;
    if (busy.current || current.error || (current.count !== null && start > current.count)) return;
    const end = current.count === null ? start : Math.min(current.count, start + DOCUMENT_PAGE_BATCH - 1);
    const pages = Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
    const width = Math.round((box.current?.clientWidth || 800) * (window.devicePixelRatio || 1));
    busy.current = true;
    read(pages, width).then(
      (result) => {
        busy.current = false;
        if (!alive.current) return;
        const added = result.pages.filter((page) => page.page >= start);
        setState({
          pages: [...current.pages, ...added].sort((left, right) => left.page - right.page),
          // No new page means nothing more will come: stop asking.
          count: added.length ? result.pageCount : current.pages.length,
          error: '',
        });
      },
      (reason: unknown) => {
        busy.current = false;
        if (!alive.current) return;
        if (!current.pages.length) onFail();
        else setState({ ...current, error: reason instanceof Error ? reason.message : String(reason) });
      }
    );
  }, [read, onFail]);
  // The next batch loads while the end of the list is in view (re-checked
  // per batch, so a short document keeps loading until it fills the pane),
  // on scroll and resize (each at most once per frame). No IntersectionObserver: while
  // one exists, Chromium runs a main-thread frame on every vsync for as long
  // as any animation runs in the window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new batch is the trigger
  useEffect(() => {
    if (!sentinel) return undefined;
    const scroller = scrollParent(sentinel);
    const check = () => {
      if (shownInView(sentinel, scroller)) load();
    };
    check();
    document.addEventListener('scroll', check, { capture: true, passive: true });
    window.addEventListener('resize', check);
    // A hidden pane shown again gives the sentinel a box.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
    observer?.observe(sentinel);
    return () => {
      document.removeEventListener('scroll', check, { capture: true });
      window.removeEventListener('resize', check);
      observer?.disconnect();
    };
  }, [sentinel, load, state.pages.length]);
  const finished = state.count !== null && state.pages.length >= state.count;
  return (
    <div ref={box} className="visualize-document-pages" role="document" aria-label={label}>
      {state.pages.map((page) => (
        <img
          key={page.page}
          src={`data:${page.mime};base64,${page.base64}`}
          width={page.width}
          height={page.height}
          alt={`${label} ${page.page}`}
        />
      ))}
      {state.error ? <div className="visualize-document-more">{state.error}</div> : null}
      {finished || state.error ? null : (
        <div ref={setSentinel} className="visualize-document-more">
          {t('Loading…')}
        </div>
      )}
    </div>
  );
}

/** A pane on a paired remote client: the host's pane URLs name its loopback
 *  servers, so the content arrives over the relay instead (a media-lane
 *  stream, a blob: URL, page images of a PDF / Office file, or a
 *  self-contained page in an opaque-origin frame whose own file requests the
 *  page bridge serves). Remounted on each revision, so a file change on the
 *  host re-fetches it. The agent's annotation marks come with the tab state
 *  and are drawn inside the page with the desktop's own overlay (CSS outlines
 *  while the page may not run scripts yet). */
function RemotePaneContent({
  pane,
  sessionId,
  tabId,
  index,
  load,
  networkAllowed,
  marks,
  revision = 0,
}: {
  pane: VisualizePaneView;
  sessionId: string;
  tabId: string;
  index: number;
  /** A page pane stays mounted across revisions and reads its file again
   *  (the same page keeps its frame); other panes remount per revision. */
  revision?: number;
  load: NonNullable<DesktopApi['visualizePaneSource']>;
  /** The desktop user allowed outside network for this tab's pages. */
  networkAllowed: boolean;
  /** This pane's annotation marks. */
  marks: Array<{ selector: string; label: string }>;
}) {
  const [source, setSource] = useState<VisualizePaneSource | null>(null);
  const [error, setError] = useState('');
  // Inline content rides the tab state; the pane remounts per revision.
  const inline = useRef(pane.inline);
  // A PDF / Office pane is drawn as page images when the host can make them.
  const readPages = window.mixdogDesktop?.visualizePanePages;
  const [pagesFailed, setPagesFailed] = useState(false);
  const asPages = (pane.kind === 'pdf' || pane.kind === 'document') && !pane.inline && !!readPages && !pagesFailed;
  const pages = useCallback(
    (list: number[], maxWidth: number) =>
      readPages
        ? readPages(sessionId, tabId, index, { pages: list, maxWidth })
        : Promise.reject(new Error('Page images are unavailable.')),
    [readPages, sessionId, tabId, index]
  );
  const pagesUnavailable = useCallback(() => setPagesFailed(true), []);
  // A media-lane URL embeds the media session: a reconnect resolves it again.
  // Only media panes use the lane; a page keeps its frame across reconnects.
  const sessionEpoch = useMediaSessionEpoch();
  const mediaEpoch = pane.kind === 'image' || pane.kind === 'audio' || pane.kind === 'video' ? sessionEpoch : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new media session and a page's revision are triggers
  useEffect(() => {
    if (asPages) return undefined;
    let alive = true;
    let url = '';
    (inline.current ? remoteInlinePageSource(inline.current) : load(sessionId, tabId, index)).then(
      (next) => {
        url = next.url ?? '';
        if (!alive) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        setError('');
        setSource(next);
      },
      (reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      }
    );
    return () => {
      alive = false;
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [load, sessionId, tabId, index, asPages, mediaEpoch, revision]);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const srcdoc = source?.srcdoc;
  // A revision's load is a new source object; the frame reloads only for a
  // different page (content identity, document, path), while the page's
  // fetch handler follows the latest load.
  const pageId = source?.contentId;
  const pagePath = source?.page;
  const servesFetches = !!source?.fetch;
  const fetchRef = useRef(source?.fetch);
  fetchRef.current = source?.fetch;
  // Marks change with the tab state; the page reloads to show the new set.
  const marksKey = JSON.stringify(marks);
  // Pages run at once, as on the desktop, and under the desktop's network
  // policy: outside network stays blocked until the desktop user allows it for
  // the tab (`networkAllowed`, carried in the tab state; a change reloads).
  // The feedback page script (Comment pins, `data-choice` picks) and the
  // annotation overlay ride inside the page: nothing on this client can reach
  // into the opaque frame. The page bridge answers the page's own fetch/XHR
  // of its project files.
  // biome-ignore lint/correctness/useExhaustiveDependencies: marksKey stands for marks; pageId is the page's identity
  useEffect(() => {
    if (!frame || srcdoc === undefined) return undefined;
    let page = withVisualizeOverlay(withVisualizeFeedbackScript(srcdoc), marks);
    if (servesFetches && pagePath !== undefined) page = withPageFetchBridge(page, pagePath);
    page = withFrameZoomBridge(page);
    const unload = loadSandboxedPage(
      frame,
      networkAllowed ? withBlockedNetworkReporter(page) : withBlockedNetwork(page)
    );
    const unserve = servesFetches
      ? servePageFetches(
          frame,
          (reference) => fetchRef.current?.(reference) ?? Promise.reject(new Error('The page is not loaded.'))
        )
      : undefined;
    const unzoom = serveFrameZoom(frame);
    // Reporting stays on either way: the frame's own CSP refuses some requests even when the tab allows network.
    const unblocked = serveBlockedNetwork(frame, (url, resource) =>
      reportVisualizeBlockedNetwork(sessionId, tabId, index, url, resource)
    );
    return () => {
      unload();
      unserve?.();
      unzoom();
      unblocked();
    };
  }, [frame, srcdoc, pageId, pagePath, servesFetches, marksKey, networkAllowed, sessionId, tabId, index]);
  if (asPages) return <RemoteDocumentPages label={pane.label} read={pages} onFail={pagesUnavailable} />;
  if (error && pane.inline) {
    // The interactive page could not be built here: the static render stands in.
    return (
      <div className="visualize-script-pane">
        <div className="visualize-script-gate" role="status">
          {t('The interactive view is unavailable here; showing a static render.')}
        </div>
        <InlinePaneContent pane={{ ...pane, kind: 'inline' }} />
      </div>
    );
  }
  if (error) return <div className="visualize-empty">{error}</div>;
  if (!source) return <div className="visualize-empty">{t('Loading…')}</div>;
  if (srcdoc !== undefined) {
    // Scripts run in an opaque origin: no access to this app, its storage or
    // its relay socket, and no outside network unless the tab allowed it (the
    // desktop's policy, as a CSP in the page). Forms (their submit handlers;
    // the CSP still refuses any form navigation) and alert/confirm work as on
    // the desktop.
    return (
      <iframe
        key="live"
        ref={setFrame}
        title={pane.label}
        sandbox="allow-scripts allow-forms allow-modals"
        referrerPolicy="no-referrer"
        allow="fullscreen"
      />
    );
  }
  return <PaneContent pane={{ ...pane, url: source.url ?? '' }} />;
}

type VisualizeTab = ReturnType<typeof useVisualizeState>['tabs'][number];

function problemOrigin(tab: VisualizeTab, problem: NonNullable<VisualizeTab['problems']>[number]): string {
  return [
    tab.panes.length > 1 ? tab.panes[problem.pane]?.label : '',
    typeof problem.version === 'number' ? t('kept v{{n}}', { n: problem.version }) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** How many tabs keep their page mounted: the shown one and the ones viewed
 *  just before it, so switching among them never reloads a page. */
export const VISUALIZE_KEPT_TABS = 4;

/** The tabs to keep mounted: `shown` first, then the recently viewed ones. */
export function visualizeKeptTabs(shown: string, recent: readonly string[]): string[] {
  const ids = shown ? [shown, ...recent.filter((id) => id !== shown)] : [...recent];
  return ids.slice(0, VISUALIZE_KEPT_TABS);
}

/** The tab strip fades an edge only while tabs lie past it (visualize.css). */
export function markVisualizeStripFades(strip: HTMLElement): void {
  const rest = strip.scrollWidth - strip.clientWidth - strip.scrollLeft;
  strip.toggleAttribute('data-fade-start', strip.scrollLeft > 1);
  strip.toggleAttribute('data-fade-end', rest > 1);
}

/** A split-view cell's tooltip: its file name, behind "vN" for a kept version
 *  (and "Live" beside one when comparing), then the full target. */
export function visualizePaneTitle(tab: Pick<VisualizeTab, 'compare' | 'panes'>, pane: VisualizePaneView): string {
  let marker = '';
  if (pane.version !== undefined) marker = `v${pane.version}`;
  else if (tab.compare) marker = t('Live');
  return [[marker, pane.label].filter(Boolean).join(' · '), pane.target].join('\n');
}

/** A split pane's hover chip: its file name, behind "vN" for a kept version. */
export function visualizePaneChipLabel(pane: Pick<VisualizePaneView, 'label' | 'version'>): string {
  return pane.version === undefined ? pane.label : `v${pane.version} · ${pane.label}`;
}

/** What one pane of a kept tab shows, and whether its frame is double-buffered. */
function visualizePaneContent({
  sessionId,
  shown,
  pane,
  index,
  live,
  sourceOn,
  remoteSource,
}: {
  sessionId: string;
  shown: VisualizeTab;
  pane: VisualizePaneView;
  index: number;
  live: boolean;
  sourceOn: boolean;
  remoteSource: DesktopApi['visualizePaneSource'];
}): { content: ReactNode; buffered: boolean; showSource: boolean } {
  const showSource = live && sourceOn && visualizePaneHasSource(pane);
  if (live && shown.missing) {
    // Desktop and paired device alike: the host reloads the tab (a new
    // revision) as soon as the file is back.
    return {
      content: (
        <div className="visualize-empty" role="status">
          {t('This file was removed. The tab reloads when it is back.')}
        </div>
      ),
      buffered: false,
      showSource,
    };
  }
  if (showSource) {
    return {
      content: <VisualizeSource pane={pane} sessionId={sessionId} tabId={shown.id} index={index} />,
      buffered: false,
      showSource,
    };
  }
  if (pane.kind === 'inline') {
    // Inline content travels in the tab state (host and remote
    // alike) and renders here in the same dead sandbox.
    return {
      content: (
        <InlinePaneContent
          pane={pane}
          onRendered={(error) => reportVisualizeRender(sessionId, shown.id, index, pane.renderId, error)}
        />
      ),
      buffered: false,
      showSource,
    };
  }
  if (remoteSource) {
    // A page keeps its frame until the new revision's page is
    // read (unchanged content: no reload at all).
    const buffered = pane.kind === 'html' && !pane.inline;
    return {
      content: (
        <RemotePaneContent
          pane={pane}
          sessionId={sessionId}
          tabId={shown.id}
          index={index}
          revision={buffered ? shown.revision : 0}
          load={remoteSource}
          networkAllowed={shown.networkAllowed === true}
          marks={visualizePaneMarks(shown.annotations, index)}
        />
      ),
      buffered,
      showSource,
    };
  }
  // Pane frames double-buffer a reload, so the cell survives it.
  return {
    content: <PaneContent pane={pane} revision={shown.revision} />,
    buffered: pane.kind === 'html' || pane.kind === 'pdf' || pane.kind === 'document',
    showSource,
  };
}

/** One pane of a kept tab: its content plus the split's name chip and enlarge button. */
function VisualizePaneCell({
  sessionId,
  shown,
  pane,
  index,
  live,
  solo,
  content,
  showSource,
  commenting,
  zoom,
  showSolo,
}: {
  sessionId: string;
  shown: VisualizeTab;
  pane: VisualizePaneView;
  index: number;
  live: boolean;
  solo: number | null;
  content: ReactNode;
  showSource: boolean;
  commenting: boolean;
  zoom: number;
  showSolo(index: number | null): void;
}) {
  // In the split, a click on a pane shows it alone — not while
  // commenting or reading source, and not on media (their controls
  // take clicks); the hover name chip works for every pane.
  const split = shown.panes.length > 1 && solo === null;
  const clickToSolo = split && !commenting && !showSource && pane.kind !== 'audio' && pane.kind !== 'video';
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a pointer shortcut; the name chip is the keyboard path
    <div
      className={`visualize-pane-cell${solo === index ? ' is-solo' : ''}${clickToSolo ? ' is-zoomable' : ''}`}
      data-visualize-pane={index}
      title={split ? visualizePaneTitle(shown, pane) : undefined}
      onClick={clickToSolo ? () => showSolo(index) : undefined}
    >
      {split ? (
        <button
          type="button"
          className="visualize-pane-chip"
          aria-label={`${visualizePaneChipLabel(pane)} — ${t('Show alone')}`}
          onClick={(event) => {
            event.stopPropagation();
            showSolo(index);
          }}
        >
          {visualizePaneChipLabel(pane)}
        </button>
      ) : null}
      {split ? (
        // Phone only (CSS): taps go into the page or video, so the cell needs its own always-visible button.
        <button
          type="button"
          className="visualize-pane-enlarge"
          aria-label={`${visualizePaneChipLabel(pane)} — ${t('Show alone')}`}
          onClick={(event) => {
            event.stopPropagation();
            showSolo(index);
          }}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      ) : null}
      <div className="visualize-pane-content">
        <div className="visualize-zoom-layer" style={visualizeZoomStyle(live ? zoom : 1, pane.kind)}>
          {content}
        </div>
        {live && visualizeCommentKind(pane.kind) && !showSource && (
          <VisualizeCommentLayer sessionId={sessionId} tab={shown} pane={pane} index={index} comment={commenting} />
        )}
      </div>
    </div>
  );
}

function problemCountLabel(count: number): string {
  return count === 1 ? t('1 error') : t('{{count}} errors', { count });
}

/** The header's tab strip, or the plain title while there are no tabs. */
function VisualizeTabStrip({
  sessionId,
  tabs,
  activeId,
  strip,
  updated,
  problemsOpen,
  onToggleProblems,
}: {
  sessionId: string;
  tabs: VisualizeTab[];
  activeId: string | undefined;
  strip: RefObject<HTMLDivElement | null>;
  updated: ReadonlySet<string>;
  problemsOpen: string;
  onToggleProblems(id: string, selected: boolean): void;
}) {
  if (!tabs.length) return <span className="dock-header-title">{t('Visualize')}</span>;
  return (
    <div
      ref={strip}
      className="visualize-tabs"
      role="tablist"
      aria-label={t('Visualize')}
      onScroll={(event) => markVisualizeStripFades(event.currentTarget)}
      onWheel={(event) => {
        // The vertical wheel drives the horizontal run, as on the pane strip
        // (a sideways wheel or trackpad already scrolls it natively).
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          event.currentTarget.scrollBy?.({ left: event.deltaY, behavior: 'auto' });
        }
      }}
    >
      {tabs.map((candidate) => {
        const selected = candidate.id === activeId;
        return (
          <div
            key={candidate.id}
            className={`browser-tab dock-header-chip${selected ? ' is-active' : ''}`}
            data-visualize-tab-id={candidate.id}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              className="browser-tab-select"
              title={visualizeTabTooltip(candidate)}
              onClick={() => activateVisualizeTab(sessionId, candidate.id)}
            >
              <VisualizeIcon size={14} aria-hidden="true" />
              <span>{candidate.label}</span>
              {updated.has(candidate.id) && !selected ? (
                <span className="visualize-tab-updated" role="img" aria-label={t('Updated')} title={t('Updated')} />
              ) : null}
            </button>
            {candidate.problems?.length ? (
              <button
                type="button"
                className="visualize-problem-badge"
                aria-expanded={selected && problemsOpen === candidate.id}
                title={t('Page problems')}
                onClick={() => onToggleProblems(candidate.id, selected)}
              >
                {problemCountLabel(candidate.problems.length)}
              </button>
            ) : null}
            <button
              type="button"
              className="browser-tab-close"
              aria-label={t('Close tab')}
              data-tooltip={t('Close tab')}
              onClick={() => closeVisualizeTab(sessionId, candidate.id)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The expanded page-problem list of the active tab. */
function VisualizeProblemList({ tab }: { tab: VisualizeTab }) {
  return (
    <ul className="visualize-problems" aria-label={t('Page problems')}>
      {(tab.problems ?? []).map((problem) => {
        const where = visualizeProblemLocation(problem);
        const origin = problemOrigin(tab, problem);
        return (
          <li key={`${problem.pane}:${problem.kind}:${problem.source}:${problem.line}:${problem.message}`}>
            {origin ? <span className="visualize-problem-origin">{origin}</span> : null}
            <span className="visualize-problem-kind">{problem.kind}</span>
            <span className="visualize-problem-message">{problem.message}</span>
            {where ? <code className="visualize-problem-source">{where}</code> : null}
            {problem.count > 1 ? <span className="visualize-problem-count">×{problem.count}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The zoom pill; while one pane is shown alone it also steps through the panes. */
function VisualizeZoomPill({
  tab,
  solo,
  paneCount,
  zoom,
  setZoom,
  showSolo,
}: {
  tab: VisualizeTab | null;
  solo: number | null;
  paneCount: number;
  zoom: number;
  setZoom(scale: number): void;
  showSolo(index: number | null): void;
}) {
  const positionTitle = tab && solo !== null ? visualizePaneTitle(tab, tab.panes[solo]) : '';
  return (
    <ZoomPill
      before={
        solo === null ? undefined : (
          <>
            <button
              type="button"
              className="browser-zoom-step"
              aria-label={t('Previous pane')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => showSolo(visualizeSoloStep(solo, paneCount, -1))}
            >
              <ChevronLeft size={14} aria-hidden="true" />
            </button>
            <span className="browser-zoom-position" title={positionTitle}>
              {solo + 1} / {paneCount}
            </span>
            <button
              type="button"
              className="browser-zoom-step"
              aria-label={t('Next pane')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => showSolo(visualizeSoloStep(solo, paneCount, 1))}
            >
              <ChevronRight size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="browser-zoom-step"
              aria-label={t('Side by side')}
              data-tooltip={t('Side by side (Esc)')}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => showSolo(null)}
            >
              <Columns3 size={14} aria-hidden="true" />
            </button>
          </>
        )
      }
      level={zoom}
      range={VISUALIZE_ZOOM_RANGE}
      presets={PREVIEW_ZOOM_PRESETS}
      step={(current, direction) => stepSnapped(current, direction, VISUALIZE_ZOOM_RANGE)}
      onChange={setZoom}
      lead={{ label: t('Fit to window'), checked: zoom === 1, onSelect: () => setZoom(1) }}
    />
  );
}

/** The tab strip's ref; keeps the selected tab in view when the strip scrolls,
 *  also once the strip has its final width (the panel opening or being resized
 *  narrows it). The run changes width with the strip and with the tab count. */
function useVisualizeStripReveal(active: boolean, tabId: string, stripTabs: number) {
  const strip = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab count is a trigger (a closed tab narrows the run)
  useEffect(() => {
    const element = strip.current;
    if (!active || !element) return;
    const reveal = () => {
      // The whole chip (its badge and close button too), not just the label.
      if (tabId) {
        element
          .querySelector<HTMLElement>('.browser-tab.is-active')
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      markVisualizeStripFades(element);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, tabId, stripTabs]);
  return strip;
}

/** The element's width, kept current while it is mounted (0 without one). */
function useElementWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const next = entries.at(-1)?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** Tells the main process the size of the panel's content while the panel is
 *  shown, so the agent's off-screen inspect / check lay pages out at it. */
function useReportPanelSize(element: HTMLElement | null, active: boolean) {
  useEffect(() => {
    const report = window.mixdogDesktop?.visualizePanelSize;
    if (!active || !element || !report || typeof ResizeObserver === 'undefined') return;
    const send = (box: { width: number; height: number }) => {
      if (box.width >= 1 && box.height >= 1) {
        void report({ width: Math.round(box.width), height: Math.round(box.height) }).catch(() => undefined);
      }
    };
    send(element.getBoundingClientRect());
    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect;
      if (box) send(box);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, active]);
}

/** Comment mode: off by default and per session; Esc or the toggle ends it.
 *  `commenting` is the mode on a tab with something to comment on; the toolbar
 *  action is there only for such a tab. */
function useVisualizeCommentMode(sessionId: string, tab: VisualizeTab | null, body: HTMLDivElement | null) {
  const [comment, setComment] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the reset trigger
  useEffect(() => setComment(false), [sessionId]);
  const commentKinds = (tab?.panes ?? []).filter((pane) => visualizeCommentKind(pane.kind)).map((pane) => pane.kind);
  const commentable = commentKinds.length > 0;
  // The mode explains itself once, as a toast; no bar stays under the header.
  const commenting = comment && commentable;
  // biome-ignore lint/correctness/useExhaustiveDependencies: turning the mode on is the trigger
  useEffect(() => {
    if (commenting) announceVisualizeCommentMode(commentKinds);
  }, [commenting]);
  useVisualizeFeedbackBridge({ sessionId, tab, body, comment: commenting, setComment });
  const commentAction = commentable
    ? [
        {
          id: 'comment',
          label: t('Comment'),
          icon: MessageSquarePlus,
          inline: true,
          checked: comment,
          onSelect: () => setComment(!comment),
        },
      ]
    : [];
  return { commenting, setComment, commentAction };
}

/** The Elements outline and the Tweaks drawer of the active tab, with their
 *  toolbar actions. */
function useVisualizeDrawers(sessionId: string, tab: VisualizeTab | null, body: HTMLDivElement | null) {
  const tabId = tab?.id ?? '';
  // Elements: the active HTML tab read as an outline, interactive elements and
  // layout findings; the findings count shows in the open view's heading.
  const [elementsOpen, setElementsOpen] = useState(false);
  const inspection = useVisualizeInspection({ body, tab, enabled: elementsOpen });
  const hasHtml = Boolean(tab?.panes.some((pane) => pane.kind === 'html'));
  const elementsAction = hasHtml
    ? [
        {
          id: 'elements',
          label: t('Elements'),
          icon: ListTree,
          checked: elementsOpen,
          checkbox: true,
          onSelect: () => {
            if (!elementsOpen) inspection.refresh();
            setElementsOpen(!elementsOpen);
          },
        },
      ]
    : [];

  // Tweaks: a toolbar button only while the active tab's page declares some;
  // it opens the controls drawer under the toolbar.
  useVisualizeTweaksRevision();
  const [tweaksOpen, setTweaksOpen] = useState(false);
  // A drawer or outline the user opened belongs to that tab: another tab starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active tab is the reset trigger
  useEffect(() => {
    setTweaksOpen(false);
    setElementsOpen(false);
  }, [sessionId, tabId]);
  const hasTweaks = tab ? visualizeTabHasTweaks(sessionId, tab) : false;
  const tweaksAction = hasTweaks
    ? [
        {
          id: 'tweaks',
          label: t('Tweaks'),
          icon: SlidersHorizontal,
          checked: tweaksOpen,
          checkbox: true,
          onSelect: () => setTweaksOpen(!tweaksOpen),
        },
      ]
    : [];
  return {
    elementsOpen,
    setElementsOpen,
    inspection,
    hasHtml,
    elementsAction,
    tweaksOpen,
    setTweaksOpen,
    hasTweaks,
    tweaksAction,
  };
}

/** While one pane is shown alone: ←/→ step through the panes, Esc returns to
 *  the split (comment mode keeps Esc for itself: it passes `active` false).
 *  Typing never switches. */
function useVisualizeSoloKeys({
  active,
  solo,
  sessionId,
  tabId,
  paneCount,
}: {
  active: boolean;
  solo: number | null;
  sessionId: string;
  tabId: string;
  paneCount: number;
}) {
  useEffect(() => {
    if (!active || solo === null) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'Escape') setVisualizeSoloPane(sessionId, tabId, null);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        setVisualizeSoloPane(sessionId, tabId, visualizeSoloStep(solo, paneCount, event.key === 'ArrowLeft' ? -1 : 1));
      } else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, solo, sessionId, tabId, paneCount]);
}

/** The recently viewed tabs stay mounted, hidden: switching back shows the
 *  page as it was instead of reloading it (an empty pane, then the page
 *  painting again). Only the shown body is the panel's body. */
function VisualizeBodies({
  sessionId,
  keptTabs,
  activeId,
  solo,
  stacked,
  bodyWidth,
  setBody,
  sourceOn,
  remoteSource,
  commenting,
  zoom,
  showSolo,
}: {
  sessionId: string;
  keptTabs: VisualizeTab[];
  activeId: string;
  solo: number | null;
  stacked: boolean;
  bodyWidth: number;
  setBody(element: HTMLDivElement | null): void;
  sourceOn: boolean;
  remoteSource: DesktopApi['visualizePaneSource'];
  commenting: boolean;
  zoom: number;
  showSolo(index: number | null): void;
}) {
  return (
    <div className="visualize-bodies">
      {keptTabs.map((shown) => {
        const live = shown.id === activeId;
        const shownCount = shown.panes.length;
        const shownSolo = live ? solo : null;
        const shownStacked = live ? stacked : visualizePanesStacked(bodyWidth, shownCount);
        return (
          <div
            key={shown.id}
            ref={live ? setBody : undefined}
            className={`visualize-body${shownStacked ? ' is-stacked' : ''}${shown.compare && shownCount > 2 && !shownStacked && shownSolo === null ? ' is-compare-grid' : ''}${shownSolo === null ? '' : ' is-solo'}`}
            data-kept={live ? undefined : ''}
            aria-hidden={live ? undefined : true}
            inert={live ? undefined : true}
            data-visualize-body={live ? '' : undefined}
            data-visualize-session={live ? sessionId : undefined}
            data-visualize-tab={live ? shown.id : undefined}
          >
            {shown.panes.map((pane, index) => {
              const { content, buffered, showSource } = visualizePaneContent({
                sessionId,
                shown,
                pane,
                index,
                live,
                sourceOn,
                remoteSource,
              });
              return (
                <VisualizePaneCell
                  // The revision remounts a pane when its file changed on disk
                  // (a buffered frame swaps in place instead).
                  // Panes are positional (pane N is the Nth file), never reordered.
                  key={buffered ? `${shown.id}:${index}` : `${shown.id}:${shown.revision}:${index}`}
                  sessionId={sessionId}
                  shown={shown}
                  pane={pane}
                  index={index}
                  live={live}
                  solo={shownSolo}
                  content={content}
                  showSource={showSource}
                  commenting={live && commenting}
                  zoom={zoom}
                  showSolo={showSolo}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** The shown tab and the last ones viewed before it, which stay mounted (hidden). */
function useKeptTabs(tabs: VisualizeTab[], tabId: string): VisualizeTab[] {
  const [recentTabs, setRecentTabs] = useState<string[]>([]);
  const keptIds = visualizeKeptTabs(
    tabId,
    recentTabs.filter((id) => tabs.some((candidate) => candidate.id === id))
  );
  const keptKey = keptIds.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keptKey carries keptIds
  useEffect(() => setRecentTabs(keptIds), [keptKey]);
  // State order, never the viewing order: a moved iframe would reload.
  return tabs.filter((candidate) => keptIds.includes(candidate.id));
}

/** Remembers whether the session's panel is on screen, and closes the panel
 *  when its last tab closes. */
function useVisualizePanelLifecycle(sessionId: string, active: boolean, tabCount: number, onClose: () => void) {
  // Remember whether this session's panel is on screen so a renderer reload
  // brings it back. Leaving the session is not hiding it; moving this pane's
  // dock to another view (or closing it) is.
  const shown = useRef({ sessionId: '', active: false });
  useEffect(() => {
    const previous = shown.current;
    if (active) markVisualizePanelShown(sessionId);
    else if (previous.active && previous.sessionId === sessionId) markVisualizePanelHidden(sessionId);
    shown.current = { sessionId, active };
    // On screen now: the open policy keeps the user's tab pick while it is.
    if (!active) return undefined;
    setVisualizePanelOnScreen(sessionId, true);
    return () => setVisualizePanelOnScreen(sessionId, false);
  }, [sessionId, active]);

  // Closing the last tab (the user's × or the agent's close) closes the
  // panel instead of leaving it empty. Unlike the header ×, the next agent
  // open may reveal it again.
  const seen = useRef({ sessionId, count: tabCount });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tab count reaching zero is the trigger; onClose is read at that moment
  useEffect(() => {
    const previous = seen.current;
    seen.current = { sessionId, count: tabCount };
    if (!active || previous.sessionId !== sessionId || previous.count === 0 || tabCount > 0) return;
    onClose();
    allowVisualizeReveal(sessionId);
  }, [sessionId, active, tabCount]);
}

export function VisualizePane({ sessionId, active, onClose }: { sessionId: string; active: boolean; onClose(): void }) {
  const state = useVisualizeState(sessionId);
  // Present only on a paired remote client.
  const remoteSource = window.mixdogDesktop?.visualizePaneSource;
  const tab = state.tabs.find((candidate) => candidate.id === state.active) ?? state.tabs.at(-1) ?? null;
  const tabId = tab?.id ?? '';
  // The tab whose page-problem list is expanded.
  const [problemsOpen, setProblemsOpen] = useState('');
  const toggleProblems = (id: string, selected: boolean) => {
    if (!selected) activateVisualizeTab(sessionId, id);
    setProblemsOpen(selected && problemsOpen === id ? '' : id);
  };

  useVisualizePanelLifecycle(sessionId, active, state.tabs.length, onClose);
  // Tabs opened or updated behind the user's pick wear a dot until viewed.
  const updated = useVisualizeUpdatedTabs(sessionId);

  // Keep the selected tab in view when the strip scrolls, also once the strip
  // has its final width (the panel opening or being resized narrows it).
  // The run changes width with the strip and with the tab count.
  const strip = useVisualizeStripReveal(active, tabId, state.tabs.length);

  // Panes stack when the body is too narrow to give each a usable width.
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const bodyWidth = useElementWidth(body);
  useReportPanelSize(body, active);
  // One pane of a split tab shown alone (visualize-solo-pane): the others stay
  // mounted (no page reloads), only hidden.
  const paneCount = tab?.panes.length ?? 0;
  const solo = useVisualizeSoloPane(sessionId, tabId, paneCount);
  const showSolo = (index: number | null) => setVisualizeSoloPane(sessionId, tabId, index);
  const visiblePanes = solo === null ? paneCount : 1;
  const stacked = tab ? visualizePanesStacked(bodyWidth, visiblePanes) : false;

  // The shown tab and the last ones viewed before it stay mounted (hidden).
  const keptTabs = useKeptTabs(state.tabs, tabId);

  // Content scale of the active tab; the zoom bar is a shared preference.
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const zoomBarVisible = useZoomBarVisible();
  const { scale: zoom, setScale: setZoom } = useVisualizeZoom({
    panel,
    // Not the revision: a reload of the tab's files keeps the user's zoom.
    scopeKey: tab ? `${sessionId}\0${tab.id}` : '',
    enabled: active && Boolean(tab),
  });
  const zoomable = Boolean(tab?.panes.some((pane) => pane.kind !== 'audio' && pane.kind !== 'video'));

  const { commenting, setComment, commentAction } = useVisualizeCommentMode(sessionId, tab, body);

  useVisualizeSoloKeys({ active: active && !commenting, solo, sessionId, tabId, paneCount });

  const {
    elementsOpen,
    setElementsOpen,
    inspection,
    hasHtml,
    elementsAction,
    tweaksOpen,
    setTweaksOpen,
    hasTweaks,
    tweaksAction,
  } = useVisualizeDrawers(sessionId, tab, body);

  // "All visuals", the source toggle and the export menu.
  const extras = useVisualizePanelExtras(sessionId, state, tab, Boolean(remoteSource));

  const left = (
    <VisualizeTabStrip
      sessionId={sessionId}
      tabs={state.tabs}
      activeId={tab?.id}
      strip={strip}
      updated={updated}
      problemsOpen={problemsOpen}
      onToggleProblems={toggleProblems}
    />
  );
  return (
    <section ref={setPanel} className="visualize-pane" aria-label={t('Visualize')} hidden={!active || undefined}>
      <DockHeaderRow
        className="session-diff-header"
        ariaLabel={t('Visualize')}
        left={left}
        actions={visualizeHeaderActions([
          ...extras.actions,
          ...elementsAction,
          ...tweaksAction,
          ...commentAction,
          zoomBarAction(),
        ])}
        onClose={onClose}
      />
      {tab?.problems?.length && problemsOpen === tab.id ? <VisualizeProblemList tab={tab} /> : null}
      {tab && hasTweaks && tweaksOpen ? (
        <VisualizeTweaksDrawer sessionId={sessionId} tab={tab} onHide={() => setTweaksOpen(false)} />
      ) : null}
      {extras.strips}
      {tab && hasHtml && elementsOpen ? (
        <VisualizeElements
          tab={tab}
          readings={inspection.readings}
          refresh={inspection.refresh}
          highlight={inspection.highlight}
          onClose={() => setElementsOpen(false)}
          onPin={(pane, selector) => startElementPin(tab.id, pane, selector, setComment)}
        />
      ) : null}
      {tab ? (
        <VisualizeBodies
          sessionId={sessionId}
          keptTabs={keptTabs}
          activeId={tab.id}
          solo={solo}
          stacked={stacked}
          bodyWidth={bodyWidth}
          setBody={setBody}
          sourceOn={extras.sourceOn}
          remoteSource={remoteSource}
          commenting={commenting}
          zoom={zoom}
          showSolo={showSolo}
        />
      ) : (
        <div className="visualize-empty">{t('Results the agent shows will appear here.')}</div>
      )}
      {((zoomable && zoomBarVisible) || solo !== null) && (
        <VisualizeZoomPill
          tab={tab}
          solo={solo}
          paneCount={paneCount}
          zoom={zoom}
          setZoom={setZoom}
          showSolo={showSolo}
        />
      )}
    </section>
  );
}
