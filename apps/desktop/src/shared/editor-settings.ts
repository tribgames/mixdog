import type { DesktopEditorSettings } from './contract';

export const DEFAULT_DESKTOP_EDITOR_SETTINGS: DesktopEditorSettings = Object.freeze({
  fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
  fontSize: 14,
  lineHeight: 21,
  wordWrap: 'off',
  wordWrapColumn: 80,
  renderWhitespace: 'selection',
  minimapEnabled: true,
  // Guides default off: the "active" mode drew a line box around the cursor's block.
  stickyScrollEnabled: true,
  bracketPairColorization: true,
  bracketPairGuides: false,
  inlayHintsEnabled: 'on',
  formatOnSave: false,
  formatOnPaste: false,
  formatOnType: false,
  markdownDefaultView: 'preview',
  tabSize: 4,
  insertSpaces: true,
  detectIndentation: true,
});

export function markdownDefaultViewSetting(value: unknown): DesktopEditorSettings['markdownDefaultView'] {
  return value === 'rich' || value === 'source' ? value : 'preview';
}
