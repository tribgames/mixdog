// Direct renderers of the visualize panel: Mermaid, SVG, ECharts, HTML and
// Markdown shown from `input.content`, without the agent writing a file.
//
// The libraries (bundled, loaded lazily — never from a CDN) run here in the
// app and produce static markup; that markup is sanitized and shown in an
// iframe that runs nothing: no `allow-scripts`, under a CSP with no network,
// no script and only inline styles / `data:` images. The app's own CSP
// (`script-src 'self'`) would block inline scripts in a srcdoc frame anyway, so
// nothing in the frame is interactive; a page that needs scripts is a file.
import type { VisualizeInlineContent } from '../shared/visualize';

/** The frame's `sandbox` attribute: every restriction, scripts included, but
 *  the frame keeps the app's origin so the app can listen for a pinch on its
 *  document (the only way a phone pinch over it can zoom the panel). With no
 *  script able to run in it, the shared origin gives the content nothing. */
export const INLINE_FRAME_SANDBOX = 'allow-same-origin';

/** The frame document's CSP: no network, scripts, forms or frames. */
export const INLINE_FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

export interface InlineTheme {
  scheme: 'dark' | 'light';
  background: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
}

const DARK: InlineTheme = {
  scheme: 'dark',
  background: '#1e1e1e',
  text: '#e6e6e6',
  muted: '#9a9a9a',
  border: '#3a3a3a',
  accent: '#58a6ff',
};
const LIGHT: InlineTheme = {
  scheme: 'light',
  background: '#ffffff',
  text: '#1f1f1f',
  muted: '#666666',
  border: '#d4d4d4',
  accent: '#0b63ce',
};

/** The panel's current theme, read from the app's `--mx-*` variables (the
 *  built-in dark or light values when a variable is missing). */
export function inlineThemeFromDocument(): InlineTheme {
  if (typeof document === 'undefined') return DARK;
  const style = getComputedStyle(document.documentElement);
  const base = style.colorScheme === 'light' ? LIGHT : DARK;
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    scheme: base.scheme,
    background: read('--mx-bg-base', base.background),
    text: read('--mx-text-strong', read('--mx-text', base.text)),
    muted: read('--mx-text-muted', base.muted),
    border: read('--mx-border', base.border),
    accent: read('--mx-accent', base.accent),
  };
}

/** A CSS value that cannot leave its declaration. */
const cssValue = (value: string): string => value.replace(/[^\w#%.,()\s/-]/g, '');

/** The frame document: theme prelude (CSS variables), CSP, then `body`. */
export function buildInlineDocument(body: string, theme: InlineTheme): string {
  const vars = [
    `--mx-bg-base:${cssValue(theme.background)}`,
    `--mx-text:${cssValue(theme.text)}`,
    `--mx-text-muted:${cssValue(theme.muted)}`,
    `--mx-border:${cssValue(theme.border)}`,
    `--mx-accent:${cssValue(theme.accent)}`,
  ].join(';');
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${INLINE_FRAME_CSP}">` +
    `<style>:root{${vars};color-scheme:${theme.scheme}}` +
    `html,body{margin:0}body{padding:12px;background:var(--mx-bg-base);color:var(--mx-text);` +
    `font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}` +
    `a{color:var(--mx-accent)}hr{border:0;border-top:1px solid var(--mx-border)}` +
    `svg{max-width:100%;height:auto}img{max-width:100%}` +
    `.fit svg{max-width:none!important;width:100%;height:auto}` +
    `pre,code{font-family:ui-monospace,Consolas,monospace}pre{overflow:auto}` +
    `table{border-collapse:collapse}th,td{border:1px solid var(--mx-border);padding:4px 8px}` +
    `blockquote{margin-left:0;padding-left:12px;border-left:3px solid var(--mx-border);color:var(--mx-text-muted)}` +
    `</style></head><body>${body}</body></html>`
  );
}

export type InlineRender = { ok: true; html: string } | { ok: false; error: string };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).trim();

type Purifier = typeof import('dompurify').default;
let purifier: Promise<Purifier> | null = null;

/** DOMPurify with links limited to in-page anchors: a sandboxed frame could
 *  still navigate itself away, so no `href` leaves the document. */
function withAnchorLinksOnly(DOMPurify: Purifier): Purifier {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    for (const name of ['href', 'xlink:href']) {
      const value = node.getAttribute?.(name);
      if (value !== null && value !== undefined && !value.trim().startsWith('#')) node.removeAttribute(name);
    }
  });
  return DOMPurify;
}

function loadPurifier(): Promise<Purifier> {
  purifier ??= import('dompurify').then(({ default: DOMPurify }) => withAnchorLinksOnly(DOMPurify));
  return purifier;
}

