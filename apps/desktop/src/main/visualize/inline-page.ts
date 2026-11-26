import { INLINE_ECHARTS_FILE, INLINE_PAGE_FILE, inlinePageDocument } from '../../shared/visualize-inline-page';
import type { VisualizeInlineContent } from '../../shared/visualize';
import { readVisualizeVendorAsset } from './vendor-asset';

/** One in-memory file of a virtual page (nothing on disk). */
export interface VirtualPageFile {
  type: string;
  body: Buffer;
}

const JS = 'text/javascript; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

/** The ECharts library shipped as an asset file, read from disk when served. */
export function bundledEchartsSource(): Promise<string> {
  return readVisualizeVendorAsset('echarts.min.js', 'echarts/dist/echarts.min.js');
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
