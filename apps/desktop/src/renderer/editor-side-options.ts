import type { editor } from 'monaco-editor';

export const SIDE_EDITOR_SCROLLBAR_SIZE = 8;

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
