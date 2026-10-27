// Scripted direct renderers of the visualize tool: `chart` (an ECharts option)
// and `html` content are shown as real pages — scripts on, tooltips and zoom
// working — instead of the static render. The page is a virtual in-memory
// document: the desktop serves it from the local page server (never written
// to the project), a paired remote client builds the same document locally.
// Mermaid, SVG and Markdown stay static.
import type { VisualizeInlineContent } from './visualize';

export const INLINE_PAGE_FILE = 'index.html';
export const INLINE_ECHARTS_FILE = 'echarts.js';
/** Set on a chart page's root once ECharts finished drawing (animations
 *  included) or the chart failed. */
export const INLINE_CHART_RENDERED = 'data-mixdog-rendered';

/** True for the kinds shown as scripted pages. */
export function inlineContentIsPage(content: Pick<VisualizeInlineContent, 'kind'>): boolean {
  return content.kind === 'chart' || content.kind === 'html';
}

/** Where a chart page gets ECharts: a sibling file (desktop page server) or
 *  its source inlined into the page (remote client). */
export type EchartsSource = { src: string } | { inline: string };

const CHART_SCRIPT = `(function () {
  var box = document.getElementById('chart');
  var note = document.getElementById('error');
  // The chart drew its last frame (or gave up): the app's card picture waits for it.
  function rendered() { document.documentElement.setAttribute('${INLINE_CHART_RENDERED}', ''); }
  function fail(message) {
    rendered();
    note.textContent = message;
    note.hidden = false;
    console.error(message);
  }
  if (typeof echarts === 'undefined') return fail('ECharts failed to load.');
  var option;
  try {
    option = JSON.parse(document.getElementById('option').textContent);
  } catch (error) {
    return fail('Invalid chart JSON: ' + error.message);
  }
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    return fail('A chart source must be a JSON object (an ECharts option).');
  }
  // The frame can report its color scheme only after it joins the panel, so
  // the chart is drawn again in the scheme the page ends up in.
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var chart;
  function draw() {
    try {
      if (chart) chart.dispose();
      chart = echarts.init(box, media.matches ? 'dark' : null);
      chart.on('finished', rendered);
      chart.setOption(Object.assign({ backgroundColor: 'transparent' }, option));
    } catch (error) {
      fail('The chart could not be rendered: ' + error.message);
    }
  }
  draw();
  media.addEventListener('change', draw);
  window.addEventListener('resize', function () { if (chart) chart.resize(); });
})();`;

/** The chart page for an ECharts option given as JSON text. The option is
 *  data (a non-executable JSON script block); a parse failure is shown on the
 *  page and logged as a console error, which the panel lists as a problem. */
export function chartPageDocument(source: string, echarts: EchartsSource): string {
  const library =
    'src' in echarts
      ? `<script src="${echarts.src}"></script>`
      : `<script>${echarts.inline.replace(/<\/(script)/gi, '<\\/$1')}</script>`;
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>Chart</title>` +
    `<style>:root{color-scheme:light dark}html,body{margin:0;height:100%}` +
    `body{background:#fff;color:#1f1f1f;font:13px system-ui,sans-serif}` +
    `@media (prefers-color-scheme:dark){body{background:#1e1e1e;color:#e6e6e6}}` +
    `#chart{width:100%;height:100%}#error{margin:12px;color:#d9534f;white-space:pre-wrap}</style></head>` +
    `<body><div id="chart"></div><div id="error" role="alert" hidden></div>` +
    `<script type="application/json" id="option">${source.replace(/</g, '\\u003c')}</script>` +
    `${library}<script>${CHART_SCRIPT}</script></body></html>`
  );
}

/** The app-theme base of an `html` sketch: CSS variables and body / control
 *  defaults, all under `:where()` so it has zero specificity and any rule the
 *  author writes wins. Light by default, dark with the system scheme the panel
 *  follows (the same switch the chart page uses). */
export const HTML_THEME_PRELUDE =
  `<style data-mixdog-theme>` +
  `:where(:root){color-scheme:light dark;--mx-bg-base:#fff;--mx-text:#1f1f1f;--mx-text-muted:#666;` +
  `--mx-border:#d4d4d4;--mx-accent:#0b63ce;--mx-surface:#f3f3f3}` +
  `@media (prefers-color-scheme:dark){:where(:root){--mx-bg-base:#1e1e1e;--mx-text:#e6e6e6;` +
  `--mx-text-muted:#9a9a9a;--mx-border:#3a3a3a;--mx-accent:#58a6ff;--mx-surface:#2a2a2a}}` +
  `:where(body){margin:0;padding:12px;background:var(--mx-bg-base);color:var(--mx-text);` +
  `font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}` +
  `:where(a){color:var(--mx-accent)}:where(hr){border:0;border-top:1px solid var(--mx-border)}` +
  `:where(button,input,select,textarea){font:inherit;color:inherit;background:var(--mx-surface);` +
  `border:1px solid var(--mx-border);border-radius:4px;padding:4px 10px}` +
  `:where(button){cursor:pointer}:where(input,select,textarea){padding:4px 6px}` +
  `:where(pre,code){font-family:ui-monospace,Consolas,monospace}` +
  `:where(table){border-collapse:collapse}:where(th,td){border:1px solid var(--mx-border);padding:4px 8px}` +
  `</style>`;

/** `html` with the theme prelude placed first in its head (made if missing),
 *  after any doctype so the page keeps standards mode. */
export function withHtmlThemePrelude(html: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head)
    return html.slice(0, head.index + head[0].length) + HTML_THEME_PRELUDE + html.slice(head.index + head[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(html);
  if (root) {
    const end = root.index + root[0].length;
    return `${html.slice(0, end)}<head>${HTML_THEME_PRELUDE}</head>${html.slice(end)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const end = doctype ? doctype[0].length : 0;
  return html.slice(0, end) + HTML_THEME_PRELUDE + html.slice(end);
}

/** The page document of a scripted inline content (`html` gets the theme prelude). */
export function inlinePageDocument(content: VisualizeInlineContent, echarts?: EchartsSource): string {
  if (content.kind === 'chart') {
    if (!echarts) throw new Error('a chart page needs the ECharts library');
    return chartPageDocument(content.source, echarts);
  }
  return withHtmlThemePrelude(content.source);
}
