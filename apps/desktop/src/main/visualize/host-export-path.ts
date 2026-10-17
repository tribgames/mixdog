import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

import { filePreviewTypeForPath } from '../../shared/file-preview';
import type { VisualizePaneView, VisualizeTabView } from '../../shared/visualize';
import { localVirtualPageUrl } from '../local-page-server';
import {
  bundledMermaidSource,
  type ExportDocument,
  imageDocument,
  inlineExportDocument,
  sideBySideDocument,
  stackedDocument,
} from './export-offscreen';
import { renderPageExport, renderPageExportDetailed } from './export-render';

/** What an export draws with: a hidden window per page, and the pane files. */
export interface ExportRenderers {
  /** One page (a lease URL) rendered whole in a hidden window. */
  page(url: string, format: 'png' | 'pdf', allowNetwork: boolean): Promise<Buffer>;
  /** An in-memory page as a PNG, in a hidden window cut off from the network. */
  document(document: ExportDocument): Promise<Buffer>;
  readFile(path: string): Promise<Buffer>;
  /** The Mermaid browser build a diagram page loads. */
  mermaidSource(): Promise<string>;
  /** Rasterized pages (1-based `pages`) of a PDF or Office file, with the
   *  document's page count (the host's `documentPreviewPagesIn`). */
  documentPages(
    file: string,
    pages: number[]
  ): Promise<{ pageCount: number; pages: Array<{ mime: string; bytes: Buffer }> }>;
}

/** Most pages one export stacks (a PNG is bounded in height). */
const MAX_DOCUMENT_PAGES = 8;
/** Most pages one `documentPages` request carries. */
const PAGES_PER_REQUEST = 4;

export const exportRenderers: ExportRenderers = {
  page: renderPageExport,
  documentPages: async () => {
    throw new Error('Document preview is unavailable in this build.');
  },
  readFile: (path) => readFile(path),
  mermaidSource: bundledMermaidSource,
  async document({ files, ready }) {
    const url = await localVirtualPageUrl(files, { authorize: async () => {} });
    return (await renderPageExportDetailed(url, 'png', false, { ...(ready ? { ready } : {}) })).data;
  },
};

/** Render without the desktop panel: `files` is the file behind each
 *  displayed pane (empty for inline content). */
export interface OffscreenExport {
  files: readonly string[];
  renderers?: ExportRenderers;
  /** A document had more pages than one PNG stacks: it carries the first
   *  `included` of `total`. */
  onPagesCut?(included: number, total: number): void;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether a pane can be drawn without the panel: pages, inline content,
 *  image files and PDF / Office files (as page images) can; audio and video
 *  cannot. */
const drawnOffscreen = (pane: VisualizePaneView, file: string | undefined): boolean =>
  pane.kind === 'html' ||
  (pane.kind === 'inline' && Boolean(pane.inline)) ||
  (['image', 'pdf', 'document'].includes(pane.kind) && Boolean(file));

/** A PDF / Office file as the panel shows it: its pages (the first
 *  MAX_DOCUMENT_PAGES) one under the other; one PNG page is sent as it is. */
async function documentImage(
  file: string,
  renderers: ExportRenderers,
  onPagesCut: OffscreenExport['onPagesCut']
): Promise<Buffer> {
  const first = await renderers.documentPages(file, [1]);
  const images = [...first.pages];
  const last = Math.min(first.pageCount, MAX_DOCUMENT_PAGES);
  if (first.pageCount > last) onPagesCut?.(last, first.pageCount);
  for (let from = 2; from <= last; from += PAGES_PER_REQUEST) {
    const wanted = [];
    for (let page = from; page < from + PAGES_PER_REQUEST && page <= last; page += 1) wanted.push(page);
    images.push(...(await renderers.documentPages(file, wanted)).pages);
  }
  if (images.length === 1 && images[0].mime === 'image/png') return images[0].bytes;
  return renderers.document(stackedDocument(images));
}

/** A pane's PNG, drawn without the panel (`drawnOffscreen` panes only). An
 *  image file that already is a PNG is sent as it is. */
async function paneImage(
  pane: VisualizePaneView,
  file: string | undefined,
  allowNetwork: boolean,
  renderers: ExportRenderers,
  onPagesCut: OffscreenExport['onPagesCut']
): Promise<Buffer> {
  if (pane.kind === 'html') return renderers.page(pane.url, 'png', allowNetwork);
  if (pane.kind === 'inline' && pane.inline) {
    return renderers.document(await inlineExportDocument(pane.inline, renderers.mermaidSource));
  }
  if (pane.kind !== 'image') return documentImage(file as string, renderers, onPagesCut);
  const bytes = await renderers.readFile(file as string);
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return bytes;
  const mime = filePreviewTypeForPath(file as string)?.mime ?? 'application/octet-stream';
  return renderers.document(imageDocument(bytes, mime));
}

/** The bytes of an export of displayed pane `paneIndex`: an HTML page is
 *  rendered whole off screen. With `offscreen`, so is everything else that
 *  can be (inline content, image files, PDF / Office files as page images,
 *  several panes side by side) and a PDF file is sent as it is; without it,
 *  and for audio and video, the result is what the panel shows now
 *  (`capture`). */
export async function exportTabBytes(
  capture: () => Promise<Buffer>,
  tab: VisualizeTabView,
  format: 'png' | 'pdf',
  paneIndex: number,
  offscreen?: OffscreenExport
): Promise<Buffer> {
  const renderers = offscreen?.renderers ?? exportRenderers;
  const files = offscreen?.files ?? [];
  const allowNetwork = tab.networkAllowed === true;
  const pane = tab.panes[paneIndex];
  if (pane?.kind === 'html' && (format === 'pdf' || tab.panes.length === 1)) {
    return renderers.page(pane.url, format, allowNetwork);
  }
  if (format === 'pdf') {
    if (pane?.kind === 'pdf' && files[paneIndex]) return renderers.readFile(files[paneIndex]);
    throw new Error('Save as PDF is for HTML pages');
  }
  if (
    offscreen &&
    tab.panes.length > 0 &&
    tab.panes.every((candidate, index) => drawnOffscreen(candidate, files[index]))
  ) {
    const pngs: Buffer[] = [];
    for (const [index, candidate] of tab.panes.entries()) {
      pngs.push(await paneImage(candidate, files[index], allowNetwork, renderers, offscreen.onPagesCut));
    }
    return pngs.length === 1 ? pngs[0] : renderers.document(sideBySideDocument(pngs));
  }
  return capture();
}

/** The OS save dialog for an export: the chosen file path, null on cancel.
 *  `directory` is preferred when it exists, else `fallback`. */
export async function chooseExportPath(
  requireWindow: () => BrowserWindow,
  { directory, fallback, name, format }: { directory: string; fallback: string; name: string; format: 'png' | 'pdf' }
): Promise<string | null> {
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
}
