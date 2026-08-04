// Monaco bootstrap (orca-parity: refs/orca monaco-setup.ts) — locally bundled
// workers, no CDN. TypeScript/JavaScript language intelligence is owned by the
// project LSP in the main process; Monaco keeps editing and tokenization only.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import * as batDef from 'monaco-editor/esm/vs/basic-languages/bat/bat.js';
import * as clojureDef from 'monaco-editor/esm/vs/basic-languages/clojure/clojure.js';
import * as coffeeDef from 'monaco-editor/esm/vs/basic-languages/coffee/coffee.js';
import * as cppDef from 'monaco-editor/esm/vs/basic-languages/cpp/cpp.js';
import * as csharpDef from 'monaco-editor/esm/vs/basic-languages/csharp/csharp.js';
import * as cssDef from 'monaco-editor/esm/vs/basic-languages/css/css.js';
import * as dartDef from 'monaco-editor/esm/vs/basic-languages/dart/dart.js';
import * as dockerfileDef from 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.js';
import * as fsharpDef from 'monaco-editor/esm/vs/basic-languages/fsharp/fsharp.js';
import * as goDef from 'monaco-editor/esm/vs/basic-languages/go/go.js';
import * as handlebarsDef from 'monaco-editor/esm/vs/basic-languages/handlebars/handlebars.js';
import * as htmlDef from 'monaco-editor/esm/vs/basic-languages/html/html.js';
import * as iniDef from 'monaco-editor/esm/vs/basic-languages/ini/ini.js';
import * as javaDef from 'monaco-editor/esm/vs/basic-languages/java/java.js';
import * as javascriptDef from 'monaco-editor/esm/vs/basic-languages/javascript/javascript.js';
import * as juliaDef from 'monaco-editor/esm/vs/basic-languages/julia/julia.js';
import * as lessDef from 'monaco-editor/esm/vs/basic-languages/less/less.js';
import * as luaDef from 'monaco-editor/esm/vs/basic-languages/lua/lua.js';
import * as markdownDef from 'monaco-editor/esm/vs/basic-languages/markdown/markdown.js';
import * as objectiveCDef from 'monaco-editor/esm/vs/basic-languages/objective-c/objective-c.js';
import * as perlDef from 'monaco-editor/esm/vs/basic-languages/perl/perl.js';
import * as phpDef from 'monaco-editor/esm/vs/basic-languages/php/php.js';
import * as powershellDef from 'monaco-editor/esm/vs/basic-languages/powershell/powershell.js';
import * as pugDef from 'monaco-editor/esm/vs/basic-languages/pug/pug.js';
import * as pythonDef from 'monaco-editor/esm/vs/basic-languages/python/python.js';
import * as rDef from 'monaco-editor/esm/vs/basic-languages/r/r.js';
import * as razorDef from 'monaco-editor/esm/vs/basic-languages/razor/razor.js';
import * as restructuredtextDef from 'monaco-editor/esm/vs/basic-languages/restructuredtext/restructuredtext.js';
import * as rubyDef from 'monaco-editor/esm/vs/basic-languages/ruby/ruby.js';
import * as rustDef from 'monaco-editor/esm/vs/basic-languages/rust/rust.js';
import * as scssDef from 'monaco-editor/esm/vs/basic-languages/scss/scss.js';
import * as shellDef from 'monaco-editor/esm/vs/basic-languages/shell/shell.js';
import * as sqlDef from 'monaco-editor/esm/vs/basic-languages/sql/sql.js';
import * as swiftDef from 'monaco-editor/esm/vs/basic-languages/swift/swift.js';
import * as typescriptDef from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js';
import * as vbDef from 'monaco-editor/esm/vs/basic-languages/vb/vb.js';
import * as xmlDef from 'monaco-editor/esm/vs/basic-languages/xml/xml.js';
import * as yamlDef from 'monaco-editor/esm/vs/basic-languages/yaml/yaml.js';
import { MONACO_EAGER_MONARCH_LANGUAGES } from './monaco-eager-languages';
import {
  LOG_LANGUAGE_CONFIGURATION,
  LOG_MONARCH_LANGUAGE,
} from './monaco-log-language';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json': return new jsonWorker();
      case 'css': case 'scss': case 'less': return new cssWorker();
      case 'html': case 'handlebars': case 'razor': return new htmlWorker();
      default: return new editorWorker();
    }
  },
};

