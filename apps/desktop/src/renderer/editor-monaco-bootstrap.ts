import { monaco } from "./monaco-setup";

let monoRemeasureArmed = false;

export const MIXDOG_EDITOR_SCROLLBAR = {
  arrowSize: 0,
  verticalScrollbarSize: 14,
  horizontalScrollbarSize: 12,
} as const;

export const QUICK_DIFF_COLOR_TOKENS = {
  add: ["--mx-editor-diff-add", "#487e02", "#48985d"],
  mod: ["--mx-editor-diff-mod", "#1b81a8", "#2090d3"],
  del: ["--mx-editor-diff-del", "#f14c4c", "#b5200d"],
} as const;

export function colorWithAlpha(color: string, alpha: string): string {
  const hex = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color);
  return hex ? `#${hex[1]}${alpha}` : color;
}

export function armMonoFontRemeasure() {
  if (monoRemeasureArmed) return;
  monoRemeasureArmed = true;
  const remeasure = () => {
    try { monaco.editor.remeasureFonts(); } catch { /* cosmetic */ }
  };
  try {
    // Cover both explicit and late @font-face registration before remeasuring
    // Monaco's cached glyph metrics.
    void document.fonts.load('400 13px "JetBrains Mono Variable"')
      .then(remeasure)
      .catch(() => undefined);
    void document.fonts.ready.then(remeasure).catch(() => undefined);
    document.fonts.addEventListener?.("loadingdone", remeasure);
  } catch { /* font readiness stays cosmetic */ }
}
