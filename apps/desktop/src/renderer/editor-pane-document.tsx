// Page-image viewer for Office documents and PDFs: the app's own scroller,
// scrollbar and zoom instead of a foreign viewer (Chromium's PDF viewer brings
// its own toolbar and native scrollbars).
//
// Pages arrive one small batch at a time, driven by what is actually on
// screen. A document is therefore as cheap to open as its first page, and
// scrolling pays for exactly the pages it reaches.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import {
  documentPageAspect,
  documentRevision,
  type DocumentPageError,
  type DocumentPreview,
} from './editor-document-model';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { ProgressSpinner } from './ProgressSpinner';
import { ZoomFrame, type ZoomViewport } from './ZoomFrame';
import { scaledSize } from './zoom-range';

// Horizontal padding of `.editor-pane-document` (12px each side).
const SCROLLER_PADDING = 24;
// A page's width at 100%; fit shrinks it to the panel, never beyond.
export const DOCUMENT_PAGE_WIDTH = 900;
// What the main process renders when a request names no width.
const DEFAULT_RENDER_WIDTH = 1200;
// Pages are re-rendered only when zoom outgrows what was requested by this much.
const CRISP_TOLERANCE = 0.9;
const RESOLUTION_DEBOUNCE_MS = 250;
// Enough to keep a steady scroll ahead of the request it is about to need,
// small enough that one reply stays a reply and not a download.
const PAGE_BATCH = 2;
// Pages start loading before they are on screen, so a normal scroll meets
// them already painted.
const PAGE_LOOKAHEAD = '600px 0px';

const NO_PAGE_ERRORS: Record<number, DocumentPageError> = {};

function samePages(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((page, index) => page === right[index]);
}

// biome-ignore lint/suspicious/noConfusingVoidType: handlers that return nothing must stay assignable; `undefined` would reject them.
type RequestPages = (pages: number[], maxWidth: number) => boolean | void;

