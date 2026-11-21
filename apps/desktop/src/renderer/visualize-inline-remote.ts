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
