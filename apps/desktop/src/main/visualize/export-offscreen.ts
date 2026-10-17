/**
 * The pages a remote export renders in a hidden window when no desktop panel
 * can draw them: inline content (SVG, Mermaid, Markdown, a chart or HTML
 * sketch), an image file, and several panes side by side (a comparison).
 */
import type { VisualizeInlineContent } from '../../shared/visualize';
import { INLINE_CHART_RENDERED } from '../../shared/visualize-inline-page';
import type { VirtualPageFile } from '../local-page-server';
import { inlinePageFiles } from './inline-page';

/** An in-memory page (`index.html` plus siblings) and, when it draws after
 *  the load, the script that answers `true` once it has (an error text when
 *  it cannot). */
export interface ExportDocument {
  files: Record<string, VirtualPageFile>;
  ready?: string;
}

const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';
const PAGE = 'index.html';
const MERMAID_FILE = 'mermaid.js';
const MERMAID_ERROR = 'data-mixdog-render-error';

/** Pane width the side-by-side page gives each pane (the export window's). */
const PANE_WIDTH = 1280;

/** Static markup runs under this policy: no script, no network. */
const STATIC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const STATIC_STYLE =
  `html,body{margin:0}body{padding:12px;background:#fff;color:#1f1f1f;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}` +
  `svg,img{max-width:100%;height:auto}pre,code{font-family:ui-monospace,Consolas,monospace}` +
  `table{border-collapse:collapse}th,td{border:1px solid #d4d4d4;padding:4px 8px}` +
  `blockquote{margin-left:0;padding-left:12px;border-left:3px solid #d4d4d4;color:#666}`;

const page = (html: string): Record<string, VirtualPageFile> => ({
  [PAGE]: { type: HTML, body: Buffer.from(html, 'utf8') },
});

/** A page of `body` markup that cannot run script or reach the network. */
const staticPage = (body: string, style = STATIC_STYLE): ExportDocument => ({
  files: page(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}">` +
      `<style>${style}</style></head><body>${body}</body></html>`
  ),
});

const MERMAID_SCRIPT = `(function () {
  var root = document.documentElement;
  function fail(error) {
    root.setAttribute('${MERMAID_ERROR}', 'The Mermaid diagram could not be rendered: ' + ((error && error.message) || error));
  }
  try {
    var source = JSON.parse(document.getElementById('source').textContent);
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
    mermaid.parse(source)
      .then(function () { return mermaid.render('mixdog-export', source); })
      .then(function (result) {
        document.getElementById('out').innerHTML = result.svg;
        root.setAttribute('${INLINE_CHART_RENDERED}', '');
      })
      .catch(fail);
  } catch (error) {
    fail(error);
  }
})();`;

const MERMAID_READY =
  `(() => { const root = document.documentElement; const error = root.getAttribute('${MERMAID_ERROR}'); ` +
  `return error !== null ? error : root.hasAttribute('${INLINE_CHART_RENDERED}'); })()`;

const CHART_READY = `document.documentElement.hasAttribute('${INLINE_CHART_RENDERED}')`;

/** The Mermaid browser build as bundled with the app (a build-time virtual
 *  module, loaded on first use). */
export async function bundledMermaidSource(): Promise<string> {
  return (await import('virtual:mixdog-mermaid-source')).default;
}

function mermaidDocument(source: string, library: string): ExportDocument {
  const data = JSON.stringify(source).replace(/</g, '\\u003c');
  return {
    files: {
      ...page(
        `<!doctype html><html><head><meta charset="utf-8">` +
          `<style>html,body{margin:0}body{background:#fff}#out{padding:12px}#out svg{display:block;margin:0 auto}</style></head>` +
          `<body><div id="out"></div><script type="application/json" id="source">${data}</script>` +
          `<script src="${MERMAID_FILE}"></script><script>${MERMAID_SCRIPT}</script></body></html>`
      ),
      [MERMAID_FILE]: { type: JS, body: Buffer.from(library, 'utf8') },
    },
    ready: MERMAID_READY,
  };
}

/** The page that draws inline `content` for an export. SVG and Markdown are
 *  static markup under a no-script policy; Mermaid, a chart and an HTML
 *  sketch run as they do in the panel's own (script-allowed) page. */
export async function inlineExportDocument(
  content: VisualizeInlineContent,
  mermaidSource: () => Promise<string> = bundledMermaidSource
): Promise<ExportDocument> {
  switch (content.kind) {
    case 'svg':
      if (!/<svg[\s>]/i.test(content.source)) throw new Error('The source is not an <svg> document.');
      return staticPage(content.source);
    case 'markdown': {
      const { marked } = await import('marked');
      return staticPage(marked.parse(content.source, { gfm: true, async: false }));
    }
    case 'mermaid':
      return mermaidDocument(content.source, await mermaidSource());
    case 'chart':
      return { files: await inlinePageFiles(content), ready: CHART_READY };
    case 'html':
      return { files: await inlinePageFiles(content) };
  }
}

/** A page showing one image file at its own size. */
export function imageDocument(bytes: Buffer, mime: string): ExportDocument {
  return staticPage(
    `<img src="data:${mime};base64,${bytes.toString('base64')}">`,
    'html,body{margin:0}img{display:block}'
  );
}

/** The page pictures of a document, one under the other as the panel stacks them. */
export function stackedDocument(images: ReadonlyArray<{ mime: string; bytes: Buffer }>): ExportDocument {
  const pictures = images
    .map(({ mime, bytes }) => `<img src="data:${mime};base64,${bytes.toString('base64')}">`)
    .join('');
  return staticPage(
    pictures,
    'html,body{margin:0;background:#d4d4d4}img{display:block;margin:0 auto 2px;max-width:100%}'
  );
}

/** The pane pictures `pngs` side by side, each in a column of the export
 *  width (a picture is shrunk to fit it, never enlarged). */
export function sideBySideDocument(pngs: readonly Buffer[]): ExportDocument {
  const columns = pngs.map((_png, index) => `<div class="pane"><img src="pane-${index}.png"></div>`).join('');
  const files = page(
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#d4d4d4}` +
      `.row{display:flex;gap:2px;align-items:flex-start}` +
      `.pane{flex:none;width:${PANE_WIDTH}px;background:#fff}.pane img{display:block;max-width:100%;height:auto}` +
      `</style></head><body><div class="row">${columns}</div></body></html>`
  );
  pngs.forEach((png, index) => {
    files[`pane-${index}.png`] = { type: 'image/png', body: png };
  });
  return { files };
}
