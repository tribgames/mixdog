// A paired remote client cannot reach the host's page server, so a scripted
// inline page (`chart` / `html` content) is built here from the content that
// travels in the tab state. A chart page carries the locally bundled ECharts
// (loaded on first use, never from a CDN). The result is an ordinary page
// source: it goes through the same script gate ([Run]) as an HTML file page.
import type { VisualizeInlineContent, VisualizePaneSource } from '../shared/visualize';
import { inlinePageDocument } from '../shared/visualize-inline-page';

/** The ECharts browser build, as a string (a lazy chunk of the renderer). */
export async function loadEchartsSource(): Promise<string> {
  return (await import('echarts/dist/echarts.min.js?raw')).default;
}

export async function remoteInlinePageSource(
  content: VisualizeInlineContent,
  echartsSource: () => Promise<string> = loadEchartsSource
): Promise<VisualizePaneSource> {
  const echarts = content.kind === 'chart' ? { inline: await echartsSource() } : undefined;
  return { kind: 'html', srcdoc: inlinePageDocument(content, echarts) };
}
