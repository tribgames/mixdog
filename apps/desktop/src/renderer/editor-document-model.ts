// Viewer state for a converted Office document. Deliberately separate from the
// Monaco pane model: this is what a surface with no code editor at all — the
// phone — needs to show a document, and it must stay loadable without pulling
// the editor in behind it.
import type { DesktopDocumentPreviewPage, DesktopDocumentPreviewPages } from '../shared/contract';

/** An Office document shown as page images. Pages arrive as the viewer
 *  scrolls, so `pages` is sparse and `pageCount` is what the scroller lays
 *  out. */
export interface DocumentPreview {
  format: string;
  mtimeMs: number;
  size: number;
  pageCount: number;
  pages: DesktopDocumentPreviewPage[];
}

// A4 portrait: the shape most conversions land on, used only while no page
// has arrived to say otherwise.
// biome-ignore lint/suspicious/noApproximativeNumericConstant: 1/1.414 is the intentional A4 ratio; Math.SQRT1_2 differs in the fourth digit and the tests pin this exact value.
const FALLBACK_ASPECT = 1 / 1.414;

/** width / height reserved for a page: its own once loaded, else the first
 *  loaded page's, else A4. Reserving this keeps the scrollbar from jumping as
 *  pages paint. */
export function documentPageAspect(pages: readonly DesktopDocumentPreviewPage[], page: number): number {
  const own = pages.find((entry) => entry.page === page) ?? pages[0];
  return own && own.width > 0 && own.height > 0 ? own.width / own.height : FALLBACK_ASPECT;
}

/** A page request that failed: the pages it asked for travel with it, so a
 *  retry re-requests exactly that batch. */
export interface DocumentPageError {
  message: string;
  batch: number[];
}

/** The file revision a preview shows: its pages are only ever mixed with
 *  pages of the very same one. */
export function documentRevision(value: { mtimeMs: number; size: number }): string {
  return `${value.mtimeMs}:${value.size}`;
}

export function documentPreviewFromResult(result: DesktopDocumentPreviewPages): DocumentPreview {
  return {
    format: result.format,
    mtimeMs: result.mtimeMs,
    size: result.size,
    pageCount: result.pageCount,
    pages: result.pages,
  };
}

/** Merge a page result into the preview it was requested for. A result of a
 *  different revision replaces the preview: the old pages are dropped, never
 *  mixed with the new ones. */
export function mergeDocumentPreviewPages(
  current: DocumentPreview,
  incoming: DesktopDocumentPreviewPages
): DocumentPreview {
  if (documentRevision(current) !== documentRevision(incoming)) return documentPreviewFromResult(incoming);
  const byPage = new Map(current.pages.map((page) => [page.page, page]));
  for (const page of incoming.pages) byPage.set(page.page, page);
  return {
    ...current,
    pageCount: incoming.pageCount || current.pageCount,
    pages: [...byPage.values()].sort((left, right) => left.page - right.page),
  };
}