loader.config({ monaco });

// basic-languages registers every language id synchronously but loads its
// Monarch tokenizer through a lazy dynamic import(); a model created before
// that chunk resolves paints untokenized (default white) on entry — the
// intermittent "white, no highlighting" first open. Registering every PANE
// target language eagerly makes the first paint colored. ('json' keeps
// monaco's own JSON-mode tokenizer; 'log' is our custom Monarch below.)
const BASIC_LANGUAGE_DEFINITIONS: Readonly<Record<string, {
  conf: monaco.languages.LanguageConfiguration;
  language: monaco.languages.IMonarchLanguage;
}>> = {
  "bat": batDef,
  "clojure": clojureDef,
  "coffee": coffeeDef,
  "cpp": cppDef,
  "csharp": csharpDef,
  "css": cssDef,
  "dart": dartDef,
  "dockerfile": dockerfileDef,
  "fsharp": fsharpDef,
  "go": goDef,
  "handlebars": handlebarsDef,
  "html": htmlDef,
  "ini": iniDef,
  "java": javaDef,
  "javascript": javascriptDef,
  "julia": juliaDef,
  "less": lessDef,
  "lua": luaDef,
  "markdown": markdownDef,
  "objective-c": objectiveCDef,
  "perl": perlDef,
  "php": phpDef,
  "powershell": powershellDef,
  "pug": pugDef,
  "python": pythonDef,
  "r": rDef,
  "razor": razorDef,
  "restructuredtext": restructuredtextDef,
  "ruby": rubyDef,
  "rust": rustDef,
  "scss": scssDef,
  "shell": shellDef,
  "sql": sqlDef,
  "swift": swiftDef,
  "typescript": typescriptDef,
  "vb": vbDef,
  "xml": xmlDef,
  "yaml": yamlDef,
};
for (const [languageId, moduleDir] of Object.entries(MONACO_EAGER_MONARCH_LANGUAGES)) {
  const definition = BASIC_LANGUAGE_DEFINITIONS[moduleDir];
  if (!definition) continue;
  monaco.languages.setMonarchTokensProvider(languageId, definition.language);
  monaco.languages.setLanguageConfiguration(languageId, definition.conf);
}
if (!monaco.languages.getLanguages().some((language) => language.id === 'log')) {
  monaco.languages.register({
    id: 'log',
    extensions: ['.log'],
    aliases: ['Log', 'log'],
  });
}
monaco.languages.setMonarchTokensProvider('log', LOG_MONARCH_LANGUAGE);
monaco.languages.setLanguageConfiguration('log', LOG_LANGUAGE_CONFIGURATION);

