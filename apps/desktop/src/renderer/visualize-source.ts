// The visualize panel's read-only source view: a pane's text as highlighted
// lines (the app's own highlighter, lowlight/highlight.js), and the small
// helpers around it — which panes have a source, their language, and the
// file a download of it gets.
import { common, createLowlight } from 'lowlight';

import type { VisualizeInlineKind, VisualizePaneView } from '../shared/visualize';
import { type DeviceSaveResult, saveBlobOnDevice } from './file-download-transfer';

const lowlight = createLowlight(common);

/** One run of text with the highlight classes of the spans it sits in
 *  (outermost first); nested spans keep inherited colors. */
export interface SourceToken {
  text: string;
  classes: string[];
}

export type SourceLine = SourceToken[];

/** Only HTML pages and inline content have a source; PDFs, images, media and
 *  converted Office documents are binary. */
export function visualizePaneHasSource(pane: Pick<VisualizePaneView, 'kind' | 'inline'>): boolean {
  return pane.inline !== undefined || pane.kind === 'html';
}

/** The highlight language of a pane's source ('' = plain text; Mermaid has none). */
export function visualizeSourceLanguage(inline: VisualizeInlineKind | undefined): string {
  switch (inline) {
    case undefined:
    case 'html':
    case 'svg':
      return 'xml';
    case 'chart':
      return 'json';
    case 'markdown':
      return 'markdown';
    default:
      return '';
  }
}

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

/** `source` as numbered-ready lines of highlighted tokens. An unknown
 *  language, or one the highlighter rejects, yields plain lines. */
export function highlightSourceLines(source: string, language: string): SourceLine[] {
  const lines: SourceLine[] = [[]];
  const push = (text: string, classes: string[]) => {
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, classes });
    });
  };
  const walk = (node: HastNode, classes: string[]) => {
    if (node.type === 'text') return push(node.value ?? '', classes);
    const className = node.properties?.className;
    const own = Array.isArray(className) ? className.map(String).join(' ') : '';
    const next = own ? [...classes, own] : classes;
    for (const child of node.children ?? []) walk(child, next);
  };
  let tree: HastNode | null = null;
  if (language && lowlight.registered(language)) {
    try {
      tree = lowlight.highlight(language, source) as unknown as HastNode;
    } catch {
      tree = null;
    }
  }
  if (tree) walk(tree, []);
  else push(source, []);
  // A trailing newline ends the last line; it does not start another.
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

/** The file a download of a pane's source gets. */
export function visualizeSourceFileName(pane: Pick<VisualizePaneView, 'label' | 'inline'>): string {
  const base =
    pane.label
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips C0 control characters from file names on purpose.
      .replace(/[\\/:*?"<>|\0-\x1f]+/g, '-')
      .trim()
      .slice(0, 80) || 'visual';
  const extension = { mermaid: 'mmd', svg: 'svg', chart: 'json', html: 'html', markdown: 'md' }[
    pane.inline?.kind ?? 'html'
  ];
  return base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`;
}

/** Save `blob` on this device: the phone app's native save, else the
 *  browser's share sheet or a download link. */
export function downloadBlob(blob: Blob, fileName: string): Promise<DeviceSaveResult> {
  return saveBlobOnDevice(blob, fileName);
}
