// Monaco bootstrap — locally bundled workers, no CDN. TypeScript/JavaScript
// language intelligence is owned by the project LSP in the main process;
// Monaco keeps editing and tokenization only.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// @ts-expect-error Monaco internal service accessor used to stop the idle editor worker when no surface is mounted.
import { IEditorWorkerService } from 'monaco-editor/esm/vs/editor/common/services/editorWorker.js';
// @ts-expect-error Monaco internal standalone service registry.
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
import { LOG_LANGUAGE_CONFIGURATION, LOG_MONARCH_LANGUAGE } from './monaco-log-language';
import {
  createMonacoLanguageLoader,
  ensureMonacoLanguage,
  installMonacoLanguageLoader,
} from './monaco-language-loader';
import {
  createMonacoWorkerLifecycle,
  installMonacoWorkerLifecycle,
  stopMonacoLanguageWorkers,
  wakeMonacoLanguageWorkers,
  type MonacoLanguageServiceDefaultsLike,
  type MonacoLanguageServiceLabel,
} from './monaco-worker-lifecycle';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker';

function languageServiceDefaults(label: MonacoLanguageServiceLabel): MonacoLanguageServiceDefaultsLike | undefined {
  switch (label) {
    case 'json':
      return monaco.json?.jsonDefaults as unknown as MonacoLanguageServiceDefaultsLike | undefined;
    case 'css':
      return monaco.css?.cssDefaults as unknown as MonacoLanguageServiceDefaultsLike | undefined;
    case 'scss':
      return monaco.css?.scssDefaults as unknown as MonacoLanguageServiceDefaultsLike | undefined;
    case 'less':
      return monaco.css?.lessDefaults as unknown as MonacoLanguageServiceDefaultsLike | undefined;
    case 'html':
      return monaco.html?.htmlDefaults as unknown as MonacoLanguageServiceDefaultsLike | undefined;
    case 'handlebars':
      return monaco.html?.handlebarDefaults as unknown as MonacoLanguageServiceDefaultsLike | undefined;
    case 'razor':
      return monaco.html?.razorDefaults as unknown as MonacoLanguageServiceDefaultsLike | undefined;
  }
}

function stopMonacoEditorWorker(): void {
  try {
    const service = StandaloneServices.get(IEditorWorkerService) as {
      _workerManager?: { _editorWorkerClient?: { dispose(): void } | null };
    };
    const manager = service?._workerManager;
    if (manager?._editorWorkerClient) {
      manager._editorWorkerClient.dispose();
      manager._editorWorkerClient = null;
    }
  } catch {
    /* service not initialized */
  }
}

function hasLiveMonacoModelsForLabel(label: MonacoLanguageServiceLabel): boolean {
  return monaco.editor.getModels().some((model) => !model.isDisposed() && model.getLanguageId() === label);
}

const workerLifecycle = createMonacoWorkerLifecycle({
  factories: {
    editor: () => new editorWorker(),
    json: () => new jsonWorker(),
    css: () => new cssWorker(),
    html: () => new htmlWorker(),
  },
  getLanguageDefaults: languageServiceDefaults,
  stopEditorWorker: stopMonacoEditorWorker,
  hasLiveModels: hasLiveMonacoModelsForLabel,
});
installMonacoWorkerLifecycle(workerLifecycle);

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    return workerLifecycle.createWorker(label);
  },
};

loader.config({ monaco });

const languageLoader = createMonacoLanguageLoader({
  register: monaco.languages,
});
installMonacoLanguageLoader(languageLoader);
if (!monaco.languages.getLanguages().some((language) => language.id === 'log')) {
  monaco.languages.register({
    id: 'log',
    extensions: ['.log'],
    aliases: ['Log', 'log'],
  });
}
monaco.languages.setMonarchTokensProvider('log', LOG_MONARCH_LANGUAGE);
monaco.languages.setLanguageConfiguration('log', LOG_LANGUAGE_CONFIGURATION);

export { ensureMonacoLanguage, stopMonacoLanguageWorkers, wakeMonacoLanguageWorkers };

