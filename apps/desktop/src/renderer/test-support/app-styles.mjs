// The app's own stylesheets bundled for a real-Chrome probe, and the contrast
// probe the skin tests share: text against what it actually sits on.
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/* MIXDOG_PROBE_CSS_ROOT: another renderer tree's stylesheets (a before/after
   comparison against an exported revision). */
const renderer = process.env.MIXDOG_PROBE_CSS_ROOT || fileURLToPath(new URL('..', import.meta.url));

/** The renderer entry's order (bootstrap-styles.ts), then the sheets the
    probed surfaces' own components import. */
export async function appStyles() {
  const sheets = [
    'styles.css',
    'desktop.css',
    'pane-layout.css',
    'agent-chat.css',
    'mixy-first.css',
    'starter-guide.css',
    'settings/settings.css',
    'settings/appearance-panel.css',
  ];
  const result = await build({
    stdin: { contents: sheets.map((sheet) => `@import "./${sheet}";`).join('\n'), resolveDir: renderer, loader: 'css' },
    bundle: true,
    write: false,
    logLevel: 'silent',
    external: ['*.woff2', '*.woff', '*.ttf', '*.otf', '*.svg', '*.png', '*.jpg', '*.webp', '*.gif'],
  });
  return result.outputFiles[0].text;
}

/* A two-appearance theme whose surfaces differ from the built-in ones. */
export const QA_THEME = JSON.stringify({
  $schema: 'mixdog-theme/v1',
  name: 'QA Pair',
  roles: {
    background: { dark: '#14161c', light: '#f4efe6' },
    surface: { dark: '#1d2028', light: '#fffaf2' },
    'surface-raised': { dark: '#262a34', light: '#efe6d6' },
    text: { dark: '#e8e6e3', light: '#2a2520' },
    'text-muted': { dark: '#a8a49e', light: '#6a6055' },
    'user-bubble': { dark: '#2a3040', light: '#e9e1d3' },
    accent: { dark: '#7aa2f7', light: '#2959c9' },
  },
});

/** Every class 28-usage-explorer.css colours (highlight.js emits
    `hljs-title function_` as two classes), one token span each. */
const HLJS_CLASSES = [
  'comment',
  'quote',
  'keyword',
  'selector-tag',
  'built_in',
  'literal',
  'tag',
  'doctag',
  'formula',
  'string',
  'regexp',
  'number',
  'symbol',
  'bullet',
  'title',
  'title function_',
  'title class_',
  'section',
  'type',
  'selector-class',
  'selector-id',
  'attr',
  'attribute',
  'variable',
  'template-variable',
  'name',
  'params',
  'meta',
];
const hljsId = (prefix, name) => `${prefix}-hljs-${name.replace(/ /g, '-')}`;

/** An assistant turn as the transcript renders it (transcript-row.tsx,
    markdown-components.tsx): a code card with one span of each hljs class and
    a prose link, inside the message plate. Ids to probe come back with it. */
export function transcriptMarkdownProbe(prefix) {
  const spans = HLJS_CLASSES.map(
    (name) => `<span class="hljs-${name}" id="${hljsId(prefix, name)}">${name}</span>`
  ).join(' ');
  return {
    html: `<article class="message assistant settled"><div class="message-body"><div class="markdown">
      <p><a href="https://example.com" id="${prefix}-link">a link</a></p>
      <div class="markdown-code"><header><span>ts</span></header><pre data-scrollable><code class="hljs language-ts">${spans}</code></pre></div>
    </div></div></article>`,
    ids: [`${prefix}-link`, ...HLJS_CLASSES.map((name) => hljsId(prefix, name))],
  };
}

/** Paint one combination on <html>: theme, imported theme sheet, skin vars. */
export function paintState(page, state) {
  return page.evaluate((state) => {
    const root = document.documentElement;
    root.removeAttribute('style');
    for (const key of ['mixdogSkin', 'mixdogSkinPlate', 'mixdogUserTheme', 'mixdogMobileTabs'])
      delete root.dataset[key];
    root.dataset.mixdogTheme = state.theme;
    if (state.phone) root.dataset.mixdogMobileTabs = 'true';
    document.getElementById('qa-user-theme')?.remove();
    if (state.themeSheet) {
      const style = document.createElement('style');
      style.id = 'qa-user-theme';
      style.textContent = state.themeSheet;
      document.head.append(style);
      root.dataset.mixdogUserTheme = 'qa';
    }
    if (state.skin) {
      root.dataset.mixdogSkin = state.skin;
      root.dataset.mixdogSkinPlate = state.plate;
      for (const [name, value] of Object.entries(state.vars)) root.style.setProperty(name, value);
    }
  }, state);
}

/** Contrast of each element's text against what it actually sits on: its own
    background composited over every ancestor's, over `underlay` (a skin
    picture's average colour) or the reading canvas. Also the luminance of
    that backdrop, for tone checks. */
export function measureIds(page, ids, underlay) {
  return page.evaluate(
    (ids, underlay) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const over = (top, bottom) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = bottom;
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = top;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return `rgb(${r}, ${g}, ${b})`;
      };
      const lum = (rgb) => {
        const [r, g, b] = rgb.match(/\d+/g).map((v) => {
          const c = Number(v) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
        return (x + 0.05) / (y + 0.05);
      };
      const base =
        underlay ?? getComputedStyle(document.documentElement).getPropertyValue('--mx-workspace-sheet').trim();
      return Object.fromEntries(
        ids.map((id) => {
          const element = document.getElementById(id);
          const layers = [];
          for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
            layers.unshift(getComputedStyle(node).backgroundColor);
          }
          const background = layers.reduce((under, layer) => over(layer, under), over(base, '#000'));
          const ink = over(getComputedStyle(element).color, background);
          return [
            id,
            {
              ratio: Math.round(ratio(ink, background) * 100) / 100,
              ink,
              background,
              light: Math.round(lum(background) * 1000) / 1000,
            },
          ];
        })
      );
    },
    ids,
    underlay
  );
}
