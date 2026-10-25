// KaTeX ships these source modules (reachable through its `"./*"` export) but
// no declarations for them. katex-text-metrics.ts reads KaTeX's own built-in
// metric data and script table through them; only the used surface is typed.
declare module 'katex/src/fontMetrics.ts' {
  export function getCharacterMetrics(
    character: string,
    font: string,
    mode: 'math' | 'text',
  ): { depth: number; height: number; italic: number; skew: number; width: number } | null | undefined;
}

declare module 'katex/src/fontMetricsData.js' {
  const fontMetricsData: Record<string, Record<number, [number, number, number, number, number]>>;
  export default fontMetricsData;
}

declare module 'katex/src/unicodeScripts.ts' {
  export function supportedCodepoint(codepoint: number): boolean;
}