// Monaco's stock vs/vs-dark canvases are cool white/near-black. Match the
// renderer's warm workspace sheet while inheriting the familiar syntax rules.
monaco.editor.defineTheme('mixdog-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1f1f1f',
    'editor.foreground': '#e9e9e9',
    'editorGutter.background': '#1f1f1f',
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#d0d0d0',
    'editor.lineHighlightBackground': '#262626',
    'editor.selectionBackground': '#424242',
    'editor.inactiveSelectionBackground': '#2e2e2e',
    'editorCursor.foreground': '#e9e9e9',
    'editorWhitespace.foreground': '#424242',
    'editorIndentGuide.background1': '#2e2e2e',
    'editorIndentGuide.activeBackground1': '#616161',
    'minimap.background': '#1f1f1f',
    'editorOverviewRuler.background': '#1f1f1f',
    'editorOverviewRuler.border': '#00000000',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#85858533',
    'scrollbarSlider.hoverBackground': '#a8a8a855',
    'scrollbarSlider.activeBackground': '#d0d0d066',
    'editorWidget.background': '#262626',
    'editorWidget.border': '#424242',
    'editorSuggestWidget.background': '#262626',
    'editorSuggestWidget.border': '#424242',
    'editorSuggestWidget.selectedBackground': '#373737',
    'editorHoverWidget.background': '#262626',
    'editorHoverWidget.border': '#424242',
    'menu.background': '#1f1f1f',
    'menu.foreground': '#cccccc',
    'menu.selectionBackground': '#0078d4',
    'menu.selectionForeground': '#ffffff',
    'menu.separatorBackground': '#cccccc33',
  },
});

monaco.editor.defineTheme('mixdog-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#faf8f5',
    'editor.foreground': '#1b1a17',
    'editorGutter.background': '#faf8f5',
    'editorLineNumber.foreground': '#878178',
    'editorLineNumber.activeForeground': '#45413a',
    'editor.lineHighlightBackground': '#f7f5f2',
    'editor.selectionBackground': '#e2ddd7',
    'editor.inactiveSelectionBackground': '#eae7e3',
    'editorCursor.foreground': '#1b1a17',
    'editorWhitespace.foreground': '#e2ddd7',
    'editorIndentGuide.background1': '#eae7e3',
    'editorIndentGuide.activeBackground1': '#b8b1a8',
    'minimap.background': '#faf8f5',
    'editorOverviewRuler.background': '#faf8f5',
    'editorOverviewRuler.border': '#00000000',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#635f5733',
    'scrollbarSlider.hoverBackground': '#635f5755',
    'scrollbarSlider.activeBackground': '#45413a66',
    'editorWidget.background': '#fffefc',
    'editorWidget.border': '#3e322335',
    'editorSuggestWidget.background': '#fffefc',
    'editorSuggestWidget.border': '#3e322335',
    'editorSuggestWidget.selectedBackground': '#f0edea',
    'editorHoverWidget.background': '#fffefc',
    'editorHoverWidget.border': '#3e322335',
    'menu.background': '#faf8f5',
    'menu.foreground': '#1b1a17',
    'menu.selectionBackground': '#005fb8',
    'menu.selectionForeground': '#ffffff',
    'menu.separatorBackground': '#1b1a1733',
  },
});

// ── Dynamic theme sync ──────────────────────────────────────────────────
// The static definitions above are the boot fallback (default warm dark /
// light). Registry themes (nord, dracula, …) restyle the shell through
// injected --mx-* tokens; the editor must follow the same tokens or it
// stays warm-dark inside a differently colored shell.
let themeColorProbe: HTMLElement | null = null;

function colorProbe(): HTMLElement {
  if (themeColorProbe?.isConnected) return themeColorProbe;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;left:-9999px;width:0;height:0;pointer-events:none;';
  document.documentElement.appendChild(probe);
  themeColorProbe = probe;
  return probe;
}

function channelHex(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, '0');
}

function alphaHex(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '';
  const value = raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
  if (!Number.isFinite(value) || value >= 1) return '';
  return channelHex(value * 255);
}