// Monaco's stock vs/vs-dark canvases are cool white/near-black. Match the
// renderer's workspace sheet while inheriting the familiar syntax rules.
monaco.editor.defineTheme('mixdog-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#111113',
    'editor.foreground': '#e9e9e9',
    'editorGutter.background': '#111113',
    'editorLineNumber.foreground': '#858585',
    'editorLineNumber.activeForeground': '#d0d0d0',
    'editor.lineHighlightBackground': '#222225',
    'editor.selectionBackground': '#3d3d41',
    'editor.inactiveSelectionBackground': '#323236',
    'editorCursor.foreground': '#e9e9e9',
    'editorWhitespace.foreground': '#3d3d41',
    'editorIndentGuide.background1': '#2a2a2d',
    'editorIndentGuide.activeBackground1': '#5c5c61',
    'minimap.background': '#111113',
    'editorOverviewRuler.background': '#111113',
    'editorOverviewRuler.border': '#00000000',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#85858533',
    'scrollbarSlider.hoverBackground': '#a8a8a855',
    'scrollbarSlider.activeBackground': '#d0d0d066',
    'editorWidget.background': '#222225',
    'editorWidget.border': '#3d3d41',
    'editorSuggestWidget.background': '#222225',
    'editorSuggestWidget.border': '#3d3d41',
    'editorSuggestWidget.selectedBackground': '#323236',
    'editorHoverWidget.background': '#222225',
    'editorHoverWidget.border': '#3d3d41',
    'menu.background': '#101013',
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
    'editor.background': '#f8f8fb',
    'editor.foreground': '#242529',
    'editorGutter.background': '#f8f8fb',
    'editorLineNumber.foreground': '#8a8f95',
    'editorLineNumber.activeForeground': '#3f4348',
    'editor.lineHighlightBackground': '#f4f4f7',
    'editor.selectionBackground': '#e2e2e2',
    'editor.inactiveSelectionBackground': '#e8e8e8',
    'editorCursor.foreground': '#242529',
    'editorWhitespace.foreground': '#e2e2e2',
    'editorIndentGuide.background1': '#e8e8e8',
    'editorIndentGuide.activeBackground1': '#b0b0b0',
    'minimap.background': '#f8f8fb',
    'editorOverviewRuler.background': '#f8f8fb',
    'editorOverviewRuler.border': '#00000000',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#5c606633',
    'scrollbarSlider.hoverBackground': '#5c606655',
    'scrollbarSlider.activeBackground': '#3f434866',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#17181a24',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.border': '#17181a24',
    'editorSuggestWidget.selectedBackground': '#ececef',
    'editorHoverWidget.background': '#ffffff',
    'editorHoverWidget.border': '#17181a24',
    'menu.background': '#f8f8fb',
    'menu.foreground': '#242529',
    'menu.selectionBackground': '#005fb8',
    'menu.selectionForeground': '#ffffff',
    'menu.separatorBackground': '#17181a33',
  },
});

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
  const sheet = resolveThemeColor('--mx-workspace-sheet', light ? '#f8f8fb' : '#111113');
  const text = resolveThemeColor('--mx-text', light ? '#242529' : '#e9e9e9');
  const faint = resolveThemeColor('--mx-text-faint', light ? '#6a6a6e' : '#808080');
  const icon = resolveThemeColor('--mx-icon', light ? '#3f4348' : '#d0d0d0');
  const base = resolveThemeColor('--mx-bg-base', light ? '#ffffff' : '#222225');
  const layer1 = resolveThemeColor('--mx-bg-layer-1', light ? '#f4f4f7' : '#2a2a2d');
  const layer2 = resolveThemeColor('--mx-bg-layer-2', light ? '#ececef' : '#323236');
  const layer3 = resolveThemeColor('--mx-bg-layer-3', light ? '#e3e3e6' : '#3d3d41');
  const contrast = resolveThemeColor('--mx-bg-contrast', light ? '#b0b0b0' : '#5c5c61');
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
    // Keep context menus on the editor sheet rather than Monaco's legacy
    // #3c3c3c select surface.
    'menu.background': sheet,
    'menu.foreground': text,
    'menu.selectionBackground': layer2,
    'menu.selectionForeground': text,
    'menu.separatorBackground': withAlpha(text, '33'),
  };
}

/** Re-derive the active Monaco theme from the CURRENT --mx-* tokens. */
function syncMonacoThemes(): void {
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
  new MutationObserver(() => syncMonacoThemes()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-mixdog-theme'],
  });
  // Align with whatever theme was applied before this lazy module loaded.
  syncMonacoThemes();
}

export { monaco };
