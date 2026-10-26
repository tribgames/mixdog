import type { DesktopEditorSettings } from '../shared/contract';
import { MIXDOG_EDITOR_SCROLLBAR } from './editor-monaco-bootstrap';
import { editorSurfaceOptions } from './editor-side-options';
import { monaco } from './monaco-setup';

/** The user's editor settings expressed as Monaco construction options; every
 *  value the settings do not own is a deliberate default. */
function monacoEditorOptions(
  editorSettings: DesktopEditorSettings,
  wordWrapOverride: DesktopEditorSettings['wordWrap'] | null
): import('monaco-editor').editor.IStandaloneEditorConstructionOptions {
  return {
    fontSize: editorSettings.fontSize,
    lineHeight: editorSettings.lineHeight,
    fontFamily: editorSettings.fontFamily,
    readOnly: false,
    domReadOnly: false,
    wordWrap: wordWrapOverride ?? editorSettings.wordWrap,
    wordWrapColumn: editorSettings.wordWrapColumn,
    minimap: {
      enabled: editorSettings.minimapEnabled,
      /* Default editor behavior. */
      size: 'proportional',
      showSlider: 'mouseover',
    },
    stickyScroll: { enabled: editorSettings.stickyScrollEnabled },
    scrollbar: MIXDOG_EDITOR_SCROLLBAR,
    automaticLayout: false,
    scrollBeyondLastLine: true,
    renderWhitespace: editorSettings.renderWhitespace,
    bracketPairColorization: {
      enabled: editorSettings.bracketPairColorization,
      /* Default text-model behavior. */
      independentColorPoolPerBracketType: false,
    },
    guides: {
      bracketPairs: editorSettings.bracketPairGuides,
      bracketPairsHorizontal: 'active',
      highlightActiveBracketPair: true,
      indentation: true,
    },
    inlayHints: { enabled: editorSettings.inlayHintsEnabled },
    formatOnPaste: editorSettings.formatOnPaste,
    formatOnType: editorSettings.formatOnType,
    glyphMargin: true,
    folding: true,
    showFoldingControls: 'mouseover',
    lineNumbersMinChars: 5,
    overviewRulerLanes: 3,
    renderLineHighlight: 'line',
    padding: { top: 4, bottom: 4 },
    fixedOverflowWidgets: true,
    /* Hide the lightbulb on empty lines. */
    lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
  };
}

/** The options the pane's Monaco surface mounts with: the settings' options
 *  narrowed for the side dock or the phone, read-only when the file is. */
export function editorPaneMonacoOptions(
  editorSettings: DesktopEditorSettings,
  wordWrapOverride: DesktopEditorSettings['wordWrap'] | null,
  surface: { side: boolean; phone: boolean; readOnly: boolean }
): import('monaco-editor').editor.IStandaloneEditorConstructionOptions {
  const baseOptions = monacoEditorOptions(editorSettings, wordWrapOverride);
  return {
    ...editorSurfaceOptions(baseOptions, wordWrapOverride, { side: surface.side, phone: surface.phone }),
    readOnly: surface.readOnly,
  };
}