/** Test seam: sanitize with an explicit purifier (a jsdom-backed one in node). */
export function useInlinePurifier(next: Purifier): void {
  purifier = Promise.resolve(withAnchorLinksOnly(next));
}

const SVG_OPTIONS = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  ADD_TAGS: ['foreignobject'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
};

async function sanitizeSvg(svg: string): Promise<string> {
  return (await loadPurifier()).sanitize(svg, SVG_OPTIONS);
}

async function renderSvg(source: string): Promise<InlineRender> {
  if (!/<svg[\s>]/i.test(source)) return { ok: false, error: 'The source is not an <svg> document.' };
  const html = await sanitizeSvg(source);
  if (!/<svg[\s>]/i.test(html)) return { ok: false, error: 'No <svg> element is left after sanitizing the source.' };
  return { ok: true, html };
}

async function renderHtml(source: string): Promise<InlineRender> {
  const html = (await loadPurifier()).sanitize(source, { FORCE_BODY: true });
  return { ok: true, html };
}

async function renderMarkdown(source: string): Promise<InlineRender> {
  const { marked } = await import('marked');
  const html = marked.parse(source, { gfm: true, async: false });
  return renderHtml(html);
}

/** A diagram is never drawn below this share of its natural width; a narrower
 *  pane scrolls sideways instead. */
const DIAGRAM_MIN_SCALE = 0.6;

/** The SVG drawn at min(natural width, pane width), centered: never upscaled,
 *  scaled down (aspect kept) only to ~0.6x natural, then it scrolls. */
export function fitDiagram(svg: string): string {
  const viewBox = /viewBox="[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+[\d.]+"/.exec(svg);
  const natural = viewBox ? Math.ceil(Number(viewBox[1])) : 0;
  const bounds = natural > 0 ? `;max-width:${natural}px;min-width:${Math.ceil(natural * DIAGRAM_MIN_SCALE)}px` : '';
  return `<div class="fit" style="overflow:auto"><div style="width:100%;margin:0 auto${bounds}">${svg}</div></div>`;
}
let mermaidQueue: Promise<unknown> = Promise.resolve();
let mermaidCount = 0;

async function renderMermaid(source: string, theme: InlineTheme): Promise<InlineRender> {
  const run = async (): Promise<InlineRender> => {
    const { default: mermaid } = await import('mermaid');
    // Strict: Mermaid itself drops scripts, event handlers and click bindings.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme.scheme === 'dark' ? 'dark' : 'default',
      // The panel's colors, so edge labels and text match the pane.
      themeVariables: {
        background: theme.background,
        textColor: theme.text,
        lineColor: theme.muted,
        edgeLabelBackground: theme.background,
      },
    });
    mermaidCount += 1;
    const id = `mixdog-mermaid-${mermaidCount}`;
    try {
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      return { ok: true, html: fitDiagram(await sanitizeSvg(svg)) };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    } finally {
      // A failed render can leave its scratch node in the app document.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  };
  // Mermaid's configuration is global: one render at a time.
  const next = mermaidQueue.then(run, run);
  mermaidQueue = next;
  return next;
}

const CHART_SIZE = { width: 800, height: 480 };

async function renderChart(source: string, theme: InlineTheme): Promise<InlineRender> {
  let option: unknown;
  try {
    option = JSON.parse(source);
  } catch (error) {
    return { ok: false, error: `Invalid chart JSON: ${errorText(error)}` };
  }
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    return { ok: false, error: 'A chart source must be a JSON object (an ECharts option).' };
  }
  const echarts = await import('echarts');
  // Server-side rendering: a static SVG, no DOM, no animation, no scripts.
  const chart = echarts.init(null, theme.scheme === 'dark' ? 'dark' : undefined, {
    renderer: 'svg',
    ssr: true,
    ...CHART_SIZE,
  });
  try {
    chart.setOption({ backgroundColor: 'transparent', animation: false, ...(option as object) });
    return { ok: true, html: await sanitizeSvg(chart.renderToSVGString()) };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  } finally {
    chart.dispose();
  }
}

/** Render `content` to sanitized, script-free markup for the frame body, or
 *  the error that stopped it (shown with the source, reported as a problem). */
export async function renderInlineContent(content: VisualizeInlineContent, theme: InlineTheme): Promise<InlineRender> {
  try {
    switch (content.kind) {
      case 'mermaid':
        return await renderMermaid(content.source, theme);
      case 'svg':
        return await renderSvg(content.source);
      case 'chart':
        return await renderChart(content.source, theme);
      case 'html':
        return await renderHtml(content.source);
      case 'markdown':
        return await renderMarkdown(content.source);
    }
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}
