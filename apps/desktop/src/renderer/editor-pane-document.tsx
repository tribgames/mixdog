// Page-image viewer for Office documents on a surface that cannot display the
// converted PDF: a paired phone, where the desktop's file URL means nothing
// and iOS refuses to inline a PDF at all.
//
// Pages arrive one small batch at a time, driven by what is actually on
// screen. A document is therefore as cheap to open as its first page, and
// scrolling pays for exactly the pages it reaches.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { type DocumentPreview } from "./editor-document-model";
import { ProgressSpinner } from "./ProgressSpinner";

// A4 portrait: the shape most conversions land on. It only reserves space for
// a page that has not arrived; a loaded page uses its own proportions.
const PLACEHOLDER_ASPECT_RATIO = "1 / 1.414";
// Enough to keep a steady scroll ahead of the request it is about to need,
// small enough that one reply stays a reply and not a download.
const PAGE_BATCH = 2;
// Pages start loading before they are on screen, so a normal scroll meets
// them already painted.
const PAGE_LOOKAHEAD = "600px 0px";

function samePages(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((page, index) => page === right[index]);
}

export function EditorPaneDocumentSurface({
  breadcrumbs,
  preview,
  relPath,
  error,
  loading,
  onRequestPages,
  onFirstPageLoad,
}: {
  breadcrumbs: ReactNode;
  preview: DocumentPreview;
  relPath: string;
  error: string;
  loading: boolean;
  onRequestPages(pages: number[]): void;
  onFirstPageLoad(): void;
}) {
  const name = relPath.split("/").at(-1) || relPath;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [visiblePages, setVisiblePages] = useState<number[]>([1]);
  const loaded = useMemo(
    () => new Map(preview.pages.map((page) => [page.page, page])),
    [preview.pages],
  );
  const pageNumbers = useMemo(
    () => Array.from({ length: Math.max(1, preview.pageCount) }, (_, index) => index + 1),
    [preview.pageCount],
  );

  const observe = useCallback((entries: IntersectionObserverEntry[]) => {
    setVisiblePages((current) => {
      const next = new Set(current);
      for (const entry of entries) {
        const page = Number(entry.target.getAttribute("data-page") || 0);
        if (!page) continue;
        if (entry.isIntersecting) next.add(page);
        else next.delete(page);
      }
      const sorted = [...next].sort((left, right) => left - right);
      return samePages(sorted, current) ? current : sorted;
    });
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver !== "function") return undefined;
    const observer = new IntersectionObserver(observe, { root, rootMargin: PAGE_LOOKAHEAD });
    for (const slot of root.querySelectorAll("[data-page]")) observer.observe(slot);
    return () => observer.disconnect();
  }, [observe, preview.pageCount]);

  // One batch in flight at a time; finishing it re-runs this and takes the
  // next. A failed request stops the loop instead of retrying forever.
  useEffect(() => {
    if (error || loading) return;
    const missing: number[] = [];
    for (const page of visiblePages) {
      if (loaded.has(page)) continue;
      missing.push(page);
      if (missing.length >= PAGE_BATCH) break;
    }
    if (missing.length) onRequestPages(missing);
  }, [error, loaded, loading, onRequestPages, visiblePages]);

  return <div className="editor-pane">{breadcrumbs}
    <div className="editor-pane-document" ref={scrollRef}>
      {pageNumbers.map((page) => {
        const image = loaded.get(page);
        return <div key={page} className="editor-pane-document-page" data-page={page}
          style={{
            aspectRatio: image ? `${image.width} / ${image.height}` : PLACEHOLDER_ASPECT_RATIO,
          }}>
          {image
            ? <img src={`data:${image.mime};base64,${image.base64}`}
              alt={`${name} page ${page}`}
              onLoad={page === 1 ? onFirstPageLoad : undefined} />
            : <ProgressSpinner size={16} className="editor-pane-spinner" aria-hidden="true" />}
        </div>;
      })}
    </div>
    {/* This surface only exists where there is no OS handler to fall back to
        (a browser), so the message is the whole answer. */}
    {error && <div className="editor-pane-document-note" role="alert">
      <p>{error}</p>
    </div>}
  </div>;
}
