// Viewer state for a converted Office document. Deliberately separate from the
// Monaco pane model: this is what a surface with no code editor at all — the
// phone — needs to show a document, and it must stay loadable without pulling
// the editor in behind it.
import type {
  DesktopDocumentPreviewPage,
  DesktopDocumentPreviewPages,
} from "../shared/contract";

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

export function mergeDocumentPreviewPages(
  current: DocumentPreview,
  incoming: DesktopDocumentPreviewPages,
): DocumentPreview {
  const byPage = new Map(current.pages.map((page) => [page.page, page]));
  for (const page of incoming.pages) byPage.set(page.page, page);
  return {
    ...current,
    pageCount: incoming.pageCount || current.pageCount,
    pages: [...byPage.values()].sort((left, right) => left.page - right.page),
  };
}