/** Resolve a CSS custom property to a Monaco-safe #rrggbb(aa) string. */
export function resolveThemeColor(token: string, fallback: string): string {
  try {
    const probe = colorProbe();
    probe.style.color = fallback;
    probe.style.color = `var(${token}, ${fallback})`;
    const computed = getComputedStyle(probe).color;
    const rgb = computed.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
    if (rgb) {
      return `#${channelHex(Number(rgb[1]))}${channelHex(Number(rgb[2]))}${channelHex(Number(rgb[3]))}${alphaHex(rgb[4])}`;
    }
    const srgb = computed.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
    if (srgb) {
      return `#${channelHex(Number(srgb[1]) * 255)}${channelHex(Number(srgb[2]) * 255)}${channelHex(Number(srgb[3]) * 255)}${alphaHex(srgb[4])}`;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function withAlpha(color: string, alpha: string): string {
  return `${color.slice(0, 7)}${alpha}`;
}

function currentMonacoColors(light: boolean): Record<string, string> {
  const sheet = resolveThemeColor('--mx-workspace-sheet', light ? '#faf8f5' : '#1f1f1f');
  const text = resolveThemeColor('--mx-text', light ? '#1b1a17' : '#e9e9e9');
  const faint = resolveThemeColor('--mx-text-faint', light ? '#878178' : '#808080');
  const icon = resolveThemeColor('--mx-icon', light ? '#45413a' : '#d0d0d0');
  const base = resolveThemeColor('--mx-bg-base', light ? '#fffefc' : '#262626');
  const layer1 = resolveThemeColor('--mx-bg-layer-1', light ? '#f7f5f2' : '#2e2e2e');
  const layer2 = resolveThemeColor('--mx-bg-layer-2', light ? '#f0edea' : '#373737');
  const layer3 = resolveThemeColor('--mx-bg-layer-3', light ? '#eae7e3' : '#424242');
  const contrast = resolveThemeColor('--mx-bg-contrast', light ? '#b8b1a8' : '#616161');
  const focus = resolveThemeColor('--mx-focus', light ? '#005fb8' : '#0078d4');
  const scrollbarThumb = resolveThemeColor('--mx-scrollbar-thumb', withAlpha(faint, '33'));
  const scrollbarThumbHover = resolveThemeColor('--mx-scrollbar-thumb-hover', withAlpha(faint, '55'));
  return {
    'editor.background': sheet,
    'editor.foreground': text,
    'editorGutter.background': sheet,
    'editorLineNumber.foreground': faint,
    'editorLineNumber.activeForeground': icon,
    'editor.lineHighlightBackground': base,
    'editor.selectionBackground': layer3,
    'editor.inactiveSelectionBackground': layer2,
    'editorCursor.foreground': text,
    'editorWhitespace.foreground': layer3,
    'editorIndentGuide.background1': layer1,
    'editorIndentGuide.activeBackground1': contrast,
    'minimap.background': sheet,
    'editorOverviewRuler.background': sheet,
    'editorOverviewRuler.border': '#00000000',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': scrollbarThumb,
    'scrollbarSlider.hoverBackground': scrollbarThumbHover,
    'scrollbarSlider.activeBackground': scrollbarThumbHover,
    'editorWidget.background': base,
    'editorWidget.border': layer3,
    'editorSuggestWidget.background': base,
    'editorSuggestWidget.border': layer3,
    'editorSuggestWidget.selectedBackground': layer2,
    'editorHoverWidget.background': base,
    'editorHoverWidget.border': layer3,
    // VS Code Dark Modern keeps context menus on the editor sheet rather than
    // Monaco's legacy #3c3c3c select surface.
    'menu.background': sheet,
    'menu.foreground': text,
    'menu.selectionBackground': focus,
    'menu.selectionForeground': '#ffffff',
    'menu.separatorBackground': withAlpha(text, '33'),
  };
}

/** Re-derive the active Monaco theme from the CURRENT --mx-* tokens. */
export function syncMonacoThemes(): void {
  if (typeof document === 'undefined') return;
  const light = document.documentElement.dataset.mixdogTheme === 'light';
  const name = light ? 'mixdog-light' : 'mixdog-dark';
  monaco.editor.defineTheme(name, {
    base: light ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [],
    colors: currentMonacoColors(light),
  });
  monaco.editor.setTheme(name);
}

if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  new MutationObserver(() => syncMonacoThemes())
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-mixdog-theme'] });
  // Align with whatever theme was applied before this lazy module loaded.
  syncMonacoThemes();
}

export { monaco };
