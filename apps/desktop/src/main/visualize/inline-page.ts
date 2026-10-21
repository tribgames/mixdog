/**
 * The files of a scripted inline page (`chart` / `html` content) for the local
 * page server's virtual lease: the page itself and, for a chart, the locally
 * bundled ECharts it loads. Nothing is read from or written to the project.
 */
import { INLINE_ECHARTS_FILE, INLINE_PAGE_FILE, inlinePageDocument } from '../../shared/visualize-inline-page';
import type { VisualizeInlineContent } from '../../shared/visualize';
import type { VirtualPageFile } from '../local-page-server';

const JS = 'text/javascript; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

/** The ECharts library as bundled with the app (a build-time virtual module,
 *  loaded on first use). */
export async function bundledEchartsSource(): Promise<string> {
  return (await import('virtual:mixdog-echarts-source')).default;
}

export async function inlinePageFiles(
  content: VisualizeInlineContent,
  echartsSource: () => Promise<string> = bundledEchartsSource
): Promise<Record<string, VirtualPageFile>> {
  if (content.kind !== 'chart') {
    return { [INLINE_PAGE_FILE]: { type: HTML, body: Buffer.from(inlinePageDocument(content), 'utf8') } };
  }
  const page = inlinePageDocument(content, { src: INLINE_ECHARTS_FILE });
  return {
    [INLINE_PAGE_FILE]: { type: HTML, body: Buffer.from(page, 'utf8') },
    [INLINE_ECHARTS_FILE]: { type: JS, body: Buffer.from(await echartsSource(), 'utf8') },
  };
}
