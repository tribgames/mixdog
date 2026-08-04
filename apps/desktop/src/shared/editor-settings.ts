import type { DesktopEditorSettings } from "./contract";

export const DEFAULT_DESKTOP_EDITOR_SETTINGS: DesktopEditorSettings = Object.freeze({
  fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
  fontSize: 14,
  lineHeight: 21,
  wordWrap: "off",
  wordWrapColumn: 80,
  renderWhitespace: "selection",
  minimapEnabled: true,
  // VS Code default parity (user: 코드 편집 UI/UX는 VS Code와 일치):
  // sticky scroll ships ON and bracket-pair guides ship OFF upstream — the
  // "active" default drew a line box around the cursor's block (user: 선이
  // 붙는다). Both remain per-workspace settings.
  stickyScrollEnabled: true,
  bracketPairColorization: true,
  bracketPairGuides: false,
  inlayHintsEnabled: "on",
  formatOnSave: false,
  formatOnPaste: false,
  formatOnType: false,
  tabSize: 4,
  insertSpaces: true,
  detectIndentation: true,
});