export function EditorPaneDocumentSurface({
  breadcrumbs,
  preview,
  error,
  loading,
  zoomKey,
  pageErrors = NO_PAGE_ERRORS,
  onRequestPages,
  onFirstPageLoad,
}: {
  breadcrumbs: ReactNode;
  preview: DocumentPreview;
  /** Batches that failed; the pages that arrived stay, each failed slot offers a retry. */
  pageErrors?: Record<number, DocumentPageError>;
  /** Remembers the zoom while this file stays open in its surface. */
  zoomKey?: string;
  error: string;
  loading: boolean;
  onRequestPages: RequestPages;
  onFirstPageLoad(): void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  return (
    <div className="editor-pane">
      {breadcrumbs}
      <ZoomFrame
        ready={preview.pages.length > 0 && !error}
        intrinsicWidth={DOCUMENT_PAGE_WIDTH}
        inset={SCROLLER_PADDING}
        memoryKey={zoomKey}
        scrollerClassName="editor-pane-document"
        scrollerRef={scrollRef}
      >
        {({ scale, viewport }) => (
          <DocumentPages
            // A new revision starts the viewer's page bookkeeping over; the
            // scroller (and with it the scroll position) lives above.
            key={documentRevision(preview)}
            scrollRef={scrollRef}
            pageErrors={pageErrors}
            scale={scale}
            viewport={viewport}
            preview={preview}
            error={error}
            loading={loading}
            onRequestPages={onRequestPages}
            onFirstPageLoad={onFirstPageLoad}
          />
        )}
      </ZoomFrame>
      {/* A failed conversion keeps its message; "Open in default app" stays in ⋯. */}
      {error && <ErrorNotice error={error} />}
    </div>
  );
}

function DocumentPages({
  scrollRef,
  pageErrors,
  scale,
  viewport,
  preview,
  error,
  loading,
  onRequestPages,
  onFirstPageLoad,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  pageErrors: Record<number, DocumentPageError>;
  scale: number;
  viewport: ZoomViewport;
  preview: DocumentPreview;
  error: string;
  loading: boolean;
  onRequestPages: RequestPages;
  onFirstPageLoad(): void;
}) {
  const [visiblePages, setVisiblePages] = useState<number[]>([1]);
  const requestedWidth = useRef(new Map<number, number>());
  const loaded = useMemo(() => new Map(preview.pages.map((page) => [page.page, page])), [preview.pages]);
  const measured = viewport.width > 0;
  const pageWidth = measured ? scaledSize(DOCUMENT_PAGE_WIDTH, scale) : 0;
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const wantedWidth = Math.ceil(pageWidth * dpr);
  // Debounced so a pinch/slider drag asks for one render, not one per step.
  const [targetWidth, setTargetWidth] = useState(wantedWidth);
  useEffect(() => {
    if (wantedWidth <= targetWidth) return undefined;
    const timer = window.setTimeout(() => setTargetWidth(wantedWidth), RESOLUTION_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [wantedWidth, targetWidth]);
  const pageNumbers = useMemo(
    () => Array.from({ length: Math.max(1, preview.pageCount) }, (_, index) => index + 1),
    [preview.pageCount]
  );

  const observe = useCallback((entries: IntersectionObserverEntry[]) => {
    setVisiblePages((current) => {
      const next = new Set(current);
      for (const entry of entries) {
        const page = Number(entry.target.getAttribute('data-page') || 0);
        if (!page) continue;
        if (entry.isIntersecting) next.add(page);
        else next.delete(page);
      }
      const sorted = [...next].sort((left, right) => left - right);
      return samePages(sorted, current) ? current : sorted;
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pageCount is the deliberate trigger - the page slots to observe are rendered from it - and scrollRef.current is a ref read at run time.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver(observe, { root, rootMargin: PAGE_LOOKAHEAD });
    for (const slot of root.querySelectorAll('[data-page]')) observer.observe(slot);
    return () => observer.disconnect();
  }, [observe, preview.pageCount]);

  // One batch in flight at a time; finishing it re-runs this and takes the
  // next. A failed request stops the loop instead of retrying forever.
  useEffect(() => {
    if (error || loading || !measured) return;
    const wanted: number[] = [];
    for (const page of visiblePages) {
      // A failed batch waits for its Retry instead of looping on the failure.
      if (pageErrors[page]) continue;
      const rendered = requestedWidth.current.get(page) ?? (loaded.has(page) ? DEFAULT_RENDER_WIDTH : 0);
      if (rendered > 0 && rendered >= targetWidth * CRISP_TOLERANCE) continue;
      wanted.push(page);
      if (wanted.length >= PAGE_BATCH) break;
    }
    if (!wanted.length) return;
    const width = Math.max(targetWidth, DEFAULT_RENDER_WIDTH);
    for (const page of wanted) requestedWidth.current.set(page, width);
    onRequestPages(wanted, width);
  }, [error, loaded, loading, measured, onRequestPages, pageErrors, targetWidth, visiblePages]);

  return (
    <>
      {pageNumbers.map((page) => {
        const image = loaded.get(page);
        const onLoad = page === 1 ? onFirstPageLoad : undefined;
        const pageError = pageErrors[page];
        const errorOverlay = image ? ' editor-pane-document-page-error-overlay' : '';
        return (
          <div
            key={page}
            className="editor-pane-document-page"
            data-page={page}
            style={{
              // Height is reserved from the page's (or the first page's) ratio.
              aspectRatio: String(documentPageAspect(preview.pages, page)),
              width: measured ? pageWidth : undefined,
            }}
          >
            {image && (
              <img
                src={`data:${image.mime};base64,${image.base64}`}
                alt={t('Preview page {{page}}', { page })}
                draggable={false}
                onLoad={onLoad}
              />
            )}
            {pageError && (
              // With an image kept, the failure (a higher-resolution re-render)
              // shows as a compact overlay instead of replacing the page.
              <div className={`editor-pane-document-page-error${errorOverlay}`} role="alert">
                <span>{pageError.message}</span>
                <button
                  type="button"
                  onClick={() => {
                    const width = Math.max(targetWidth, DEFAULT_RENDER_WIDTH);
                    for (const retried of pageError.batch) requestedWidth.current.set(retried, width);
                    onRequestPages(pageError.batch, width);
                  }}
                >
                  {t('Retry')}
                </button>
              </div>
            )}
            {!pageError && !image && <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" />}
          </div>
        );
      })}
    </>
  );
}
