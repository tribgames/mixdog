// In-app page preview of PDFs and office documents: the page set and its
// per-batch failures, the one-request-at-a-time page loader, and the stat poll
// that refreshes a shown preview when the file changes on disk.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  documentRevision,
  mergeDocumentPreviewPages,
  type DocumentPageError,
  type DocumentPreview,
} from './editor-document-model';
import { startEditorDiskWatch } from './editor-disk-watch';

export function useEditorDocumentPages({
  api,
  projectPath,
  relPath,
  accessToken,
}: {
  api: typeof window.mixdogDesktop;
  projectPath: string;
  relPath: string;
  accessToken?: string;
}) {
  const [documentPreview, setDocumentPreview] = useState<DocumentPreview | null>(null);
  const [documentError, setDocumentError] = useState('');
  const [documentPagesLoading, setDocumentPagesLoading] = useState(false);
  const [documentPageErrors, setDocumentPageErrors] = useState<Record<number, DocumentPageError>>({});
  const documentPagesInFlight = useRef(false);
  // Bumped whenever the document is (re)opened: a page result that belongs to an
  // earlier opening is dropped instead of merged into the new one.
  const documentGeneration = useRef(0);
  const documentPreviewRef = useRef<DocumentPreview | null>(null);
  documentPreviewRef.current = documentPreview;
  const documentWidth = useRef<number | undefined>(undefined);
  const documentSettling = useRef('');

  /** Starts a fresh opening and returns its generation. */
  const resetDocument = useCallback((): number => {
    setDocumentPreview(null);
    setDocumentError('');
    setDocumentPageErrors({});
    documentGeneration.current += 1;
    documentPagesInFlight.current = false;
    setDocumentPagesLoading(false);
    documentWidth.current = undefined;
    documentSettling.current = '';
    return documentGeneration.current;
  }, []);

  // Page images arrive as the viewer scrolls. One request at a time: the
  // conversion is shared, but each page is its own rasterization and a phone
  // gains nothing from three of them racing down the same link.
  const loadDocumentPages = useCallback(
    (pages: number[], maxWidth?: number) => {
      const reader = api?.previewDocumentPages;
      if (!reader || pages.length === 0 || documentPagesInFlight.current) return;
      const generation = documentGeneration.current;
      documentPagesInFlight.current = true;
      setDocumentPagesLoading(true);
      if (maxWidth) documentWidth.current = maxWidth;
      // A retried batch starts clean: its failure marks leave with the request.
      setDocumentPageErrors((current) => {
        if (!pages.some((page) => current[page])) return current;
        const next = { ...current };
        for (const page of pages) delete next[page];
        return next;
      });
      void reader(projectPath, relPath, accessToken, maxWidth ? { pages, maxWidth } : { pages })
        .then((result) => {
          if (generation !== documentGeneration.current) return;
          const current = documentPreviewRef.current;
          if (!current) return;
          const next = mergeDocumentPreviewPages(current, result);
          // Another revision replaced the preview: nothing of the old one survives,
          // failures included.
          if (documentRevision(current) !== documentRevision(next)) setDocumentPageErrors({});
          setDocumentPreview(next);
        })
        .catch((reason) => {
          if (generation !== documentGeneration.current) return;
          // Page-local: pages that already arrived stay, only this batch is marked.
          const message = reason instanceof Error ? reason.message : String(reason);
          setDocumentPageErrors((current) => {
            const next = { ...current };
            for (const page of pages) next[page] = { message, batch: pages };
            return next;
          });
        })
        .finally(() => {
          if (generation !== documentGeneration.current) return;
          documentPagesInFlight.current = false;
          setDocumentPagesLoading(false);
        });
    },
    [accessToken, api, projectPath, relPath]
  );

  return {
    documentPreview,
    setDocumentPreview,
    documentError,
    setDocumentError,
    documentPagesLoading,
    documentPageErrors,
    documentGeneration,
    resetDocument,
    loadDocumentPages,
    documentPreviewRef,
    documentPagesInFlight,
    documentWidth,
    documentSettling,
  };
}

/** Previews are binary loads, which the text watch skips: poll their stat
 *  instead, so an external or agent edit refreshes them. A change must be seen
 *  on two polls in a row before it is acted on (a file still being written does
 *  not trigger a refresh per write). A document refreshes through its page
 *  request - the viewer keeps its scroll position and the revision check swaps
 *  the pages - a media preview reloads. */
export function useEditorPreviewPoll({
  api,
  projectPath,
  relPath,
  accessToken,
  active,
  previewWatched,
  savedMtime,
  reload,
  loadDocumentPages,
  documentPreviewRef,
  documentPagesInFlight,
  documentWidth,
  documentSettling,
}: {
  api: typeof window.mixdogDesktop;
  projectPath: string;
  relPath: string;
  accessToken?: string;
  active: boolean;
  previewWatched: boolean;
  savedMtime: { current: number };
  reload(): void;
  loadDocumentPages(pages: number[], maxWidth?: number): void;
  documentPreviewRef: { current: DocumentPreview | null };
  documentPagesInFlight: { current: boolean };
  documentWidth: { current: number | undefined };
  documentSettling: { current: string };
}) {
  useEffect(() => {
    if (!active || !previewWatched) return undefined;
    return startEditorDiskWatch(window, () => {
      if (document.body.dataset.tabDragging) return;
      void api
        ?.statProjectFile?.(projectPath, relPath, accessToken)
        .then((info) => {
          if (!info) return;
          const shown = documentPreviewRef.current;
          const changed = shown
            ? documentRevision(shown) !== documentRevision(info)
            : info.mtimeMs !== savedMtime.current;
          const key = documentRevision(info);
          if (!changed) {
            documentSettling.current = '';
            return;
          }
          if (documentSettling.current !== key) {
            documentSettling.current = key;
            return;
          }
          if (!shown) {
            documentSettling.current = '';
            reload();
          } else if (!documentPagesInFlight.current) {
            documentSettling.current = '';
            loadDocumentPages([1], documentWidth.current);
          }
        })
        .catch(() => undefined);
    });
  }, [
    accessToken,
    active,
    api,
    documentPagesInFlight,
    documentPreviewRef,
    documentSettling,
    documentWidth,
    loadDocumentPages,
    previewWatched,
    projectPath,
    relPath,
    reload,
    savedMtime,
  ]);
}
