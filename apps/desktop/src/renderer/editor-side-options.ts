import type { editor } from 'monaco-editor';

export const SIDE_EDITOR_SCROLLBAR_SIZE = 8;
export const SIDE_EDITOR_LINE_DECORATIONS_WIDTH = 12;
export const SIDE_EDITOR_LINE_NUMBERS_MIN_CHARS = 3;

/** The narrow side-dock editor: no minimap or sticky-scroll overlay (they eat
 *  a narrow panel's width and pin lines over the revealed one) and wrapped
 *  lines, so only the vertical scrollbar remains. Alt+Z still overrides wrap. */
export function sideEditorOptions(
  base: editor.IStandaloneEditorConstructionOptions,
  wordWrapOverride: editor.IStandaloneEditorConstructionOptions['wordWrap'] | null
): editor.IStandaloneEditorConstructionOptions {
  return {
    ...base,
    minimap: { ...base.minimap, enabled: false },
    stickyScroll: { enabled: false },
    wordWrap: wordWrapOverride ?? 'on',
    // Slim gutter: code starts ≈45px from the card edge (no glyph margin, no
    // folding arrows, minimal decorations, 3-digit line numbers).
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: SIDE_EDITOR_LINE_DECORATIONS_WIDTH,
    lineNumbersMinChars: SIDE_EDITOR_LINE_NUMBERS_MIN_CHARS,
    // The overview ruler paints change/cursor marks inside the scrollbar
    // track; on the 8px track they sit on top of the thumb. Changed lines
    // still show as the gutter stripes beside the line numbers.
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    // The shell scrollbar's 8px track (--mx-scrollbar-size); the pill look is
    // the `.pane-side-dock` slider rules in 26-editor.css.
    scrollbar: {
      ...base.scrollbar,
      arrowSize: 0,
      verticalScrollbarSize: SIDE_EDITOR_SCROLLBAR_SIZE,
      horizontalScrollbarSize: SIDE_EDITOR_SCROLLBAR_SIZE,
      useShadows: false,
    },
  };
}
