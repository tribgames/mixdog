// Editor preview for documents no browser can open on its own (.docx, .xlsx,
// .pptx and their relatives).
//
// The conversion itself lives in the runtime package next to LibreOffice and
// pdf.js — the two heavy, native-adjacent dependencies this process must not
// bundle — and is reached through the same injected-loader path the desktop
// service already uses for runtime modules. What stays here is the part that
// belongs to the desktop: resolving a project-relative request to a real file
// without letting it escape the project, and bounding what one call may ask
// for.
import { stat } from 'node:fs/promises';

import { projectEntryPathIn } from './project-files';

interface DocumentPreviewPdf {
  path: string;
  format: string;
  mtimeMs: number;
  size: number;
  cached: boolean;
}

interface DocumentPreviewPage {
  page: number;
  width: number;
  height: number;
  mime: string;
  base64: string;
}

interface DocumentPreviewPages {
  pageCount: number;
  pages: DocumentPreviewPage[];
}

export interface DocumentPreviewModule {
  documentPreviewFormat(path: string): string;
  documentPreviewPdf(path: string, options: { cacheRoot: string }): Promise<DocumentPreviewPdf>;
  documentPreviewPages(
    pdfPath: string,
    options: { pages: number[]; maxWidth: number; cacheRoot: string }
  ): Promise<DocumentPreviewPages>;
}

// A viewer asks for the pages it is about to show. The ceiling keeps one call
// bounded in time (each page is a rasterization) and in payload, because a
// remote surface carries these images inside a single reply.
const MAX_PAGES_PER_CALL = 4;
const MIN_PAGE_WIDTH = 320;
// Wide enough for a 400% zoom on a high-DPI panel to stay crisp.
const MAX_PAGE_WIDTH = 2400;
const DEFAULT_PAGE_WIDTH = 1200;

function requestedPages(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [1];
  const pages = [...new Set(raw.map((page) => Math.trunc(Number(page))))].filter(
    (page) => Number.isInteger(page) && page >= 1
  );
  if (!pages.length) throw new TypeError('A document preview needs at least one page.');
  if (pages.length > MAX_PAGES_PER_CALL) {
    throw new TypeError(`A document preview accepts at most ${MAX_PAGES_PER_CALL} pages per request.`);
  }
  return pages.sort((left, right) => left - right);
}

function requestedWidth(value: unknown): number {
  const width = Math.trunc(Number(value));
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_PAGE_WIDTH;
  return Math.min(MAX_PAGE_WIDTH, Math.max(MIN_PAGE_WIDTH, width));
}

export function createDocumentPreviewOperations({
  cacheRoot,
  loadDocumentPreview,
}: {
  cacheRoot: string;
  loadDocumentPreview?: () => Promise<DocumentPreviewModule>;
}) {
  const runtime = async (): Promise<DocumentPreviewModule> => {
    if (!loadDocumentPreview) {
      throw new Error('Document preview is unavailable in this build.');
    }
    return await loadDocumentPreview();
  };
  const convert = async (root: string, relPath: string): Promise<DocumentPreviewPdf> => {
    const file = projectEntryPathIn(String(root || ''), String(relPath || ''));
    // A PDF needs no conversion: it is rasterized in place, so the editor can
    // show it with the same page viewer as converted documents.
    if (/\.pdf$/i.test(file)) {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('Not a file.');
      return { path: file, format: 'pdf', mtimeMs: info.mtimeMs, size: info.size, cached: true };
    }
    const office = await runtime();
    if (!office.documentPreviewFormat(file)) {
      throw new Error('This file type has no built-in document preview.');
    }
    return await office.documentPreviewPdf(file, { cacheRoot });
  };
  return {
    /** Absolute path of the converted PDF. Desktop-local: the renderer never
     *  sees it, the preview token registered from it is what travels. */
    documentPreviewIn: (root: string, relPath: string) => convert(root, relPath),
    /** Rasterized pages for a surface that cannot display a PDF. The reply
     *  carries the page count, so the viewer can ask for the rest. */
    documentPreviewPagesIn: async (
      root: string,
      relPath: string,
      options: { pages?: unknown; maxWidth?: unknown } = {}
    ) => {
      const pages = requestedPages(options.pages);
      const maxWidth = requestedWidth(options.maxWidth);
      let pdf = await convert(root, relPath);
      const office = await runtime();
      let rendered = await office.documentPreviewPages(pdf.path, { pages, maxWidth, cacheRoot });
      // The PDF is mutable: if it changed while rasterizing, the pixels may
      // belong to either revision. Re-render once against the new one and
      // report that revision so the renderer's binding resets.
      const after = await stat(pdf.path);
      if (after.mtimeMs !== pdf.mtimeMs || after.size !== pdf.size) {
        pdf = { ...pdf, mtimeMs: after.mtimeMs, size: after.size };
        rendered = await office.documentPreviewPages(pdf.path, { pages, maxWidth, cacheRoot });
        const settled = await stat(pdf.path);
        pdf = { ...pdf, mtimeMs: settled.mtimeMs, size: settled.size };
      }
      return {
        format: pdf.format,
        mtimeMs: pdf.mtimeMs,
        size: pdf.size,
        pageCount: rendered.pageCount,
        pages: rendered.pages,
      };
    },
  };
}
